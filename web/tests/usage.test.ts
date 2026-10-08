import { describe, expect, it } from "vitest";
import type { AgentRun, Deliberation } from "../src/lib/agents/orchestrate";
import { costOf, fmtUsd, pricesFromEnv, usageRows, usageTotals } from "../src/lib/agents/usage";

// Made-up runs. No model is called.
const runs: Deliberation["runs"] = {
  optimist: { role: "optimist", status: "done", model: "model-a", ms: 4200, attempts: 1, usage: { promptTokens: 1000, outputTokens: 400, thinkingTokens: 100, finishReason: "stop" } },
  cautious: { role: "cautious", status: "done", model: "model-a", ms: 5300, attempts: 2, usage: { promptTokens: 1100, outputTokens: 500 } },
  // Failed before any reply: no usage at all.
  critic: { role: "critic", status: "error", model: "model-a", ms: 800, error: "503 overloaded" },
  chair: { role: "chair", status: "done", model: "model-b", ms: 9000, attempts: 1, usage: { promptTokens: 3000, outputTokens: 900, thinkingTokens: 600 } },
};

describe("usage rows", () => {
  it("gives one row per agent, in order, with its label, model, tokens and seconds", () => {
    const rows = usageRows(runs);
    expect(rows.map((r) => r.role)).toEqual(["optimist", "cautious", "critic", "chair"]);
    expect(rows[0]).toEqual({ role: "optimist", label: "Optimist", model: "model-a", inputTokens: 1000, outputTokens: 400, thinkingTokens: 100, seconds: 4.2, attempts: 1 });
    expect(rows[3]).toMatchObject({ label: "Chair", model: "model-b", inputTokens: 3000, outputTokens: 900, thinkingTokens: 600, seconds: 9 });
  });

  it("leaves a count that was not reported as null, never zero", () => {
    const rows = usageRows(runs);
    expect(rows[1]).toMatchObject({ inputTokens: 1100, outputTokens: 500, thinkingTokens: null, attempts: 2 });
    expect(rows[2]).toEqual({ role: "critic", label: "Critic", model: "model-a", inputTokens: null, outputTokens: null, thinkingTokens: null, seconds: 0.8, attempts: null });
  });

  it("takes a plain list, and a run that is not one of the four agents", () => {
    const idle: AgentRun = { role: "chair", status: "idle" };
    const rows = usageRows([idle, { role: "reader", label: "Offer reader", model: null, ms: null, usage: null }, { role: "other", usage: { promptTokens: Number.NaN, outputTokens: -5 } }]);
    expect(rows[0]).toEqual({ role: "chair", label: "Chair", model: null, inputTokens: null, outputTokens: null, thinkingTokens: null, seconds: null, attempts: null });
    expect(rows[1]).toMatchObject({ role: "reader", label: "Offer reader", model: null, seconds: null });
    // No label given: the role stands in. Counts that are not real counts are dropped.
    expect(rows[2]).toMatchObject({ label: "other", inputTokens: null, outputTokens: null });
  });
});

describe("usage totals", () => {
  it("adds the rows up and says how many reported nothing or were asked twice", () => {
    const totals = usageTotals(usageRows(runs));
    expect(totals).toMatchObject({ agents: 4, reported: 3, unreported: 1, retried: 1, models: ["model-a", "model-b"], inputTokens: 5100, outputTokens: 1800, thinkingTokens: 700 });
    expect(totals.seconds).toBeCloseTo(19.3, 6);
  });

  it("is all zeros for no rows", () => {
    expect(usageTotals([])).toEqual({ agents: 0, reported: 0, unreported: 0, retried: 0, models: [], inputTokens: 0, outputTokens: 0, thinkingTokens: 0, seconds: 0 });
  });
});

