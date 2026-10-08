import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { keyFor, keySettings, modelName, providerName } from "../src/lib/agents/provider";

const SETTINGS = ["AGENT_PROVIDER", "OPENAI_API_KEY", "OPENAI_API_KEY_CRITIC", "OPENAI_MODEL", "GEMINI_API_KEY", "GEMINI_API_KEY_CRITIC", "GEMINI_MODEL"];
const before = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of SETTINGS) delete process.env[name];
});
afterAll(() => {
  for (const name of SETTINGS) {
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  }
});

describe("which service runs the agents", () => {
  it("is Gemini when nothing says otherwise", () => {
    expect(providerName()).toBe("gemini");
    expect(modelName()).toBe("gemini-3.8-flash");
    expect(keyFor("critic")).toBeNull();
    expect(keySettings("critic")).toBe("GEMINI_API_KEY_CRITIC or GEMINI_API_KEY");
  });

  it("is OpenAI once an OpenAI key is set", () => {
    process.env.OPENAI_API_KEY = "one-key";
    process.env.GEMINI_API_KEY = "another";
    expect(providerName()).toBe("openai");
    expect(modelName()).toBe("gpt-6-luna");
    // One key serves every agent.
    expect(keyFor("optimist")).toBe("one-key");
    expect(keyFor("chair")).toBe("one-key");
    expect(keySettings("chair")).toBe("OPENAI_API_KEY_CHAIR or OPENAI_API_KEY");
  });

  it("follows AGENT_PROVIDER when it is set, whichever keys exist", () => {
    process.env.OPENAI_API_KEY = "one-key";
    process.env.GEMINI_API_KEY_CRITIC = "critic-key";
    process.env.AGENT_PROVIDER = " Gemini ";
    expect(providerName()).toBe("gemini");
    expect(keyFor("critic")).toBe("critic-key");
    expect(keyFor("chair")).toBeNull();

    process.env.AGENT_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    expect(providerName()).toBe("openai");
    expect(keyFor("critic")).toBeNull();
  });

  it("ignores a value it does not know", () => {
    process.env.AGENT_PROVIDER = "mistral";
    expect(providerName()).toBe("gemini");
  });

  it("takes the model name from the service in use", () => {
    process.env.OPENAI_MODEL = "gpt-6.1-sol";
    process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
    process.env.AGENT_PROVIDER = "openai";
    expect(modelName()).toBe("gpt-6.1-sol");
    process.env.AGENT_PROVIDER = "gemini";
    expect(modelName()).toBe("gemini-3.5-flash-lite");
  });

  it("lets one agent have its own key", () => {
    process.env.AGENT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "shared";
    process.env.OPENAI_API_KEY_CRITIC = "critics-own";
    expect(keyFor("critic")).toBe("critics-own");
    expect(keyFor("optimist")).toBe("shared");
  });
});
