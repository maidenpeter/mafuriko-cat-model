import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DRAINAGE_DEFAULTS, drainageDistances, drainageSensitivity, sampleGrid, stressAt } from "../src/lib/geo/drainage";
import { withDrainage, type DrainageState } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { sampleRaster } from "../src/lib/ingest/raster";
import type { LossMode } from "../src/lib/model/drivers";
import { averageAnnualLoss } from "../src/lib/model/financial";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { DEFAULT_TERMS } from "../src/lib/model/terms";
import type { Dataset, DrainageInfo, Raster } from "../src/lib/model/types";
import { damageRatio } from "../src/lib/model/vulnerability";
import {
  basementFact,
  DRIVER_IDS,
  DRIVER_LABELS,
  driverName,
  MODELLED_DRIVER_IDS,
  offerDrivers,
  statedFloodHistory,
  statedValues,
  type DriverBuilding,
  type OfferDrivers,
  type OfferDriversInput,
} from "../src/lib/offer/drivers";
import { BASEMENT_LADDER, JUDGEMENT_BOUNDS, JUDGEMENT_KEYS, REFERENCE_JUDGEMENT, type OfferJudgement } from "../src/lib/offer/judgement";
import { priceOffer } from "../src/lib/offer/price";
import { policyTerms } from "../src/lib/offer/terms";
import type { OfferExtraction, OfferTerms, PolicyTerms, PricingRow, Quoted } from "../src/lib/offer/types";

// Nothing here comes from a real document: every name, figure and sentence is made up for the test.

const said = <T,>(value: T, quote = "an invented sentence"): Quoted<T> => ({ value, quote, status: "verified", reason: null });
const missing = <T,>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });
const doubted = <T,>(value: T): Quoted<T> => ({ value, quote: "a sentence that does not hold the figure", status: "unverified", reason: "The number is not in the sentence given for it." });

const terms = (values: Partial<OfferTerms> = {}): OfferTerms => ({
  basements: missing(),
  occupancy: missing(),
  floodDeductiblePct: missing(),
  floodDeductibleMinKes: missing(),
  floodDeductibleBasis: missing(),
  floodLimitKes: missing(),
  policyPeriod: missing(),
  floodCover: missing(),
  placeName: missing(),
  riverName: missing(),
  riverDistanceM: missing(),
  ...values,
});
const extraction = (values: Partial<OfferTerms> = {}, more: Partial<OfferExtraction> = {}): OfferExtraction => ({ rows: [], terms: terms(values), notes: [], ...more });

/** The panel's example terms: 2% of the insured value, never less than KES 50,000, and a limit of the whole insured value. */
const EXAMPLE: PolicyTerms = { deductible: { source: "example", share: 0.02, minKes: 50_000 }, limit: { source: "example", share: 1 } };

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));
const priced = (d: OfferDrivers | null): OfferDrivers => {
  if (!d) throw new Error("the offer should be priced");
  return d;
};

// --- a hand-made map -----------------------------------------------------------------------------
// Three depth maps of 20 by 20 cells, about 111 m a cell. One cell, two cells east of the building,
// floods to 1 m in the 1-in-50 flood and 2 m in the 1-in-250; the building's own cell takes 0.5 m in
// the 1-in-250 only. Every depth is a number a 32-bit float holds exactly.

const BBOX: [number, number, number, number] = [36.8, -1.3, 36.82, -1.28];
const SIZE = 20;
const cell = (row: number, col: number) => row * SIZE + col;
const centre = (row: number, col: number) => ({ lon: BBOX[0] + ((col + 0.5) / SIZE) * (BBOX[2] - BBOX[0]), lat: BBOX[3] - ((row + 0.5) / SIZE) * (BBOX[3] - BBOX[1]) });

function map(scenarioId: string, wet: [number, number, number][]): Raster {
  const data = new Float32Array(SIZE * SIZE);
  for (const [row, col, depth] of wet) data[cell(row, col)] = depth;
  return { scenarioId, fileName: `${scenarioId}.tif`, width: SIZE, height: SIZE, bbox: BBOX, data, noData: null };
}

const HAND: Dataset = {
  name: "hand-made",
  hazardKind: "depth_m",
  scenarios: [
    { id: "rp10", label: "1-in-10", fixedReturnPeriod: 10 },
    { id: "rp50", label: "1-in-50", fixedReturnPeriod: 50 },
    { id: "rp250", label: "1-in-250", fixedReturnPeriod: 250 },
  ],
  buildings: [],
  hotspots: [],
  rasters: [map("rp10", []), map("rp50", [[10, 12, 1]]), map("rp250", [[10, 12, 2], [10, 10, 0.5]])],
};

const TIV = 1_000_000_000;
/** The building: its own cell is dry until the 1-in-250 flood, with water two cells away from the 1-in-50. */
const SITE: DriverBuilding = { ...centre(10, 10), housingClass: "concrete_rcc", tivKes: TIV };
/** A building nowhere near the water: dry on every map, at the point and within the buffer. */
const FAR: DriverBuilding = { ...centre(2, 2), housingClass: "concrete_rcc", tivKes: TIV };

/** What an invented offer states: two basements, KES 100m of plant and contents in them, interruption covered on KES 73m a year. */
const STATED: Partial<OfferTerms> = {
  basements: said(2, "The building has two basement levels."),
  valueBelowGroundKes: said(100_000_000, "Plant and contents in the basements are valued at KES 100,000,000."),
  biCovered: said("covered", "Loss of rent is to be insured."),
  annualRentKes: said(73_000_000, "Annual rent roll KES 73,000,000."),
};

const run = (building: DriverBuilding, e: OfferExtraction, mode: LossMode = "all_drivers", more: Partial<OfferDriversInput> = {}) =>
  offerDrivers({ dataset: HAND, params: REFERENCE_PARAMS, building, extraction: e, terms: EXAMPLE, judgement: REFERENCE_JUDGEMENT, mode, ...more });

/** The structure's damage ratio for the class at a depth, straight off the curve. */
const ratio = (depthM: number) => damageRatio(depthM, "concrete_rcc", REFERENCE_PARAMS);

