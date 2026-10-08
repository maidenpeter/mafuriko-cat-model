import { describe, expect, it } from "vitest";
import type { Check, CheckGroup, CheckStatus } from "../src/lib/checks";
import {
  aalChange,
  chainStatus,
  chainSummary,
  classLossRows,
  hotspotCount,
  layerSteps,
  nearestEventIndex,
  paramChanges,
  shadeLevel,
  signedPct,
  standardAt,
  topWards,
} from "../src/lib/dashboard";
import { applyTerms, DEFAULT_TERMS } from "../src/lib/model/terms";
import type { Dataset, ModelResult, ScenarioResult } from "../src/lib/model/types";

describe("signed percentages", () => {
  it("puts a plus sign on a rise and a minus sign on a fall", () => {
    expect(signedPct(0.125)).toBe("+12.5%");
    expect(signedPct(-0.04)).toBe("-4.0%");
  });

  it("writes a change that rounds to nothing without a sign", () => {
    expect(signedPct(0)).toBe("0.0%");
    expect(signedPct(-0.0001)).toBe("0.0%");
    expect(signedPct(0.0001)).toBe("0.0%");
  });

  it("says n/a when there is no figure", () => {
    expect(signedPct(null)).toBe("n/a");
    expect(signedPct(Number.NaN)).toBe("n/a");
  });
});

describe("the event the page opens on", () => {
  it("picks 1-in-100 when it is modelled", () => {
    expect(nearestEventIndex([10, 25, 50, 100, 250])).toBe(3);
  });

  it("picks the nearest on the log scale when it is not", () => {
    // 80 is nearer 100 than 150 is on a log scale (ratio 1.25 against 1.5).
    expect(nearestEventIndex([5, 20, 80, 150, 400])).toBe(2);
    expect(nearestEventIndex([2, 5])).toBe(1);
  });

  it("gives a tie to the more frequent event and -1 when there are no events", () => {
    expect(nearestEventIndex([50, 200])).toBe(0);
    expect(nearestEventIndex([])).toBe(-1);
  });
});

describe("the standard return period table", () => {
  const standard = [
    { returnPeriod: 10, groundUpKes: 1, grossKes: 1, netKes: 1, extrapolated: false },
    { returnPeriod: 100, groundUpKes: 9, grossKes: 8, netKes: 4, extrapolated: false },
  ];

  it("finds a return period, or null when it is not listed", () => {
    expect(standardAt(standard, 100)?.netKes).toBe(4);
    expect(standardAt(standard, 500)).toBeNull();
  });
});

describe("loss by housing class", () => {
  const cls = (count: number, tivKes: number, lossKes: number, affected = 0) => ({ count, tivKes, lossKes, affected, tivExposedKes: 0 });
  const scenario = {
    byClass: {
      informal_iron_sheet: cls(600, 10_000_000, 4_000_000, 300),
      semi_permanent: cls(250, 30_000_000, 6_000_000, 90),
      permanent_masonry: cls(100, 60_000_000, 0),
      concrete_rcc: cls(50, 100_000_000, 10_000_000, 12),
    },
  } as Pick<ScenarioResult, "byClass">;
  const rows = classLossRows(scenario);

  it("keeps the model's class order and names", () => {
    expect(rows.map((r) => r.label)).toEqual(["Informal (iron sheet)", "Semi-permanent", "Permanent masonry", "Concrete / RCC"]);
  });

  it("works out each class's share of insured value and of the loss", () => {
    expect(rows[0]).toMatchObject({ buildings: 600, affected: 300, tivShare: 0.05, lossShare: 0.2 });
    expect(rows[3]).toMatchObject({ tivShare: 0.5, lossShare: 0.5 });
    expect(rows.reduce((t, r) => t + r.tivShare, 0)).toBeCloseTo(1, 12);
    expect(rows.reduce((t, r) => t + r.lossShare, 0)).toBeCloseTo(1, 12);
  });

  it("gives zero shares, not a division by zero, when nothing is insured or lost", () => {
    const empty = classLossRows({ byClass: { informal_iron_sheet: cls(0, 0, 0), semi_permanent: cls(0, 0, 0), permanent_masonry: cls(0, 0, 0), concrete_rcc: cls(0, 0, 0) } } as Pick<ScenarioResult, "byClass">);
    expect(empty.every((r) => r.tivShare === 0 && r.lossShare === 0)).toBe(true);
  });
});

