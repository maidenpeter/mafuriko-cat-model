import { describe, expect, it } from "vitest";
import { annualChance, axisTicks, EP_HELP, insuredValueFlag, isPlaceholder, kes1, pct1, PLACEHOLDER_BADGE, PLACEHOLDER_RATE_LINE, rpLabel, rpWithChance, SOURCE_KINDS, SOURCE_LABELS, wrapLabel } from "../src/lib/labels";

describe("return period labels", () => {
  it("writes a return period as 1-in-N", () => {
    expect(rpLabel(100)).toBe("1-in-100");
    expect(rpLabel(10)).toBe("1-in-10");
    expect(rpLabel(1000)).toBe("1-in-1000");
    expect(rpLabel(2.5)).toBe("1-in-2.5");
  });
  it("gives the annual chance with sensible decimals", () => {
    expect(annualChance(100)).toBe("1% a year");
    expect(annualChance(250)).toBe("0.4% a year");
    expect(annualChance(10)).toBe("10% a year");
    expect(annualChance(8)).toBe("12.5% a year");
    expect(annualChance(2)).toBe("50% a year");
    expect(annualChance(5)).toBe("20% a year");
    expect(annualChance(25)).toBe("4% a year");
    expect(annualChance(50)).toBe("2% a year");
    expect(annualChance(200)).toBe("0.5% a year");
    expect(annualChance(500)).toBe("0.2% a year");
    expect(annualChance(1000)).toBe("0.1% a year");
    expect(annualChance(3)).toBe("33.3% a year");
    expect(annualChance(1)).toBe("100% a year");
  });
  it("never rounds a very long return period down to no chance at all", () => {
    expect(annualChance(10_000)).toBe("0.01% a year");
    expect(annualChance(1500)).toBe("0.07% a year");
    expect(annualChance(2000)).toBe("0.05% a year");
  });
  it("puts the two side by side", () => {
    expect(rpWithChance(100)).toBe("1-in-100 (1% a year)");
    expect(rpWithChance(250)).toBe("1-in-250 (0.4% a year)");
  });
  it("answers n/a for a return period that is not a positive number", () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(rpLabel(bad)).toBe("n/a");
      expect(annualChance(bad)).toBe("n/a");
      expect(rpWithChance(bad)).toBe("n/a");
    }
  });
});

describe("shillings with one decimal", () => {
  it("scales to billions, millions and thousands", () => {
    expect(kes1(4_200_000_000)).toBe("KES 4.2bn");
    expect(kes1(63_635_075_000)).toBe("KES 63.6bn");
    expect(kes1(213_900_000)).toBe("KES 213.9m");
    expect(kes1(1_000_000)).toBe("KES 1.0m");
    expect(kes1(50_000)).toBe("KES 50.0k");
    expect(kes1(1000)).toBe("KES 1.0k");
  });
  it("keeps whole shillings below a thousand", () => {
    expect(kes1(950)).toBe("KES 950");
    expect(kes1(0)).toBe("KES 0");
    expect(kes1(12.4)).toBe("KES 12");
  });
  it("moves up a unit when rounding would print a thousand of the smaller one", () => {
    expect(kes1(999.6)).toBe("KES 1.0k");
    expect(kes1(999_960)).toBe("KES 1.0m");
    expect(kes1(999_960_000)).toBe("KES 1.0bn");
    expect(kes1(999_940_000)).toBe("KES 999.9m");
    expect(kes1(2_500_000_000_000)).toBe("KES 2500.0bn");
  });
  it("puts a minus sign in front of a negative amount", () => {
    expect(kes1(-4_200_000_000)).toBe("-KES 4.2bn");
    expect(kes1(-213_900_000)).toBe("-KES 213.9m");
    expect(kes1(-50_000)).toBe("-KES 50.0k");
    expect(kes1(-950)).toBe("-KES 950");
    expect(kes1(-0.2)).toBe("KES 0");
    expect(kes1(-0)).toBe("KES 0");
  });
  it("answers n/a when there is no amount", () => {
    expect(kes1(null)).toBe("n/a");
    expect(kes1(undefined)).toBe("n/a");
    expect(kes1(NaN)).toBe("n/a");
    expect(kes1(Infinity)).toBe("n/a");
  });
});