describe("the six loss drivers on a hand-made map", () => {
  it("prices a building that is dry at the point from the water around it, the drains, the basement and the lost rent", () => {
    const d = priced(run(SITE, extraction(STATED)));
    expect(d.mode).toBe("all_drivers");
    expect(d.tivKes).toBe(TIV);
    expect(d.judgement).toEqual(REFERENCE_JUDGEMENT);
    expect(d.bufferRadiusM).toBe(250);
    expect(d.perReturnPeriod.map((r) => r.returnPeriod)).toEqual([10, 50, 250]);
    const [rp10, rp50, rp250] = d.perReturnPeriod;

    // 1-in-10: the maps are dry and the drains, taken as built for a 1-in-25 event, cope. Nothing is lost.
    expect(rp10.depths).toMatchObject({ pointM: 0, bufferM: 0, pondingM: 0, overloaded: false, overloadM: 0, surfaceM: 0 });
    expect(rp10.surfaceFrom).toBe("dry");
    expect(rp10.groundUpTotalKes).toBe(0);
    expect(rp10.grossKes).toBe(0);

    // 1-in-50: dry at the point, 1 m within the buffer. The structure is the insured value less the KES 100m below ground.
    expect(rp50.depths).toMatchObject({ pointM: 0, bufferM: 1, overloaded: true, overloadM: 0.1, surfaceM: 1 });
    expect(rp50.surfaceFrom).toBe("buffer");
    expect(rp50.pointKes).toBe(0);
    close(ratio(1), 0.284);
    close(rp50.groundUpKes.surrounding, 0.284 * 900_000_000);
    expect(rp50.bufferAddedKes).toBe(rp50.groundUpKes.surrounding);
    // The drains are overloaded, but 0.1 m is shallower than the water already there: nothing is counted twice.
    expect(rp50.groundUpKes.overload).toBe(0);
    expect(rp50.groundUpKes.ponding).toBe(0);
    // The basement takes water: KES 100m × the ladder's middle rung of 0.4.
    expect(rp50.building.basementTakesWater).toBe(true);
    close(rp50.groundUpKes.basement, 40_000_000);
    // Ten days of outage at KES 73m ÷ 365 a day.
    close(rp50.groundUpKes.interruption, 10 * 200_000);
    close(rp50.modelledKes, 255_600_000 + 40_000_000 + 2_000_000);
    // Uncertainty is 10% of the five above, on its own line.
    close(rp50.groundUpKes.uncertainty, 29_760_000);
    close(rp50.groundUpTotalKes, 327_360_000);
    // The deductible, 2% of the insured value, comes off the sum of the six; the limit does not bite.
    close(rp50.deductibleKes, 20_000_000);
    expect(rp50.overLimitKes).toBe(0);
    close(rp50.grossKes, 307_360_000);

    // 1-in-250: 0.5 m at the point, 2 m within the buffer.
    expect(rp250.depths).toMatchObject({ pointM: 0.5, bufferM: 2, surfaceM: 2 });
    close(rp250.pointKes, 0.154 * 900_000_000);
    close(rp250.bufferAddedKes, (0.5 - 0.154) * 900_000_000);
    close(rp250.groundUpKes.surrounding, 450_000_000);
    close(rp250.groundUpKes.basement, 70_000_000);
    close(rp250.groundUpKes.interruption, 40 * 200_000);
    close(rp250.groundUpTotalKes, 580_800_000);

    // Every row: the drivers add up, the terms take off what they take off, and the gross split adds up too.
    for (const r of d.perReturnPeriod) {
      close(r.structureKes, r.groundUpKes.surrounding + r.groundUpKes.ponding + r.groundUpKes.overload);
      close(r.modelledKes, MODELLED_DRIVER_IDS.reduce((t, id) => t + r.groundUpKes[id], 0));
      close(r.groundUpTotalKes, DRIVER_IDS.reduce((t, id) => t + r.groundUpKes[id], 0));
      close(r.groundUpKes.uncertainty, 0.1 * r.modelledKes);
      close(r.groundUpTotalKes - r.deductibleKes - r.overLimitKes, r.grossKes);
      close(DRIVER_IDS.reduce((t, id) => t + r.grossByDriverKes[id], 0), r.grossKes);
      expect(r.building.groundUpTotalKes).toBe(r.groundUpTotalKes);
      expect(r.building.grossKes).toBe(r.grossKes);
    }

    // Average annual loss: the area under the curve, as for the portfolio, and by driver.
    const area = 0.08 * 0.5 * 327_360_000 + 0.016 * 0.5 * (327_360_000 + 580_800_000) + 0.004 * 580_800_000;
    close(d.aal.groundUpTotalKes, area);
    close(DRIVER_IDS.reduce((t, id) => t + d.aal.groundUpKes[id], 0), d.aal.groundUpTotalKes);
    close(DRIVER_IDS.reduce((t, id) => t + d.aal.grossKes[id], 0), d.aal.grossTotalKes);
    close(d.aal.grossTotalKes, averageAnnualLoss(d.perReturnPeriod.map((r) => ({ returnPeriod: r.returnPeriod, lossKes: r.grossKes }))));
    expect(d.firstReturnPeriod).toEqual({ wet: 50, wetAtPoint: 250, wetInBuffer: 50, overloaded: 50, basement: 50 });
    // A 1-in-100 loss is read off the curve between the 1-in-50 and the 1-in-250.
    expect(d.loss100.extrapolated).toBe(false);
    expect(d.loss100.groundUpKes!).toBeGreaterThan(327_360_000);
    expect(d.loss100.groundUpKes!).toBeLessThan(580_800_000);
  });

  it("puts water at a site the maps leave dry once the drains are overloaded, and the basement takes it", () => {
    const d = priced(run(FAR, extraction(STATED)));
    const [rp10, rp50, rp250] = d.perReturnPeriod;
    expect(d.perReturnPeriod.every((r) => r.depths.pointM === 0 && r.depths.bufferM === 0)).toBe(true);
    expect(rp10.groundUpTotalKes).toBe(0);
    // Rarer than the 1-in-25 design: 0.1 m of surface water, credited to Drain overload alone.
    expect(rp50.depths).toMatchObject({ overloaded: true, overloadM: 0.1, surfaceM: 0.1 });
    expect(rp50.surfaceFrom).toBe("overload");
    expect(rp50.groundUpKes.surrounding).toBe(0);
    close(rp50.groundUpKes.overload, ratio(0.1) * 900_000_000);
    close(ratio(0.1), 0.0308);
    // 0.1 m reaches the 0.1 m ingress threshold, so the basement takes water.
    expect(rp50.building.basementTakesWater).toBe(true);
    close(rp50.groundUpKes.basement, 40_000_000);
    close(rp250.groundUpKes.basement, 70_000_000);
    expect(rp50.groundUpKes.interruption).toBeGreaterThan(0);
    expect(d.firstReturnPeriod).toEqual({ wet: 50, wetAtPoint: null, wetInBuffer: null, overloaded: 50, basement: 50 });

    // A threshold above the overload depth keeps the basement dry: the structure's loss stays, and the value
    // below ground loses the share the damage curve gives at that water, never less, and nothing off the ladder.
    const high = priced(run(FAR, extraction(STATED), "all_drivers", { judgement: { ...REFERENCE_JUDGEMENT, ingressThresholdM: 0.2 } }));
    expect(high.perReturnPeriod.every((r) => !r.building.basementTakesWater)).toBe(true);
    expect(high.perReturnPeriod[0].groundUpKes.basement).toBe(0);
    close(high.perReturnPeriod[1].groundUpKes.basement, ratio(0.1) * 100_000_000);
    close(high.perReturnPeriod[1].building.basementAppliedRatio, ratio(0.1));
    expect(high.perReturnPeriod[1].groundUpKes.overload).toBe(rp50.groundUpKes.overload);
    expect(high.firstReturnPeriod.basement).toBeNull();

    // The offer's own design return period is used when it states one: built for 1-in-100, only the 1-in-250 overloads.
    const designed = priced(run(FAR, extraction({ ...STATED, drainDesignRp: said(100, "Storm drains are designed for a 100-year event.") })));
    expect(designed.drainDesign.returnPeriod).toBe(100);
    expect(designed.drainDesign.source).toEqual({ kind: "offer", what: "Drains designed for a 1-in-100 event", quote: "Storm drains are designed for a 100-year event." });
    expect(designed.perReturnPeriod.map((r) => r.depths.overloaded)).toEqual([false, false, true]);
    expect(designed.perReturnPeriod[1].groundUpTotalKes).toBe(0);
    expect(designed.firstReturnPeriod.overloaded).toBe(250);
    // Not stated: the assumption, and it says so.
    expect(d.drainDesign).toMatchObject({ returnPeriod: 25, source: { kind: "assumption", keys: ["drainDesignRp"] } });
    // A design return period that failed its check is not used.
    const unsure = priced(run(FAR, extraction({ ...STATED, drainDesignRp: doubted(100) })));
    expect(unsure.drainDesign.returnPeriod).toBe(25);
  });

  it("credits ponding with what it adds, and drain overload with nothing where ponding is deeper", () => {
    // Ponding of half the full depth everywhere: 0.1 m, 0.2 m and 0.3 m in the three floods.
    const drainage: DrainageInfo = { reachM: 300, depthM: [0.2, 0.4, 0.6], buildingStress: [], grid: { width: 1, height: 1, bbox: BBOX, stress: new Float32Array([0.5]) } };
    const d = priced(run(FAR, extraction(STATED), "all_drivers", { dataset: { ...HAND, drainage } }));
    const [rp10, rp50, rp250] = d.perReturnPeriod;
    expect(rp10.depths).toMatchObject({ pondingM: 0.1, overloaded: false, surfaceM: 0.1 });
    expect(rp10.surfaceFrom).toBe("ponding");
    close(rp10.groundUpKes.ponding, ratio(0.1) * 900_000_000);
    expect(rp10.groundUpKes.overload).toBe(0);
    // 1-in-50: 0.2 m of ponding and 0.1 m from the drains. The deeper one is the ponding, so the drains add nothing.
    expect(rp50.depths).toMatchObject({ pondingM: 0.2, overloaded: true, overloadM: 0.1, surfaceM: 0.2 });
    close(rp50.groundUpKes.ponding, ratio(0.2) * 900_000_000);
    expect(rp50.groundUpKes.overload).toBe(0);
    close(rp250.structureKes, ratio(0.3) * 900_000_000);
    expect(d.lines.find((l) => l.id === "ponding")).toMatchObject({ on: true });
    // The ponding the engine already worked out is used when it is handed in.
    const given = priced(run({ ...FAR, pondingM: { rp10: 0, rp50: 0.05, rp250: 0.4 } }, extraction(STATED), "all_drivers", { dataset: { ...HAND, drainage } }));
    expect(given.perReturnPeriod.map((r) => r.depths.pondingM)).toEqual([0, 0.05, 0.4]);
    // 0.05 m of ponding, then the drains take the water to 0.1 m: each is credited with its own step.
    const mixed = given.perReturnPeriod[1];
    close(mixed.groundUpKes.ponding, ratio(0.05) * 900_000_000);
    close(mixed.groundUpKes.overload, (ratio(0.1) - ratio(0.05)) * 900_000_000);
    // Without the drainage layer the driver is off and says why.
    expect(priced(run(FAR, extraction(STATED))).lines.find((l) => l.id === "ponding")).toMatchObject({ on: false });
  });

  it("uses the assumptions where the offer states nothing, and prices no basement or interruption it was not told of", () => {
    // Nothing stated: no basement is assumed and interruption is not priced.
    const bare = priced(run(SITE, extraction()));
    expect(bare.basement.present).toBeNull();
    expect(bare.interruptionCover).toBeNull();
    for (const r of bare.perReturnPeriod) {
      expect(r.groundUpKes.basement).toBe(0);
      expect(r.groundUpKes.interruption).toBe(0);
    }
    // The whole insured value is then the structure.
    close(bare.perReturnPeriod[1].groundUpKes.surrounding, 0.284 * TIV);
    expect(bare.lines.filter((l) => !l.on).map((l) => l.id)).toEqual(["ponding", "basement", "interruption"]);
    expect(bare.components.map((c) => [c.id, c.on, c.valueKes])).toEqual([["structure", true, TIV], ["below_ground", false, 0], ["interruption", false, 0]]);

    // Basements and cover stated, but no values: the assumed shares of the insured value stand in, and are marked as assumptions.
    const assumed = priced(run(SITE, extraction({ basements: said(1, "one basement"), biCovered: said("covered", "Loss of rent is insured.") })));
    const [structure, below, interruption] = assumed.components;
    close(below.valueKes, 0.08 * TIV);
    expect(below.valueSource).toMatchObject({ kind: "assumption", keys: ["belowGroundShare"] });
    close(structure.valueKes, 0.92 * TIV);
    close(structure.valueKes + below.valueKes, TIV);
    close(interruption.valueKes, 0.08 * TIV);
    expect(interruption.valueSource).toMatchObject({ kind: "assumption", keys: ["annualRentShare"] });
    close(assumed.perReturnPeriod[1].groundUpKes.interruption, (10 * 0.08 * TIV) / 365);
    expect(interruption.perReturnPeriod.map((r) => r.days)).toEqual([0, 10, 40]);
    close(below.perReturnPeriod[2].damageRatio, 0.7);
    expect(below.perReturnPeriod[0]).toMatchObject({ damageRatio: 0, lossKes: 0 });

    // Stated: the offer's own figures, each with its sentence.
    const stated = priced(run(SITE, extraction(STATED)));
    expect(stated.components[1]).toMatchObject({ valueKes: 100_000_000, valueSource: { kind: "offer", quote: "Plant and contents in the basements are valued at KES 100,000,000." } });
    expect(stated.components[2]).toMatchObject({ valueKes: 73_000_000, valueSource: { kind: "offer", quote: "Annual rent roll KES 73,000,000." } });
    expect(stated.components[0].valueKes).toBe(900_000_000);
    // Excluded cover and a stated absence of basements switch the two drivers off, each with the offer's own words.
    const off = priced(run(SITE, extraction({ basements: said(0, "There are no basements."), biCovered: said("excluded", "Loss of rent is not insured.") })));
    expect(off.basement.present).toBe(false);
    expect(off.lines.find((l) => l.id === "basement")).toMatchObject({ on: false, sources: [{ kind: "offer", quote: "There are no basements." }] });
    expect(off.lines.find((l) => l.id === "interruption")).toMatchObject({ on: false, sources: [{ kind: "offer", quote: "Loss of rent is not insured." }] });
    expect(off.perReturnPeriod.every((r) => r.groundUpKes.basement === 0 && r.groundUpKes.interruption === 0)).toBe(true);
  });

  it("names the source of every driver, in the six fixed names", () => {
    expect(DRIVER_IDS.map((id) => DRIVER_LABELS[id])).toEqual(["Surrounding flooding", "Drainage ponding", "Drain overload", "Basement ingress", "Business interruption", "Uncertainty loading"]);
    for (const e of [extraction(), extraction(STATED)]) {
      for (const mode of ["all_drivers", "depth_only"] as const) {
        const d = priced(run(SITE, e, mode));
        expect(d.lines.map((l) => l.id)).toEqual([...DRIVER_IDS]);
        for (const line of d.lines) {
          expect(line.label).toBe(driverName(line.id, mode));
          expect(line.text.trim()).not.toBe("");
          expect(line.sources.length).toBeGreaterThan(0);
          for (const s of line.sources) {
            expect(["offer", "assumption", "data"]).toContain(s.kind);
            expect(s.what.trim()).not.toBe("");
            // An assumption names judgement figures that exist; a figure from the offer carries its sentence.
            if (s.kind === "assumption") for (const key of s.keys) expect(JUDGEMENT_KEYS).toContain(key);
            if (s.kind === "offer") expect(s.quote.trim()).not.toBe("");
          }
        }
        for (const c of d.components) {
          expect(c.valueSource.what.trim()).not.toBe("");
          expect(c.damageSource.what.trim()).not.toBe("");
        }
        for (const line of d.premium.lines) expect(line.sources.length).toBeGreaterThan(0);
      }
    }
    const d = priced(run(SITE, extraction(STATED)));
    const keys = (id: string) => d.lines.find((l) => l.id === id)!.sources.flatMap((s) => (s.kind === "assumption" ? s.keys : []));
    expect(keys("surrounding")).toEqual(["bufferRadiusM"]);
    expect(keys("overload")).toEqual(["drainDesignRp", "drainOverloadDepthM"]);
    expect(keys("basement")).toEqual(["ingressThresholdM", "basementDamageExtreme", "basementDamageSevere", "basementDamageModerate", "basementDamageOccasional", "basementDamageCommon"]);
    expect(keys("interruption")).toEqual(["outageDaysExtreme", "outageDaysSevere", "outageDaysModerate", "outageDaysOccasional", "outageDaysCommon"]);
    expect(keys("uncertainty")).toEqual(["uncertaintyLoading"]);
  });

  it("builds the premium up from the modelled loss by driver, the uncertainty, the capital load and the minimum rate", () => {
    const d = priced(run(SITE, extraction({ ...STATED, premiumKes: said(4_000_000, "Annual premium KES 4,000,000 all risks.") })));
    const p = d.premium;
    expect(p.lines.map((l) => l.id)).toEqual(["surrounding", "ponding", "overload", "basement", "interruption", "uncertainty", "capital_load", "technical", "minimum", "flood_premium"]);
    close(p.modelledAalKes, MODELLED_DRIVER_IDS.reduce((t, id) => t + d.aal.grossKes[id], 0));
    expect(p.uncertaintyAalKes).toBe(d.aal.grossKes.uncertainty);
    // Capital load: 8% of what the offer adds to the portfolio's 1-in-100 gross loss, which is its own 1-in-100 gross loss.
    expect(p.capital).toEqual({ addedLoss100Kes: d.loss100.grossKes, costOfCapital: 0.08, basis: "gross" });
    close(p.capitalLoadKes, 0.08 * d.loss100.grossKes!);
    expect(p.capitalLoadKes).toBeLessThan(0.08 * d.loss100.groundUpKes!);
    expect(p.lines.find((l) => l.id === "capital_load")!.text).toContain("1-in-100 gross loss");
    // Every driver's line is gross, and the caption says so once: no driver in force repeats it.
    expect(p.caption).toContain("gross: after the deductible and the limit");
    for (const id of MODELLED_DRIVER_IDS) expect(p.lines.find((l) => l.id === id)!.text, id).toBe(d.lines.find((l) => l.id === id)!.on ? "" : d.lines.find((l) => l.id === id)!.text);
    close(p.technicalKes, p.modelledAalKes + p.uncertaintyAalKes + p.capitalLoadKes);
    close(p.minimumKes, 0.0001 * TIV);
    expect(p.setBy).toBe("modelled");
    expect(p.floodPremiumKes).toBe(p.technicalKes);
    close(p.floodRatePerMille, (p.floodPremiumKes / TIV) * 1000);
    // Beside it: the offer's own premium and all-risks rate, with the sentence.
    expect(p.stated).toMatchObject({ premiumKes: 4_000_000, ratePerMille: 4, quote: "Annual premium KES 4,000,000 all risks.", onTivKes: TIV, partlyPriced: false, note: null });
    close(p.stated!.floodShareOfAllRisks, p.floodPremiumKes / 4_000_000);
    // The flood rate as a share of the all-risks rate is the same figure, read from the two rates.
    close(p.stated!.floodShareOfAllRisks, p.floodRatePerMille / p.stated!.ratePerMille);
    expect(priced(run(SITE, extraction(STATED))).premium.stated).toBeNull();

    // Given the portfolio's 1-in-100 with and without the offer, the capital load is on the difference.
    const given = priced(run(SITE, extraction(STATED), "all_drivers", { portfolioLoss100Kes: { without: 2_000_000_000, with: 2_050_000_000 } }));
    close(given.premium.capital.addedLoss100Kes!, 50_000_000);
    close(given.premium.capitalLoadKes, 4_000_000);
    // With only the "without" side the offer's own 1-in-100 loss is what it adds.
    const half = priced(run(SITE, extraction(STATED), "all_drivers", { portfolioLoss100Kes: { without: 2_000_000_000 } }));
    expect(half.premium.capitalLoadKes).toBe(p.capitalLoadKes);

    // A building the maps and the drains never reach is given the minimum rate, and the premium says so.
    const dry = priced(run(FAR, extraction(), "all_drivers", { judgement: { ...REFERENCE_JUDGEMENT, drainOverloadDepthM: 0, minimumRatePerMille: 0.5 } }));
    expect(dry.perReturnPeriod.every((r) => r.groundUpTotalKes === 0)).toBe(true);
    expect(dry.premium.setBy).toBe("minimum rate");
    close(dry.premium.floodPremiumKes, 0.0005 * TIV);
    close(dry.premium.floodRatePerMille, 0.5);
    expect(dry.premium.technicalKes).toBeLessThan(dry.premium.minimumKes);

    // The document's own flood losses are set beside the modelled loss as a loss per year, and never blended in.
    const withHistory = extraction({ ...STATED, floodHistoryYears: said(10, "Ten years of loss history are attached.") }, { floodLosses: [{ year: said(2020), amountKes: said(30_000_000, "KES 30,000,000 was paid for the 2020 flood.") }] });
    const h = priced(run(SITE, withHistory));
    expect(h.premium.history).toMatchObject({ years: 10, totalKes: 30_000_000, lossPerYearKes: 3_000_000, usable: true, why: null });
    // The one modelled figure the history is set beside, everywhere: the average annual loss, gross.
    expect(h.premium.history.modelledAalKes).toBe(h.aal.grossTotalKes);
    expect(h.premium.history.modelledAalKes).toBeLessThan(h.aal.groundUpTotalKes);
    expect(h.premium.floodPremiumKes).toBe(priced(run(SITE, extraction(STATED))).premium.floodPremiumKes);
    expect(d.premium.history).toMatchObject({ usable: false, lossPerYearKes: null, why: "The document states no period for its loss history." });
  });

  it("keeps a judgement figure inside its range and each ladder rising", () => {
    const wild: OfferJudgement = { ...REFERENCE_JUDGEMENT, uncertaintyLoading: 9, bufferRadiusM: 99_999, basementDamageModerate: 0.01 };
    const d = priced(run(SITE, extraction(STATED), "all_drivers", { judgement: wild }));
    expect(d.judgement.uncertaintyLoading).toBe(0.5);
    expect(d.judgement.bufferRadiusM).toBe(500);
    // The middle rung was below the one before it: it is raised to match.
    expect(d.judgement.basementDamageModerate).toBe(REFERENCE_JUDGEMENT.basementDamageSevere);
    close(d.perReturnPeriod[1].groundUpKes.uncertainty, 0.5 * d.perReturnPeriod[1].modelledKes);
    // A buffer of zero reads the point's own cell and nothing around it.
    const point = priced(run(SITE, extraction(STATED), "all_drivers", { judgement: { ...REFERENCE_JUDGEMENT, bufferRadiusM: 0 } }));
    expect(point.perReturnPeriod.map((r) => r.depths.bufferM)).toEqual([0, 0, 0.5]);
    expect(point.perReturnPeriod[1].surfaceFrom).toBe("overload");
  });

  it("adds up several buildings, each read at its own point, and shares the offer's stated amounts by insured value", () => {
    const other: DriverBuilding = { ...FAR, tivKes: 500_000_000 };
    const both = priced(run(SITE, extraction(STATED), "all_drivers", { others: [other] }));
    expect(both.buildings).toBe(2);
    expect(both.tivKes).toBe(1_500_000_000);
    const [, rp50] = both.perReturnPeriod;
    // The KES 100m below ground is shared two to one: 66.7m and 33.3m. Both basements take water in the 1-in-50.
    close(rp50.groundUpKes.basement, 0.4 * 100_000_000);
    close(both.components[1].valueKes, (100_000_000 * 2) / 3);
    close(both.components[0].valueKes, TIV - (100_000_000 * 2) / 3);
    // The followed building's own figures stay its own; the totals cover both.
    expect(rp50.building.groundUpTotalKes).toBeLessThan(rp50.groundUpTotalKes);
    close(rp50.groundUpKes.surrounding, ratio(1) * (TIV - (100_000_000 * 2) / 3));
    close(rp50.groundUpKes.overload, ratio(0.1) * (500_000_000 - 100_000_000 / 3));
    close(rp50.groundUpTotalKes - rp50.deductibleKes - rp50.overLimitKes, rp50.grossKes);
  });

  it("never charges capital on more than the policy can pay in one flood", () => {
    // A dry point, two basements, a deductible of 5% with a minimum of KES 1m and a flood limit of KES 10m.
    const capped: PolicyTerms = { deductible: { source: "document", pct: 5, minKes: 1_000_000, basis: "percent_of_loss" }, limit: { source: "document", kes: 10_000_000 } };
    const d = priced(run(FAR, extraction({ basements: said(2, "The building has two basement levels.") }), "all_drivers", { terms: capped }));
    expect(d.loss100.groundUpKes!).toBeGreaterThan(10_000_000);
    expect(d.loss100.grossKes!).toBeLessThanOrEqual(10_000_000);
    close(d.premium.capitalLoadKes, 0.08 * d.loss100.grossKes!);
    expect(d.premium.capitalLoadKes).toBeLessThanOrEqual(0.08 * 10_000_000 + 1e-6);
    // The same holds at every cost of capital in its range.
    for (const costOfCapital of [JUDGEMENT_BOUNDS.costOfCapital.min, 0.15, JUDGEMENT_BOUNDS.costOfCapital.max]) {
      const at = priced(run(FAR, extraction({ basements: said(2) }), "all_drivers", { terms: capped, judgement: { ...REFERENCE_JUDGEMENT, costOfCapital } }));
      expect(at.premium.capitalLoadKes).toBeLessThanOrEqual(costOfCapital * 10_000_000 + 1e-6);
    }
  });

  it("sets what the document states for the whole offer against the whole offer's insured value, priced or not", () => {
    // Two buildings of KES 1bn each, one outside the maps and so not priced: KES 150m below ground, KES 146m rent, a KES 4m premium.
    const whole = extraction({
      basements: said(2, "Each building has two basement levels."),
      valueBelowGroundKes: said(150_000_000, "Plant and contents below ground are valued at KES 150,000,000."),
      biCovered: said("covered", "Loss of rent is to be insured."),
      annualRentKes: said(146_000_000, "Annual rent roll KES 146,000,000."),
      premiumKes: said(4_000_000, "Annual premium KES 4,000,000 all risks."),
    });
    const one = priced(run(SITE, whole, "all_drivers", { offerTivKes: 2 * TIV }));
    expect(one.tivKes).toBe(TIV);
    expect(one.offerTivKes).toBe(2 * TIV);
    // The one priced building carries half of each stated amount, as it does when both are priced.
    close(one.components.find((c) => c.id === "below_ground")!.valueKes, 75_000_000);
    close(one.components.find((c) => c.id === "interruption")!.valueKes, 73_000_000);
    const both = priced(run(SITE, whole, "all_drivers", { others: [{ ...FAR }] }));
    close(both.components.find((c) => c.id === "below_ground")!.valueKes, 75_000_000);
    close(both.components.find((c) => c.id === "interruption")!.valueKes, 73_000_000);
    // The all-risks rate is 2 per mille on the KES 2bn the premium covers, not 4 on the half that is priced, and the premium says so.
    close(one.premium.stated!.ratePerMille, 2);
    expect(one.premium.stated).toMatchObject({ onTivKes: 2 * TIV, partlyPriced: true });
    expect(one.premium.stated!.note).toContain("whole offer");
    close(one.premium.stated!.floodShareOfAllRisks, one.premium.floodRatePerMille / 2);
    expect(both.premium.stated).toMatchObject({ ratePerMille: 2, partlyPriced: false, note: null });
    // Left out, or below what is priced, the priced buildings' own total is used.
    expect(priced(run(SITE, whole)).offerTivKes).toBe(TIV);
    expect(priced(run(SITE, whole, "all_drivers", { offerTivKes: 1 })).offerTivKes).toBe(TIV);
  });

  it("never prices below Depth only at the ends of any judgement figure's range", () => {
    // 0.5 m at the point in the rarest flood, read at the point alone (no buffer), with two basements and no stated value below ground.
    const wetSite = extraction({ basements: said(2, "The building has two basement levels.") });
    const point = priced(run(SITE, wetSite, "depth_only"));
    expect(point.perReturnPeriod[2].groundUpTotalKes).toBeGreaterThan(0);
    const never = (judgement: OfferJudgement, what: string) => {
      const all = priced(run(SITE, wetSite, "all_drivers", { judgement }));
      all.perReturnPeriod.forEach((r, k) => expect(r.groundUpTotalKes, `${what}, ${r.returnPeriod}`).toBeGreaterThanOrEqual(point.perReturnPeriod[k].groundUpTotalKes - 1e-6));
      return all;
    };
    const base: OfferJudgement = { ...REFERENCE_JUDGEMENT, bufferRadiusM: 0, uncertaintyLoading: 0 };
    for (const key of JUDGEMENT_KEYS) {
      for (const end of ["min", "max"] as const) never({ ...base, [key]: JUDGEMENT_BOUNDS[key][end] }, `${key} at its ${end}`);
    }
    // The hardest case: a large share below ground and a ladder that gives the basement nothing.
    const flat = Object.fromEntries(BASEMENT_LADDER.map((key) => [key, 0])) as Partial<OfferJudgement>;
    const hard = never({ ...base, ...flat, belowGroundShare: 0.5, ingressThresholdM: 0.5, drainOverloadDepthM: 0 }, "no ladder, half the value below ground");
    // The value below ground then loses exactly the share the curve gives the structure at the same water.
    const rarest = hard.perReturnPeriod[2];
    close(rarest.building.basementAppliedRatio, ratio(0.5));
    close(rarest.groundUpKes.basement, ratio(0.5) * 500_000_000);
    close(rarest.groundUpTotalKes, point.perReturnPeriod[2].groundUpTotalKes);
    // Where the ladder gives more than the curve, the ladder stands.
    const ladder = never(base, "reference ladder");
    close(ladder.perReturnPeriod[2].building.basementAppliedRatio, REFERENCE_JUDGEMENT.basementDamageCommon);
  });

  it("says when each thing first happens at any building of the offer, not only the one followed", () => {
    // A second building whose own cell floods to 1 m from the 1-in-10 flood, five cells from the first.
    const wetEarly: Dataset = { ...HAND, rasters: [map("rp10", [[5, 5, 1]]), map("rp50", [[10, 12, 1], [5, 5, 1]]), map("rp250", [[10, 12, 2], [10, 10, 0.5], [5, 5, 2]])] };
    const second: DriverBuilding = { ...centre(5, 5), housingClass: "concrete_rcc", tivKes: TIV };
    const d = priced(run(SITE, extraction(STATED), "all_drivers", { dataset: wetEarly, others: [second] }));
    const rp10 = d.perReturnPeriod[0];
    // The followed building is dry in the 1-in-10 flood; the offer is not, and its basement loss is there.
    expect(rp10.depths.surfaceM).toBe(0);
    expect(rp10.building.basementTakesWater).toBe(false);
    expect(rp10.groundUpKes.basement).toBeGreaterThan(0);
    expect(rp10.anyBuilding).toEqual({ wet: true, wetAtPoint: true, wetInBuffer: false, overloaded: false, basementTakesWater: true });
    expect(d.firstReturnPeriod).toMatchObject({ wet: 10, wetAtPoint: 10, basement: 10, overloaded: 50 });
    // With the one building, the row says what its own depths say.
    const alone = priced(run(SITE, extraction(STATED)));
    expect(alone.perReturnPeriod.map((r) => r.anyBuilding.wet)).toEqual(alone.perReturnPeriod.map((r) => r.depths.surfaceM > 0));
  });

  it("never assumes more below ground than the plant, machinery and contents the offer states", () => {
    // KES 30m of machinery and KES 20m of contents on KES 1bn: the assumed 8% would be KES 80m.
    const split = extraction({ basements: said(2, "The building has two basement levels."), valueMachineryKes: said(30_000_000, "Plant and machinery KES 30,000,000."), valueContentsKes: said(20_000_000, "Contents KES 20,000,000.") });
    const d = priced(run(SITE, split));
    const below = d.components.find((c) => c.id === "below_ground")!;
    close(below.valueKes, 50_000_000);
    expect(below.valueSource).toMatchObject({ kind: "assumption", keys: ["belowGroundShare"] });
    expect(below.valueSource.what).toContain("KES 50.0m of the plant, machinery and contents the offer states");
    // With only one of the two stated, or with more stated than the share gives, the share stands.
    close(priced(run(SITE, extraction({ basements: said(2), valueMachineryKes: said(30_000_000) }))).components[1].valueKes, 80_000_000);
    close(priced(run(SITE, extraction({ basements: said(2), valueMachineryKes: said(300_000_000), valueContentsKes: said(200_000_000) }))).components[1].valueKes, 80_000_000);
  });

  it("names the first line for what it is with Depth only, and quotes each share as it is used", () => {
    const point = priced(run(SITE, extraction(STATED), "depth_only"));
    expect(point.lines[0]).toMatchObject({ id: "surrounding", label: "Depth at the point", on: true });
    expect(point.premium.lines[0]).toMatchObject({ id: "surrounding", label: "Depth at the point" });
    expect(priced(run(SITE, extraction(STATED))).lines[0].label).toBe("Surrounding flooding");
    expect(driverName("surrounding", "depth_only")).toBe("Depth at the point");
    expect(driverName("ponding", "depth_only")).toBe(DRIVER_LABELS.ponding);
    // A share with a half in it reads as it is used, so the sentence reproduces the figure beside it.
    const halves = priced(run(SITE, extraction({ basements: said(2), biCovered: said("covered", "Loss of rent is to be insured.") }), "all_drivers", { judgement: { ...REFERENCE_JUDGEMENT, uncertaintyLoading: 0.125, belowGroundShare: 0.075, annualRentShare: 0.065, costOfCapital: 0.085 } }));
    const text = [...halves.lines.flatMap((l) => [l.text, ...l.sources.map((s) => s.what)]), ...halves.premium.lines.flatMap((l) => [l.text, ...l.sources.map((s) => s.what)])].join(" | ");
    for (const share of ["12.5% on top", "12.5% of the modelled loss", "7.5% of the insured value", "6.5% of the insured value", "8.5% a year"]) expect(text, share).toContain(share);
    expect(text).not.toMatch(/\b(13|8|7|9)% (on top|of the modelled|of the insured|a year)/);
    // A whole share has no decimal.
    expect(priced(run(SITE, extraction(STATED))).lines.find((l) => l.id === "uncertainty")!.text).toMatch(/^10% on top/);
    // Nobody is sent to the Hazard map step to set what cannot be set there.
    expect(text).not.toContain("set on the Hazard map step");
  });

  it("gives no figure outside the maps, for a building with no value, or with no map loaded", () => {
    expect(run({ ...SITE, lon: 34.1, lat: 0.12 }, extraction(STATED))).toBeNull();
    expect(run({ ...SITE, lon: 34.1, lat: 0.12 }, extraction(STATED), "depth_only")).toBeNull();
    expect(run(SITE, extraction(STATED), "all_drivers", { others: [{ ...FAR, lon: 34.1, lat: 0.12 }] })).toBeNull();
    expect(run({ ...SITE, tivKes: 0 }, extraction(STATED))).toBeNull();
    expect(run(SITE, extraction(STATED), "all_drivers", { dataset: { ...HAND, rasters: [] } })).toBeNull();
    expect(run(SITE, extraction(STATED), "all_drivers", { dataset: { ...HAND, scenarios: [], rasters: [] } })).toBeNull();
  });

  it("reproduces the point pricing exactly with Depth only", () => {
    const rows = (b: DriverBuilding, i: number): PricingRow => ({ index: i, locId: `OFFER-${i + 1}`, name: `Building ${i + 1}`, path: "rules", location: { kind: "exact", lat: b.lat, lon: b.lon, reading: null }, housingClass: b.housingClass, floorAreaM2: null, costPerM2Kes: null, tivKes: b.tivKes, tivFrom: "stated", blockers: [] });
    const stated: PolicyTerms = { deductible: { source: "document", pct: 5, minKes: 1_000_000, basis: "percent_of_loss" }, limit: { source: "document", kes: 100_000_000 } };
    for (const policy of [EXAMPLE, stated]) {
      for (const list of [[SITE], [SITE, { ...FAR, tivKes: 500_000_000 }], [FAR]]) {
        const engine = priceOffer({ dataset: HAND, params: REFERENCE_PARAMS, drainage: null, rows: list.map(rows), terms: policy, wards: null });
        // Everything the offer states is there, and none of it moves a Depth only figure.
        const d = priced(offerDrivers({ dataset: HAND, params: REFERENCE_PARAMS, building: list[0], others: list.slice(1), extraction: extraction(STATED), terms: policy, judgement: REFERENCE_JUDGEMENT, mode: "depth_only" }));
        const totals = engine.totals!;
        d.perReturnPeriod.forEach((r, k) => {
          expect(r.groundUpTotalKes).toBe(totals.scenarios[k].groundUpKes);
          expect(r.grossKes).toBe(totals.scenarios[k].grossKes);
          expect(r.returnPeriod).toBe(totals.scenarios[k].returnPeriod);
          for (const id of ["overload", "basement", "interruption", "uncertainty"] as const) expect(r.groundUpKes[id]).toBe(0);
          expect(r.bufferAddedKes).toBe(0);
          expect(r.depths.surfaceM).toBe(Math.max(r.depths.pointM, r.depths.pondingM));
        });
        expect(d.aal.groundUpTotalKes).toBe(totals.aalGroundUpKes);
        expect(d.aal.grossTotalKes).toBe(totals.aalGrossKes);
        // The premium is then the modelled loss and nothing else, so the rate is the pure rate as before.
        expect(d.premium.floodPremiumKes).toBe(totals.aalGrossKes);
        expect(d.premium.floodRatePerMille).toBe(totals.ratePerMilleGross);
        expect(d.premium).toMatchObject({ capitalLoadKes: 0, minimumKes: 0, uncertaintyAalKes: 0, setBy: "modelled" });
        expect(d.bufferRadiusM).toBe(0);
        expect(d.lines.filter((l) => l.on).map((l) => l.id)).toEqual(["surrounding"]);
      }
    }
    // The 1-in-50 flood: Depth only gives nothing for the building that All loss drivers prices.
    expect(priced(run(SITE, extraction(STATED), "depth_only")).perReturnPeriod[1].groundUpTotalKes).toBe(0);
    expect(priced(run(SITE, extraction(STATED))).perReturnPeriod[1].groundUpTotalKes).toBeGreaterThan(0);
  });
});

