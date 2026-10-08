import { describe, expect, it } from "vitest";
import { averageAnnualLoss, lossAtReturnPeriod } from "../src/lib/model/financial";
import { enforceBounds, REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import { HOUSING_CLASSES, type Dataset } from "../src/lib/model/types";
import { baseCurve, damageRatio } from "../src/lib/model/vulnerability";
import { REFERENCE_JUDGEMENT } from "../src/lib/offer/judgement";

describe("JRC base curve", () => {
  it("returns the published points exactly", () => {
    expect(baseCurve(0)).toBe(0);
    expect(baseCurve(0.5)).toBeCloseTo(0.22);
    expect(baseCurve(1)).toBeCloseTo(0.38);
    expect(baseCurve(2)).toBeCloseTo(0.64);
    expect(baseCurve(6)).toBe(1);
  });
  it("interpolates in a straight line between points", () => {
    expect(baseCurve(0.25)).toBeCloseTo(0.11);
    expect(baseCurve(2.5)).toBeCloseTo(0.73);
  });
  it("stays at the ceiling beyond 6 m and at zero for dry or invalid depths", () => {
    expect(baseCurve(20)).toBe(1);
    expect(baseCurve(-1)).toBe(0);
    expect(baseCurve(NaN)).toBe(0);
  });
});

describe("class damage", () => {
  it("applies fragility to depth, then the cap", () => {
    // informal: 1 m × 1.5 = 1.5 m on the curve → 0.53
    expect(damageRatio(1, "informal_iron_sheet", REFERENCE_PARAMS)).toBeCloseTo(0.53);
    // concrete: 1 m × 0.7 = 0.7 m → 0.22 + 0.4 × 0.16 = 0.284
    expect(damageRatio(1, "concrete_rcc", REFERENCE_PARAMS)).toBeCloseTo(0.284);
    // deep water hits the cap
    expect(damageRatio(10, "concrete_rcc", REFERENCE_PARAMS)).toBe(0.8);
    expect(damageRatio(10, "informal_iron_sheet", REFERENCE_PARAMS)).toBe(0.95);
  });
  it("never falls as depth rises", () => {
    for (const c of HOUSING_CLASSES) {
      let prev = 0;
      for (let d = 0; d <= 8; d += 0.01) {
        const dr = damageRatio(d, c, REFERENCE_PARAMS);
        expect(dr).toBeGreaterThanOrEqual(prev);
        prev = dr;
      }
    }
  });
});

describe("parameter bounds", () => {
  it("leaves the reference set untouched", () => {
    const { params, adjustments } = enforceBounds(REFERENCE_PARAMS);
    expect(adjustments).toEqual([]);
    expect(params).toEqual(REFERENCE_PARAMS);
  });
  it("clamps out-of-range values and reports each change", () => {
    const { params, adjustments } = enforceBounds({
      ...REFERENCE_PARAMS,
      depthScaleM: 40,
      cap: { ...REFERENCE_PARAMS.cap, concrete_rcc: 0.1 },
    });
    expect(params.depthScaleM).toBe(6);
    expect(params.cap.concrete_rcc).toBe(0.6);
    expect(adjustments.map((a) => a.path).sort()).toEqual(["cap.concrete_rcc", "depthScaleM"]);
  });
  it("forces return periods to rise from the narrowest footprint to the widest", () => {
    const { params, adjustments } = enforceBounds({
      ...REFERENCE_PARAMS,
      returnPeriods: { extreme: 50, severe: 20, moderate: 50, occasional: 100, common: 250 },
    });
    expect(params.returnPeriods.severe).toBeGreaterThan(params.returnPeriods.extreme);
    expect(params.returnPeriods.moderate).toBeGreaterThan(params.returnPeriods.severe);
    expect(adjustments.length).toBeGreaterThan(0);
  });
  it("falls back to the reference value when a number is missing", () => {
    const broken = JSON.parse(JSON.stringify(REFERENCE_PARAMS));
    delete broken.fragility.semi_permanent;
    expect(enforceBounds(broken).params.fragility.semi_permanent).toBe(REFERENCE_PARAMS.fragility.semi_permanent);
  });
});

describe("loss curve", () => {
  const points = [
    { returnPeriod: 10, lossKes: 100 },
    { returnPeriod: 100, lossKes: 300 },
  ];
  it("reads modelled points exactly and interpolates on log return period", () => {
    expect(lossAtReturnPeriod(points, 10).lossKes).toBe(100);
    expect(lossAtReturnPeriod(points, 100).lossKes).toBe(300);
    // sqrt(10 × 100) is halfway on a log scale
    expect(lossAtReturnPeriod(points, Math.sqrt(1000)).lossKes).toBeCloseTo(200);
  });
  it("does not invent losses below the range and holds flat above it", () => {
    expect(lossAtReturnPeriod(points, 5)).toEqual({ lossKes: null, extrapolated: false });
    expect(lossAtReturnPeriod(points, 500)).toEqual({ lossKes: 300, extrapolated: true });
  });
  it("integrates average annual loss over exceedance probability", () => {
    // (0.1 − 0.01) × (100 + 300)/2 + 0.01 × 300 = 18 + 3
    expect(averageAnnualLoss(points)).toBeCloseTo(21);
  });
});

describe("pipeline on a hand-checked portfolio", () => {
  const dataset: Dataset = {
    name: "toy",
    hazardKind: "score",
    scenarios: [
      { id: "extreme", label: "extreme" },
      { id: "common", label: "common" },
    ],
    hotspots: [],
    rasters: [],
    buildings: [
      { locId: "A", lat: 0, lon: 0, housingClassRaw: "informal_iron_sheet", housingClass: "informal_iron_sheet", floorAreaM2: null, costPerM2Kes: null, tivKes: 1000, synthetic: true, hazard: [0, 0.25] },
      { locId: "B", lat: 0, lon: 0, housingClassRaw: "concrete_rcc", housingClass: "concrete_rcc", floorAreaM2: null, costPerM2Kes: null, tivKes: 100000, synthetic: true, hazard: [0.25, 0.5] },
    ],
  };
  const result = runModel(dataset, REFERENCE_PARAMS);

  it("orders scenarios from most frequent to rarest", () => {
    expect(result.scenarios.map((s) => [s.id, s.returnPeriod])).toEqual([["extreme", 10], ["common", 250]]);
  });
  it("matches the arithmetic done by hand", () => {
    // extreme: A dry. B score 0.25 × 4 m = 1 m; × 0.7 = 0.7 m → 0.284 × 100,000 = 28,400
    expect(result.scenarios[0].lossKes).toBeCloseTo(28400);
    expect(result.scenarios[0].affected).toBe(1);
    // common: A 0.25 × 4 = 1 m; × 1.5 = 1.5 m → 0.53 × 1,000 = 530
    //         B 0.5 × 4 = 2 m; × 0.7 = 1.4 m → 0.38 + 0.8 × 0.15 = 0.50 × 100,000 = 50,000
    expect(result.scenarios[1].lossKes).toBeCloseTo(50530);
    expect(result.scenarios[1].byClass.informal_iron_sheet.lossKes).toBeCloseTo(530);
    expect(result.totalTivKes).toBe(101000);
  });
  it("is the depth-only model unless all loss drivers are asked for", () => {
    expect(result.mode).toBe("depth_only");
    expect(runModel(dataset, REFERENCE_PARAMS, { mode: "depth_only" })).toEqual(result);
    // This portfolio has no maps, so there is no buffer to read and all loss drivers add drain overload only.
    // Drains designed for 1-in-5: the 1-in-10 puts 0.1 m at A. 0.1 m × 1.5 = 0.15 m → 0.066 × 1,000 = 66.
    const all = runModel(dataset, REFERENCE_PARAMS, { mode: "all_drivers", judgement: { ...REFERENCE_JUDGEMENT, drainDesignRp: 5 } });
    expect(all.mode).toBe("all_drivers");
    expect(all.scenarios[0].lossKes).toBeCloseTo(28466);
    expect(all.scenarios[0].byDriver?.overloadKes).toBeCloseTo(66);
    expect(all.scenarios[0].affected).toBe(2);
    // Where the water at the point is already deeper than 0.1 m, drain overload adds nothing.
    expect(all.scenarios[1].lossKes).toBeCloseTo(50530);
    expect(all.scenarios[1].byDriver?.overloadKes).toBe(0);
  });
});
