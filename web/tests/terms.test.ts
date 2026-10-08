import { describe, expect, it } from "vitest";
import { termsChecks } from "../src/lib/checks/terms";
import { averageAnnualLoss } from "../src/lib/model/financial";
import { applyTerms, DEFAULT_TERMS, policyLoss, sanitiseTerms, xolRecovery, type InsuranceTerms } from "../src/lib/model/terms";
import type { Dataset, ModelResult } from "../src/lib/model/types";

// A hand-made result: two buildings, three events. Only the fields the terms read are filled in.
const TIVS = [10_000_000, 2_000_000];
const LOSSES = [
  [0, 1_000_000, 4_000_000], // building 0 at 1-in-10, 1-in-50, 1-in-250
  [30_000, 500_000, 2_000_000], // building 1
];
const RPS = [10, 50, 250];
const dataset = { buildings: TIVS.map((tivKes) => ({ tivKes })) } as unknown as Pick<Dataset, "buildings">;
const result = {
  scenarios: RPS.map((returnPeriod, k) => ({ id: `s${k}`, returnPeriod, lossKes: LOSSES[0][k] + LOSSES[1][k] })),
  buildings: LOSSES.map((row, i) => ({ locId: `b${i}`, perScenario: row.map((lossKes) => ({ lossKes })) })),
} as unknown as ModelResult;

describe("policy terms for one building", () => {
  const terms = { deductibleShare: 0.02, deductibleMinKes: 50_000, limitShare: 1 };

  it("takes 2% of the insured value off the loss", () => {
    expect(policyLoss(1_000_000, 10_000_000, terms)).toEqual({ deductibleKes: 200_000, overLimitKes: 0, grossKes: 800_000 });
  });

  it("uses the KES minimum when 2% of the insured value is smaller", () => {
    expect(policyLoss(500_000, 2_000_000, terms)).toEqual({ deductibleKes: 50_000, overLimitKes: 0, grossKes: 450_000 });
  });

  it("pays nothing, and never a negative amount, when the loss is inside the deductible", () => {
    expect(policyLoss(30_000, 2_000_000, terms)).toEqual({ deductibleKes: 30_000, overLimitKes: 0, grossKes: 0 });
  });

  it("charges no deductible when there is no loss", () => {
    expect(policyLoss(0, 10_000_000, terms)).toEqual({ deductibleKes: 0, overLimitKes: 0, grossKes: 0 });
  });

  it("caps the payment at the limit and says how much was over it", () => {
    const p = policyLoss(9_000_000, 10_000_000, { ...terms, limitShare: 0.5 });
    expect(p).toEqual({ deductibleKes: 200_000, overLimitKes: 3_800_000, grossKes: 5_000_000 });
    expect(p.deductibleKes + p.overLimitKes + p.grossKes).toBe(9_000_000);
  });
});