describe("what the drivers read from the document", () => {
  it("counts a value only when its status is verified, confirmed or edited", () => {
    const e = extraction({
      basements: said(2, "two basement levels"),
      drainDesignRp: doubted(50),
      valueBelowGroundKes: { value: 80_000_000, quote: "an older sentence", status: "edited", reason: null },
      annualRentKes: { value: 60_000_000, quote: "Rent roll KES 60,000,000 a year.", status: "confirmed", reason: null },
      biCovered: missing(),
      sumpPumpBackup: said("no", "The sump pumps have no standby power."),
      floodBarriers: said("absent", "No flood barriers are fitted."),
    });
    const s = statedValues(e);
    expect(s.basements).toEqual({ value: 2, quote: "two basement levels", typed: false });
    expect(s.drainDesignRp).toBeNull();
    // A typed value has no sentence of the document behind it.
    expect(s.valueBelowGroundKes).toEqual({ value: 80_000_000, quote: "", typed: true });
    expect(s.annualRentKes).toMatchObject({ value: 60_000_000, typed: false });
    expect(s.biCovered).toBeNull();
    expect(s.sumpPumpBackup?.value).toBe("no");
    expect(s.floodBarriers?.value).toBe("absent");
    expect(s.premiumKes).toBeNull();
    expect(s.equipmentBelowGround).toEqual([]);
    // An extraction made before these values existed has none of them, and nothing breaks.
    const old = statedValues({ rows: [], terms: terms(), notes: [] });
    expect(Object.values(old).every((v) => v === null || (Array.isArray(v) && v.length === 0))).toBe(true);
  });

  it("knows a basement from a stated level, equipment, plant or value below ground, and never assumes one", () => {
    expect(basementFact(statedValues(extraction())).present).toBeNull();
    expect(basementFact(statedValues(extraction({ basements: said(0, "There are no basements.") })))).toMatchObject({ present: false, quote: "There are no basements." });
    expect(basementFact(statedValues(extraction({ basements: said(3, "three basement levels") })))).toMatchObject({ present: true, quote: "three basement levels" });
    expect(basementFact(statedValues(extraction({}, { equipmentBelowGround: [{ item: said("Standby generator", "The standby generator is in basement 1.") }] })))).toMatchObject({ present: true, quote: "The standby generator is in basement 1." });
    expect(basementFact(statedValues(extraction({}, { equipmentBelowGround: [{ item: doubted("Standby generator") }] }))).present).toBeNull();
    expect(basementFact(statedValues(extraction({}, { notes: [{ ...said("Pumps in the basement", "The fire pumps are in the basement."), kind: "basement_plant" }] })))).toMatchObject({ present: true, quote: "The fire pumps are in the basement." });
  });

  it("makes a loss per year only from a stated period and stated amounts that passed their checks", () => {
    const withHistory = (amount: Quoted<number>): OfferExtraction => extraction({ floodHistoryYears: said(10, "Ten years of loss history are attached.") }, { floodLosses: [{ year: said(2020), amountKes: amount }] });
    expect(statedFloodHistory(withHistory(said(30_000_000)))).toMatchObject({ years: 10, usable: true, reason: null, losses: [{ year: 2020, amountKes: 30_000_000 }] });
    expect(statedFloodHistory(withHistory(doubted(30_000_000)))).toMatchObject({ usable: false, reason: "unverified", losses: [] });
    expect(statedFloodHistory(extraction({}, { floodLosses: [{ year: said(2020), amountKes: said(30_000_000) }] }))).toMatchObject({ usable: false, reason: "no_history_period" });
    expect(statedFloodHistory(extraction({ floodHistoryYears: said(10) }))).toMatchObject({ usable: false, reason: "no_loss_amounts" });
  });
});