describe("the wards with the most loss", () => {
  const ward = (index: number, lossKes: number) => ({ index, name: `Ward ${index}`, subcounty: "Sub", buildings: 10, flooded: 2, tivKes: 1, lossKes });

  it("ranks by loss, leaves out wards with none, and stops at the count asked for", () => {
    const top = topWards([ward(0, 5), ward(1, 0), ward(2, 50), ward(3, 20), ward(4, 25)], 3);
    expect(top.map((w) => w.index)).toEqual([2, 4, 3]);
    expect(top.map((w) => w.rank)).toEqual([1, 2, 3]);
  });

  it("gives each ward its share of the whole loss, not of the top few", () => {
    const top = topWards([ward(0, 60), ward(1, 30), ward(2, 10)], 2);
    expect(top.map((w) => w.lossShare)).toEqual([0.6, 0.3]);
  });

  it("keeps equal losses in the order given and carries the row's own fields", () => {
    const top = topWards([ward(7, 10), ward(3, 10)]);
    expect(top.map((w) => w.index)).toEqual([7, 3]);
    expect(top[0]).toMatchObject({ name: "Ward 7", subcounty: "Sub", buildings: 10, tivKes: 1 });
  });

  it("returns nothing when no ward has a loss", () => {
    expect(topWards([ward(0, 0), ward(1, 0)])).toEqual([]);
    expect(topWards([])).toEqual([]);
  });
});

