import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import {
  answerKey,
  assembleAssumptions,
  evaluate,
  flattenAssumptions,
  GROUPS,
  liveKeys,
  offerTarget,
  shapley,
  shapleyAsync,
  SHAPLEY_TITLE,
  shapleyMethodLine,
  SWING_IDS,
  swingAssumptions,
  swingRange,
  tornado,
  TORNADO_TITLE,
  tornadoMethodLine,
  tornadoPlan,
  type Assumptions,
  type OfferTarget,
  type PortfolioTarget,
  type SwingId,
  type Target,
  type TornadoRow,
} from "../src/lib/interpret";
import { BOUNDS, enforceBounds, REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import { SCORE_TIERS, type Building, type Dataset, type ModelParams, type Raster } from "../src/lib/model/types";
import { offerDrivers, type DriverBuilding } from "../src/lib/offer/drivers";
import type { PricedFocus } from "../src/lib/offer/focus";
import { BASEMENT_LADDER, enforceJudgement, JUDGEMENT_BOUNDS, REFERENCE_JUDGEMENT, type OfferJudgement } from "../src/lib/offer/judgement";
import type { OfferExtraction, OfferTerms, PolicyTerms, Quoted } from "../src/lib/offer/types";

// Every building, map, figure and sentence here is invented. No model is called and nothing is fetched.

const REF: Assumptions = { params: REFERENCE_PARAMS, judgement: REFERENCE_JUDGEMENT };
const judge = (more: Partial<OfferJudgement>): OfferJudgement => enforceJudgement({ ...REFERENCE_JUDGEMENT, ...more }).judgement;
const params = (more: { depthScaleM?: number; fragility?: Partial<ModelParams["fragility"]>; cap?: Partial<ModelParams["cap"]>; returnPeriods?: Partial<ModelParams["returnPeriods"]> }): ModelParams =>
  enforceBounds({
    ...REFERENCE_PARAMS,
    ...more,
    fragility: { ...REFERENCE_PARAMS.fragility, ...(more.fragility ?? {}) },
    cap: { ...REFERENCE_PARAMS.cap, ...(more.cap ?? {}) },
    returnPeriods: { ...REFERENCE_PARAMS.returnPeriods, ...(more.returnPeriods ?? {}) },
  }).params;
const close = (a: number, b: number, tolerance = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(a), Math.abs(b)));

// --- a score portfolio with every tier --------------------------------------------------------

const building = (locId: string, housingClass: Building["housingClass"], tivKes: number, hazard: number[], where = { lat: 0, lon: 0 }): Building => ({
  locId,
  ...where,
  housingClassRaw: housingClass,
  housingClass,
  floorAreaM2: null,
  costPerM2Kes: null,
  tivKes,
  synthetic: true,
  hazard,
});

/** Five tiers, no maps: depth from the columns, drain overload from the tier return periods. */
const SCORES: Dataset = {
  name: "scores",
  hazardKind: "score",
  scenarios: SCORE_TIERS.map((t) => ({ id: t, label: t })),
  hotspots: [],
  rasters: [],
  buildings: [
    building("A", "informal_iron_sheet", 1_000, [0, 0, 0.1, 0.2, 0.3]),
    building("B", "concrete_rcc", 100_000, [0.1, 0.2, 0.3, 0.4, 0.5]),
    building("C", "permanent_masonry", 50_000, [0, 0.05, 0.1, 0.2, 0.4]),
    building("D", "semi_permanent", 20_000, [0, 0, 0, 0.1, 0.25]),
  ],
};
const scores: PortfolioTarget = { kind: "portfolio", dataset: SCORES };

// --- a depth portfolio with maps, as in drivers.test.ts -----------------------------------------

const BBOX: [number, number, number, number] = [0, 0, 0.005, 0.005];
const map = (scenarioId: string, wet: [row: number, col: number, value: number][], bbox = BBOX): Raster => {
  const data = new Float32Array(25);
  for (const [row, col, value] of wet) data[row * 5 + col] = value;
  return { scenarioId, fileName: `${scenarioId}.tif`, width: 5, height: 5, bbox, data, noData: null };
};
const at = (row: number, col: number) => ({ lon: (col + 0.5) * 0.001, lat: 0.005 - (row + 0.5) * 0.001 });

const DEPTHS: Dataset = {
  name: "depths",
  hazardKind: "depth_m",
  scenarios: [
    { id: "rp25", label: "25 years", fixedReturnPeriod: 25 },
    { id: "rp50", label: "50 years", fixedReturnPeriod: 50 },
  ],
  hotspots: [],
  rasters: [map("rp25", [[2, 4, 0.5]]), map("rp50", [[2, 2, 0.25], [2, 4, 1]])],
  buildings: [building("A", "permanent_masonry", 1_000_000, [0, 0.25], at(2, 2)), building("B", "permanent_masonry", 1_000_000, [0, 0], at(0, 0))],
};
const depths: PortfolioTarget = { kind: "portfolio", dataset: DEPTHS };