describe("prices from the settings", () => {
  it("reads both prices for the provider named", () => {
    const env = { OPENAI_PRICE_IN_PER_M: "0.25", OPENAI_PRICE_OUT_PER_M: " 2 ", GEMINI_PRICE_IN_PER_M: "0.1", GEMINI_PRICE_OUT_PER_M: "0.4" };
    expect(pricesFromEnv(env, "openai")).toEqual({ inPerM: 0.25, outPerM: 2 });
    expect(pricesFromEnv(env, "gemini")).toEqual({ inPerM: 0.1, outPerM: 0.4 });
  });

  it("is null when they are missing or empty", () => {
    expect(pricesFromEnv({}, "openai")).toBeNull();
    expect(pricesFromEnv({ OPENAI_PRICE_IN_PER_M: "", OPENAI_PRICE_OUT_PER_M: "  " }, "openai")).toBeNull();
    // The other provider's prices are not borrowed.
    expect(pricesFromEnv({ GEMINI_PRICE_IN_PER_M: "0.1", GEMINI_PRICE_OUT_PER_M: "0.4" }, "openai")).toBeNull();
    expect(pricesFromEnv({ _PRICE_IN_PER_M: "1", _PRICE_OUT_PER_M: "1" }, "")).toBeNull();
  });

  it("is null when only one of the two is set", () => {
    expect(pricesFromEnv({ OPENAI_PRICE_IN_PER_M: "0.25" }, "openai")).toBeNull();
    expect(pricesFromEnv({ OPENAI_PRICE_OUT_PER_M: "2" }, "openai")).toBeNull();
  });

  it("is null when either is zero or negative", () => {
    expect(pricesFromEnv({ OPENAI_PRICE_IN_PER_M: "0", OPENAI_PRICE_OUT_PER_M: "2" }, "openai")).toBeNull();
    expect(pricesFromEnv({ OPENAI_PRICE_IN_PER_M: "0.25", OPENAI_PRICE_OUT_PER_M: "0.0" }, "openai")).toBeNull();
    expect(pricesFromEnv({ OPENAI_PRICE_IN_PER_M: "-1", OPENAI_PRICE_OUT_PER_M: "2" }, "openai")).toBeNull();
  });

  it("is null when either is not a plain number", () => {
    for (const bad of ["abc", "$0.25", "0,25", "1e3", "Infinity", "NaN", "0.25 USD", "."]) {
      expect(pricesFromEnv({ OPENAI_PRICE_IN_PER_M: bad, OPENAI_PRICE_OUT_PER_M: "2" }, "openai"), bad).toBeNull();
      expect(pricesFromEnv({ OPENAI_PRICE_IN_PER_M: "0.25", OPENAI_PRICE_OUT_PER_M: bad }, "openai"), bad).toBeNull();
    }
  });
});

describe("cost", () => {
  const prices = { inPerM: 2, outPerM: 10 };
  const rows = usageRows(runs);

  it("charges thinking tokens at the output price", () => {
    // 1000 × 2 + (400 + 100) × 10 = 7000, per million.
    expect(costOf(rows[0], prices)).toBeCloseTo(0.007, 12);
  });

  it("works without thinking tokens", () => {
    // 1100 × 2 + 500 × 10 = 7200, per million.
    expect(costOf(rows[1], prices)).toBeCloseTo(0.0072, 12);
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000, thinkingTokens: 0 }, prices)).toBe(12);
  });

  it("adds up for the totals", () => {
    const totals = usageTotals(rows);
    // 5100 × 2 + (1800 + 700) × 10 = 35200, per million.
    expect(costOf(totals, prices)).toBeCloseTo(0.0352, 12);
    const each = rows.map((r) => costOf(r, prices) ?? 0).reduce((a, b) => a + b, 0);
    expect(costOf(totals, prices)).toBeCloseTo(each, 12);
  });

  it("is null without prices", () => {
    expect(costOf(rows[0], null)).toBeNull();
    expect(costOf(rows[0], undefined)).toBeNull();
    expect(costOf(usageTotals(rows), pricesFromEnv({}, "openai"))).toBeNull();
  });

  it("is null, not zero, when nothing was reported", () => {
    expect(costOf(rows[2], prices)).toBeNull();
    expect(costOf(usageTotals([rows[2]]), prices)).toBeNull();
    expect(costOf(usageTotals([]), prices)).toBeNull();
  });
});

describe("dollar amounts", () => {
  it("keeps four decimals below a dollar and two above", () => {
    expect(fmtUsd(0.0352)).toBe("USD 0.0352");
    expect(fmtUsd(0.5)).toBe("USD 0.5000");
    expect(fmtUsd(12.345)).toBe("USD 12.35");
    expect(fmtUsd(1234.5)).toBe("USD 1,234.50");
    expect(fmtUsd(0)).toBe("USD 0.00");
  });

  it("does not round a small cost down to nothing", () => {
    expect(fmtUsd(0.00001)).toBe("under USD 0.0001");
    expect(fmtUsd(0.00006)).toBe("USD 0.0001");
  });

  it("says n/a when there is no cost", () => {
    expect(fmtUsd(null)).toBe("n/a");
    expect(fmtUsd(undefined)).toBe("n/a");
    expect(fmtUsd(Number.NaN)).toBe("n/a");
  });
});
