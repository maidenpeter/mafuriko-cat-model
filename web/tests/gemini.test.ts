import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateJson } from "../src/lib/agents/gemini";

// A local stand-in for the Gemini streaming endpoint. No real model is called.
let server: Server;
let requests = 0;
let handler: (res: ServerResponse, n: number) => void;

const event = (text: string, extra: object = {}) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...extra }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 } })}\n\n`;
const sse = (res: ServerResponse) => res.writeHead(200, { "content-type": "text/event-stream" });

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(res, ++requests));
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.GEMINI_BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  delete process.env.GEMINI_BASE_URL;
  delete process.env.GEMINI_TIMEOUT_S;
});
beforeEach(() => {
  requests = 0;
  delete process.env.GEMINI_TIMEOUT_S;
});

describe("model call", () => {
  it("joins a reply that arrives in pieces, including braces inside strings", async () => {
    handler = (res) => {
      sse(res);
      res.write(event('{"summary": "a } b \\" c", '));
      res.write(event('"n": {"value": 1}}', { finishReason: "STOP" }));
      res.end();
    };
    const out = await generateJson("k", "s", "u", {});
    expect(JSON.parse(out.text)).toEqual({ summary: 'a } b " c', n: { value: 1 } });
    expect(out.usage.finishReason).toBe("STOP");
    expect(out.usage.outputTokens).toBe(5);
    expect(out.usage.padded).toBeUndefined();
  });

  it("stops listening when the model pads a finished reply with whitespace", async () => {
    let padding: ReturnType<typeof setInterval>;
    handler = (res) => {
      sse(res);
      res.write(event('{"ok": true}\n\n'));
      padding = setInterval(() => res.write(event("\n\n\n\n")), 100);
      res.on("close", () => clearInterval(padding));
    };
    const started = Date.now();
    const out = await generateJson("k", "s", "u", {});
    expect(JSON.parse(out.text)).toEqual({ ok: true });
    expect(out.usage.padded).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  it("does not retry a quota error", async () => {
    handler = (res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Quota exceeded" } }));
    };
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/quota or rate limit.*Quota exceeded/);
    expect(requests).toBe(1);
  });

  it("retries once when the service is overloaded", async () => {
    handler = (res, n) => {
      if (n === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "overloaded" } }));
        return;
      }
      sse(res);
      res.end(event('{"ok": 1}', { finishReason: "STOP" }));
    };
    expect(JSON.parse((await generateJson("k", "s", "u", {})).text)).toEqual({ ok: 1 });
    expect(requests).toBe(2);
  }, 10_000);

  it("says where the time went when nothing comes back", async () => {
    process.env.GEMINI_TIMEOUT_S = "1";
    handler = (res) => sse(res); // accepts the request, then stays silent
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/within 1 s: the model accepted the request but sent nothing/);
  }, 10_000);

  it("says how far a slow reply got", async () => {
    process.env.GEMINI_TIMEOUT_S = "1";
    handler = (res) => {
      sse(res);
      res.write(event('{"summary": "half'));
    };
    await expect(generateJson("k", "s", "u", {})).rejects.toThrow(/reply started after .* s but was not finished \(17 characters so far\)/);
  }, 10_000);
});