// --- an offer on a hand-made map, as in offerDrivers.test.ts ----------------------------------

const said = <T,>(value: T, quote = "an invented sentence"): Quoted<T> => ({ value, quote, status: "verified", reason: null });
const missing = <T,>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });
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
const extraction = (values: Partial<OfferTerms> = {}): OfferExtraction => ({ rows: [], terms: terms(values), notes: [] });
const EXAMPLE: PolicyTerms = { deductible: { source: "example", share: 0.02, minKes: 50_000 }, limit: { source: "example", share: 1 } };

const HBOX: [number, number, number, number] = [36.8, -1.3, 36.82, -1.28];
const SIZE = 20;
const centre = (row: number, col: number) => ({ lon: HBOX[0] + ((col + 0.5) / SIZE) * (HBOX[2] - HBOX[0]), lat: HBOX[3] - ((row + 0.5) / SIZE) * (HBOX[3] - HBOX[1]) });
function handMap(scenarioId: string, wet: [number, number, number][]): Raster {
  const data = new Float32Array(SIZE * SIZE);
  for (const [row, col, depth] of wet) data[row * SIZE + col] = depth;
  return { scenarioId, fileName: `${scenarioId}.tif`, width: SIZE, height: SIZE, bbox: HBOX, data, noData: null };
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
  rasters: [handMap("rp10", []), handMap("rp50", [[10, 12, 1]]), handMap("rp250", [[10, 12, 2], [10, 10, 0.5]])],
};
const SITE: DriverBuilding = { ...centre(10, 10), housingClass: "concrete_rcc", tivKes: 1_000_000_000 };
/** Two basements, plant below ground, interruption covered: every driver in play. */
const STATED: Partial<OfferTerms> = {
  basements: said(2, "The building has two basement levels."),
  valueBelowGroundKes: said(100_000_000, "Plant and contents in the basements are valued at KES 100,000,000."),
  biCovered: said("covered", "Loss of rent is to be insured."),
  annualRentKes: said(73_000_000, "Annual rent roll KES 73,000,000."),
};
const offer: OfferTarget = { kind: "offer", offer: { dataset: HAND, building: SITE, extraction: extraction(STATED), terms: EXAMPLE } };
/** The same building with a basement and nothing stated about its value or its rent: the assumed shares are in force. */
const assumedOffer: OfferTarget = { kind: "offer", offer: { dataset: HAND, building: SITE, extraction: extraction({ basements: said(2, "Two basement levels."), biCovered: said("covered", "Loss of rent is to be insured.") }), terms: EXAMPLE } };
/** The same offer on score maps with every tier, so the depth scale and the tier return periods act as well. */
const scoreOffer: OfferTarget = {
  kind: "offer",
  offer: {
    ...assumedOffer.offer,
    dataset: {
      ...HAND,
      hazardKind: "score",
      scenarios: SCORE_TIERS.map((t) => ({ id: t, label: t })),
      rasters: SCORE_TIERS.map((t, k) => handMap(t, [[10, 12, 0.2 * (k + 1)], [10, 10, 0.1 * k]])),
    },
  },
};

/** A set that differs from the reference in every group. */
const EVERYWHERE: Assumptions = {
  params: params({ depthScaleM: 3, fragility: { informal_iron_sheet: 2, concrete_rcc: 0.9 }, cap: { concrete_rcc: 0.7, semi_permanent: 0.95 }, returnPeriods: { extreme: 8, common: 300 } }),
  judgement: judge({ bufferRadiusM: 400, drainDesignRp: 10, drainOverloadDepthM: 0.2, ingressThresholdM: 0.05, basementDamageCommon: 0.9, belowGroundShare: 0.12, outageDaysCommon: 60, annualRentShare: 0.1, uncertaintyLoading: 0.2 }),
};

const ALL = { mode: "all_drivers" } as const;
const DEPTH_ONLY = { mode: "depth_only" } as const;

/** The stated range of a swing, from the bounds the agents are held to. */
const statedBounds = (id: SwingId): { min: number; max: number } => {
  if (id === "depthScaleM") return BOUNDS.depthScaleM;
  if (id.startsWith("returnPeriods.")) return BOUNDS.returnPeriod;
  if (id.startsWith("fragility.")) return BOUNDS.fragility;
  if (id.startsWith("cap.")) return BOUNDS.cap;
  if (id === "offer.basementLadder") return { min: Math.min(...BASEMENT_LADDER.map((k) => JUDGEMENT_BOUNDS[k].min)), max: Math.max(...BASEMENT_LADDER.map((k) => JUDGEMENT_BOUNDS[k].max)) };
  return JUDGEMENT_BOUNDS[id.slice("offer.".length) as keyof OfferJudgement];
};
const each = (v: number | number[]): number[] => (Array.isArray(v) ? v : [v]);