// --- the starter kit -----------------------------------------------------------------------------

const KIT = join(__dirname, "..", "..", "data", "data");

function filesUnder(root: string): FileSource[] {
  const out: FileSource[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        out.push({
          path: relative(root, full).replaceAll("\\", "/"),
          size: statSync(full).size,
          text: async () => readFileSync(full, "utf8"),
          arrayBuffer: async () => {
            const b = readFileSync(full);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
          },
        });
      }
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!existsSync(KIT))("the six loss drivers on the Nairobi starter kit", () => {
  const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;
  let dataset: Dataset;
  let state: DrainageState;
  /** A point the terrain maps flood, one they leave dry and out of reach of drainage, and one the drainage zone reaches. */
  let wet: { lat: number; lon: number };
  let dry: { lat: number; lon: number };
  let ponded: { lat: number; lon: number };

  const building = (p: { lat: number; lon: number }, tivKes = 2_000_000_000): DriverBuilding => ({ lon: p.lon, lat: p.lat, housingClass: "concrete_rcc", tivKes });
  const row = (b: DriverBuilding, i: number): PricingRow => ({ index: i, locId: `OFFER-${i + 1}`, name: `Building ${i + 1}`, path: "rules", location: { kind: "exact", lat: b.lat, lon: b.lon, reading: null }, housingClass: b.housingClass, floorAreaM2: null, costPerM2Kes: null, tivKes: b.tivKes, tivFrom: "stated", blockers: [] });

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const widest = dataset.rasters.find((r) => r.scenarioId === dataset.scenarios[dataset.scenarios.length - 1].id)!;
    const narrowest = dataset.rasters.find((r) => r.scenarioId === dataset.scenarios[0].id)!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, geo<WaterwayProps>("waterways.geojson"), geo<SettlementProps>("informal-settlements.geojson"));
    state = { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) };
    const value = (p: { lat: number; lon: number }, m = widest) => sampleRaster(m, p.lon, p.lat, "score").value;
    const stress = (p: { lat: number; lon: number }) => stressAt(sampleGrid(distances.grid, distances.toDrain, p.lon, p.lat), sampleGrid(distances.grid, distances.toSettlement, p.lon, p.lat), DRAINAGE_DEFAULTS.reachM);
    wet = dataset.buildings.find((b) => value(b, narrowest) > 0)!;
    dry = dataset.buildings.find((b) => value(b) === 0 && stress(b) === 0)!;
    ponded = dataset.buildings.find((b) => value(b) === 0 && stress(b) > 0)!;
    for (const p of [wet, dry, ponded]) expect(p).toBeTruthy();
  }, 120_000);

  it("matches the engine's point pricing to the last decimal with Depth only, with and without drainage", () => {
    const e = extraction(STATED);
    for (const drainage of [null, state]) {
      const maps = drainage ? withDrainage({ ...dataset, buildings: [] }, drainage) : dataset;
      for (const list of [[building(wet)], [building(dry)], [building(ponded)], [building(wet), building(ponded, 500_000_000), building(dry, 300_000_000)]]) {
        const policy = policyTerms(e.terms, DEFAULT_TERMS);
        const engine = priceOffer({ dataset, params: REFERENCE_PARAMS, drainage, rows: list.map(row), terms: policy, wards: null });
        const totals = engine.totals!;
        const d = priced(offerDrivers({ dataset: maps, params: REFERENCE_PARAMS, building: list[0], others: list.slice(1), extraction: e, terms: policy, judgement: REFERENCE_JUDGEMENT, mode: "depth_only" }));
        expect(d.perReturnPeriod.map((r) => r.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
        d.perReturnPeriod.forEach((r, k) => {
          expect(r.groundUpTotalKes).toBe(totals.scenarios[k].groundUpKes);
          expect(r.grossKes).toBe(totals.scenarios[k].grossKes);
        });
        expect(d.aal.groundUpTotalKes).toBe(totals.aalGroundUpKes);
        expect(d.aal.grossTotalKes).toBe(totals.aalGrossKes);
        expect(d.premium.floodRatePerMille).toBe(totals.ratePerMilleGross);
        // The followed building's own reading is the engine's row.
        const first = engine.rows[0];
        if (first.status !== "priced") throw new Error("the row should be priced");
        d.perReturnPeriod.forEach((r, k) => {
          expect(r.depths.pointM).toBe(first.scenarios[k].terrainM);
          expect(r.depths.pondingM).toBe(first.scenarios[k].drainageM);
          expect(r.depths.surfaceM).toBe(first.scenarios[k].depthM);
          expect(r.building.damageRatio).toBe(first.scenarios[k].damageRatio);
          expect(r.building.groundUpTotalKes).toBe(first.scenarios[k].groundUpKes);
          expect(r.building.grossKes).toBe(first.scenarios[k].grossKes);
        });
      }
    }
  });

  it("never prices below Depth only, and adds every driver up at every return period", () => {
    const e = extraction(STATED);
    const policy = policyTerms(e.terms, DEFAULT_TERMS);
    const maps = withDrainage({ ...dataset, buildings: [] }, state);
    for (const p of [wet, dry, ponded]) {
      const input = { dataset: maps, params: REFERENCE_PARAMS, building: building(p), extraction: e, terms: policy, judgement: REFERENCE_JUDGEMENT };
      const all = priced(offerDrivers({ ...input, mode: "all_drivers" }));
      const point = priced(offerDrivers({ ...input, mode: "depth_only" }));
      all.perReturnPeriod.forEach((r, k) => {
        expect(r.groundUpTotalKes).toBeGreaterThanOrEqual(point.perReturnPeriod[k].groundUpTotalKes);
        expect(r.depths.bufferM).toBeGreaterThanOrEqual(r.depths.pointM);
        expect(r.depths.surfaceM).toBe(Math.max(r.depths.bufferM, r.depths.pondingM, r.depths.overloadM));
        close(r.structureKes, r.groundUpKes.surrounding + r.groundUpKes.ponding + r.groundUpKes.overload);
        close(r.groundUpTotalKes, DRIVER_IDS.reduce((t, id) => t + r.groundUpKes[id], 0));
        close(r.groundUpTotalKes - r.deductibleKes - r.overLimitKes, r.grossKes);
        for (const id of DRIVER_IDS) expect(r.groundUpKes[id]).toBeGreaterThanOrEqual(0);
        // The reading at the point is the same in both modes: only what is added differs.
        expect(r.depths.pointM).toBe(point.perReturnPeriod[k].depths.pointM);
        expect(r.depths.pondingM).toBe(point.perReturnPeriod[k].depths.pondingM);
      });
      expect(all.aal.groundUpTotalKes).toBeGreaterThan(point.aal.groundUpTotalKes);
      // Drains taken as built for 1-in-25: overloaded in the three rarer floods, wherever the building is.
      expect(all.perReturnPeriod.map((r) => r.depths.overloaded)).toEqual([false, false, true, true, true]);
    }
    // A building wet at its point, read at the point alone: taking the value below ground off the curve never
    // makes it cheaper than Depth only, whatever share is below ground and with no loading on top.
    const basementsOnly = extraction({ basements: said(2, "The building has two basement levels.") });
    for (const figures of [{ bufferRadiusM: 0, belowGroundShare: 0.3 }, { bufferRadiusM: 0, uncertaintyLoading: 0 }, { bufferRadiusM: 0, uncertaintyLoading: 0, belowGroundShare: 0.5, ingressThresholdM: 0.5 }]) {
      const input = { dataset: maps, params: REFERENCE_PARAMS, building: building(wet, 1_000_000_000), extraction: basementsOnly, terms: policy, judgement: { ...REFERENCE_JUDGEMENT, ...figures } };
      const all = priced(offerDrivers({ ...input, mode: "all_drivers" }));
      const point = priced(offerDrivers({ ...input, mode: "depth_only" }));
      all.perReturnPeriod.forEach((r, k) => expect(r.groundUpTotalKes, JSON.stringify(figures)).toBeGreaterThanOrEqual(point.perReturnPeriod[k].groundUpTotalKes - 1e-6));
    }

    // The dry building: nothing at the point, and a loss from the drains and the basement all the same.
    const dryAll = priced(offerDrivers({ dataset, params: REFERENCE_PARAMS, building: building(dry), extraction: e, terms: policy, judgement: REFERENCE_JUDGEMENT, mode: "all_drivers" }));
    expect(dryAll.perReturnPeriod.every((r) => r.depths.pointM === 0)).toBe(true);
    expect(dryAll.aal.groundUpKes.basement).toBeGreaterThan(0);
    expect(dryAll.firstReturnPeriod.basement).not.toBeNull();
    expect(dryAll.premium.floodRatePerMille).toBeGreaterThan(0);
  });
});