describe("map shades", () => {
  it("keeps the unshaded level for no loss", () => {
    expect(shadeLevel(0, 100)).toBe(0);
    expect(shadeLevel(-5, 100)).toBe(0);
    expect(shadeLevel(10, 0)).toBe(0);
  });

  it("rises with the loss, on its square root, up to the top shade", () => {
    expect(shadeLevel(1, 100)).toBe(1); // sqrt 0.1, first fifth
    expect(shadeLevel(4, 100)).toBe(1); // sqrt 0.2, the edge of the first fifth
    expect(shadeLevel(5, 100)).toBe(2);
    expect(shadeLevel(25, 100)).toBe(3); // sqrt 0.5
    expect(shadeLevel(100, 100)).toBe(5);
    expect(shadeLevel(400, 100)).toBe(5);
  });

  it("never goes down as the loss goes up", () => {
    let previous = 0;
    for (let v = 0; v <= 1000; v += 1) {
      const level = shadeLevel(v, 1000);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });
});

describe("the layers of one event", () => {
  const TIVS = [10_000_000, 2_000_000];
  const LOSSES = [
    [0, 1_000_000, 9_000_000],
    [30_000, 500_000, 2_000_000],
  ];
  const dataset = { buildings: TIVS.map((tivKes) => ({ tivKes })) } as unknown as Pick<Dataset, "buildings">;
  const result = {
    scenarios: [10, 50, 250].map((returnPeriod, k) => ({ id: `s${k}`, returnPeriod, lossKes: LOSSES[0][k] + LOSSES[1][k] })),
    buildings: LOSSES.map((row, i) => ({ locId: `b${i}`, perScenario: row.map((lossKes) => ({ lossKes })) })),
  } as unknown as ModelResult;

  // The running level of a waterfall: a total sets it, a decrease lowers it.
  const reconciles = (steps: ReturnType<typeof layerSteps>) => {
    let level = 0;
    for (const s of steps) {
      if (s.kind === "decrease") level -= s.value;
      else {
        if (level !== 0) expect(s.value).toBeCloseTo(level, 6);
        level = s.value;
      }
    }
  };

  it("runs ground-up, deductibles, gross, quota share, excess of loss, net", () => {
    const row = applyTerms(dataset, result, DEFAULT_TERMS).scenarios[1];
    const steps = layerSteps(row);
    expect(steps.map((s) => s.label)).toEqual(["Ground-up", "Minus deductibles", "Gross", "Minus quota share", "Minus excess of loss", "Net"]);
    expect(steps.map((s) => s.kind)).toEqual(["total", "decrease", "total", "decrease", "decrease", "total"]);
    expect(steps[0].value).toBe(1_500_000);
    expect(steps[2].value).toBe(1_250_000);
    reconciles(steps);
  });

  it("adds a step for amounts over policy limits when there are any, so the bars still add up", () => {
    const row = applyTerms(dataset, result, { ...DEFAULT_TERMS, limitShare: 0.5 }).scenarios[2];
    expect(row.overLimitKes).toBeGreaterThan(0);
    const steps = layerSteps(row);
    expect(steps.map((s) => s.label)).toContain("Minus amounts over policy limits");
    expect(steps).toHaveLength(7);
    reconciles(steps);
  });
});

describe("what the agents changed in the average annual loss", () => {
  it("gives the change as a fraction of the reference", () => {
    expect(aalChange(200, 250)).toEqual({ referenceKes: 200, agentsKes: 250, fraction: 0.25 });
    expect(aalChange(200, 150)?.fraction).toBe(-0.25);
  });

  it("is null when the agents have no result", () => {
    expect(aalChange(200, null)).toBeNull();
    expect(aalChange(200, undefined)).toBeNull();
  });

  it("has no percentage when the reference is zero", () => {
    expect(aalChange(0, 50)).toEqual({ referenceKes: 0, agentsKes: 50, fraction: null });
  });
});

describe("the agents' parameter changes", () => {
  const ledger = [
    { path: "depthScaleM", reference: 4, final: 5, adjusted: false },
    { path: "fragility.semi_permanent", reference: 1.2, final: 1.2, adjusted: false },
    { path: "cap.concrete_rcc", reference: 0.8, final: 0.6, adjusted: true },
  ];

  it("keeps only the parameters that moved, with the change as a fraction", () => {
    const changes = paramChanges(ledger);
    expect(changes.map((c) => c.path)).toEqual(["depthScaleM", "cap.concrete_rcc"]);
    expect(changes[0]).toMatchObject({ reference: 4, agreed: 5, fraction: 0.25, adjusted: false });
    expect(changes[1].fraction).toBeCloseTo(-0.25, 12);
    expect(changes[1].adjusted).toBe(true);
  });

  it("is empty when the agents agreed with the reference", () => {
    expect(paramChanges([{ path: "depthScaleM", reference: 4, final: 4 }])).toEqual([]);
  });
});

describe("hotspots", () => {
  it("counts the flagged areas out of all of them", () => {
    expect(hotspotCount([{ hit: true }, { hit: false }, { hit: true }])).toEqual({ matched: 2, total: 3 });
    expect(hotspotCount([])).toEqual({ matched: 0, total: 0 });
  });
});

describe("the model chain", () => {
  const check = (group: CheckGroup, id: string, status: CheckStatus = "pass"): Check => ({ group, id, status, title: id, detail: "" });
  const checks = [
    check("data", "files-found"),
    check("data", "synthetic-flag", "warn"),
    check("hazard", "range"),
    check("hazard", "hotspots", "warn"),
    check("vulnerability", "zero"),
    check("financial", "sum-buildings"),
    check("financial", "gross-le-ground-up", "fail"),
    check("financial", "recoveries-reconcile"),
    check("financial", "loss-rises"),
    check("financial", "aal"),
    check("financial", "aal-order"),
    check("ai", "schema", "fail"),
  ];
  const stages = chainStatus(checks);

  it("lists the five stages in order, each with the step it opens", () => {
    expect(stages.map((s) => s.label)).toEqual(["Hazard", "Vulnerability", "Exposure", "Financial engine", "Loss curve"]);
    expect(stages.map((s) => s.step)).toEqual(["hazard", "vulnerability", "exposure", "financial", "results"]);
  });

  it("gives a stage the worst result among its checks", () => {
    expect(stages.map((s) => s.status)).toEqual(["warn", "pass", "warn", "fail", "pass"]);
  });

  it("splits the financial checks between the engine and the loss curve, and counts every one once", () => {
    expect(stages[3]).toMatchObject({ pass: 2, warn: 0, fail: 1, total: 3 });
    expect(stages[4]).toMatchObject({ pass: 3, warn: 0, fail: 0, total: 3 });
    // The check on the agents belongs to no stage.
    expect(stages.reduce((t, s) => t + s.total, 0)).toBe(checks.length - 1);
  });

  it("marks a stage with no checks as having none", () => {
    expect(chainStatus([]).every((s) => s.status === "none" && s.total === 0)).toBe(true);
  });

  it("says the counts in words", () => {
    expect(chainSummary(stages[1])).toBe("1 of 1 checks passed");
    expect(chainSummary(stages[0])).toBe("1 of 2 passed, 1 warning");
    expect(chainSummary(stages[3])).toBe("2 of 3 passed, 1 failed");
    expect(chainSummary({ pass: 1, warn: 2, fail: 1, total: 4 })).toBe("1 of 4 passed, 1 failed, 2 warnings");
    expect(chainSummary({ pass: 0, warn: 0, fail: 0, total: 0 })).toBe("No checks yet");
  });
});