describe("the evaluator", () => {
  it("reads the portfolio's answer the way the figures row does", () => {
    for (const target of [scores, depths]) {
      for (const mode of ["depth_only", "all_drivers"] as const) {
        const result = runModel(target.dataset, REFERENCE_PARAMS, { mode, judgement: REFERENCE_JUDGEMENT });
        const answer = evaluate(target, REF, mode);
        expect(answer.loss100Kes).toBe(result.standardLosses.find((s) => s.returnPeriod === 100)!.lossKes);
        expect(answer.aalKes).toBe(result.aalKes);
      }
    }
    expect(evaluate(scores, REF, "all_drivers").aalKes).toBeGreaterThan(evaluate(scores, REF, "depth_only").aalKes);
  });

  it("reads the offer's own ground-up figures from its loss drivers", () => {
    for (const mode of ["depth_only", "all_drivers"] as const) {
      const d = offerDrivers({ dataset: HAND, params: REFERENCE_PARAMS, building: SITE, extraction: extraction(STATED), terms: EXAMPLE, judgement: REFERENCE_JUDGEMENT, mode })!;
      expect(evaluate(offer, REF, mode)).toEqual({ loss100Kes: d.loss100.groundUpKes, aalKes: d.aal.groundUpTotalKes });
    }
    expect(evaluate(offer, REF, "all_drivers").aalKes).toBeGreaterThan(evaluate(offer, REF, "depth_only").aalKes);
  });

  it("returns the same object for the same assumptions, and for a change that cannot reach the answer", () => {
    const first = evaluate(scores, REF, "all_drivers");
    expect(evaluate(scores, { params: { ...REFERENCE_PARAMS }, judgement: { ...REFERENCE_JUDGEMENT } }, "all_drivers")).toBe(first);
    // The portfolio never reads the basement threshold; under Depth only it reads no judgement figure at all.
    expect(evaluate(scores, { params: REFERENCE_PARAMS, judgement: judge({ ingressThresholdM: 0.4 }) }, "all_drivers")).toBe(first);
    const depthOnly = evaluate(scores, REF, "depth_only");
    expect(evaluate(scores, { params: REFERENCE_PARAMS, judgement: judge({ bufferRadiusM: 0, drainDesignRp: 2 }) }, "depth_only")).toBe(depthOnly);
    expect(depthOnly).not.toBe(first);
    // A figure that does reach it gives another answer.
    const moved = evaluate(scores, { params: REFERENCE_PARAMS, judgement: judge({ drainDesignRp: 5 }) }, "all_drivers");
    expect(moved).not.toBe(first);
    expect(moved.aalKes).toBeGreaterThan(first.aalKes);
    expect(answerKey(scores, REF, "all_drivers")).not.toBe(answerKey(scores, { params: REFERENCE_PARAMS, judgement: judge({ drainDesignRp: 5 }) }, "all_drivers"));
  });

  it("names the assumptions that can move the answer, and no others", () => {
    const portfolioAll = liveKeys(scores, "all_drivers");
    expect(portfolioAll).toContain("depthScaleM");
    expect(portfolioAll).toContain("returnPeriods.severe");
    expect(portfolioAll).toContain("offer.bufferRadiusM");
    expect(portfolioAll).toContain("offer.drainDesignRp");
    expect(portfolioAll).toContain("offer.drainOverloadDepthM");
    expect(portfolioAll).not.toContain("offer.ingressThresholdM");
    expect(portfolioAll).not.toContain("offer.uncertaintyLoading");
    expect(liveKeys(scores, "depth_only").filter((k) => k.startsWith("offer."))).toEqual([]);
    // Measured depths with their own return periods: the depth scale and the tiers are not read.
    const depthAll = liveKeys(depths, "all_drivers");
    expect(depthAll).not.toContain("depthScaleM");
    expect(depthAll.filter((k) => k.startsWith("returnPeriods."))).toEqual([]);
    expect(depthAll).toContain("fragility.concrete_rcc");
    // An offer reads every figure but the two that only enter the premium.
    const offerAll = liveKeys(offer, "all_drivers");
    expect(offerAll).toContain("offer.ingressThresholdM");
    expect(offerAll).toContain("offer.uncertaintyLoading");
    expect(offerAll).not.toContain("offer.costOfCapital");
    expect(offerAll).not.toContain("offer.minimumRatePerMille");
  });

  it("flattens and assembles a set without losing a figure", () => {
    const flat = flattenAssumptions(EVERYWHERE);
    expect(flat["fragility.informal_iron_sheet"]).toBe(2);
    expect(flat["offer.bufferRadiusM"]).toBe(400);
    expect(assembleAssumptions(flat, REF)).toEqual(EVERYWHERE);
    expect(assembleAssumptions({}, REF)).toEqual(REF);
  });

  it("builds the offer target from a priced focus the way buildOfferFocus feeds the drivers", () => {
    const rows = [
      { locId: "OFFER-1", name: "Head office", tivKes: 1_000_000_000 },
      { locId: "OFFER-2", name: "Store", tivKes: 500_000_000 },
    ];
    const pricedRow = (locId: string, where: { lon: number; lat: number }, tivKes: number) => ({
      status: "priced",
      locId,
      name: locId,
      location: { kind: "coordinates", lon: where.lon, lat: where.lat },
      housingClass: "concrete_rcc",
      tivKes,
      scenarios: HAND.scenarios.map((s) => ({ id: s.id, drainageM: 0 })),
    });
    const focus = {
      building: { locId: "OFFER-1" },
      rows,
      extraction: extraction(STATED),
      terms: { policy: EXAMPLE },
      pricing: { rows: [pricedRow("OFFER-1", centre(10, 10), 1_000_000_000), { status: "outside", locId: "OFFER-3" }, pricedRow("OFFER-2", centre(2, 2), 500_000_000)] },
    } as unknown as PricedFocus;
    const target = offerTarget(focus, HAND);
    expect(target.offer.building).toMatchObject({ ...centre(10, 10), housingClass: "concrete_rcc", tivKes: 1_000_000_000, name: "Head office", pondingM: { rp10: 0, rp50: 0, rp250: 0 } });
    expect(target.offer.others).toHaveLength(1);
    expect(target.offer.others![0]).toMatchObject({ ...centre(2, 2), tivKes: 500_000_000, name: "Store" });
    expect(target.offer.offerTivKes).toBe(1_500_000_000);
    expect(target.offer.terms).toBe(EXAMPLE);
    const d = offerDrivers({ dataset: HAND, params: REFERENCE_PARAMS, building: target.offer.building, others: target.offer.others, extraction: target.offer.extraction, terms: EXAMPLE, judgement: REFERENCE_JUDGEMENT, mode: "all_drivers", offerTivKes: 1_500_000_000 })!;
    expect(evaluate(target, REF, "all_drivers")).toEqual({ loss100Kes: d.loss100.groundUpKes, aalKes: d.aal.groundUpTotalKes });
  });
});

