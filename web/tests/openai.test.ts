import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateJson, strictSchema } from "../src/lib/agents/openai";
import { RESPONSE_SCHEMAS } from "../src/lib/agents/responseSchema";
import { PARAMETER_NAMES } from "../src/lib/agents/schema";

// A local stand-in for OpenAI's chat completions endpoint. No real model is called.
type Sent = { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
let server: Server;
let sent: Sent[] = [];
let handler: (res: ServerResponse, n: number) => void;

const json = (res: ServerResponse, status: number, payload: object) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
const reply = (content: string | null, extra: { finish?: string; refusal?: string } = {}) => ({
  choices: [{ finish_reason: extra.finish ?? "stop", message: { role: "assistant", content, refusal: extra.refusal ?? null } }],
  usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } },
});
const rejected = (message: string, param: string | null = null) => ({ error: { message, type: "invalid_request_error", param } });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      sent.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(body) });
      handler(res, sent.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.OPENAI_BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  for (const name of ["OPENAI_BASE_URL", "OPENAI_TIMEOUT_S", "OPENAI_MODEL", "OPENAI_REASONING_EFFORT"]) delete process.env[name];
});
beforeEach(() => {
  sent = [];
  for (const name of ["OPENAI_TIMEOUT_S", "OPENAI_MODEL", "OPENAI_REASONING_EFFORT"]) delete process.env[name];
});

describe("reply shape for OpenAI", () => {
  it("is the same shape in plain JSON Schema, with every object closed", () => {
    const schema = strictSchema(RESPONSE_SCHEMAS.chair) as { type: string; required: string[]; additionalProperties: boolean; properties: Record<string, { type: string; minItems?: number; maxItems?: number; items: { type: string; additionalProperties: boolean; required: string[]; properties: Record<string, { type: string; enum?: string[] }> } }> };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["summary", "parameters", "responses"]);
    const { parameters, responses } = schema.properties;
    expect(parameters).toMatchObject({ type: "array", minItems: 14, maxItems: 14 });
    expect(parameters.items.additionalProperties).toBe(false);
    // The reason comes before the value, so the number follows from the argument.
    expect(Object.keys(parameters.items.properties)).toEqual(["name", "reason", "basis", "leans", "value"]);
    expect(parameters.items.required).toEqual(["name", "reason", "basis", "leans", "value"]);
    expect(parameters.items.properties.name).toEqual({ type: "string", enum: PARAMETER_NAMES });
    expect(parameters.items.properties.value).toEqual({ type: "number" });
    expect(responses.items.additionalProperties).toBe(false);
  });

  it("leaves nothing in Gemini's spelling, for any agent", () => {
    for (const schema of Object.values(RESPONSE_SCHEMAS)) {
      const text = JSON.stringify(strictSchema(schema));
      expect(text).not.toMatch(/propertyOrdering|"(OBJECT|ARRAY|STRING|NUMBER)"/);
    }
  });
});

