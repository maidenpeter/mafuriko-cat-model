import type { Role } from "./schema";

export const DEFAULT_MODEL = "gemini-3.8-flash";

export const modelName = () => process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

/** Each agent can have its own key; any of them falls back to GEMINI_API_KEY. */
export function keyFor(role: Role): string | null {
  return process.env[`GEMINI_API_KEY_${role.toUpperCase()}`]?.trim() || process.env.GEMINI_API_KEY?.trim() || null;
}

/**
 * Gemini 3 models reject sampling settings and take a thinking level instead;
 * "low" keeps each agent quick. Older models take temperature 0 for repeatable replies.
 */
function samplingConfig(model: string): Record<string, unknown> {
  if (/^gemini-[3-9]/.test(model)) return { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL?.trim() || "low" } };
  return { temperature: 0 };
}

const sleep = (ms: number) => new Promise<"waited">((r) => setTimeout(() => r("waited"), ms));
const timeoutMs = () => (Number(process.env.GEMINI_TIMEOUT_S) || 150) * 1000;
/** Hard ceiling on reply length. A full reply is a few thousand tokens; this stops a runaway one. */
const MAX_OUTPUT_TOKENS = 12_000;
/** How long to let the stream end by itself once the JSON object is complete. */
const GRACE_MS = 2000;

export interface Usage {
  promptTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  finishReason?: string;
  /** Seconds until the first piece of the reply arrived. */
  firstTextS?: number;
  /** True when the model kept sending after the reply was complete and was cut off. */
  padded?: boolean;
}

export interface Generated {
  text: string;
  usage: Usage;
}

/** Tells, piece by piece, when a streamed JSON value has closed its outermost bracket. */
function completionScanner() {
  let depth = 0;
  let inString = false;
  let escaped = false;
  /** Returns how many characters of this piece belong to the reply, or -1 if it is not complete yet. */
  return (piece: string): number => {
    for (let i = 0; i < piece.length; i++) {
      const ch = piece[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  };
}

/**
 * One text-in, JSON-text-out call. This is the only place that knows which
 * provider is used; swap it to change provider.
 *
 * The reply is streamed so that it can be cut off the moment the JSON object
 * is complete, and so that a slow call can say where the time went.
 */
export async function generateJson(apiKey: string, system: string, user: string, responseSchema: Record<string, unknown>, label = "agent"): Promise<Generated> {
  // GEMINI_BASE_URL exists so tests can point the agents at a local stand-in.
  const base = process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com";
  const url = `${base}/v1beta/models/${encodeURIComponent(modelName())}:streamGenerateContent?alt=sse`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema, maxOutputTokens: MAX_OUTPUT_TOKENS, ...samplingConfig(modelName()) },
  });
  const limit = timeoutMs();

  let lastError = "no response";
  // One retry, and only when the service is overloaded. A quota error (429) is
  // never retried: repeating the call only spends more of the quota.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2000);
    const started = Date.now();
    const seconds = () => Number(((Date.now() - started) / 1000).toFixed(1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    let text = "";
    const usage: Usage = {};

    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body, signal: controller.signal });
      if (!res.ok || !res.body) {
        clearTimeout(timer);
        const payload = await res.json().catch(() => null);
        const detail = (Array.isArray(payload) ? payload[0] : payload)?.error?.message ?? res.statusText;
        lastError = res.status === 429 ? `quota or rate limit reached for this key (429). ${detail}`.trim() : `${res.status} ${detail}`;
        console.log(`[${label}] rejected after ${seconds()} s: ${lastError.slice(0, 200)}`);
        if (res.status < 500) break;
        continue;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const scan = completionScanner();
      let buffer = "";
      let completeAt: number | null = null;
      let streamError: { code?: number; message?: string } | null = null;

      while (true) {
        // Once the reply is complete, give the stream a moment to end, then stop listening.
        const next = completeAt === null ? await reader.read() : await Promise.race([reader.read(), sleep(Math.max(0, GRACE_MS - (Date.now() - completeAt)))]);
        if (next === "waited") {
          usage.padded = true;
          break;
        }
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          let chunk;
          try {
            chunk = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (chunk.error) streamError = chunk.error;
          const meta = chunk.usageMetadata;
          if (meta) Object.assign(usage, { promptTokens: meta.promptTokenCount, outputTokens: meta.candidatesTokenCount, thinkingTokens: meta.thoughtsTokenCount });
          const candidate = chunk.candidates?.[0];
          if (candidate?.finishReason) usage.finishReason = candidate.finishReason;
          const piece: string = (candidate?.content?.parts ?? []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text ?? "").join("");
          if (!piece || completeAt !== null) continue;
          usage.firstTextS ??= seconds();
          const end = scan(piece);
          if (end === -1) text += piece;
          else {
            text += piece.slice(0, end);
            completeAt = Date.now();
          }
        }
      }
      clearTimeout(timer);
      controller.abort();
      // The stream ended before the JSON closed, and the model never said it had finished: the
      // service dropped the reply part-way. That is a failed call, not a badly shaped reply, so
      // it gets the one retry an overloaded service gets, unless the service says the quota ran out.
      if (completeAt === null && !usage.finishReason) {
        const quota = streamError?.code === 429;
        const detail = streamError?.message;
        lastError = quota
          ? `quota or rate limit reached for this key (429). ${detail ?? ""}`.trim()
          : `the service stopped part-way through the reply, after ${text.length.toLocaleString("en-KE")} characters${detail ? `: ${detail}` : ""}`;
        console.log(`[${label}] cut off after ${seconds()} s: ${lastError.slice(0, 200)}`);
        if (quota) break;
        continue;
      }
      console.log(
        `[${label}] ${modelName()} · first text ${usage.firstTextS ?? "?"} s · done ${seconds()} s · ${usage.outputTokens ?? "?"} tokens written, ${usage.thinkingTokens ?? 0} thinking · finish ${usage.finishReason ?? "cut off"}${usage.padded ? " · kept sending after the reply was complete" : ""}`,
      );
      if (text) return { text, usage };
      throw new Error(`empty reply (finish reason: ${usage.finishReason ?? "unknown"})`);
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).message.startsWith("empty reply")) throw e;
      if (controller.signal.aborted) {
        const where = usage.firstTextS === undefined
          ? "the model accepted the request but sent nothing back (queued, or still thinking)"
          : `the reply started after ${usage.firstTextS} s but was not finished (${text.length.toLocaleString("en-KE")} characters so far)`;
        console.log(`[${label}] gave up after ${limit / 1000} s: ${where}`);
        throw new Error(`no complete reply within ${limit / 1000} s: ${where}`);
      }
      throw new Error(`could not reach the model (${(e as Error).message})`);
    }
  }
  throw new Error(lastError);
}