describe("the tornado", () => {
  it("carries its title and swings each assumption across its stated range, largest swing first", () => {
    expect(TORNADO_TITLE).toBe("Which assumptions move the answer most");
    const rows = tornado(scores, REF, ALL);
    expect(rows.map((r) => r.id).sort()).toEqual(["depthScaleM", ...SCORE_TIERS.map((t) => `returnPeriods.${t}`), ...Object.keys(REFERENCE_PARAMS.fragility).map((c) => `fragility.${c}`), ...Object.keys(REFERENCE_PARAMS.cap).map((c) => `cap.${c}`), "offer.bufferRadiusM", "offer.drainDesignRp"].sort());
    const base = evaluate(scores, REF, "all_drivers");
    for (const row of rows) {
      const { min, max } = statedBounds(row.id);
      expect(row.rangeMin).toBeGreaterThanOrEqual(min);
      expect(row.rangeMax).toBeLessThanOrEqual(max);
      for (const v of each(row.lowValue)) expect(v).toBeGreaterThanOrEqual(row.rangeMin);
      for (const v of each(row.highValue)) expect(v).toBeLessThanOrEqual(row.rangeMax);
      expect(row.low.aalChangeKes).toBe(row.low.aalKes - base.aalKes);
      expect(row.high.loss100ChangeKes).toBe(row.high.loss100Kes! - base.loss100Kes!);
      expect(row.swing.aalKes).toBeGreaterThanOrEqual(Math.abs(row.low.aalChangeKes));
      expect(row.swing.aalKes).toBeGreaterThanOrEqual(Math.abs(row.high.aalChangeKes));
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.unit.length).toBeGreaterThan(0);
      expect(row.lowText).not.toBe("");
    }
    const order = rows.map((r) => r.swing.loss100Kes!);
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    // Deeper water raises the loss and shallower water lowers it.
    expect(rows.find((r) => r.id === "depthScaleM")!.high.aalChangeKes).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === "depthScaleM")!.low.aalChangeKes).toBeLessThan(0);
    expect(tornadoMethodLine(rows)).toContain(`${rows.length} assumptions`);
    expect(tornadoMethodLine(rows)).toContain(`${2 * rows.length} runs`);
    // Ordered by the average annual loss when asked.
    const byAal = tornado(scores, REF, { ...ALL, sortBy: "aal" }).map((r) => r.swing.aalKes);
    expect([...byAal].sort((a, b) => b - a)).toEqual(byAal);
  });

  it("leaves out what cannot move the answer, and says why", () => {
    const plan = tornadoPlan(scores, REF, ALL);
    expect(plan.leftOut.map((x) => x.id).sort()).toEqual(["offer.basementLadder", "offer.ingressThresholdM", "offer.uncertaintyLoading"]);
    for (const x of plan.leftOut) expect(x.why).toContain("portfolio");
    const depthOnly = tornadoPlan(scores, REF, DEPTH_ONLY);
    expect(depthOnly.swung.map((s) => s.id).some((id) => id.startsWith("offer."))).toBe(false);
    expect(depthOnly.leftOut.find((x) => x.id === "offer.bufferRadiusM")!.why).toContain("Depth only");
    // Measured depths carry their own return periods: the depth scale and the tiers are left out, not shown as zero.
    const measured = tornadoPlan(depths, REF, ALL);
    expect(measured.swung.map((s) => s.id)).not.toContain("depthScaleM");
    expect(measured.swung.map((s) => s.id).some((id) => id.startsWith("returnPeriods."))).toBe(false);
    expect(measured.leftOut.find((x) => x.id === "depthScaleM")!.why).toContain("data set");
    // An offer on score maps with every tier swings every assumption listed; on measured depths the depth scale and the tiers are left out.
    expect(tornadoPlan(scoreOffer, REF, ALL).swung.map((s) => s.id)).toEqual([...SWING_IDS]);
    expect(tornadoPlan(offer, REF, ALL).swung.map((s) => s.id)).toEqual(SWING_IDS.filter((id) => id !== "depthScaleM" && !id.startsWith("returnPeriods.")));
  });

  it("keeps a tier between its neighbours, and gives a zero swing where that leaves a single value", () => {
    const severe = swingRange("returnPeriods.severe", REF);
    expect(severe).toMatchObject({ min: 11, max: 49 });
    expect(severe.note).toContain("rarer than the extreme tier (10 years)");
    expect(severe.note).toContain("more frequent than the moderate tier (50 years)");
    expect(swingRange("returnPeriods.extreme", REF)).toMatchObject({ min: BOUNDS.returnPeriod.min, max: 24 });
    expect(swingRange("returnPeriods.common", REF)).toMatchObject({ min: 101, max: BOUNDS.returnPeriod.max });
    // Tiers one year apart leave the middle one no room: its range is one value and its swing is zero.
    const pinned: Assumptions = { params: params({ returnPeriods: { extreme: 10, severe: 11, moderate: 12 } }), judgement: REFERENCE_JUDGEMENT };
    expect(swingRange("returnPeriods.severe", pinned)).toMatchObject({ min: 11, max: 11 });
    const row = tornado(scores, pinned, ALL).find((r) => r.id === "returnPeriods.severe")!;
    expect(row.lowValue).toBe(11);
    expect(row.highValue).toBe(11);
    expect(row.swing).toEqual({ loss100Kes: 0, aalKes: 0 });
    expect(row.low).toEqual(row.high);
    expect(row.low.aalChangeKes).toBe(0);
    expect(row.low.loss100ChangeKes).toBe(0);
    // Every tier swing on every row stays in order with its neighbours.
    for (const r of tornado(scores, REF, ALL).filter((x) => x.id.startsWith("returnPeriods."))) {
      for (const side of [r.lowValue, r.highValue] as number[]) {
        const swung = swingAssumptions(r.id, REF, side);
        expect(enforceBounds(swung.params).adjustments).toEqual([]);
      }
    }
  });

  it("swings the basement ladder as one assumption and keeps it rising", () => {
    const rows = tornado(offer, REF, ALL);
    const ladder = rows.find((r) => r.id === "offer.basementLadder")!;
    expect(ladder.baseValue).toEqual(BASEMENT_LADDER.map((k) => REFERENCE_JUDGEMENT[k]));
    expect(ladder.lowValue).toEqual([0, 0, 0, 0, 0]);
    expect(ladder.highValue).toEqual([1, 1, 1, 1, 1]);
    expect(ladder.baseText).toBe("0.15 / 0.25 / 0.4 / 0.55 / 0.7");
    expect(ladder.lowText).toBe("0 / 0 / 0 / 0 / 0");
    expect(ladder.note).toContain("keeps rising");
    for (const side of [ladder.lowValue, ladder.highValue]) {
      const swung = swingAssumptions("offer.basementLadder", REF, side);
      const rungs = BASEMENT_LADDER.map((k) => swung.judgement[k]);
      expect(rungs).toEqual(side);
      for (let i = 1; i < rungs.length; i++) expect(rungs[i]).toBeGreaterThanOrEqual(rungs[i - 1]);
      expect(enforceJudgement(swung.judgement).adjustments).toEqual([]);
    }
    // One number sets every rung.
    expect(BASEMENT_LADDER.map((k) => swingAssumptions("offer.basementLadder", REF, 0.5).judgement[k])).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
    // The value below ground is never lost in a smaller share than the structure, so the bottom of the ladder still prices something and the top prices more.
    expect(ladder.high.aalChangeKes).toBeGreaterThan(0);
    expect(ladder.low.aalChangeKes).toBeLessThanOrEqual(0);
    // Every offer swing stays inside its range, and the judgement at each end needs no correction.
    for (const row of rows) {
      const { min, max } = statedBounds(row.id);
      for (const v of [...each(row.lowValue), ...each(row.highValue)]) {
        expect(v).toBeGreaterThanOrEqual(min);
        expect(v).toBeLessThanOrEqual(max);
      }
      for (const side of [row.lowValue, row.highValue]) expect(enforceJudgement(swingAssumptions(row.id, REF, side).judgement).adjustments).toEqual([]);
    }
    const uncertainty = rows.find((r) => r.id === "offer.uncertaintyLoading")!;
    expect(uncertainty.low.aalChangeKes).toBeLessThan(0);
    expect(uncertainty.high.aalChangeKes).toBeGreaterThan(0);
  });

  it("notes a drain design return period the offer states itself, which the swing cannot move", () => {
    const statedDrains: Target = { kind: "offer", offer: { ...offer.offer, extraction: extraction({ ...STATED, drainDesignRp: said(100, "Storm drains designed for a 1-in-100 event.") }) } };
    const row = tornado(statedDrains, REF, ALL).find((r) => r.id === "offer.drainDesignRp")!;
    expect(row.note).toContain("states its drain design return period");
    expect(row.swing).toEqual({ loss100Kes: 0, aalKes: 0 });
    expect(tornado(offer, REF, ALL).find((r) => r.id === "offer.drainDesignRp")!.note).toBeNull();
  });
});

