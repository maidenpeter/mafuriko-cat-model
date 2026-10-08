import type { Generated, Usage } from "./gemini";
import type { Role } from "./schema";

export const DEFAULT_MODEL = "gpt-6-luna";

export const modelName = () => process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;

/** One key serves all four agents; any of them can still be given its own. */
export function keyFor(role: Role): string | null {
  return process.env[`OPENAI_API_KEY_${role.toUpperCase()}`]?.trim() || process.env.OPENAI_API_KEY?.trim() || null;
}

/** The GPT-3 and GPT-4 families, which do not reason before they answer. */
const isOlder = (model: string) => /^gpt-[34]/.test(model);

/**
 * GPT-5 and later reason before they answer: they take an effort level and reject a
 * temperature. "low" keeps each agent quick. Older models take temperature 0 for repeatable replies.
 */
function samplingConfig(model: string): Record<string, unknown> {
  if (isOlder(model)) return { temperature: 0 };
  return { reasoning_effort: process.env.OPENAI_REASONING_EFFORT?.trim() || "low" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeoutMs = () => (Number(process.env.OPENAI_TIMEOUT_S) || 150) * 1000;
/** Hard ceiling on one call. It covers the model's reasoning as well as the reply, which is a few thousand tokens. */
const MAX_COMPLETION_TOKENS = 25_000;

type Schema = Record<string, unknown>;

/**
 * The reply shape in the form OpenAI enforces: plain JSON Schema with lower-case type names
 * and every object closed to extra fields. Keys keep their order, so each reason is still
 * written before its value.
 */
export function strictSchema(schema: Schema): Schema {
  const out: Schema = { ...schema };
  if (typeof schema.type === "string") out.type = schema.type.toLowerCase();
  delete out.propertyOrdering;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, Schema>).map(([name, s]) => [name, strictSchema(s)]));
    out.additionalProperties = false;
  }
  if (schema.items) out.items = strictSchema(schema.items as Schema);
  return out;
}

/**
 * Takes out the optional setting a model said it does not accept, so the call can be sent
 * again. Returns false when the complaint is about something that cannot be left out.
 */
function relax(request: Record<string, unknown>, param: unknown): boolean {
  const instructions = (request.messages as { role: string }[])[0];
  if (String(param).startsWith("messages[0].role") && instructions.role === "developer") {
    instructions.role = "system";
    return true;
  }
  const name = String(param ?? "").split(".")[0];
  if (name === "response_format" && (request.response_format as { type: string }).type === "json_schema") {
    // The prompt still describes the shape, and the route checks the reply against it.
    request.response_format = { type: "json_object" };
    return true;
  }
  if (["reasoning_effort", "temperature", "max_completion_tokens"].includes(name) && name in request) {
    delete request[name];
    return true;
  }
  return false;
}

/** Error text comes back to the screen, so anything shaped like a key is taken out of it. */
const redact = (text: string) => text.replace(/\bsk-[\w*-]{8,}/g, "sk-…");

interface Completion {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string; param?: string | null };
}

/**
 * One text-in, JSON-text-out call to OpenAI's Chat Completions API. Same contract as the
 * Gemini call; provider.ts picks between the two.
 *
 * The reply is not streamed: it arrives whole, so there is nothing to cut off.
 */
export async function generateJson(apiKey: string, system: string, user: string, responseSchema: Schema, label = "agent"): Promise<Generated> {
  // OPENAI_BASE_URL exists so tests can point the agents at a local stand-in.
  const url = `${process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com"}/v1/chat/completions`;
  const request: Record<string, unknown> = {
    model: modelName(),
    messages: [
      // OpenAI's name for the instructions changed with its reasoning models.
      { role: isOlder(modelName()) ? "system" : "developer", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "reply", strict: true, schema: strictSchema(responseSchema) } },
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    ...samplingConfig(modelName()),
  };
  const limit = timeoutMs();

  let lastError = "no response";
  let retried = false;
  while (true) {
    const started = Date.now();
    const seconds = () => Number(((Date.now() - started) / 1000).toFixed(1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    let res: Response;
    let payload: Completion | null;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request), signal: controller.signal });
      payload = (await res.json().catch(() => null)) as Completion | null;
      if (controller.signal.aborted) throw new Error("timed out");
    } catch (e) {
      if (controller.signal.aborted) {
        console.log(`[${label}] gave up after ${limit / 1000} s`);
        throw new Error(`no reply within ${limit / 1000} s: the request was sent, but the model had not answered yet`);
      }
      throw new Error(`could not reach the model (${(e as Error).message})`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = redact(payload?.error?.message ?? res.statusText);
      lastError = res.status === 429 ? `quota or rate limit reached for this key (429). ${detail}`.trim() : `${res.status} ${detail}`;
      console.log(`[${label}] rejected after ${seconds()} s: ${lastError.slice(0, 200)}`);
      // A model that does not take one of the optional settings says which one. Nothing was generated, so sending again costs nothing.
      if (res.status === 400 && relax(request, payload?.error?.param)) continue;
      // One retry, and only when the service is overloaded. A quota error (429) is
      // never retried: repeating the call only spends more of the quota.
      if (res.status >= 500 && !retried) {
        retried = true;
        await sleep(2000);
        continue;
      }
      break;
    }

    const choice = payload?.choices?.[0];
    const thinking = payload?.usage?.completion_tokens_details?.reasoning_tokens;
    const written = payload?.usage?.completion_tokens;
    const usage: Usage = {
      promptTokens: payload?.usage?.prompt_tokens,
      // OpenAI counts reasoning inside the completion; the screen shows the two apart.
      outputTokens: written === undefined ? undefined : written - (thinking ?? 0),
      thinkingTokens: thinking,
      finishReason: choice?.finish_reason,
    };
    console.log(`[${label}] ${modelName()} · done ${seconds()} s · ${usage.outputTokens ?? "?"} tokens written, ${usage.thinkingTokens ?? 0} thinking · finish ${usage.finishReason ?? "unknown"}`);
    if (choice?.message?.refusal) throw new Error(`the model declined to answer: ${choice.message.refusal}`);
    const text = choice?.message?.content ?? "";
    if (text) return { text, usage };
    throw new Error(usage.finishReason === "length" ? "the reply hit the output limit before any of it was written" : `empty reply (finish reason: ${usage.finishReason ?? "unknown"})`);
  }
  throw new Error(lastError);
}