describe("percentages with one decimal", () => {
  it("takes a fraction and always shows one decimal", () => {
    expect(pct1(0.125)).toBe("12.5%");
    expect(pct1(0.0606)).toBe("6.1%");
    expect(pct1(1)).toBe("100.0%");
    expect(pct1(0)).toBe("0.0%");
    expect(pct1(-0.25)).toBe("-25.0%");
    expect(pct1(-0.0001)).toBe("0.0%");
  });
  it("answers n/a when there is no fraction", () => {
    expect(pct1(null)).toBe("n/a");
    expect(pct1(undefined)).toBe("n/a");
    expect(pct1(NaN)).toBe("n/a");
  });
});

describe("source badges and help text", () => {
  it("has exactly four kinds with the agreed words", () => {
    expect(SOURCE_KINDS).toEqual(["real", "synthetic", "assumption", "ai"]);
    expect(SOURCE_LABELS).toEqual({ real: "Real data", synthetic: "Synthetic", assumption: "Assumption", ai: "AI" });
  });
  it("carries the exceedance curve help sentence word for word", () => {
    expect(EP_HELP).toBe("Read across from a return period to the loss: a 1-in-100 loss has about a 1% chance of being exceeded in any year.");
  });
});

describe("axis ticks", () => {
  it("starts at zero and ends at or above the largest value", () => {
    expect(axisTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(axisTicks(4_200_000_000)).toEqual([0, 2e9, 4e9, 6e9]);
    expect(axisTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const ticks = axisTicks(0.37);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(0.37);
  });
  it("keeps the tick values free of floating point noise", () => {
    expect(axisTicks(0.6)).toEqual([0, 0.2, 0.4, 0.6]);
  });
  it("falls back to a unit axis when there is nothing to show", () => {
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(-3)).toEqual([0, 1]);
    expect(axisTicks(NaN)).toEqual([0, 1]);
  });
});

describe("wrapping labels for SVG", () => {
  it("leaves a short label on one line", () => {
    expect(wrapLabel("Permanent", 12)).toEqual(["Permanent"]);
  });
  it("breaks at spaces", () => {
    expect(wrapLabel("Minus excess of loss", 12, 3)).toEqual(["Minus excess", "of loss"]);
    expect(wrapLabel("Informal settlement", 10)).toEqual(["Informal", "settlement"]);
  });
  it("ends in an ellipsis when the label does not fit in the lines allowed", () => {
    expect(wrapLabel("Informal settlement housing stock", 10)).toEqual(["Informal", "settlemen…"]);
    expect(wrapLabel("Semi permanent housing", 14, 1)).toEqual(["Semi permanen…"]);
    for (const line of wrapLabel("Informal settlement housing stock", 10)) expect(line.length).toBeLessThanOrEqual(10);
  });
  it("cuts a single word that is longer than a line", () => {
    expect(wrapLabel("Supercalifragilistic", 8, 3)).toEqual(["Supercal", "ifragili", "stic"]);
  });
  it("copes with an empty label and a silly width", () => {
    expect(wrapLabel("", 10)).toEqual([""]);
    expect(wrapLabel("ab", 0)).toEqual(["a", "b"]);
  });
});

describe("the two placeholders and the insured value flag", () => {
  it("badges the cost of capital and the minimum rate, and nothing else", () => {
    expect(PLACEHOLDER_BADGE).toBe("Assumption, to be set by Kenya Re underwriting");
    expect(isPlaceholder("costOfCapital")).toBe(true);
    expect(isPlaceholder("minimumRatePerMille")).toBe(true);
    expect(isPlaceholder("bufferRadiusM")).toBe(false);
    expect(PLACEHOLDER_RATE_LINE).toContain("to be set by Kenya Re underwriting");
    expect(`${PLACEHOLDER_BADGE} ${PLACEHOLDER_RATE_LINE}`).not.toMatch(/market|going rate/i);
  });

  it("flags insured values that are a multiple of their formula, and only then", () => {
    const flag = insuredValueFlag(10);
    expect(flag?.short).toBe("10 times the documented formula");
    expect(flag?.full).toBe("Insured values are as written in the exposure file: 10 times the documented formula.");
    expect(flag?.where).toContain("Read the data");
    expect(insuredValueFlag(9.96)?.short).toBe("10 times the documented formula");
    expect(insuredValueFlag(1)).toBeNull();
    expect(insuredValueFlag(1.04)).toBeNull();
    expect(insuredValueFlag(null)).toBeNull();
    expect(insuredValueFlag(undefined)).toBeNull();
    expect(insuredValueFlag(Number.NaN)).toBeNull();
  });
});