describe("exact Shapley values", () => {
  it("carries its label and adds up to the whole change, with the groups that cannot act dropped and explained", () => {
    expect(SHAPLEY_TITLE).toBe("How much of the AI's change each assumption accounts for (exact Shapley values)");
    const result = shapley(scores, REF, EVERYWHERE, ALL);
    // The portfolio reads six groups; basement and interruption never reach it.
    expect(result.groups.map((g) => g.id).sort()).toEqual(["buffer", "caps", "depthScale", "drainOverload", "fragility", "returnPeriods"]);
    expect(result.evaluations).toBe(64);
    expect(result.dropped.map((d) => d.id).sort()).toEqual(["basement", "interruptionUncertainty"]);
    for (const d of result.dropped) expect(d.why).toContain("portfolio");
    close(result.sumAalKes, result.totalAalKes);
    close(result.sumLoss100Kes!, result.totalLoss100Kes!);
    expect(result.reference).toBe(evaluate(scores, REF, "all_drivers"));
    expect(result.agreed).toBe(evaluate(scores, EVERYWHERE, "all_drivers"));
    expect(result.totalAalKes).toBe(result.agreed.aalKes - result.reference.aalKes);
    // The buffer changed, but with no maps it cannot find deeper water: its exact value is zero.
    expect(result.groups.find((g) => g.id === "buffer")!.aalKes).toBe(0);
    expect(result.groups.find((g) => g.id === "buffer")!.keysChanged).toEqual(["offer.bufferRadiusM"]);
    expect(result.groups.find((g) => g.id === "fragility")!.keysChanged.sort()).toEqual(["fragility.concrete_rcc", "fragility.informal_iron_sheet"]);
    // Largest absolute value first.
    const sizes = result.groups.map((g) => Math.abs(g.loss100Kes!));
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(shapleyMethodLine(result)).toContain("64 combinations");
    expect(shapleyMethodLine(result)).toContain("6 groups");
  });

  it("matches the formula worked by hand for two groups", () => {
    const agreed: Assumptions = { params: params({ depthScaleM: 3, fragility: { concrete_rcc: 1.1 } }), judgement: REFERENCE_JUDGEMENT };
    const result = shapley(scores, REF, agreed, DEPTH_ONLY);
    expect(result.evaluations).toBe(4);
    const v = (depthScaleM: number, concrete: number) => evaluate(scores, { params: params({ depthScaleM, fragility: { concrete_rcc: concrete } }), judgement: REFERENCE_JUDGEMENT }, "depth_only").aalKes;
    const none = v(4, 0.7);
    const d = v(3, 0.7);
    const f = v(4, 1.1);
    const both = v(3, 1.1);
    close(result.groups.find((g) => g.id === "depthScale")!.aalKes, 0.5 * (d - none + (both - f)));
    close(result.groups.find((g) => g.id === "fragility")!.aalKes, 0.5 * (f - none + (both - d)));
    close(result.sumAalKes, both - none);
    expect(result.dropped.find((x) => x.id === "caps")!.why).toContain("same value");
    expect(result.dropped.find((x) => x.id === "buffer")!.why).toContain("Depth only");
  });

  it("gives every group zero, from the base alone, when the two sets are the same", () => {
    for (const target of [scores, depths, offer]) {
      const result = shapley(target, REF, { params: { ...REFERENCE_PARAMS }, judgement: { ...REFERENCE_JUDGEMENT } }, ALL);
      expect(result.groups).toEqual([]);
      expect(result.evaluations).toBe(1);
      expect(result.runs).toBeLessThanOrEqual(1);
      expect(result.dropped).toHaveLength(GROUPS.length);
      expect(result.totalAalKes).toBe(0);
      expect(result.totalLoss100Kes).toBe(0);
      expect(result.sumAalKes).toBe(0);
      expect(result.sumLoss100Kes).toBe(0);
      expect(shapleyMethodLine(result)).toContain("no change to attribute");
    }
    // A set that differs only in figures the target never reads is the same set to it.
    const offerOnly: Assumptions = { params: REFERENCE_PARAMS, judgement: judge({ ingressThresholdM: 0.3, uncertaintyLoading: 0.4 }) };
    expect(shapley(scores, REF, offerOnly, ALL).evaluations).toBe(1);
    expect(shapley(offer, REF, offerOnly, DEPTH_ONLY).evaluations).toBe(1);
    expect(shapley(offer, REF, offerOnly, ALL).evaluations).toBe(4);
  });

  it("runs every one of the 256 combinations for an offer where all eight groups changed", () => {
    for (const target of [offer, assumedOffer]) {
      const result = shapley(target, REF, EVERYWHERE, ALL);
      // The hand-made map carries measured depths with their own return periods, so neither the depth scale nor the tiers can act; every other group does.
      expect(result.groups).toHaveLength(6);
      expect(result.evaluations).toBe(64);
      expect(result.dropped.map((d) => d.id)).toEqual(["depthScale", "returnPeriods"]);
      close(result.sumAalKes, result.totalAalKes);
      close(result.sumLoss100Kes!, result.totalLoss100Kes!);
      expect(result.totalAalKes).not.toBe(0);
    }
    // On score maps with every tier the other two groups act too: the full 256.
    const full = shapley(scoreOffer, REF, EVERYWHERE, ALL);
    expect(full.groups).toHaveLength(8);
    expect(full.evaluations).toBe(256);
    expect(full.dropped).toEqual([]);
    close(full.sumAalKes, full.totalAalKes);
    close(full.sumLoss100Kes!, full.totalLoss100Kes!);
  });

  it("gives the same values asynchronously, reports progress, and stops when cancelled", async () => {
    const sync = shapley(depths, REF, EVERYWHERE, ALL);
    expect(sync.evaluations).toBe(16);
    const seen: [number, number][] = [];
    const async = await shapleyAsync(depths, REF, EVERYWHERE, { ...ALL, budgetMs: 0, onProgress: (done, total) => seen.push([done, total]) });
    expect(async.groups).toEqual(sync.groups);
    expect(async.totalAalKes).toBe(sync.totalAalKes);
    expect(async.sumLoss100Kes).toBe(sync.sumLoss100Kes);
    expect(async.evaluations).toBe(sync.evaluations);
    expect(seen).toEqual(Array.from({ length: 16 }, (_, i) => [i + 1, 16]));
    // Cancelled after the third evaluation: nothing more is evaluated and the promise rejects.
    const controller = new AbortController();
    let done = 0;
    const stopped = shapleyAsync(scores, REF, EVERYWHERE, {
      ...ALL,
      budgetMs: 0,
      signal: controller.signal,
      onProgress: (n) => {
        done = n;
        if (n === 3) controller.abort();
      },
    });
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    expect(done).toBe(3);
    // Already cancelled: nothing runs at all.
    const never = new AbortController();
    never.abort();
    let touched = false;
    await expect(shapleyAsync(scores, REF, EVERYWHERE, { ...ALL, signal: never.signal, onProgress: () => (touched = true) })).rejects.toMatchObject({ name: "AbortError" });
    expect(touched).toBe(false);
  });
});