describe("OpenAI call", () => {
  it("sends the prompt, the key and the enforced shape, and reads the reply", async () => {
    handler = (res) => json(res, 200, reply('{"stance": "s"}'));
    const out = await generateJson("test-key", "the instructions", "the input", RESPONSE_SCHEMAS.optimist);
    expect(out.text).toBe('{"stance": "s"}');
    // Reasoning is counted inside the completion, and shown apart from what was written.
    expect(out.usage).toEqual({ promptTokens: 100, outputTokens: 30, thinkingTokens: 20, finishReason: "stop" });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/v1/chat/completions");
    expect(sent[0].headers.authorization).toBe("Bearer test-key");
    const { body } = sent[0];
    expect(body.model).toBe("gpt-6-luna");
    expect(body.messages).toEqual([
      { role: "developer", content: "the instructions" },
      { role: "user", content: "the input" },
    ]);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "reply", strict: true, schema: strictSchema(RESPONSE_SCHEMAS.optimist) } });
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBeGreaterThan(10_000);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("stream");
  });

  it("uses the model and the effort level set in the environment", async () => {
    process.env.OPENAI_MODEL = "gpt-6.1-sol";
    process.env.OPENAI_REASONING_EFFORT = "medium";
    handler = (res) => json(res, 200, reply("{}"));
    await generateJson("k", "s", "u", {});
    expect(sent[0].body).toMatchObject({ model: "gpt-6.1-sol", reasoning_effort: "medium" });
  });

  it("gives an older model a temperature instead of an effort level, and system instructions", async () => {
    process.env.OPENAI_MODEL = "gpt-4.1-mini";
    handler = (res) => json(res, 200, reply("{}"));
    await generateJson("k", "s", "u", {});
    expect(sent[0].body.temperature).toBe(0);
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");
    expect((sent[0].body.messages as { role: string }[])[0].role).toBe("system");
  });

  it("sends the instructions under the older name when a model asks for that", async () => {
    handler = (res, n) => (n === 1 ? json(res, 400, rejected("Unsupported value: 'messages[0].role' does not support 'developer' with this model.", "messages[0].role")) : json(res, 200, reply('{"ok": 1}')));
    expect((await generateJson("k", "the instructions", "u", {})).text).toBe('{"ok": 1}');
    expect(sent).toHaveLength(2);
    expect((sent[1].body.messages as object[])[0]).toEqual({ role: "system", content: "the instructions" });
  });

  it("does not retry a quota error", async () => {
    handler = (res) => json(res, 429, rejected("You exceeded your current quota, please check your plan and billing details."));
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/quota or rate limit reached for this key \(429\)\. You exceeded your current quota/);
    expect(sent).toHaveLength(1);
  });

  it("retries once when the service is overloaded", async () => {
    handler = (res, n) => (n === 1 ? json(res, 503, rejected("The server is overloaded")) : json(res, 200, reply('{"ok": 1}')));
    expect((await generateJson("k", "s", "u", {})).text).toBe('{"ok": 1}');
    expect(sent).toHaveLength(2);
  }, 10_000);

  it("gives up after the one retry", async () => {
    handler = (res) => json(res, 500, rejected("The server had an error"));
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/500 The server had an error/);
    expect(sent).toHaveLength(2);
  }, 10_000);

  it("sends the call again without a setting the model does not take", async () => {
    handler = (res, n) => (n === 1 ? json(res, 400, rejected("Unsupported parameter: 'reasoning_effort' is not supported with this model.", "reasoning_effort")) : json(res, 200, reply('{"ok": 1}')));
    expect((await generateJson("k", "s", "u", {})).text).toBe('{"ok": 1}');
    expect(sent).toHaveLength(2);
    expect(sent[0].body.reasoning_effort).toBe("low");
    expect(sent[1].body).not.toHaveProperty("reasoning_effort");
    expect(sent[1].body.response_format).toEqual(sent[0].body.response_format);
  });

  it("falls back to plain JSON when the model does not take the enforced shape", async () => {
    handler = (res, n) => (n === 1 ? json(res, 400, rejected("Invalid schema for response_format 'reply'.", "response_format")) : json(res, 200, reply('{"ok": 1}')));
    expect((await generateJson("k", "s", "u", {})).text).toBe('{"ok": 1}');
    expect(sent[1].body.response_format).toEqual({ type: "json_object" });
  });

  it("stops at a rejection it cannot work around, and keeps keys out of the message", async () => {
    handler = (res) => json(res, 401, rejected("Incorrect API key provided: sk-proj-abc*****************xyz9. You can find your API key at the dashboard."));
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow("401 Incorrect API key provided: sk-…. You can find your API key at the dashboard.");
    expect(sent).toHaveLength(1);
    handler = (res) => json(res, 400, rejected("This model's maximum context length was exceeded.", "messages"));
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/400 This model's maximum context length/);
    expect(sent).toHaveLength(2);
  });

  it("reports a refusal as a refusal", async () => {
    handler = (res) => json(res, 200, reply(null, { refusal: "I cannot help with that." }));
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow("the model declined to answer: I cannot help with that.");
  });

  it("says so when reasoning used up the whole output limit", async () => {
    handler = (res) => json(res, 200, reply("", { finish: "length" }));
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow("the reply hit the output limit before any of it was written");
  });

  it("hands back a reply that ran out of room, with the reason, so the route can ask again", async () => {
    handler = (res) => json(res, 200, reply('{"stance": "half', { finish: "length" }));
    const out = await generateJson("k", "s", "u", {});
    expect(out.text).toBe('{"stance": "half');
    expect(out.usage.finishReason).toBe("length");
  });

  it("gives up when nothing comes back in time", async () => {
    process.env.OPENAI_TIMEOUT_S = "1";
    handler = () => {}; // accepts the request, then stays silent
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/no reply within 1 s: the request was sent/);
  }, 10_000);

  it("says when the service cannot be reached at all", async () => {
    const url = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9"; // nothing listens here
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/could not reach the model/);
    process.env.OPENAI_BASE_URL = url;
  }, 10_000);
});