describe("terms on a portfolio", () => {
  const t = applyTerms(dataset, result, DEFAULT_TERMS);

  it("sums building gross losses event by event", () => {
    // 1-in-10: building 0 has no loss, building 1's 30,000 is inside its 50,000 deductible.
    expect(t.scenarios[0]).toMatchObject({ groundUpKes: 30_000, deductiblesKes: 30_000, grossKes: 0 });
    // 1-in-50: 1,000,000 - 200,000 and 500,000 - 50,000.
    expect(t.scenarios[1]).toMatchObject({ groundUpKes: 1_500_000, deductiblesKes: 250_000, grossKes: 1_250_000 });
    // 1-in-250: 4,000,000 - 200,000 and 2,000,000 - 50,000 (capped at the 2,000,000 limit: not binding).
    expect(t.scenarios[2]).toMatchObject({ groundUpKes: 6_000_000, grossKes: 5_750_000 });
    expect(t.buildingGrossKes).toEqual([
      [0, 800_000, 3_800_000],
      [0, 450_000, 1_950_000],
    ]);
  });

  it("cedes a quarter of every gross loss to the quota share", () => {
    expect(t.scenarios.map((r) => r.quotaShareKes)).toEqual([0, 312_500, 1_437_500]);
    expect(t.scenarios.map((r) => r.retainedKes)).toEqual([0, 937_500, 4_312_500]);
  });

  it("sets the default excess of loss from the retained 1-in-10 and 1-in-250 losses", () => {
    expect(t.xol).toEqual({ attachmentKes: 0, limitKes: 4_312_500, attachmentIsDefault: true, limitIsDefault: true });
  });

  it("applies a typed excess of loss per event, after the quota share", () => {
    const typed = applyTerms(dataset, result, { ...DEFAULT_TERMS, xolAttachmentKes: 500_000, xolLimitKes: 3_000_000 });
    expect(typed.xol).toMatchObject({ attachmentKes: 500_000, limitKes: 3_000_000, attachmentIsDefault: false, limitIsDefault: false });
    expect(typed.scenarios.map((r) => r.xolKes)).toEqual([0, 437_500, 3_000_000]);
    expect(typed.scenarios.map((r) => r.netKes)).toEqual([0, 500_000, 1_312_500]);
  });

  it("gives an average annual loss for each of the three curves, from the same method as the model", () => {
    const typed = applyTerms(dataset, result, { ...DEFAULT_TERMS, xolAttachmentKes: 500_000, xolLimitKes: 3_000_000 });
    const aal = (pick: (i: number) => number) => averageAnnualLoss(RPS.map((returnPeriod, i) => ({ returnPeriod, lossKes: pick(i) })));
    expect(typed.aal.groundUpKes).toBeCloseTo(aal((i) => typed.scenarios[i].groundUpKes), 6);
    expect(typed.aal.grossKes).toBeCloseTo(aal((i) => typed.scenarios[i].grossKes), 6);
    expect(typed.aal.netKes).toBeCloseTo(aal((i) => typed.scenarios[i].netKes), 6);
    expect(typed.aal.netKes).toBeLessThan(typed.aal.grossKes);
    expect(typed.aal.grossKes).toBeLessThan(typed.aal.groundUpKes);
  });

  it("reads all three curves at the standard return periods", () => {
    expect(t.standard.map((s) => s.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    expect(t.standard[0]).toMatchObject({ groundUpKes: 30_000, grossKes: 0, netKes: 0 });
    expect(t.standard[2]).toMatchObject({ groundUpKes: 1_500_000, grossKes: 1_250_000 });
    for (const s of t.standard) {
      expect(s.grossKes!).toBeLessThanOrEqual(s.groundUpKes!);
      expect(s.netKes!).toBeLessThanOrEqual(s.grossKes!);
    }
  });

  it("with no deductible, full limit and no reinsurance, leaves the loss as it was", () => {
    const none: InsuranceTerms = { deductibleShare: 0, deductibleMinKes: 0, limitShare: 1, quotaShareCeded: 0, xolAttachmentKes: 0, xolLimitKes: 0 };
    const plain = applyTerms(dataset, result, none);
    expect(plain.scenarios.map((r) => r.netKes)).toEqual(plain.scenarios.map((r) => r.groundUpKes));
    expect(plain.aal.netKes).toBeCloseTo(plain.aal.groundUpKes, 6);
  });

  it("keeps edited terms inside what makes sense", () => {
    expect(sanitiseTerms({ deductibleShare: -1, deductibleMinKes: -5, limitShare: 3, quotaShareCeded: Number.NaN, xolAttachmentKes: -10, xolLimitKes: null })).toEqual({
      deductibleShare: 0, deductibleMinKes: 0, limitShare: 1, quotaShareCeded: 0, xolAttachmentKes: 0, xolLimitKes: null,
    });
  });

  it("pays an excess of loss only above the attachment and never more than the limit", () => {
    expect(xolRecovery(400, 500, 1000)).toBe(0);
    expect(xolRecovery(900, 500, 1000)).toBe(400);
    expect(xolRecovery(5000, 500, 1000)).toBe(1000);
  });
});

describe("checks on the terms", () => {
  const good = applyTerms(dataset, result, { ...DEFAULT_TERMS, xolAttachmentKes: 500_000, xolLimitKes: 3_000_000 });

  it("pass on a result the engine produced", () => {
    const checks = termsChecks(good);
    expect(checks.map((c) => c.id)).toEqual(["gross-le-ground-up", "net-le-gross", "recoveries-reconcile", "aal-order"]);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("fail when a figure has been tampered with", () => {
    const status = (rows: typeof good.scenarios) => Object.fromEntries(termsChecks({ ...good, scenarios: rows }).map((c) => [c.id, c.status]));
    const bump = (field: "grossKes" | "netKes" | "xolKes", by: number) => good.scenarios.map((r, i) => (i === 2 ? { ...r, [field]: r[field] + by } : r));
    expect(status(bump("grossKes", 10_000_000))["gross-le-ground-up"]).toBe("fail");
    expect(status(bump("netKes", 10_000_000))["net-le-gross"]).toBe("fail");
    expect(status(bump("xolKes", 1))["recoveries-reconcile"]).toBe("fail");
  });
});