// The hackathon starter kit, read from disk the way the browser reads it from a zip, and the runs that ship with the app.
const KIT = join(__dirname, "..", "..", "data", "data");
const PUBLIC = join(__dirname, "..", "public", "agents");

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

const ms = (t: number) => `${t.toFixed(1)} ms`;

describe.skipIf(!existsSync(KIT))("starter kit with drainage on, all loss drivers", () => {
  let drained: Dataset;
  let portfolio: PortfolioTarget;
  let kitOffer: OfferTarget;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    const nairobi = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const geo = <P,>(f: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", f), "utf8")) as GeoCollection<P>;
    const widest = nairobi.rasters.find((r) => r.scenarioId === "common")!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, geo<WaterwayProps>("waterways.geojson"), geo<SettlementProps>("informal-settlements.geojson"));
    drained = withDrainage(nairobi, { distances, sensitivity: drainageSensitivity(distances, widest, nairobi.hotspots) });
    portfolio = { kind: "portfolio", dataset: drained };
    // An invented offer at the site of the portfolio building with the most water in the widest tier.
    const k = drained.scenarios.findIndex((s) => s.id === "common");
    const wettest = [...drained.buildings].sort((a, b) => (b.hazard[k] ?? 0) - (a.hazard[k] ?? 0))[0];
    kitOffer = { kind: "offer", offer: { dataset: drained, building: { lon: wettest.lon, lat: wettest.lat, housingClass: "concrete_rcc", tivKes: 2_000_000_000 }, extraction: extraction(STATED), terms: EXAMPLE } };
  }, 120_000);

  it("times one evaluation, a full tornado and the largest Shapley attribution", () => {
    let t = performance.now();
    const cold = evaluate(portfolio, REF, "all_drivers");
    const coldMs = performance.now() - t;
    t = performance.now();
    expect(evaluate(portfolio, REF, "all_drivers")).toBe(cold);
    const memoMs = performance.now() - t;
    t = performance.now();
    runModel(drained, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT });
    const warmRunMs = performance.now() - t;

    t = performance.now();
    const rows = tornado(portfolio, REF, ALL);
    const tornadoMs = performance.now() - t;
    expect(rows).toHaveLength(16);

    t = performance.now();
    const six = shapley(portfolio, REF, EVERYWHERE, ALL);
    const shapleyMs = performance.now() - t;
    expect(six.groups).toHaveLength(6);
    expect(six.evaluations).toBe(64);
    close(six.sumAalKes, six.totalAalKes);
    close(six.sumLoss100Kes!, six.totalLoss100Kes!);

    t = performance.now();
    const offerRows = tornado(kitOffer, REF, ALL);
    const offerTornadoMs = performance.now() - t;
    expect(offerRows).toHaveLength(SWING_IDS.length);
    t = performance.now();
    const eight = shapley(kitOffer, REF, EVERYWHERE, ALL);
    const offerShapleyMs = performance.now() - t;
    expect(eight.groups).toHaveLength(8);
    expect(eight.evaluations).toBe(256);
    close(eight.sumAalKes, eight.totalAalKes);
    close(eight.sumLoss100Kes!, eight.totalLoss100Kes!);

    const line = (r: TornadoRow) => `    ${r.label.padEnd(52)} ${r.lowText.padStart(8)} to ${r.highText.padEnd(8)} 1-in-100 swing KES ${(r.swing.loss100Kes! / 1e6).toFixed(1)}m, AAL swing KES ${(r.swing.aalKes / 1e6).toFixed(1)}m`;
    console.log(
      [
        `Nairobi starter kit, drainage on, all loss drivers, ${drained.buildings.length} buildings x ${drained.scenarios.length} tiers:`,
        `  one evaluation: first ${ms(coldMs)}, from the memo ${ms(memoMs)}, a plain warm run of the engine ${ms(warmRunMs)}`,
        `  full tornado, ${rows.length} rows (${2 * rows.length} runs): ${ms(tornadoMs)}`,
        ...rows.slice(0, 5).map(line),
        `  Shapley, portfolio, ${six.groups.length} live groups, ${six.evaluations} evaluations (${six.runs} runs): ${ms(shapleyMs)}`,
        ...six.groups.map((g) => `    ${g.label.padEnd(32)} 1-in-100 KES ${(g.loss100Kes! / 1e6).toFixed(1)}m, AAL KES ${(g.aalKes / 1e6).toFixed(1)}m`),
        `    total 1-in-100 KES ${(six.totalLoss100Kes! / 1e6).toFixed(1)}m (sum ${(six.sumLoss100Kes! / 1e6).toFixed(1)}m), AAL KES ${(six.totalAalKes / 1e6).toFixed(1)}m (sum ${(six.sumAalKes / 1e6).toFixed(1)}m)`,
        `  offer on the kit: tornado ${offerRows.length} rows ${ms(offerTornadoMs)}; Shapley ${eight.groups.length} live groups, ${eight.evaluations} evaluations (${eight.runs} runs): ${ms(offerShapleyMs)}`,
      ].join("\n"),
    );
  }, 120_000);

  it.skipIf(!existsSync(join(PUBLIC, "index.json")))("attributes the shipped runs' change exactly, and the shares add up", () => {
    const index = JSON.parse(readFileSync(join(PUBLIC, "index.json"), "utf8")) as { runs: { file: string; kind: string; inputs: { dataset: string } }[] };
    const made = index.runs.filter((r) => r.inputs.dataset === drained.name);
    expect(made.length).toBeGreaterThan(0);
    for (const entry of made) {
      const run = JSON.parse(readFileSync(join(PUBLIC, entry.file), "utf8")) as { finalParams?: ModelParams; offerJudgement?: { final?: Partial<OfferJudgement> | null } | null };
      expect(run.finalParams, entry.file).toBeDefined();
      const agreed: Assumptions = { params: enforceBounds(run.finalParams!).params, judgement: judge(run.offerJudgement?.final ?? {}) };
      for (const target of [portfolio, kitOffer]) {
        const result = shapley(target, REF, agreed, ALL);
        close(result.sumAalKes, result.totalAalKes);
        if (result.totalLoss100Kes !== null) close(result.sumLoss100Kes!, result.totalLoss100Kes);
        expect(result.evaluations).toBe(2 ** result.groups.length);
        expect(result.groups.length + result.dropped.length).toBe(GROUPS.length);
        console.log(`  ${entry.file} on the ${target.kind}: ${result.groups.length} live groups, ${result.evaluations} evaluations; AAL change KES ${(result.totalAalKes / 1e6).toFixed(2)}m = ${result.groups.map((g) => `${g.label} ${(g.aalKes / 1e6).toFixed(2)}m`).join(" + ") || "nothing"}`);
      }
    }
  }, 120_000);
});
