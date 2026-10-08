import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Deliberation, Scored } from "../src/lib/agents/orchestrate";
import { SEVERITY_ORDER } from "../src/lib/decision";
import { DRAINAGE_DEFAULTS, drainageDistances, drainageSensitivity, sampleGrid, stressAt } from "../src/lib/geo/drainage";
import { withDrainage, type DrainageState } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WardProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { sampleRaster } from "../src/lib/ingest/raster";
import { kes1 } from "../src/lib/labels";
import { highestWithin, type LossMode } from "../src/lib/model/drivers";
import { lossAtReturnPeriod } from "../src/lib/model/financial";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import { DEFAULT_TERMS, policyLoss } from "../src/lib/model/terms";
import type { Dataset, ModelParams, ModelResult } from "../src/lib/model/types";
import { damageRatio } from "../src/lib/model/vulnerability";
import { DRIVER_IDS, DRIVER_LABELS, MODELLED_DRIVER_IDS } from "../src/lib/offer/drivers";
import { assumedJudgement, buildOfferFocus, isPriced, NEIGHBOUR_RADIUS_M, offerBrief, portfolioJudgement, sameOffer, settersOf, settersText, type AgentsJudgement, type OfferFocus, type OfferFocusInput, type PricedFocus } from "../src/lib/offer/focus";
import { AGENT_JUDGEMENT_KEYS, BASEMENT_LADDER, JUDGEMENT_KEYS, OUTAGE_LADDER, REFERENCE_JUDGEMENT, type OfferJudgement } from "../src/lib/offer/judgement";
import { extractOffer } from "../src/lib/offer/client";
import { docxToText } from "../src/lib/offer/docx";
import { nearestWaterway } from "../src/lib/offer/locate";
import { termsSplit } from "../src/lib/offer/terms";
import {
  OUTSIDE_MAPS_MESSAGE,
  type OfferExtraction,
  type OfferNote,
  type OfferRow,
  type OfferState,
  type OfferTerms,
  type PolicyTerms,
  type Quoted,
} from "../src/lib/offer/types";
import { confirmValue, editValue } from "../src/lib/offer/verify";

// --- an invented offer ---------------------------------------------------------------------------
// Nothing here comes from a real document: every name, figure and sentence is made up for the test.

const said = <T,>(value: T, quote = "an invented sentence"): Quoted<T> => ({ value, quote, status: "verified", reason: null });
const missing = <T,>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });
const doubted = <T,>(value: T, reason: string): Quoted<T> => ({ value, quote: "a sentence that does not hold the figure", status: "unverified", reason });

const row = (values: Partial<OfferRow> = {}): OfferRow => ({
  name: said("Invented Tower", "INSURED PROPERTY: Invented Tower"),
  lat: missing(),
  lon: missing(),
  housingClass: said("concrete_rcc", "reinforced concrete frame"),
  floorAreaM2: said(20_000, "GROSS FLOOR AREA: 20,000 m2"),
  costPerM2Kes: missing(),
  tivKes: said(2_000_000_000, "TOTAL SUM INSURED: KES 2,000,000,000"),
  path: "model",
  coordinates: null,
  ...values,
});

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

const note = (kind: OfferNote["kind"], value: string, quote: string): OfferNote => ({ ...said(value, quote), kind });

const DOCUMENT_TEXT = "INSURED PROPERTY: Invented Tower\nGROSS FLOOR AREA: 20,000 m2\nTOTAL SUM INSURED: KES 2,000,000,000";

function offerOf(extraction: OfferExtraction, path: "model" | "rules" = "model"): OfferState {
  return {
    document: { name: "invented-offer.txt", kind: "txt", text: `${DOCUMENT_TEXT}\nContact: someone` },
    run: {
      extraction,
      documentText: DOCUMENT_TEXT,
      removed: { emails: 1, phones: 0, blocks: [] },
      path,
      fallbackReason: path === "rules" ? "The fixed rules were chosen, so nothing was sent to the model." : null,
      sentToModel: path === "model",
      prompt: path === "model" ? { system: "instructions", user: DOCUMENT_TEXT } : null,
      model: path === "model" ? "invented-model" : null,
      usage: path === "model" ? { promptTokens: 900, outputTokens: 300 } : null,
      ms: path === "model" ? 1200 : null,
      replyJson: path === "model" ? '{"entries":[]}' : null,
    },
    extraction,
  };
}

/** The terms an offer states: 5% of each loss, at least KES 1m, and KES 500m for one flood. */
const STATED_TERMS: Partial<OfferTerms> = {
  floodDeductiblePct: said(5, "Flood deductible 5% of each and every loss"),
  floodDeductibleMinKes: said(1_000_000, "minimum KES 1,000,000"),
  floodLimitKes: said(500_000_000, "Flood sub-limit KES 500,000,000 any one event"),
};
const STATED_POLICY: PolicyTerms = { deductible: { source: "document", pct: 5, minKes: 1_000_000, basis: "percent_of_loss" }, limit: { source: "document", kes: 500_000_000 } };

/** What an offer states for the loss drivers beyond depth: the drains' design, KES 150m below ground, and loss of rent insured on KES 146m a year. */
const STATED_DRIVERS: Partial<OfferTerms> = {
  basements: said(2, "two basement levels"),
  drainDesignRp: said(50, "Storm drains are designed for a 50-year event."),
  valueBelowGroundKes: said(150_000_000, "Plant and contents in the basements are valued at KES 150,000,000."),
  biCovered: said("covered", "Loss of rent is to be insured."),
  annualRentKes: said(146_000_000, "Annual rent roll KES 146,000,000."),
};

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

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(a), Math.abs(b)));
const sum = (values: number[]) => values.reduce((t, v) => t + v, 0);
const TIERS = ["extreme", "severe", "moderate", "occasional", "common"];
/** The reference ladders, most frequent first. */
const BASEMENT_RATIOS = [0.15, 0.25, 0.4, 0.55, 0.7];
const OUTAGE_DAYS = [2, 5, 10, 20, 40];

describe.skipIf(!existsSync(KIT))("the offer focus on the Nairobi starter kit", () => {
  const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;
  const wards = geo<WardProps>("wards.geojson");
  const waterways = geo<WaterwayProps>("waterways.geojson");
  const layers = { wards, waterways };
  let dataset: Dataset;
  let state: DrainageState;
  /** The portfolio on reference assumptions, with Depth only and with all loss drivers. */
  let depthResult: ModelResult;
  let allResult: ModelResult;
  /** A point the terrain maps flood, and one they leave dry in every tier. */
  let wet: { lat: number; lon: number };
  let dry: { lat: number; lon: number };
  /** A point the terrain maps leave dry but the drainage zone reaches. */
  let ponded: { lat: number; lon: number };
  /** A point dry in every tier, out of reach of drainage, with mapped water within 100 m of it. */
  let dryNearWater: { lat: number; lon: number };
  /** A point dry in every tier, out of reach of drainage, with no mapped water within 500 m. */
  let dryFarFromWater: { lat: number; lon: number };

  /** The focus's input. The portfolio's result is handed in already run in the mode asked for, as the walkthrough does. */
  const input = (offer: OfferState | null, more: Partial<OfferFocusInput> = {}): OfferFocusInput => ({
    offer,
    session: { dataset },
    active: { source: "reference", params: REFERENCE_PARAMS, result: (more.mode ?? "all_drivers") === "all_drivers" ? allResult : depthResult },
    drainage: null,
    policyDefaults: DEFAULT_TERMS,
    deliberation: null,
    layers,
    ...more,
  });
  const depthOnly: Partial<OfferFocusInput> = { mode: "depth_only" };
  const at = (p: { lat: number; lon: number }, values: Partial<OfferRow> = {}) => row({ lat: said(p.lat, "GPS: invented"), lon: said(p.lon, "GPS: invented"), ...values });
  const extraction = (rows: OfferRow[], t: Partial<OfferTerms> = {}, notes: OfferNote[] = [], more: Partial<OfferExtraction> = {}): OfferExtraction => ({ rows, terms: terms(t), notes, ...more });
  const priced = (focus: OfferFocus | null): PricedFocus => {
    if (!isPriced(focus)) throw new Error(`the offer should be priced, not ${focus?.status ?? "missing"}`);
    return focus;
  };
  const ratio = (depthM: number, params = REFERENCE_PARAMS) => damageRatio(depthM, "concrete_rcc", params);

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const widest = dataset.rasters.find((r) => r.scenarioId === dataset.scenarios[dataset.scenarios.length - 1].id)!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, waterways, geo<SettlementProps>("informal-settlements.geojson"));
    state = { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) };
    depthResult = runModel(dataset, REFERENCE_PARAMS);
    allResult = runModel(dataset, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT });

    // The points are found on the maps themselves, so the test does not lean on any one place.
    const narrowest = dataset.rasters.find((r) => r.scenarioId === dataset.scenarios[0].id)!;
    const value = (p: { lat: number; lon: number }, map = widest) => sampleRaster(map, p.lon, p.lat, "score").value;
    wet = dataset.buildings.find((b) => value(b, narrowest) > 0)!;
    const stress = (p: { lat: number; lon: number }) => stressAt(sampleGrid(distances.grid, distances.toDrain, p.lon, p.lat), sampleGrid(distances.grid, distances.toSettlement, p.lon, p.lat), DRAINAGE_DEFAULTS.reachM);
    dry = dataset.buildings.find((b) => value(b) === 0 && stress(b) === 0)!;
    ponded = dataset.buildings.find((b) => value(b) === 0 && stress(b) > 0)!;
    const highest = (p: { lat: number; lon: number }, radiusM: number) => highestWithin(widest, p.lon, p.lat, radiusM, "score") ?? 0;
    dryNearWater = dataset.buildings.find((b) => value(b) === 0 && stress(b) === 0 && highest(b, 100) > 0)!;
    dryFarFromWater = dataset.buildings.find((b) => value(b) === 0 && stress(b) === 0 && highest(b, 500) === 0)!;
    for (const p of [wet, dry, ponded, dryNearWater, dryFarFromWater]) expect(p).toBeTruthy();
  }, 120_000);

  it("is null when there is no offer, and places nothing until the ward map has loaded", () => {
    expect(buildOfferFocus(input(null))).toBeNull();

    const focus = buildOfferFocus(input(offerOf(extraction([at(wet)])), { layers: null }))!;
    expect(focus.status).toBe("locating");
    expect(focus.price).toBeNull();
    expect(focus.drivers).toBeNull();
    expect(focus.mode).toBe("all_drivers");
    expect(focus.judgement).toMatchObject({ inForce: REFERENCE_JUDGEMENT, assumed: REFERENCE_JUDGEMENT, reference: REFERENCE_JUDGEMENT, agreed: null, typed: {}, fromOffer: {}, agents: "none" });
    expect(Object.values(focus.judgement.setBy).every((who) => who === "reference")).toBe(true);
    expect(focus.pricing).toBeNull();
    expect(focus.buildings).toEqual([]);
    expect(focus.summary).toMatchObject({ name: "invented-offer.txt", loss100Kes: null, aalKes: null, outside: false });
    // What was read is there all the same: the document, its fields and the questions for the broker do not wait for the map.
    expect(focus.fields.length).toBeGreaterThan(0);
    expect(focus.document.text).toBe(DOCUMENT_TEXT);
    expect(focus.questions.length).toBeGreaterThan(0);
  });

  it("with Depth only, follows a building from the hazard map to the gross loss exactly as the engine prices its point", () => {
    const notes = [note("basement_plant", "Generators in basement 2", "Standby generators are housed in basement level 2."), note("past_flood", "Car park flooded in 2024", "The lower car park flooded in April 2024.")];
    const e = extraction([at(wet)], { ...STATED_TERMS, ...STATED_DRIVERS, occupancy: said("commercial", "Grade A offices"), riverName: said("Nairobi River", "about 400 m from the Nairobi River"), riverDistanceM: said(400, "about 400 m from the Nairobi River"), floodCover: said("covered", "Flood cover is requested"), policyPeriod: said("1 January 2027 to 31 December 2027", "Period: 1 January 2027 to 31 December 2027") }, notes);
    const given = input(offerOf(e), depthOnly);
    const focus = priced(buildOfferFocus(given));
    const { price, building, drivers } = focus;
    expect(focus.mode).toBe("depth_only");
    expect(drivers.mode).toBe("depth_only");

    // Identity.
    expect(focus.documentName).toBe("invented-offer.txt");
    expect(focus.line).toMatchObject({ insured: "Invented Tower", sumInsuredKes: 2_000_000_000, cover: "Flood covered", period: "1 January 2027 to 31 December 2027" });
    expect(focus.line.location).toBeTruthy();
    expect(focus.line.text).toContain("Invented Tower");
    expect(focus.several).toBe(false);
    expect(focus.severalLine).toBeNull();
    expect(focus.outside).toBe(false);
    expect(focus.outsideMessage).toBeNull();
    expect(focus.waiting).toEqual([]);

    // The building.
    expect(building).toMatchObject({ locId: "OFFER-1", name: "Invented Tower", status: "priced", approximate: false, housingClass: "concrete_rcc", housingLabel: "Concrete / RCC", tivKes: 2_000_000_000, tivFrom: "stated", valuePerM2Kes: 100_000 });
    expect(building.lat).toBe(wet.lat);
    expect(focus.buildings).toHaveLength(1);

    // The trace: one row per return period, and every line adds up. Nothing but the depth at the point is in it,
    // whatever the offer states about basements, drains and rent.
    const trace = price.building.perReturnPeriod;
    expect(trace.map((r) => r.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    expect(trace.map((r) => r.id)).toEqual(price.scenarios.map((s) => s.id));
    for (const r of trace) {
      close(r.groundUpKes - r.deductibleKes - r.overLimitKes, r.grossKes);
      expect(r.depthM).toBe(Math.max(r.terrainM, r.drainageM));
      expect(r.drainageM).toBe(0);
      close(r.effectiveDepthM, r.depthM * REFERENCE_PARAMS.fragility.concrete_rcc);
      close(r.damageRatio, Math.min(r.curveDamage, REFERENCE_PARAMS.cap.concrete_rcc));
      expect(r.groundUpKes).toBe(r.damageRatio * 2_000_000_000);
      expect(r.capped).toBe(r.curveDamage > REFERENCE_PARAMS.cap.concrete_rcc);
      expect(r.depthFrom).toBe(r.depthM > 0 ? "terrain" : "dry");
      expect(r.nearestWetM === null).toBe(r.hazard > 0);
      expect(r.byDriverKes).toMatchObject({ ponding: 0, overload: 0, basement: 0, interruption: 0, uncertainty: 0 });
      expect(r.byDriverKes.surrounding).toBe(r.groundUpKes);
      const split = termsSplit([r.groundUpKes], [2_000_000_000], STATED_POLICY)[0];
      close(r.deductibleKes, split.deductibleKes);
      close(r.grossKes, split.grossKes);
    }
    expect(trace[0].depthM).toBeGreaterThan(0);
    expect(price.building.firstWetReturnPeriod).toBe(10);
    expect(price.building.dryAtEveryReturnPeriod).toBe(false);
    expect(price.building.dryAtPointEveryReturnPeriod).toBe(false);
    expect(price.building.nearestWetM).toBe(0);
    expect(price.building).toMatchObject({ locId: "OFFER-1", fragility: REFERENCE_PARAMS.fragility.concrete_rcc, cap: REFERENCE_PARAMS.cap.concrete_rcc });

    // The figures are the engine's own, to the last decimal, and one building is the whole offer.
    const totals = focus.pricing!.totals!;
    const engine = focus.pricing!.rows[0];
    if (engine.status !== "priced") throw new Error("the row should be priced");
    trace.forEach((r, k) => {
      expect(r.groundUpKes).toBe(engine.scenarios[k].groundUpKes);
      expect(r.grossKes).toBe(engine.scenarios[k].grossKes);
      expect(r.depthM).toBe(engine.scenarios[k].depthM);
      expect(r.damageRatio).toBe(engine.scenarios[k].damageRatio);
      expect(price.total.curve[k]).toEqual(totals.scenarios[k]);
    });
    expect(price.total.aalGrossKes).toBe(totals.aalGrossKes);
    expect(price.total.aalGroundUpKes).toBe(totals.aalGroundUpKes);
    expect(price.total.ratePerMilleGross).toBe(totals.ratePerMilleGross);
    expect(price.total.ratePerMilleGroundUp).toBe(totals.ratePerMilleGroundUp);
    expect(price.building.aalGrossKes).toBe(totals.aalGrossKes);
    expect(price.total.loss100GrossKes).toBe(lossAtReturnPeriod(totals.scenarios.map((s) => ({ returnPeriod: s.returnPeriod, lossKes: s.grossKes })), 100).lossKes);
    expect(price.total.loss100GroundUpKes).toBe(trace[3].groundUpKes);
    expect(price.total.standard.map((s) => s.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    expect(price.total.loss100GrossKes!).toBeLessThanOrEqual(500_000_000);
    // With Depth only in force, "depthOnly" is the same picture.
    expect(price.depthOnly).toBe(price.total);
    expect(price.pricedCount).toBe(1);
    // The premium is then the modelled loss alone and the rate is the pure rate: no loading, no capital load, no minimum.
    expect(drivers.premium).toMatchObject({ floodPremiumKes: totals.aalGrossKes, floodRatePerMille: totals.ratePerMilleGross, capitalLoadKes: 0, minimumKes: 0, uncertaintyAalKes: 0 });
    expect(drivers.lines.filter((l) => l.on).map((l) => l.id)).toEqual(["surrounding"]);

    // The portfolio is not discarded: the same engine, with and without the offer.
    const own = given.active.result;
    const p = price.portfolio;
    expect(p.sameAsPortfolioView).toBe(true);
    expect(p.without.aalKes).toBe(own.aalKes);
    expect(p.with.buildings).toBe(own.buildingCount + 1);
    close(p.aalChangeKes, totals.aalGroundUpKes);
    close(p.with.aalKes - p.without.aalKes, totals.aalGroundUpKes);
    close(p.loss100ChangeKes!, price.total.loss100GroundUpKes!);
    // The engine's own run with the offer in the list gives the very same portfolio.
    close(p.with.aalKes, focus.pricing!.portfolio!.with.aalKes);
    close(p.with.loss100Kes!, focus.pricing!.portfolio!.with.loss100Kes!);
    expect(p.depthOnly).toEqual({ loss100ChangeKes: p.loss100ChangeKes, aalChangeKes: p.aalChangeKes });
    close(p.tivShare, 2_000_000_000 / (own.totalTivKes + 2_000_000_000));
    close(p.timesLargest!, 2_000_000_000 / Math.max(...dataset.buildings.map((b) => b.tivKes)));
    close(p.gross!.change100Kes!, price.total.loss100GrossKes!);
    close(p.gross!.aalWithKes - p.gross!.aalWithoutKes, totals.aalGrossKes);
    // The portfolio's gross figures are its buildings through the panel's example terms, one by one.
    close(p.gross!.without100Kes!, sum(own.buildings.map((b, i) => policyLoss(b.perScenario[3].lossKes, dataset.buildings[i].tivKes, DEFAULT_TERMS).grossKes)));
    expect(p.classRange).toMatchObject({ housingClass: "concrete_rcc", perM2Kes: 100_000 });
    expect(p.classRange!.count).toBe(dataset.buildings.filter((b) => b.housingClass === "concrete_rcc").length);
    expect(p.classContext!.buildings).toBe(p.classRange!.count);
    expect(p.classContext!.perReturnPeriod.map((r) => r.returnPeriod)).toEqual([10, 25, 50, 100, 250]);

    // The site: what the map and the checks need.
    const site = focus.site;
    expect(site.lat).toBe(wet.lat);
    expect(site.river).toMatchObject({ statedName: "Nairobi River", statedDistanceM: 400, quote: "about 400 m from the Nairobi River" });
    expect(site.river.named!.matchedName.toLowerCase()).toContain("nairobi");
    expect(site.river.nearest!.distanceM).toBeLessThanOrEqual(site.river.named!.distanceM + 1e-6);
    expect(site.river.nearest).toEqual(nearestWaterway(wet, waterways, ["river", "stream"]));
    expect(site.drain!.distanceM).toBeGreaterThanOrEqual(0);
    expect(site.drainageStress).toBeNull();
    expect(site.neighbours.radiusM).toBe(NEIGHBOUR_RADIUS_M);
    // The site is one of the portfolio's own points, so that building is its nearest neighbour.
    expect(site.neighbours.nearestM).toBe(0);
    expect(site.neighbours.count).toBe(site.neighbours.indices.length);
    expect(site.neighbours.count).toBeGreaterThanOrEqual(1);
    if (building.ward) expect(site.wardPortfolio).toMatchObject({ name: building.ward.name });

    // The document and its fields.
    expect(focus.document).toMatchObject({ name: "invented-offer.txt", text: DOCUMENT_TEXT, path: "model", sentToModel: true, model: "invented-model", replyJson: '{"entries":[]}' });
    expect(focus.document.sent).toEqual({ system: "instructions", user: DOCUMENT_TEXT });
    expect(focus.document.removedLine).toContain("1 email address");
    const field = (id: string) => focus.fields.find((f) => f.id === id)!;
    expect(field("row:0:tivKes")).toMatchObject({ label: "Insured value", value: "KES 2,000,000,000", quote: "TOTAL SUM INSURED: KES 2,000,000,000", origin: "AI, verified", mark: "verified", group: "building", row: 0, holdsPricing: false });
    expect(field("row:0:housingClass").value).toBe("Concrete / RCC");
    expect(field("row:0:costPerM2Kes")).toMatchObject({ origin: "not stated", value: "", mark: null });
    expect(field("terms:floodDeductiblePct")).toMatchObject({ label: "Flood deductible", value: "5%", group: "terms" });
    expect(field("terms:riverDistanceM")).toMatchObject({ value: "400 m", group: "site" });
    // The values the loss drivers read are in the same list, each with its sentence.
    expect(field("terms:drainDesignRp")).toMatchObject({ raw: 50, quote: "Storm drains are designed for a 50-year event.", group: "site", origin: "AI, verified" });
    expect(field("terms:valueBelowGroundKes")).toMatchObject({ raw: 150_000_000, value: "KES 150,000,000", quote: "Plant and contents in the basements are valued at KES 150,000,000." });
    expect(field("terms:biCovered")).toMatchObject({ raw: "covered", group: "terms" });
    expect(field("terms:sumpPumpBackup")).toMatchObject({ origin: "not stated", mark: null });
    expect(field("note:1")).toMatchObject({ group: "note", quote: "The lower car park flooded in April 2024." });
    expect(new Set(focus.fields.map((f) => f.id)).size).toBe(focus.fields.length);

    // Points to weigh: worst first, each with a sentence of the document or a figure of the model.
    expect(focus.flags.length).toBeGreaterThan(0);
    const order = focus.flags.map((f) => SEVERITY_ORDER.indexOf(f.severity));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const f of focus.flags) {
      expect(["quote", "figure"]).toContain(f.evidence.kind);
      expect(f.evidence.text.trim()).not.toBe("");
    }
    const flag = (id: string) => focus.flags.find((f) => f.id === id);
    expect(flag("flood-depth")).toMatchObject({ severity: "high" });
    expect(flag("critical-plant")).toMatchObject({ severity: "high", evidence: { kind: "quote", text: "Standby generators are housed in basement level 2." } });
    expect(flag("critical-plant")!.detail).toContain("not in the Depth only figures");
    expect(flag("past-flood-loss")).toMatchObject({ evidence: { kind: "quote" } });
    expect(flag("past-flood-loss")!.detail).toContain("The document states no period for its loss history.");
    expect(flag("offer-curve")).toMatchObject({ evidence: { kind: "quote", text: "Grade A offices" } });
    expect(flag("offer-basements")).toMatchObject({ title: "Basements are not in the modelled loss", evidence: { kind: "quote", text: "two basement levels" } });
    // None of the drivers that act beyond depth is in force, so none of their flags is raised.
    for (const id of ["drain-overload", "basement-ingress", "interruption-not-stated", "minimum-rate", "dry-point-wet-buffer"]) expect(flag(id)).toBeUndefined();
    expect(flag("proxy-hazard")).toMatchObject({ severity: "low" });
    expect(flag("example-terms")).toBeUndefined();

    expect(focus.facts).toMatchObject({ basements: 2, criticalPlantInBasement: true, pastFloodLoss: true, dryInEveryTier: false, nearestWetCellM: 0, approximateLocation: false, unverifiedValues: 0, commercialOnResidentialCurve: true, tivKes: 2_000_000_000 });
    expect(focus.facts.grossLoss100Kes).toBe(price.total.loss100GrossKes);
    expect(focus.conditions.map((c) => c.id)).toEqual(expect.arrayContaining(["relocate_plant", "confirm_occupancy"]));

    expect(focus.summary).toEqual({ name: "invented-offer.txt", fieldsRead: focus.counts.verified, fieldsVerified: focus.counts.verified, loss100Kes: price.total.loss100GrossKes, aalKes: price.total.aalGrossKes, outside: false });
    expect(focus.checks.length).toBeGreaterThan(1);
    expect(focus.rows).toHaveLength(1);
  });

  it("with all loss drivers, adds what the surroundings, the drains, the basement and the lost rent cost, each with its source", () => {
    const notes = [note("basement_plant", "Generators in basement 2", "Standby generators are housed in basement level 2.")];
    const e = extraction([at(wet)], { ...STATED_TERMS, ...STATED_DRIVERS }, notes);
    const focus = priced(buildOfferFocus(input(offerOf(e))));
    const point = priced(buildOfferFocus(input(offerOf(e), depthOnly)));
    const { price, drivers, judgement } = focus;
    expect(focus.mode).toBe("all_drivers");
    expect(drivers).toMatchObject({ mode: "all_drivers", tivKes: 2_000_000_000, buildings: 1, bufferRadiusM: 250, interruptionCover: "covered" });
    expect(drivers.judgement).toEqual(REFERENCE_JUDGEMENT);

    // Who set each judgement figure: the document where it states the figure itself, the reference value otherwise.
    expect(judgement.assumed).toEqual(REFERENCE_JUDGEMENT);
    expect(judgement.setBy).toMatchObject({ drainDesignRp: "offer", belowGroundShare: "offer", annualRentShare: "offer", bufferRadiusM: "reference", uncertaintyLoading: "reference", minimumRatePerMille: "reference" });
    expect(JUDGEMENT_KEYS.filter((key) => judgement.setBy[key] === "offer")).toEqual(["belowGroundShare", "drainDesignRp", "annualRentShare"]);
    expect(judgement.inForce).toEqual({ ...REFERENCE_JUDGEMENT, drainDesignRp: 50, belowGroundShare: 0.075, annualRentShare: 0.073 });
    expect(judgement.fromOffer.drainDesignRp).toMatchObject({ value: 50, quote: "Storm drains are designed for a 50-year event." });
    expect(judgement.fromOffer.belowGroundShare!.quote).toBe("Plant and contents in the basements are valued at KES 150,000,000.");
    expect(drivers.drainDesign).toEqual({ returnPeriod: 50, source: { kind: "offer", what: "Drains designed for a 1-in-50 event", quote: "Storm drains are designed for a 50-year event." } });

    // One row per return period: the two depths side by side, each driver, the sum, then the terms.
    const trace = price.building.perReturnPeriod;
    expect(trace.map((r) => r.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    // Designed for 1-in-50: overloaded in the two rarer floods only.
    expect(trace.map((r) => r.overloaded)).toEqual([false, false, false, true, true]);
    trace.forEach((r, k) => {
      const d = drivers.perReturnPeriod[k];
      expect(r.terrainM).toBe(point.price.building.perReturnPeriod[k].terrainM);
      expect(r.bufferM).toBeGreaterThanOrEqual(r.terrainM);
      expect(r.overloadM).toBe(r.overloaded ? 0.1 : 0);
      expect(r.depthM).toBe(Math.max(r.bufferM, r.drainageM, r.overloadM));
      expect(d.depths).toMatchObject({ pointM: r.terrainM, bufferM: r.bufferM, pondingM: r.drainageM, overloaded: r.overloaded, surfaceM: r.depthM });
      // The structure is the insured value less the KES 150m below ground, read once on the curve at the deepest water.
      close(r.damageRatio, ratio(r.depthM));
      close(r.byDriverKes.surrounding + r.byDriverKes.ponding + r.byDriverKes.overload, r.damageRatio * 1_850_000_000);
      close(d.pointKes, ratio(r.terrainM) * 1_850_000_000);
      close(d.pointKes + d.bufferAddedKes, r.byDriverKes.surrounding);
      // The basement takes water once the site has 0.1 m: KES 150m × the ladder's figure for the event, and never
      // a smaller share than the curve gives the structure at the same water.
      close(r.byDriverKes.basement, 150_000_000 * Math.max(r.depthM >= 0.1 ? BASEMENT_RATIOS[k] : 0, r.damageRatio));
      // Lost rent whenever water reaches the site: outage days × KES 146m ÷ 365.
      close(r.byDriverKes.interruption, r.depthM > 0 ? OUTAGE_DAYS[k] * 400_000 : 0);
      // Uncertainty: 10% of the five above, on its own line.
      close(r.byDriverKes.uncertainty, 0.1 * sum(MODELLED_DRIVER_IDS.map((id) => r.byDriverKes[id])));
      close(r.groundUpKes, sum(DRIVER_IDS.map((id) => r.byDriverKes[id])));
      // The deductible and the limit act on the sum of the six.
      const split = termsSplit([r.groundUpKes], [2_000_000_000], STATED_POLICY)[0];
      close(r.deductibleKes, split.deductibleKes);
      close(r.overLimitKes, split.overLimitKes);
      close(r.grossKes, split.grossKes);
      expect(r.groundUpKes).toBeGreaterThanOrEqual(point.price.building.perReturnPeriod[k].groundUpKes);
      // The headline curve is the drivers' own.
      expect(price.total.curve[k]).toEqual({ id: d.id, label: d.label, returnPeriod: d.returnPeriod, groundUpKes: d.groundUpTotalKes, grossKes: d.grossKes });
      expect(d.groundUpTotalKes).toBe(r.groundUpKes);
    });
    expect(trace[4].byDriverKes.basement).toBeGreaterThan(0);
    expect(trace[4].byDriverKes.interruption).toBeGreaterThan(0);

    // The headline figures come from the drivers; the Depth only figures stay on show beside them.
    expect(price.total.aalGrossKes).toBe(drivers.aal.grossTotalKes);
    expect(price.total.aalGroundUpKes).toBe(drivers.aal.groundUpTotalKes);
    expect(price.total.loss100GrossKes).toBe(drivers.loss100.grossKes);
    expect(price.total.loss100GroundUpKes).toBe(drivers.loss100.groundUpKes);
    expect(price.depthOnly).toEqual(point.price.total);
    expect(price.depthOnly.aalGrossKes).toBe(focus.pricing!.totals!.aalGrossKes);
    expect(price.total.aalGroundUpKes).toBeGreaterThan(price.depthOnly.aalGroundUpKes);
    expect(focus.summary).toMatchObject({ loss100Kes: price.total.loss100GrossKes, aalKes: price.total.aalGrossKes });
    expect(focus.facts.grossLoss100Kes).toBe(price.total.loss100GrossKes);

    // Every driver and every part of the building names its source.
    expect(drivers.lines.map((l) => l.label)).toEqual(DRIVER_IDS.map((id) => DRIVER_LABELS[id]));
    expect(drivers.lines.filter((l) => l.on).map((l) => l.id)).toEqual(["surrounding", "overload", "basement", "interruption", "uncertainty"]);
    for (const line of drivers.lines) expect(line.sources.length).toBeGreaterThan(0);
    expect(drivers.components.map((c) => [c.id, c.valueKes, c.valueSource.kind])).toEqual([["structure", 1_850_000_000, "offer"], ["below_ground", 150_000_000, "offer"], ["interruption", 146_000_000, "offer"]]);
    expect(drivers.components[1].valueSource).toMatchObject({ quote: "Plant and contents in the basements are valued at KES 150,000,000." });

    // The portfolio is run the same way, and the offer goes on top of it with all of its drivers.
    const p = price.portfolio;
    expect(p.sameAsPortfolioView).toBe(true);
    expect(p.without.aalKes).toBe(allResult.aalKes);
    expect(allResult.aalKes).toBeGreaterThan(depthResult.aalKes);
    close(p.aalChangeKes, drivers.aal.groundUpTotalKes);
    close(p.with.aalKes - p.without.aalKes, drivers.aal.groundUpTotalKes);
    close(p.with.loss100Kes! - p.without.loss100Kes!, drivers.loss100.groundUpKes!);
    expect(p.loss100ChangeKes).toBe(drivers.loss100.groundUpKes);
    expect(p.depthOnly).toEqual({ loss100ChangeKes: price.depthOnly.loss100GroundUpKes, aalChangeKes: price.depthOnly.aalGroundUpKes });
    close(p.gross!.aalWithKes - p.gross!.aalWithoutKes, drivers.aal.grossTotalKes);
    // Handed a portfolio that was run with Depth only, the focus runs it again its own way and says the two differ.
    const mismatched = priced(buildOfferFocus(input(offerOf(e), { active: { source: "reference", params: REFERENCE_PARAMS, result: depthResult } })));
    expect(mismatched.price.portfolio.sameAsPortfolioView).toBe(false);
    close(mismatched.price.portfolio.without.aalKes, allResult.aalKes);
    close(mismatched.price.portfolio.without.loss100Kes!, p.without.loss100Kes!);

    // The premium build-up: modelled loss by driver, uncertainty, capital load on the change to the portfolio's 1-in-100, then the minimum.
    const { premium } = drivers;
    close(premium.modelledAalKes + premium.uncertaintyAalKes, drivers.aal.grossTotalKes);
    // The capital load is on the gross change, like every other line: never on the deductible or on what is over the limit.
    expect(premium.capital).toMatchObject({ addedLoss100Kes: price.total.loss100GrossKes, basis: "gross" });
    close(premium.capital.addedLoss100Kes!, p.gross!.change100Kes!);
    close(premium.capitalLoadKes, 0.08 * p.gross!.change100Kes!);
    expect(premium.capitalLoadKes).toBeLessThanOrEqual(0.08 * 500_000_000);
    expect(p.gross!.change100Kes!).toBeLessThan(p.loss100ChangeKes!);
    close(premium.technicalKes, drivers.aal.grossTotalKes + premium.capitalLoadKes);
    close(premium.minimumKes, 200_000);
    expect(premium.setBy).toBe("modelled");
    close(premium.floodRatePerMille, (premium.floodPremiumKes / 2_000_000_000) * 1000);
    expect(premium.floodRatePerMille).toBeGreaterThan(price.total.ratePerMilleGross);
    expect(premium.stated).toBeNull();

    // The points to weigh that the drivers raise, each with a sentence of the document or a figure of the model.
    const flag = (id: string) => focus.flags.find((f) => f.id === id);
    expect(flag("drain-overload")).toMatchObject({ severity: "medium", title: "Drains are overloaded from the 1-in-100 flood", evidence: { kind: "quote", text: "Storm drains are designed for a 50-year event." } });
    // One point for the basement: the flood that first reaches the threshold, the value at risk and that the ratios
    // are assumptions, with the document's sentence on the plant as its evidence and the highest severity of the three it replaces.
    expect(flag("basement-ingress")).toMatchObject({ severity: "high", evidence: { kind: "quote", text: "Standby generators are housed in basement level 2." } });
    expect(flag("basement-ingress")!.title).toMatch(/^The basement takes water from the 1-in-\d+ flood$/);
    expect(flag("basement-ingress")!.detail).toContain("KES 150.0m");
    expect(flag("basement-ingress")!.detail).toContain("assumptions, not a survey");
    expect(flag("basement-ingress")!.detail).toContain("critical plant");
    expect(flag("critical-plant")).toBeUndefined();
    expect(flag("offer-basements")).toBeUndefined();
    expect(focus.flags.filter((f) => /basement|plant/i.test(`${f.id} ${f.title}`)).map((f) => f.id)).toEqual(["basement-ingress"]);
    // The check itself is still in the list of checks: only its point is folded.
    expect(focus.checks.some((c) => c.id === "offer-basements")).toBe(true);
    expect(focus.conditions.map((c) => c.id)).toContain("relocate_plant");
    expect(flag("interruption-not-stated")).toBeUndefined();
    expect(flag("minimum-rate")).toBeUndefined();
    // What the document does not state is asked of the broker in its own list, and no point repeats a question.
    expect(focus.questions.length).toBeGreaterThan(0);
    expect(focus.questions.map((q) => q.id)).not.toContain("drainDesignRp");
    expect(focus.flags.some((f) => f.id.startsWith("broker-questions-"))).toBe(false);
    for (const q of focus.questions) for (const f of focus.flags) expect(`${f.detail} ${f.evidence.text}`, `${f.id} repeats ${q.id}`).not.toContain(q.question);
  });

  it("holds the price for an unverified value that switches a loss driver on or sets its size, with all loss drivers only", () => {
    const five: [keyof OfferTerms, string | number, string][] = [
      ["basements", 3, "Basement levels"],
      ["valueBelowGroundKes", 150_000_000, "Value below ground"],
      ["drainDesignRp", 50, "Drain design return period"],
      ["biCovered", "covered", "Business interruption cover"],
      ["annualRentKes", 146_000_000, "Rent or revenue for a year"],
    ];
    const settled = priced(buildOfferFocus(input(offerOf(extraction([at(dryFarFromWater)], { ...STATED_TERMS, ...STATED_DRIVERS })))));
    for (const [key, value, label] of five) {
      const e = extraction([at(dryFarFromWater)], { ...STATED_TERMS, ...STATED_DRIVERS, [key]: doubted(value, "The value is not in the sentence given for it.") } as Partial<OfferTerms>);
      // Never priced around with the assumption, and never said to be "not stated": the offer waits for the underwriter.
      const focus = buildOfferFocus(input(offerOf(e)))!;
      expect(focus.status, key).toBe("waiting");
      expect(focus.price, key).toBeNull();
      expect(focus.drivers, key).toBeNull();
      expect(focus.waiting.map((w) => w.fieldId), key).toEqual([`terms:${key}`]);
      expect(focus.waiting[0], key).toMatchObject({ where: "Offer", label, ref: { scope: "terms", key } });
      expect(focus.fields.find((f) => f.id === `terms:${key}`), key).toMatchObject({ status: "unverified", holdsPricing: true });
      expect(focus.statusLine, key).toContain("waiting for 1 value");
      // Depth only reads none of the five, so it is priced exactly as before.
      const point = priced(buildOfferFocus(input(offerOf(e), depthOnly)));
      expect(point.waiting, key).toEqual([]);
      expect(point.price.total, key).toEqual(priced(buildOfferFocus(input(offerOf(extraction([at(dryFarFromWater)], { ...STATED_TERMS, ...STATED_DRIVERS })), depthOnly))).price.total);
      // Confirmed, it is used; cleared, the assumption is used and the question is asked.
      const confirmed = priced(buildOfferFocus(input(offerOf(confirmValue(e, { scope: "terms", key })))));
      if (value === STATED_DRIVERS[key]!.value) expect(confirmed.price.total, key).toEqual(settled.price.total);
      const cleared = priced(buildOfferFocus(input(offerOf(editValue(e, { scope: "terms", key }, null)))));
      expect(cleared.waiting, key).toEqual([]);
      expect(cleared.questions.map((q) => q.id), key).toContain(key);
    }
    // A year's rent is not read while interruption is excluded or not mentioned, so it holds nothing then.
    for (const cover of [said<"covered" | "excluded">("excluded", "Loss of rent is not insured."), missing<"covered" | "excluded">()]) {
      const e = extraction([at(dryFarFromWater)], { ...STATED_TERMS, ...STATED_DRIVERS, biCovered: cover, annualRentKes: doubted(146_000_000, "The value is not in the sentence given for it.") });
      expect(buildOfferFocus(input(offerOf(e)))!.status).toBe("priced");
    }
  });

  it("says who moved a ladder rung that code raised to keep the ladder rising", () => {
    const offer = offerOf(extraction([at(wet)], { ...STATED_TERMS, ...STATED_DRIVERS }));
    // The most frequent rung of each ladder typed above every other rung's reference value.
    const typed = priced(buildOfferFocus(input(offer, { judgement: { basementDamageExtreme: 0.9, outageDaysExtreme: 100 } }))).judgement;
    for (const key of BASEMENT_LADDER) expect(typed.inForce[key], key).toBe(0.9);
    for (const key of OUTAGE_LADDER) expect(typed.inForce[key], key).toBe(100);
    // No rung reads "reference" beside a figure that is not the reference value.
    for (const key of [...BASEMENT_LADDER, ...OUTAGE_LADDER]) expect(typed.setBy[key], key).toBe("typed");
    for (const key of JUDGEMENT_KEYS) if (typed.setBy[key] === "reference") expect(typed.inForce[key], key).toBe(REFERENCE_JUDGEMENT[key]);
    // The eight that were not typed are marked as raised, with the value they had and why; the two typed are not.
    expect(Object.keys(typed.raised).sort()).toEqual([...BASEMENT_LADDER.slice(1), ...OUTAGE_LADDER.slice(1)].sort());
    expect(typed.raised.basementDamageCommon).toMatchObject({ from: 0.7, to: 0.9, by: "typed" });
    expect(typed.raised.outageDaysSevere).toMatchObject({ from: 5, to: 100, by: "typed" });
    expect(typed.raised.outageDaysSevere!.reason).toContain("keep the ladder rising");
    expect(Object.keys(typed.typed).sort()).toEqual(["basementDamageExtreme", "outageDaysExtreme"]);
    // A rung typed in the middle raises only the rungs after it that it overtakes.
    const middle = priced(buildOfferFocus(input(offer, { judgement: { basementDamageModerate: 0.6 } }))).judgement;
    expect(BASEMENT_LADDER.map((key) => middle.setBy[key])).toEqual(["reference", "reference", "typed", "typed", "reference"]);
    expect(Object.keys(middle.raised)).toEqual(["basementDamageOccasional"]);
    // Nothing typed, nothing raised.
    expect(priced(buildOfferFocus(input(offer))).judgement.raised).toEqual({});
    expect(portfolioJudgement().raised).toEqual({});
    // Every setter of a group of figures is named, in one order and in the one set of words.
    expect(settersOf(middle, BASEMENT_LADDER)).toEqual(["typed", "reference"]);
    expect(settersText(middle, BASEMENT_LADDER)).toBe("typed by the underwriter and the reference value");
    expect(settersOf(middle, ["drainDesignRp", "bufferRadiusM"])).toEqual(["offer", "reference"]);
    expect(settersText(middle, ["bufferRadiusM"])).toBe("the reference value");
    expect(settersOf(null, BASEMENT_LADDER)).toEqual([]);
  });

  it("sets what the document states for the whole offer against every building of it, when one lies outside the maps", () => {
    // Two buildings of KES 2bn each, the second in Busia: KES 150m below ground, KES 146m rent and a KES 4m premium for both.
    const whole: Partial<OfferTerms> = { ...STATED_TERMS, ...STATED_DRIVERS, premiumKes: said(4_000_000, "Annual premium KES 4,000,000 all risks.") };
    const both = priced(buildOfferFocus(input(offerOf(extraction([at(wet), at(dry, { name: said("Annex", "Annex") })], whole)))));
    const one = priced(buildOfferFocus(input(offerOf(extraction([at(wet), at({ lat: 0.12, lon: 34.1 }, { name: said("Busia depot", "Busia depot") })], whole)))));
    expect(one.price.pricedCount).toBe(1);
    expect(one.line.sumInsuredKes).toBe(4_000_000_000);
    expect(one.drivers).toMatchObject({ tivKes: 2_000_000_000, offerTivKes: 4_000_000_000, buildings: 1 });
    // The priced building carries its half of each stated amount, the same as when both are priced.
    const part = (focus: PricedFocus, id: string) => focus.drivers.components.find((c) => c.id === id)!.valueKes;
    close(part(one, "below_ground"), 75_000_000);
    close(part(one, "interruption"), 73_000_000);
    close(part(both, "below_ground"), 75_000_000);
    close(part(both, "interruption"), 73_000_000);
    // The shares the judgement block quotes are of the whole offer too.
    close(one.judgement.fromOffer.belowGroundShare!.value, 150 / 4000);
    close(one.judgement.fromOffer.annualRentShare!.value, 146 / 4000);
    expect(one.judgement.fromOffer).toEqual(both.judgement.fromOffer);
    // The all-risks rate is 1 per mille on the KES 4bn the premium covers, and the premium says the flood rate covers less.
    close(one.drivers.premium.stated!.ratePerMille, 1);
    expect(one.drivers.premium.stated).toMatchObject({ onTivKes: 4_000_000_000, partlyPriced: true });
    expect(one.drivers.premium.stated!.note).toContain("KES 4.0bn");
    expect(both.drivers.premium.stated).toMatchObject({ ratePerMille: 1, partlyPriced: false, note: null });
  });

  it("tests under-insurance on the building's own value where the offer states it", () => {
    const costs = dataset.buildings.filter((b) => b.housingClass === "concrete_rcc" && b.costPerM2Kes !== null && b.costPerM2Kes > 0).map((b) => b.costPerM2Kes as number);
    const lowest = Math.min(...costs);
    const highest = Math.max(...costs);
    // A floor area that puts the whole insured value in the middle of the class range.
    const area = Math.round(2_000_000_000 / ((lowest + highest) / 2));
    const withArea = at(wet, { floorAreaM2: said(area, "GROSS FLOOR AREA: invented") });
    const whole = priced(buildOfferFocus(input(offerOf(extraction([withArea], STATED_TERMS)))));
    expect(whole.building).toMatchObject({ valuePerM2From: "insured_value" });
    close(whole.building.valuePerM2Kes!, 2_000_000_000 / area);
    expect(whole.price.portfolio.classRange!.position).toBe("within");
    expect(whole.facts.underInsured).toBe(false);
    expect(whole.checks.find((c) => c.id.startsWith("offer-value-per-m2"))).toMatchObject({ status: "pass" });
    // The same offer stating that the building itself is a small part of that value: machinery and contents no longer hide it.
    const ownValue = Math.round(0.5 * lowest * area);
    const split = priced(buildOfferFocus(input(offerOf(extraction([withArea], { ...STATED_TERMS, valueBuildingKes: said(ownValue, "Building: invented") })))));
    expect(split.building).toMatchObject({ valuePerM2From: "building_value" });
    close(split.building.valuePerM2Kes!, ownValue / area);
    expect(split.building.valuePerM2How).toContain("stated building value");
    expect(split.price.portfolio.classRange!.position).toBe("below");
    expect(split.facts.underInsured).toBe(true);
    const check = split.checks.find((c) => c.id.startsWith("offer-value-per-m2"))!;
    expect(check).toMatchObject({ status: "warn" });
    expect(check.detail).toContain("the stated building value ÷ floor area");
    const point = split.flags.find((f) => f.id.startsWith("offer-value-per-m2"))!;
    expect(point.title).toBe("Value per m² is below the portfolio's range for its class: possible under-insurance");
    expect(split.conditions.find((c) => c.id === "revaluation")!.because).toContain(point.id);
    // The price itself does not move with the split.
    expect(split.price.total).toEqual(whole.price.total);
  });

  it("says a dry building is dry, prices it at zero with Depth only, and from the drains with all loss drivers", () => {
    const offer = offerOf(extraction([at(dryFarFromWater)]));
    const point = priced(buildOfferFocus(input(offer, depthOnly)));
    const b = point.price.building;
    expect(b.dryOnEveryTerrainMap).toBe(true);
    expect(b.dryAtEveryReturnPeriod).toBe(true);
    expect(b.firstWetReturnPeriod).toBeNull();
    expect(b.perReturnPeriod.every((r) => r.depthFrom === "dry" && r.groundUpKes === 0 && r.grossKes === 0 && r.deductibleKes === 0)).toBe(true);
    expect(b.nearestWetM).toBe(Math.min(...b.perReturnPeriod.map((r) => r.nearestWetM!)));
    expect(b.nearestWetM!).toBeGreaterThan(0);
    expect(point.price.total.aalGrossKes).toBe(0);
    expect(point.price.total.ratePerMilleGross).toBe(0);
    expect(point.drivers.premium.floodPremiumKes).toBe(0);
    expect(point.summary.aalKes).toBe(0);
    expect(point.facts.dryInEveryTier).toBe(true);
    expect(point.flags.find((f) => f.id === "flood-depth")).toBeUndefined();

    // All loss drivers: still dry at the point and within the buffer, but the drains, taken as built for a
    // 1-in-25 event, are overloaded in the three rarer floods and put 0.1 m of water at the site.
    const focus = priced(buildOfferFocus(input(offer)));
    const trace = focus.price.building.perReturnPeriod;
    expect(focus.price.building.dryOnEveryTerrainMap).toBe(true);
    expect(focus.price.building.dryAtPointEveryReturnPeriod).toBe(true);
    expect(focus.price.building.dryAtEveryReturnPeriod).toBe(false);
    expect(focus.price.building.firstWetReturnPeriod).toBe(50);
    expect(trace.map((r) => r.bufferM)).toEqual([0, 0, 0, 0, 0]);
    expect(trace.map((r) => r.depthFrom)).toEqual(["dry", "dry", "overload", "overload", "overload"]);
    expect(trace.map((r) => r.depthM)).toEqual([0, 0, 0.1, 0.1, 0.1]);
    for (const r of trace.slice(2)) {
      close(r.byDriverKes.overload, ratio(0.1) * 2_000_000_000);
      // The document states no basement and no interruption cover, so neither is priced: nothing is guessed.
      expect(r.byDriverKes).toMatchObject({ surrounding: 0, ponding: 0, basement: 0, interruption: 0 });
      close(r.groundUpKes, 1.1 * ratio(0.1) * 2_000_000_000);
    }
    expect(focus.price.total.aalGrossKes).toBeGreaterThan(0);
    expect(focus.price.depthOnly.aalGrossKes).toBe(0);
    expect(focus.judgement.setBy.drainDesignRp).toBe("reference");
    expect(focus.drivers.drainDesign).toMatchObject({ returnPeriod: 25, source: { kind: "assumption", keys: ["drainDesignRp"] } });
    // Said of the maps at the point, whatever the drivers add: the survey suggestion still rests on it.
    expect(focus.facts.dryInEveryTier).toBe(true);
    const flag = (id: string) => focus.flags.find((f) => f.id === id);
    expect(flag("flood-depth")).toBeUndefined();
    expect(flag("drain-overload")).toMatchObject({ severity: "medium", title: "Drains are overloaded from the 1-in-50 flood", evidence: { kind: "figure" } });
    expect(flag("drain-overload")!.detail).toContain("both assumptions");
    expect(flag("basement-ingress")).toBeUndefined();
    // What is not stated is a question for the broker, in the one list of questions: no point says it again.
    expect(focus.questions.map((q) => q.id)).toEqual(expect.arrayContaining(["basements", "drainDesignRp", "biCovered"]));
    expect(flag("interruption-not-stated")).toBeUndefined();
    expect(focus.flags.some((f) => f.id.startsWith("broker-questions-"))).toBe(false);
    expect(focus.conditions.map((c) => c.id)).toContain("confirm_interruption");
  });

  it("prices a point that is dry itself from the deepest mapped water within the buffer, and says so with the model's own figures", () => {
    const offer = offerOf(extraction([at(dryNearWater)]));
    const focus = priced(buildOfferFocus(input(offer)));
    const { drivers, price } = focus;
    expect(price.building.dryAtPointEveryReturnPeriod).toBe(true);
    expect(price.depthOnly.aalGroundUpKes).toBe(0);
    const rarest = price.building.perReturnPeriod[4];
    expect(rarest.terrainM).toBe(0);
    expect(rarest.bufferM).toBeGreaterThan(0);
    expect(rarest.byDriverKes.surrounding).toBeGreaterThan(0);
    expect(drivers.perReturnPeriod[4].pointKes).toBe(0);
    expect(drivers.perReturnPeriod[4].bufferAddedKes).toBe(rarest.byDriverKes.surrounding);
    expect(drivers.aal.groundUpKes.surrounding).toBeGreaterThan(0);
    expect(drivers.firstReturnPeriod.wetAtPoint).toBeNull();
    expect(drivers.firstReturnPeriod.wetInBuffer).not.toBeNull();
    // The portfolio takes the offer's loss, so the offer now moves it; with Depth only it would not.
    close(price.portfolio.aalChangeKes, drivers.aal.groundUpTotalKes);
    expect(price.portfolio.aalChangeKes).toBeGreaterThan(0);
    expect(price.portfolio.depthOnly.aalChangeKes).toBe(0);
    const flag = focus.flags.find((f) => f.id === "dry-point-wet-buffer")!;
    expect(flag).toMatchObject({ severity: "medium", evidence: { kind: "figure" } });
    expect(flag.title).toBe(`Dry at the point, but wet within the 250 m buffer from the 1-in-${drivers.firstReturnPeriod.wetInBuffer} flood`);
    expect(flag.evidence.text).toContain("At the point: dry at every return period.");
    // One home for the fact: the "near water" flag stands down when the water is inside the buffer.
    expect(focus.flags.find((f) => f.id === "near-water")).toBeUndefined();

    // With no buffer, no water from the drains and no loading, the same offer is the point reading again.
    const bare = priced(buildOfferFocus(input(offer, { judgement: { bufferRadiusM: 0, drainOverloadDepthM: 0, uncertaintyLoading: 0 } })));
    expect(bare.price.total.curve).toEqual(bare.price.depthOnly.curve);
    expect(bare.price.total.aalGroundUpKes).toBe(0);
    expect(bare.flags.find((f) => f.id === "dry-point-wet-buffer")).toBeUndefined();
    // Depth only never reads the buffer, so the nearby water is a point to weigh there, not a loss.
    const point = priced(buildOfferFocus(input(offer, depthOnly)));
    expect(point.price.total.aalGroundUpKes).toBe(0);
    expect(point.flags.find((f) => f.id === "dry-point-wet-buffer")).toBeUndefined();
    expect(point.flags.find((f) => f.id === "near-water")).toMatchObject({ severity: "medium" });
  });

  it("falls back on the minimum rate when the maps and the drains give nothing, and flags it", () => {
    const focus = priced(buildOfferFocus(input(offerOf(extraction([at(dryFarFromWater)])), { judgement: { drainOverloadDepthM: 0 } })));
    const { drivers, price } = focus;
    expect(price.total.curve.every((r) => r.groundUpKes === 0)).toBe(true);
    expect(price.total.aalGrossKes).toBe(0);
    // The pure rate is zero; the flood premium is the minimum, and says it is.
    expect(price.total.ratePerMilleGross).toBe(0);
    expect(drivers.premium.setBy).toBe("minimum rate");
    expect(drivers.premium.floodRatePerMille).toBeCloseTo(REFERENCE_JUDGEMENT.minimumRatePerMille, 12);
    close(drivers.premium.floodPremiumKes, (REFERENCE_JUDGEMENT.minimumRatePerMille / 1000) * 2_000_000_000);
    // The minimum is a yearly figure: the loss in any one flood stays what the maps say.
    expect(price.total.loss100GrossKes).toBe(0);
    expect(price.portfolio.aalChangeKes).toBe(0);
    expect(price.assumptions[0]).toMatchObject({ id: "reference", premiumSetBy: "minimum rate", floodPremiumKes: drivers.premium.floodPremiumKes });
    const flag = focus.flags.find((f) => f.id === "minimum-rate")!;
    expect(flag).toMatchObject({ severity: "medium", evidence: { kind: "figure" } });
    expect(flag.evidence.text).toContain("0.1 per mille");
    // With no water assumed from the drains there is nothing to flag about them.
    expect(focus.flags.find((f) => f.id === "drain-overload")).toBeUndefined();
  });

  it("uses the judgement figures the underwriter types, keeps them in range and says they are typed", () => {
    const offer = offerOf(extraction([at(wet)], STATED_TERMS, [note("basement_plant", "Pumps in the basement", "The fire pumps are in the basement.")]));
    const reference = priced(buildOfferFocus(input(offer)));
    // The portfolio is handed in on the same buffer the underwriter typed, as the walkthrough does.
    const wider = assumedJudgement(null, { uncertaintyLoading: 0.3, bufferRadiusM: 9_999 });
    const typed = priced(buildOfferFocus(input(offer, { judgement: { uncertaintyLoading: 0.3, bufferRadiusM: 9_999 }, active: { source: "reference", params: REFERENCE_PARAMS, result: runModel(dataset, REFERENCE_PARAMS, { mode: "all_drivers", judgement: wider }) } })));
    // 9,999 m is outside the allowed range: code brings it back to 500 m and prices on that.
    expect(wider).toEqual({ ...REFERENCE_JUDGEMENT, uncertaintyLoading: 0.3, bufferRadiusM: 500 });
    expect(typed.judgement.typed).toEqual({ uncertaintyLoading: 0.3, bufferRadiusM: 500 });
    expect(typed.judgement.assumed).toEqual(wider);
    expect(typed.judgement.inForce).toEqual(wider);
    expect(typed.judgement.reference).toEqual(REFERENCE_JUDGEMENT);
    expect(typed.judgement.setBy).toMatchObject({ uncertaintyLoading: "typed", bufferRadiusM: "typed", ingressThresholdM: "reference", drainDesignRp: "reference" });
    expect(typed.drivers.judgement).toEqual(wider);
    expect(typed.drivers.bufferRadiusM).toBe(500);
    typed.drivers.perReturnPeriod.forEach((r, k) => {
      close(r.groundUpKes.uncertainty, 0.3 * r.modelledKes);
      expect(r.depths.bufferM).toBeGreaterThanOrEqual(reference.drivers.perReturnPeriod[k].depths.bufferM);
    });
    // Ground-up, as the limit of KES 500m holds the gross loss of this building at the same figure either way.
    expect(typed.price.total.aalGroundUpKes).toBeGreaterThan(reference.price.total.aalGroundUpKes);
    // The portfolio follows the typed buffer too, and the offer is compared with exactly that portfolio.
    expect(typed.price.portfolio.sameAsPortfolioView).toBe(true);
    expect(typed.price.portfolio.without.aalKes).toBeGreaterThanOrEqual(allResult.aalKes);
    // Depth only does not move with a judgement figure.
    expect(typed.price.depthOnly).toEqual(reference.price.depthOnly);
    // Something that is not a number is not a typed figure.
    const junk = priced(buildOfferFocus(input(offer, { judgement: { bufferRadiusM: Number.NaN } })));
    expect(junk.judgement).toMatchObject({ typed: {}, inForce: REFERENCE_JUDGEMENT });
    expect(junk.judgement.setBy.bufferRadiusM).toBe("reference");
    // With nothing read around the point, nothing below ground, no water from the drains and no loading, the price is the reading at the point, exactly.
    const bare = priced(buildOfferFocus(input(offer, { judgement: { bufferRadiusM: 0, drainOverloadDepthM: 0, belowGroundShare: 0, uncertaintyLoading: 0 } })));
    expect(bare.price.total.curve).toEqual(bare.price.depthOnly.curve);
    expect(bare.price.total.aalGrossKes).toBe(bare.price.depthOnly.aalGrossKes);
    expect(bare.price.total.aalGroundUpKes).toBe(bare.price.depthOnly.aalGroundUpKes);
    // The same block for the portfolio alone, when no offer is read: reference values with the typed ones over them.
    const own = portfolioJudgement({ bufferRadiusM: 9_999 });
    expect(own).toMatchObject({ assumed: { ...REFERENCE_JUDGEMENT, bufferRadiusM: 500 }, typed: { bufferRadiusM: 500 }, agreed: null, fromOffer: {}, agents: "none" });
    expect(own.inForce).toEqual(own.assumed);
    expect(own.setBy.bufferRadiusM).toBe("typed");
    expect(portfolioJudgement().inForce).toEqual(REFERENCE_JUDGEMENT);
  });

  it("sets the document's own loss history beside the modelled loss as a sense check, and never blends it in", () => {
    // The loss history as the reader fills it: the years on the terms, and each stated loss with its year and amount.
    const withHistory = (status: "verified" | "unverified"): OfferExtraction => {
      const e = extraction([at(dryNearWater)], STATED_TERMS, [note("past_flood", "Basement flooded in 2020", "The basement flooded in March 2020.")]);
      const amount: Quoted<number> = status === "verified" ? said(30_000_000, "KES 30,000,000 was paid for the 2020 flood.") : doubted(30_000_000, "The number is not in the sentence given for it.");
      return { ...e, terms: { ...e.terms, floodHistoryYears: said(10, "Ten years of loss history are attached.") }, floodLosses: [{ year: said(2020, "KES 30,000,000 was paid for the 2020 flood."), amountKes: amount }] };
    };
    const none = priced(buildOfferFocus(input(offerOf(extraction([at(dryNearWater)], STATED_TERMS, [note("past_flood", "Basement flooded in 2020", "The basement flooded in March 2020.")])))));
    const focus = priced(buildOfferFocus(input(offerOf(withHistory("verified")))));
    expect(focus.drivers.premium.history).toMatchObject({ years: 10, totalKes: 30_000_000, lossPerYearKes: 3_000_000, usable: true, why: null, yearsQuote: "Ten years of loss history are attached." });
    // The history changes no figure: not the curve, not the premium, not what is added to the portfolio.
    expect(focus.price.total).toEqual(none.price.total);
    expect(focus.drivers.premium.floodPremiumKes).toBe(none.drivers.premium.floodPremiumKes);
    expect(focus.price.portfolio.aalChangeKes).toBe(none.price.portfolio.aalChangeKes);
    expect(focus.flags.find((f) => f.id === "past-flood-loss")!.detail).toContain("sense check");
    // One modelled figure beside the history, on every surface: the gross average annual loss.
    expect(focus.drivers.premium.history.modelledAalKes).toBe(focus.price.total.aalGrossKes);
    expect(focus.drivers.premium.history.modelledAalKes).not.toBe(focus.drivers.aal.groundUpTotalKes);
    expect(focus.flags.find((f) => f.id === "past-flood-loss")!.detail).toContain(`a modelled average annual loss of ${kes1(focus.drivers.premium.history.modelledAalKes)} gross`);
    expect(none.flags.find((f) => f.id === "past-flood-loss")!.detail).toContain("The document states no period for its loss history.");
    // The agents are told the count, the total and the years, never more of the document than its quoted sentences.
    expect(offerBrief(focus)).toMatchObject({ floodLossCount: 1, floodLossTotalKes: 30_000_000, floodHistoryYears: 10 });

    // An amount that failed its check gives no loss per year, and the history says why.
    const waiting = priced(buildOfferFocus(input(offerOf(withHistory("unverified")))));
    expect(waiting.drivers.premium.history).toMatchObject({ usable: false, lossPerYearKes: null, why: "A stated loss or the history period is not verified against the document yet." });
    expect(waiting.price.total).toEqual(none.price.total);
  });

  it("tells the agents the plain facts of the offer, and nothing else of the document", () => {
    const notes = [note("basement_plant", "Generators in basement 2", "Standby generators are housed in basement level 2."), note("drainage_condition", "Storm drain blocked", "The storm drain is blocked with silt."), note("past_flood", "Car park flooded in 2024", "The lower car park flooded in April 2024.")];
    const stated: Partial<OfferTerms> = {
      ...STATED_TERMS,
      basements: said(2, "two basement levels"),
      drainDesignRp: said(50, "Storm drains are designed for a 50-year event."),
      biCovered: said("covered", "Loss of rent is to be insured."),
      sumpPumpBackup: said("no", "The sump pumps have no standby power."),
      riverName: said("Nairobi River", "about 400 m from the Nairobi River"),
      riverDistanceM: said(400, "about 400 m from the Nairobi River"),
    };
    const e = extraction([at(dryNearWater)], stated, notes, { equipmentBelowGround: [{ item: said("Standby generator", "The standby generator set sits in basement 2.") }] });
    const focus = priced(buildOfferFocus(input(offerOf(e))));
    const brief = offerBrief(focus);
    expect(brief).toMatchObject({
      housingClass: "concrete_rcc",
      occupancy: null,
      insuredValueKes: 2_000_000_000,
      floorAreaM2: 20_000,
      locationApproximate: false,
      basements: 2,
      basementDepthM: null,
      criticalPlantInBasement: true,
      equipmentBelowGroundCount: 1,
      valueBelowGroundKes: null,
      drainageCondition: "Storm drain blocked",
      drainDesignRp: 50,
      sumpPumpCapacity: null,
      sumpPumpBackup: "no",
      floodBarriers: null,
      nonReturnValves: null,
      biCovered: "covered",
      floodLossCount: 0,
      floodLossTotalKes: null,
      floodHistoryYears: null,
      bufferRadiusM: 250,
    });
    // What the maps and the drains give at the building, tier by tier: the two depths, the ponding and whether the drains are overloaded.
    const trace = focus.price.building.perReturnPeriod;
    expect(brief.depthsByTier).toEqual(trace.map((r, k) => ({ tier: TIERS[k], returnPeriod: r.returnPeriod, pointM: 0, bufferM: r.bufferM, pondingM: 0, overloaded: r.returnPeriod > 50 })));
    expect(brief.depthsByTier[4].bufferM!).toBeGreaterThan(0);
    expect(brief.nearestMappedWaterM).toBe(trace[4].nearestWetM);
    expect(brief.nearestMappedWaterM!).toBeGreaterThan(0);
    expect(brief.nearestRiverM).toBe(focus.site.river.nearest!.distanceM);
    expect(brief.nearestDrainM).toBe(focus.site.drain!.distanceM);
    expect(brief.quotes).toEqual([
      { about: "basements", quote: "two basement levels" },
      { about: "basement plant", quote: "Standby generators are housed in basement level 2." },
      { about: "equipment below ground", quote: "The standby generator set sits in basement 2." },
      { about: "drainage", quote: "The storm drain is blocked with silt." },
      { about: "drain design", quote: "Storm drains are designed for a 50-year event." },
      { about: "sump pump", quote: "The sump pumps have no standby power." },
      { about: "business interruption", quote: "Loss of rent is to be insured." },
      { about: "past flood", quote: "The lower car park flooded in April 2024." },
      { about: "river", quote: "about 400 m from the Nairobi River" },
    ]);
    // No name and no coordinates: the brief has no field for them, and none of its text carries them.
    expect(JSON.stringify(brief)).not.toContain("Invented Tower");
    expect(Object.keys(brief).sort()).toEqual(
      [
        "housingClass", "occupancy", "insuredValueKes", "floorAreaM2", "locationApproximate",
        "basements", "basementDepthM", "criticalPlantInBasement", "equipmentBelowGroundCount", "valueBelowGroundKes",
        "drainageCondition", "drainDesignRp", "sumpPumpCapacity", "sumpPumpBackup", "floodBarriers", "nonReturnValves",
        "biCovered", "floodLossCount", "floodLossTotalKes", "floodHistoryYears",
        "bufferRadiusM", "depthsByTier", "nearestMappedWaterM", "nearestRiverM", "nearestDrainM", "quotes",
      ].sort(),
    );
    // A wet point is wet at the point in every tier and has water at zero distance.
    const wetBrief = offerBrief(priced(buildOfferFocus(input(offerOf(extraction([at(wet)]))))));
    expect(wetBrief.depthsByTier.every((t) => t.pointM! > 0 && t.bufferM! >= t.pointM!)).toBe(true);
    // Not stated: the drains are taken as built for a 1-in-25 event, and the brief says the offer gives no figure.
    expect(wetBrief.drainDesignRp).toBeNull();
    expect(wetBrief.depthsByTier.map((t) => t.overloaded)).toEqual([false, false, true, true, true]);
    expect(wetBrief.nearestMappedWaterM).toBe(0);
    // An offer outside the maps has nothing to say about the maps.
    const outsideBrief = offerBrief(buildOfferFocus(input(offerOf(extraction([row({ lat: said(0.12), lon: said(34.1) })]))))!);
    expect(outsideBrief).toMatchObject({ depthsByTier: [], nearestMappedWaterM: null });
  });

  it("stops outside the maps with the one sentence and no loss fields, whichever mode is chosen", () => {
    for (const mode of ["all_drivers", "depth_only"] as LossMode[]) {
      const focus = buildOfferFocus(input(offerOf(extraction([row({ lat: said(0.12), lon: said(34.1) })], { ...STATED_TERMS, ...STATED_DRIVERS })), { mode }))!;
      expect(focus.status).toBe("outside");
      expect(focus.outside).toBe(true);
      expect(focus.outsideMessage).toBe("Outside the hazard maps loaded: flood cannot be priced here");
      expect(focus.outsideMessage).toBe(OUTSIDE_MAPS_MESSAGE);
      expect(focus.statusLine).toContain(OUTSIDE_MAPS_MESSAGE);
      expect(isPriced(focus)).toBe(false);
      // No loss figure of any kind, not even a zero: no driver, no premium and no minimum rate outside the maps.
      expect(focus.price).toBeNull();
      expect(focus.drivers).toBeNull();
      expect(focus.judgement.assumed).toEqual(REFERENCE_JUDGEMENT);
      expect(focus.site).toBeNull();
      expect(focus.pricing!.totals).toBeNull();
      expect(focus.summary).toMatchObject({ loss100Kes: null, aalKes: null, outside: true });
      expect(focus.facts).toMatchObject({ grossLoss100Kes: null, tivKes: null, nearestWetCellM: null });
      expect(focus.building).toMatchObject({ status: "outside", lat: 0.12, lon: 34.1, ward: null });
      expect(focus.coverage).toContain("team_a_nairobi");
      expect(focus.flags[0]).toMatchObject({ severity: "high", title: "The building is outside the hazard maps loaded" });
      expect(focus.flags.some((f) => /^(drain-overload|basement-ingress|minimum-rate|interruption-not-stated)$/.test(f.id))).toBe(false);
      expect(JSON.stringify(focus.building)).not.toMatch(/Kes":0|lossKes/);
    }
  });

  it("waits for an unverified value, says which, and prices once it is confirmed", () => {
    const e = extraction([at(wet, { tivKes: doubted(2_000_000_000, "The number 2,000,000,000 is not in the sentence given for it.") })]);
    const focus = buildOfferFocus(input(offerOf(e)))!;
    expect(focus.status).toBe("waiting");
    expect(focus.price).toBeNull();
    expect(focus.drivers).toBeNull();
    expect(focus.outside).toBe(false);
    expect(focus.waiting).toHaveLength(1);
    expect(focus.waiting[0]).toMatchObject({ where: "Building 1", label: "Insured value", value: "KES 2,000,000,000", fieldId: "row:0:tivKes", ref: { scope: "row", row: 0, key: "tivKes" } });
    expect(focus.waiting[0].text).toBe("Building 1, insured value: KES 2,000,000,000. The number 2,000,000,000 is not in the sentence given for it.");
    expect(focus.statusLine).toContain("waiting for 1 value");
    expect(focus.fields.find((f) => f.id === "row:0:tivKes")).toMatchObject({ origin: "AI, unverified", mark: "unverified", holdsPricing: true });
    // Only the check on the values themselves runs while the price waits.
    expect(focus.checks.map((c) => c.id)).toEqual(["offer-values"]);
    expect(focus.flags.map((f) => f.id)).toEqual(["offer-values"]);
    expect(focus.flags[0].title).toBe("1 value is not verified against the document");
    expect(focus.summary).toMatchObject({ loss100Kes: null, aalKes: null, outside: false });

    const confirmed = priced(buildOfferFocus(input({ ...offerOf(e), extraction: confirmValue(e, focus.waiting[0].ref) })));
    expect(confirmed.waiting).toEqual([]);
    expect(confirmed.fields.find((f) => f.id === "row:0:tivKes")).toMatchObject({ origin: "confirmed", mark: "confirmed", holdsPricing: false });
    expect(confirmed.price.total.tivKes).toBe(2_000_000_000);
  });

  it("uses the document's terms when it states them and the example terms when it does not, and says which", () => {
    const fromDocument = priced(buildOfferFocus(input(offerOf(extraction([at(wet)], STATED_TERMS)))));
    expect(fromDocument.terms.deductible).toMatchObject({ source: "from the document", mixed: false, quotes: ["Flood deductible 5% of each and every loss", "minimum KES 1,000,000"] });
    expect(fromDocument.terms.limit).toMatchObject({ source: "from the document", quotes: ["Flood sub-limit KES 500,000,000 any one event"] });
    expect(fromDocument.terms.summary).toBe("From the document");
    expect(fromDocument.terms.policy).toEqual(STATED_POLICY);
    expect(fromDocument.flags.find((f) => f.id === "example-terms")).toBeUndefined();

    const example = priced(buildOfferFocus(input(offerOf(extraction([at(wet)])))));
    expect(example.terms.deductible).toMatchObject({ source: "example terms", quotes: [] });
    expect(example.terms.limit).toMatchObject({ source: "example terms", quotes: [] });
    expect(example.terms.summary).toBe("Example terms");
    expect(example.flags.find((f) => f.id === "example-terms")).toMatchObject({ severity: "low", evidence: { kind: "figure" } });
    // The deductible and the limit act on the sum of the drivers, as they acted on the loss at the point.
    for (const r of example.price.building.perReturnPeriod) {
      const p = policyLoss(r.groundUpKes, 2_000_000_000, DEFAULT_TERMS);
      expect(r.deductibleKes).toBe(p.deductibleKes);
      expect(r.overLimitKes).toBe(p.overLimitKes);
      expect(r.grossKes).toBe(p.grossKes);
    }
    // Ground-up is the same building on the same maps; only what the terms take off differs.
    expect(example.price.total.aalGroundUpKes).toBe(fromDocument.price.total.aalGroundUpKes);
    expect(example.price.total.aalGrossKes).not.toBe(fromDocument.price.total.aalGrossKes);

    // One term from each, and a limit the underwriter typed.
    const e = extraction([at(wet)], { floodLimitKes: STATED_TERMS.floodLimitKes });
    const mixed = priced(buildOfferFocus(input(offerOf(e))));
    expect(mixed.terms.summary).toBe("Deductible example terms, limit from the document");
    const typed = priced(buildOfferFocus(input({ ...offerOf(e), extraction: editValue(e, { scope: "terms", key: "floodLimitKes" }, "300000000") })));
    expect(typed.terms.limit).toMatchObject({ source: "typed by you", quotes: [] });
    expect(typed.terms.policy.limit).toEqual({ source: "document", kes: 300_000_000 });
  });

  it("prices the same rows under each set of assumptions, in either mode", () => {
    const softer: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 2.5, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 0.5 } };
    const harder: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 5.5, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 1.1 }, returnPeriods: { extreme: 5, severe: 15, moderate: 40, occasional: 80, common: 200 } };
    const agreed: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 4.5, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 0.8 } };
    // Only the parameters are read from a deliberation, so the results are left out of this stand-in.
    const scored = (params: ModelParams) => ({ params, adjustments: [] }) as unknown as Scored;
    const deliberation: Pick<Deliberation, "optimist" | "cautious" | "final"> = { optimist: scored(softer), cautious: scored(harder), final: scored(agreed) };
    const offer = offerOf(extraction([at(wet)], STATED_TERMS));

    for (const mode of ["depth_only", "all_drivers"] as LossMode[]) {
      const run = (params: ModelParams) => runModel(dataset, params, { mode, judgement: REFERENCE_JUDGEMENT });
      // No agents: the reference set alone, and it is the one in force.
      const alone = priced(buildOfferFocus(input(offer, { mode })));
      expect(alone.price.assumptions.map((a) => a.id)).toEqual(["reference"]);
      expect(alone.price.assumptions[0]).toMatchObject({ inForce: true, label: "Reference, no AI", aalGrossKes: alone.price.total.aalGrossKes, loss100GrossKes: alone.price.total.loss100GrossKes, floodPremiumKes: alone.drivers.premium.floodPremiumKes });
      expect(alone.price.assumptions[0].aalGrossByDriverKes).toEqual(alone.drivers.aal.grossKes);
      expect(alone.assumptionsInForce).toBe("reference");

      // Agents have run and their set is in force.
      const withAgents = priced(buildOfferFocus(input(offer, { mode, deliberation, active: { source: "ai", params: agreed, result: run(agreed) } })));
      const by = Object.fromEntries(withAgents.price.assumptions.map((a) => [a.id, a]));
      expect(withAgents.price.assumptions.map((a) => a.id)).toEqual(["reference", "optimist", "cautious", "agreed"]);
      expect(withAgents.price.assumptions.filter((a) => a.inForce).map((a) => a.id)).toEqual(["agreed"]);
      expect(withAgents.assumptionsInForce).toBe("ai");
      expect(withAgents.price.portfolio.sameAsPortfolioView).toBe(true);
      expect(by.agreed.aalGrossKes).toBe(withAgents.price.total.aalGrossKes);
      expect(by.agreed.floodRatePerMille).toBe(withAgents.drivers.premium.floodRatePerMille);
      expect(by.optimist.aalGrossKes).toBeLessThan(by.agreed.aalGrossKes);
      expect(by.cautious.aalGrossKes).toBeGreaterThan(by.agreed.aalGrossKes);
      expect(by.optimist.floodPremiumKes).toBeLessThan(by.cautious.floodPremiumKes);
      expect(by.cautious.params).toBe(harder);
      expect(by.cautious.building.map((r) => r.returnPeriod)).toEqual([5, 15, 40, 80, 200]);
      // The Cautious set's rarest flood is 1-in-200, so its 1-in-100 loss is read off the curve, not held flat.
      expect(by.cautious.loss100Extrapolated).toBe(false);

      // The reference entry is the very pricing of a run on the reference set, and the same goes for every other set.
      close(by.reference.aalGrossKes, alone.price.total.aalGrossKes);
      close(by.reference.aalGroundUpKes, alone.price.total.aalGroundUpKes);
      close(by.reference.loss100GrossKes!, alone.price.total.loss100GrossKes!);
      by.reference.building.forEach((r, k) => {
        const own = alone.price.building.perReturnPeriod[k];
        expect(r.returnPeriod).toBe(own.returnPeriod);
        close(r.depthM, own.depthM);
        close(r.effectiveDepthM, own.effectiveDepthM);
        close(r.damageRatio, own.damageRatio);
        close(r.groundUpKes, own.groundUpKes);
        close(r.grossKes, own.grossKes);
      });
      for (const [id, params] of [["optimist", softer], ["cautious", harder]] as const) {
        const own = priced(buildOfferFocus(input(offer, { mode, active: { source: "ai", params, result: run(params) }, deliberation: { optimist: null, cautious: null, final: scored(params) } })));
        close(by[id].aalGrossKes, own.price.total.aalGrossKes);
        close(by[id].aalGroundUpKes, own.price.total.aalGroundUpKes);
        close(by[id].ratePerMilleGross, own.price.total.ratePerMilleGross);
        close(by[id].floodPremiumKes, own.drivers.premium.floodPremiumKes);
        expect(by[id].loss100Extrapolated).toBe(own.price.total.loss100Extrapolated);
        close(by[id].loss100GrossKes!, own.price.total.loss100GrossKes!);
        // Depth only under each set is still there, whatever the mode, and is the engine's.
        close(by[id].depthOnly.aalGrossKes, own.pricing!.totals!.aalGrossKes);
      }
      expect(by.agreed.depthOnly.aalGrossKes).toBe(withAgents.price.depthOnly.aalGrossKes);
      close(by.reference.depthOnly.aalGrossKes, alone.price.depthOnly.aalGrossKes);
      if (mode === "depth_only") for (const a of withAgents.price.assumptions) expect(a.depthOnly.aalGrossKes).toBe(a.aalGrossKes);

      // A wide gap between the two agents is itself a point to weigh.
      expect(by.cautious.aalGrossKes).toBeGreaterThanOrEqual(2 * by.optimist.aalGrossKes);
      expect(withAgents.flags.find((f) => f.id === "assumption-spread")).toMatchObject({ severity: "medium", evidence: { kind: "figure" } });

      // The agents ran without an offer here, so every set is priced on the reference judgement figures.
      expect(withAgents.judgement).toMatchObject({ assumed: REFERENCE_JUDGEMENT, agreed: null, agents: "none" });
      expect(Object.values(withAgents.judgement.setBy).every((who) => who === "reference")).toBe(true);
      for (const a of withAgents.price.assumptions) {
        expect(a.judgement).toEqual(REFERENCE_JUDGEMENT);
        expect(a.judgementFromAgents).toBe(false);
      }
    }
  });

  it("prices each set with its own judgement figures once the agents have argued this offer", () => {
    const softer: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 3 };
    const harder: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 5 };
    const agreed: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 4.5 };
    const scored = (params: ModelParams) => ({ params, adjustments: [] }) as unknown as Scored;
    // The figures the agents may argue: the buffer, the ingress threshold, the two ladders, the share below ground and the loading.
    const low: Partial<OfferJudgement> = { bufferRadiusM: 100, ingressThresholdM: 0.2, basementDamageExtreme: 0.1, basementDamageSevere: 0.2, basementDamageModerate: 0.3, basementDamageOccasional: 0.4, basementDamageCommon: 0.5, belowGroundShare: 0.05, outageDaysExtreme: 1, outageDaysSevere: 3, outageDaysModerate: 6, outageDaysOccasional: 12, outageDaysCommon: 25, uncertaintyLoading: 0.05 };
    const high: Partial<OfferJudgement> = { bufferRadiusM: 400, ingressThresholdM: 0.05, basementDamageExtreme: 0.3, basementDamageSevere: 0.4, basementDamageModerate: 0.6, basementDamageOccasional: 0.8, basementDamageCommon: 0.9, belowGroundShare: 0.15, outageDaysExtreme: 5, outageDaysSevere: 10, outageDaysModerate: 20, outageDaysOccasional: 40, outageDaysCommon: 80, uncertaintyLoading: 0.2 };
    const settled: Partial<OfferJudgement> = { bufferRadiusM: 300, ingressThresholdM: 0.1, basementDamageExtreme: 0.2, basementDamageSevere: 0.3, basementDamageModerate: 0.45, basementDamageOccasional: 0.6, basementDamageCommon: 0.75, belowGroundShare: 0.1, outageDaysExtreme: 3, outageDaysSevere: 6, outageDaysModerate: 12, outageDaysOccasional: 24, outageDaysCommon: 48, uncertaintyLoading: 0.15 };
    expect(Object.keys(settled).sort()).toEqual([...AGENT_JUDGEMENT_KEYS].sort());
    const offer = offerOf(extraction([at(dryNearWater)], { ...STATED_TERMS, biCovered: said("covered", "Loss of rent is to be insured.") }, [note("basement_plant", "Pumps in the basement", "The fire pumps are in the basement.")]));
    const brief = offerBrief(priced(buildOfferFocus(input(offer))));
    const offerJudgement: AgentsJudgement = { optimist: low, cautious: high, final: settled, brief };
    const deliberation = { optimist: scored(softer), cautious: scored(harder), final: scored(agreed), offerJudgement };
    const withSettled = { ...REFERENCE_JUDGEMENT, ...settled };
    const on = { source: "ai" as const, params: agreed, result: runModel(dataset, agreed, { mode: "all_drivers", judgement: withSettled }) };

    // "Agreed by agents" is on: the agreed judgement figures are in force, and each says the agents set it.
    const focus = priced(buildOfferFocus(input(offer, { deliberation, active: on })));
    expect(focus.judgement).toMatchObject({ inForce: withSettled, assumed: withSettled, reference: REFERENCE_JUDGEMENT, agreed: settled, typed: {}, fromOffer: {}, agents: "this_offer" });
    for (const key of JUDGEMENT_KEYS) expect(focus.judgement.setBy[key]).toBe(AGENT_JUDGEMENT_KEYS.includes(key) ? "agents" : "reference");
    expect(focus.drivers.judgement).toEqual(withSettled);
    expect(focus.drivers.bufferRadiusM).toBe(300);
    // The basement's value is the agents' share of the insured value, as the document states none.
    expect(focus.drivers.components[1]).toMatchObject({ valueKes: 200_000_000, valueSource: { kind: "assumption", keys: ["belowGroundShare"] } });
    expect(focus.price.portfolio.sameAsPortfolioView).toBe(true);
    const by = Object.fromEntries(focus.price.assumptions.map((a) => [a.id, a]));
    expect(by.reference).toMatchObject({ judgement: REFERENCE_JUDGEMENT, judgementFromAgents: false, inForce: false });
    expect(by.optimist).toMatchObject({ judgement: { ...REFERENCE_JUDGEMENT, ...low }, judgementFromAgents: true });
    expect(by.cautious).toMatchObject({ judgement: { ...REFERENCE_JUDGEMENT, ...high }, judgementFromAgents: true });
    expect(by.agreed).toMatchObject({ judgement: withSettled, judgementFromAgents: true, inForce: true });
    expect(by.agreed.aalGrossKes).toBe(focus.price.total.aalGrossKes);
    expect(by.agreed.floodRatePerMille).toBe(focus.drivers.premium.floodRatePerMille);
    expect(by.optimist.aalGrossKes).toBeLessThan(by.cautious.aalGrossKes);
    expect(by.optimist.floodPremiumKes).toBeLessThan(by.cautious.floodPremiumKes);
    // Each row is that set's parameters and that set's judgement figures through the same code.
    const alone = priced(buildOfferFocus(input(offer, { active: { source: "ai", params: harder, result: runModel(dataset, harder) }, deliberation: { optimist: null, cautious: null, final: scored(harder), offerJudgement: { optimist: null, cautious: null, final: high, brief } } })));
    close(by.cautious.aalGrossKes, alone.price.total.aalGrossKes);
    close(by.cautious.loss100GrossKes ?? 0, alone.price.total.loss100GrossKes ?? 0);
    close(by.cautious.floodPremiumKes, alone.drivers.premium.floodPremiumKes);

    // "Reference, no AI" is on: the reference figures price the offer, and the agreed set is still on record.
    const off = priced(buildOfferFocus(input(offer, { deliberation })));
    expect(off.judgement).toMatchObject({ inForce: REFERENCE_JUDGEMENT, assumed: REFERENCE_JUDGEMENT, agreed: settled, agents: "this_offer" });
    expect(Object.values(off.judgement.setBy).every((who) => who === "reference")).toBe(true);
    expect(off.price.assumptions.find((a) => a.inForce)!.id).toBe("reference");

    // A figure the underwriter types goes over the agents' set, in every row.
    const typed = priced(buildOfferFocus(input(offer, { deliberation, active: on, judgement: { minimumRatePerMille: 1, uncertaintyLoading: 0.4 } })));
    expect(typed.judgement).toMatchObject({ typed: { minimumRatePerMille: 1, uncertaintyLoading: 0.4 }, assumed: { ...withSettled, minimumRatePerMille: 1, uncertaintyLoading: 0.4 } });
    expect(typed.judgement.setBy).toMatchObject({ minimumRatePerMille: "typed", uncertaintyLoading: "typed", bufferRadiusM: "agents", costOfCapital: "reference" });
    expect(typed.price.assumptions.every((a) => a.judgement.minimumRatePerMille === 1 && a.judgement.uncertaintyLoading === 0.4)).toBe(true);
    expect(typed.price.assumptions.find((a) => a.id === "optimist")!.judgement).toEqual({ ...REFERENCE_JUDGEMENT, ...low, minimumRatePerMille: 1, uncertaintyLoading: 0.4 });

    // What the document states stays the document's, whoever else has a figure for it.
    const stating = offerOf({ ...offer.extraction, terms: { ...offer.extraction.terms, valueBelowGroundKes: said(500_000_000, "Plant in the basements is valued at KES 500,000,000.") } });
    const stated = priced(buildOfferFocus(input(stating, { deliberation: { ...deliberation, offerJudgement: { ...offerJudgement, brief: offerBrief(priced(buildOfferFocus(input(stating)))) } }, active: on })));
    expect(stated.judgement.setBy.belowGroundShare).toBe("offer");
    expect(stated.judgement.inForce.belowGroundShare).toBe(0.25);
    expect(stated.judgement.assumed.belowGroundShare).toBe(0.1);
    expect(stated.drivers.components[1]).toMatchObject({ valueKes: 500_000_000, valueSource: { kind: "offer" } });
    expect(stated.price.assumptions.every((a) => a.judgement.belowGroundShare === 0.25)).toBe(true);

    // A figure the agents may not argue, and one outside its range, never reach the price as they were sent.
    const wild: AgentsJudgement = { optimist: null, cautious: null, final: { ...settled, bufferRadiusM: 900, minimumRatePerMille: 2 }, brief };
    const kept = priced(buildOfferFocus(input(offer, { deliberation: { ...deliberation, offerJudgement: wild }, active: on })));
    expect(kept.judgement.agreed).toEqual({ ...settled, bufferRadiusM: 500 });
    expect(kept.judgement.assumed.minimumRatePerMille).toBe(REFERENCE_JUDGEMENT.minimumRatePerMille);
    expect(kept.judgement.setBy.minimumRatePerMille).toBe("reference");
    expect(assumedJudgement(wild.final)).toEqual(kept.judgement.assumed);

    // The agents argued another offer: their figures are not used for this one, and the focus says so.
    const other = offerOf(extraction([at(dryNearWater, { tivKes: said(900_000_000, "TOTAL SUM INSURED: KES 900,000,000") })], STATED_TERMS));
    const stale = priced(buildOfferFocus(input(other, { deliberation, active: on })));
    expect(sameOffer(brief, offerBrief(stale))).toBe(false);
    expect(stale.judgement).toMatchObject({ inForce: REFERENCE_JUDGEMENT, assumed: REFERENCE_JUDGEMENT, agreed: null, agents: "another_offer" });
    expect(stale.price.assumptions.every((a) => !a.judgementFromAgents)).toBe(true);
    // The portfolio handed in was run on the agents' buffer, so it is run again on the figures this offer is priced with.
    expect(stale.price.portfolio.sameAsPortfolioView).toBe(false);
    close(stale.price.portfolio.without.aalKes, runModel(dataset, agreed, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT }).aalKes);
    // The flood source switch does not make it another offer: only the document and the place do.
    const view = withDrainage(dataset, state);
    const drained = priced(buildOfferFocus(input(offer, { deliberation, session: { dataset: view }, drainage: state, active: { source: "ai", params: agreed, result: runModel(view, agreed, { mode: "all_drivers", judgement: withSettled }) } })));
    expect(drained.judgement).toMatchObject({ agents: "this_offer", assumed: withSettled });
    // Nor does the mode: the same offer on Depth only is still the offer the agents argued.
    expect(priced(buildOfferFocus(input(offer, { deliberation, mode: "depth_only", active: { source: "ai", params: agreed, result: runModel(dataset, agreed) } }))).judgement.agents).toBe("this_offer");
  });

  it("adds drainage ponding at the building when drainage is on, in the trace and under every set of assumptions", () => {
    const view = withDrainage(dataset, state);
    const offer = offerOf(extraction([at(ponded)]));
    const drained = (params: ModelParams, mode: LossMode, more: Partial<OfferFocusInput> = {}) =>
      input(offer, { mode, session: { dataset: view }, drainage: state, active: { source: "reference", params, result: runModel(view, params, { mode, judgement: REFERENCE_JUDGEMENT }) }, ...more });
    const focus = priced(buildOfferFocus(drained(REFERENCE_PARAMS, "depth_only")));
    expect(focus.drainageOn).toBe(true);
    expect(focus.price.portfolio.sameAsPortfolioView).toBe(true);
    const stress = focus.site.drainageStress!;
    expect(stress).toBeGreaterThan(0);
    expect(stress).toBeLessThanOrEqual(1);
    expect(focus.site.drainageReachM).toBe(300);
    expect(typeof focus.site.inInformalSettlement).toBe("boolean");
    for (const r of focus.price.building.perReturnPeriod) {
      expect(r.terrainM).toBe(0);
      expect(r.depthM).toBe(r.drainageM);
      expect(r.depthFrom).toBe(r.drainageM > 0 ? "drainage" : "dry");
      expect(r.byDriverKes.ponding).toBe(r.groundUpKes);
    }
    close(focus.price.building.perReturnPeriod[4].drainageM, stress * DRAINAGE_DEFAULTS.depthM.common);
    expect(focus.price.building.dryOnEveryTerrainMap).toBe(true);
    expect(focus.price.building.dryAtEveryReturnPeriod).toBe(false);
    expect(focus.price.building.firstWetReturnPeriod).toBe(10);
    expect(focus.flags.find((f) => f.id === "drainage-ponding")).toMatchObject({ severity: "low" });
    // Assumed ponding is not a report of poor drainage, so no evidence of upkeep is asked for on its account.
    expect(focus.facts.drainagePoor).toBe(false);
    expect(focus.conditions.map((c) => c.id)).not.toContain("drainage_evidence");
    // Depth only with drainage on is the engine's own pricing of the point.
    expect(focus.price.total.aalGrossKes).toBe(focus.pricing!.totals!.aalGrossKes);
    expect(focus.price.total.curve).toEqual(focus.pricing!.totals!.scenarios);

    // The same point with drainage off is dry at the point, and no stress is reported.
    const off = priced(buildOfferFocus(input(offer, depthOnly)));
    expect(off.site.drainageStress).toBeNull();
    expect(off.price.building.dryAtEveryReturnPeriod).toBe(true);

    // With all loss drivers the ponding is one driver among them: the same ponding, credited with what it adds.
    const all = priced(buildOfferFocus(drained(REFERENCE_PARAMS, "all_drivers")));
    expect(all.price.portfolio.sameAsPortfolioView).toBe(true);
    all.price.building.perReturnPeriod.forEach((r, k) => {
      expect(r.drainageM).toBe(focus.price.building.perReturnPeriod[k].drainageM);
      expect(r.depthM).toBe(Math.max(r.bufferM, r.drainageM, r.overloadM));
      close(r.byDriverKes.surrounding + r.byDriverKes.ponding + r.byDriverKes.overload, ratio(r.depthM) * 2_000_000_000);
    });
    expect(all.drivers.lines.find((l) => l.id === "ponding")).toMatchObject({ on: true });
    for (const r of all.price.building.perReturnPeriod) if (r.drainageM > r.bufferM) expect(r.byDriverKes.ponding).toBeGreaterThan(0);
    expect(all.price.total.aalGroundUpKes).toBeGreaterThanOrEqual(focus.price.total.aalGroundUpKes);

    // The pricing under another set of assumptions carries the ponding too.
    const harder: ModelParams = { ...REFERENCE_PARAMS, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 1.2 } };
    const scored = (params: ModelParams) => ({ params, adjustments: [] }) as unknown as Scored;
    for (const mode of ["depth_only", "all_drivers"] as LossMode[]) {
      const both = priced(buildOfferFocus(drained(REFERENCE_PARAMS, mode, { deliberation: { optimist: null, cautious: scored(harder), final: null } })));
      const own = priced(buildOfferFocus(drained(harder, mode)));
      close(both.price.assumptions.find((a) => a.id === "cautious")!.aalGrossKes, own.price.total.aalGrossKes);
    }
  });

  it("follows the first priced building of several and says so", () => {
    const e = extraction([row({ name: said("Not Located House") }), at(wet, { name: said("Invented Tower") }), at(dryFarFromWater, { name: said("Dry Annex"), tivKes: said(500_000_000) })], STATED_TERMS);
    const point = priced(buildOfferFocus(input(offerOf(e), depthOnly)));
    expect(point.several).toBe(true);
    expect(point.buildings.map((b) => b.status)).toEqual(["not_ready", "priced", "priced"]);
    expect(point.building).toMatchObject({ index: 1, locId: "OFFER-2", name: "Invented Tower" });
    expect(point.severalLine).toContain("3 buildings");
    expect(point.severalLine).toContain("Invented Tower");
    expect(point.price.pricedCount).toBe(2);
    expect(point.price.building.locId).toBe("OFFER-2");
    expect(point.price.total.tivKes).toBe(2_500_000_000);
    expect(point.price.building.tivKes).toBe(2_000_000_000);
    // At the points alone the dry annex adds no loss, so the terms fall on the one building that floods.
    close(point.price.total.aalGrossKes, point.price.building.aalGrossKes);
    expect(point.price.total.aalGrossKes).toBe(point.pricing!.totals!.aalGrossKes);
    expect(point.price.total.curve).toEqual(point.pricing!.totals!.scenarios);
    expect(point.line.sumInsuredKes).toBe(4_500_000_000);
    expect(point.buildings[0].blockers.length).toBeGreaterThan(0);

    // With all loss drivers both buildings are read, each at its own point: the annex now has the drains' water.
    const focus = priced(buildOfferFocus(input(offerOf(e))));
    expect(focus.drivers.buildings).toBe(2);
    expect(focus.drivers.tivKes).toBe(2_500_000_000);
    expect(focus.price.total.tivKes).toBe(2_500_000_000);
    expect(focus.price.portfolio.with.buildings).toBe(dataset.buildings.length + 2);
    const rarest = focus.drivers.perReturnPeriod[4];
    close(rarest.groundUpTotalKes - rarest.building.groundUpTotalKes, 1.1 * ratio(0.1) * 500_000_000);
    expect(focus.price.total.aalGrossKes).toBeGreaterThan(focus.price.building.aalGrossKes);
    expect(focus.price.depthOnly).toEqual(point.price.total);
  });

  it("marks values read by the fixed rules, and an approximate location", () => {
    const e = extraction([row({ path: "rules" })], { placeName: said("Kibera", "a shop in Kibera") });
    const focus = priced(buildOfferFocus(input(offerOf(e, "rules"))));
    expect(focus.document).toMatchObject({ path: "rules", sentToModel: false, sent: null, replyJson: null, why: "The fixed rules were chosen, so nothing was sent to the model." });
    expect(focus.fields.find((f) => f.id === "row:0:tivKes")).toMatchObject({ origin: "rules", mark: "rules" });
    expect(focus.fields.find((f) => f.id === "terms:placeName")).toMatchObject({ origin: "rules", group: "site" });
    expect(focus.building).toMatchObject({ approximate: true });
    expect(focus.building.standIn).toContain("Kibera");
    expect(focus.site.approximate).toBe(true);
    expect(focus.facts.approximateLocation).toBe(true);
    expect(focus.flags.find((f) => f.id === "offer-coordinates:OFFER-1")).toMatchObject({ title: "The location is approximate", evidence: { kind: "quote", text: "a shop in Kibera" } });
    expect(focus.conditions.map((c) => c.id)).toContain("survey_before_binding");
    expect(focus.line.location).toContain("Kibera");
    expect(offerBrief(focus).locationApproximate).toBe(true);
  });

  it("is quick enough to run on every edit of a field", () => {
    const offer = offerOf(extraction([at(wet)], { ...STATED_TERMS, ...STATED_DRIVERS }));
    const softer: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 3 };
    const scored = (params: ModelParams) => ({ params, adjustments: [] }) as unknown as Scored;
    const view = withDrainage(dataset, state);
    const result = runModel(view, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT });
    const given = input(offer, { session: { dataset: view }, drainage: state, active: { source: "reference", params: REFERENCE_PARAMS, result }, deliberation: { optimist: scored(softer), cautious: scored(softer), final: scored(softer) } });
    expect(priced(buildOfferFocus(given)).price.portfolio.sameAsPortfolioView).toBe(true);
    const runs = 5;
    const started = performance.now();
    for (let i = 0; i < runs; i++) buildOfferFocus(given);
    const ms = (performance.now() - started) / runs;
    console.log(`Offer focus on ${dataset.buildings.length} buildings with drainage, all loss drivers and four sets of assumptions: ${ms.toFixed(1)} ms a run`);
    expect(ms).toBeLessThan(400);
  });
});

// --- the two test offers -------------------------------------------------------------------------
// Read through code, by the fixed rules, with nothing sent anywhere. Their text is never shown and
// none of it is written here: every expectation is on something derived, one plain value at a time,
// so a failure cannot print a word of a memo.

const TEST_DATA = join(__dirname, "..", "..", "data", "test-data");
const memos = existsSync(TEST_DATA) ? readdirSync(TEST_DATA).filter((f) => f.toLowerCase().endsWith(".docx")) : [];
const nairobiMemo = memos.find((f) => f.toUpperCase().includes("NAIROBI"));
const nzoiaMemo = memos.find((f) => f.toUpperCase().includes("NZOIA"));

describe.skipIf(!existsSync(KIT) || !nairobiMemo || !nzoiaMemo)("the two test offers through the focus, by the rules alone", () => {
  const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;
  const wards = geo<WardProps>("wards.geojson");
  const waterways = geo<WaterwayProps>("waterways.geojson");
  /** Each memo under the default, All loss drivers, and under Depth only. Reference assumptions. */
  let nairobi: OfferFocus;
  let nairobiPoint: OfferFocus;
  let nzoia: OfferFocus;
  let nzoiaPoint: OfferFocus;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    const dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const results: Record<LossMode, ModelResult> = { depth_only: runModel(dataset, REFERENCE_PARAMS), all_drivers: runModel(dataset, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT }) };
    const knownPlaces = [...wards.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
    const read = async (file: string): Promise<[OfferFocus, OfferFocus]> => {
      const text = await docxToText(readFileSync(join(TEST_DATA, file)));
      const run = await extractOffer(text, { rulesOnly: true, knownPlaces });
      const offer: OfferState = { document: { name: "test-offer.docx", kind: "docx", text }, run, extraction: run.extraction };
      const under = (mode: LossMode) => buildOfferFocus({ offer, session: { dataset }, active: { source: "reference", params: REFERENCE_PARAMS, result: results[mode] }, drainage: null, policyDefaults: DEFAULT_TERMS, deliberation: null, layers: { wards, waterways }, mode })!;
      return [under("all_drivers"), under("depth_only")];
    };
    [nairobi, nairobiPoint] = await read(nairobiMemo!);
    [nzoia, nzoiaPoint] = await read(nzoiaMemo!);
  }, 120_000);

  it("prices the Nairobi offer and gives every step what it needs about that building", () => {
    expect(nairobi.status).toBe("priced");
    if (!isPriced(nairobi)) throw new Error("the Nairobi offer should be priced");
    expect(nairobi.mode).toBe("all_drivers");
    expect(nairobi.outside).toBe(false);
    expect(nairobi.waiting.length).toBe(0);
    expect(nairobi.document.path).toBe("rules");
    expect(nairobi.document.sentToModel).toBe(false);
    expect(nairobi.building.status).toBe("priced");
    expect(nairobi.price.building.perReturnPeriod.map((r) => r.returnPeriod).join(",")).toBe("10,25,50,100,250");
    expect(nairobi.price.building.perReturnPeriod.every((r) => Math.abs(r.groundUpKes - r.deductibleKes - r.overLimitKes - r.grossKes) <= 1e-6 * Math.max(1, r.groundUpKes))).toBe(true);
    expect(nairobi.price.total.tivKes > 0).toBe(true);
    expect(nairobi.price.portfolio.sameAsPortfolioView).toBe(true);
    expect(nairobi.price.portfolio.gross !== null).toBe(true);
    expect(nairobi.price.assumptions.map((a) => a.id).join(",")).toBe("reference");
    expect(nairobi.site.neighbours.radiusM).toBe(NEIGHBOUR_RADIUS_M);
    expect(nairobi.line.insured !== null).toBe(true);
    expect(nairobi.line.sumInsuredKes).toBe(nairobi.price.total.tivKes);
    expect(nairobi.fields.filter((f) => f.origin === "rules").length > 0).toBe(true);
    expect(nairobi.fields.every((f) => f.origin !== "AI, verified" && f.origin !== "AI, unverified")).toBe(true);
    expect(nairobi.flags.length > 0).toBe(true);
    expect(nairobi.flags.every((f) => f.evidence.text.trim() !== "")).toBe(true);
    expect(nairobi.conditions.length > 0).toBe(true);
    expect(nairobi.summary.outside).toBe(false);
    expect(nairobi.summary.aalKes).toBe(nairobi.price.total.aalGrossKes);
    // Figures and ids only: nothing of the memo's own words.
    const { total, depthOnly, building, portfolio } = nairobi.price;
    const d = nairobi.drivers;
    const kes = (v: number | null) => `KES ${Math.round(v ?? 0).toLocaleString("en-KE")}`;
    console.log(
      [
        `Nairobi test offer by the rules, through the focus: ${nairobi.fields.filter((f) => f.status !== "missing").length} values read, class ${nairobi.building.housingClass}, ${nairobi.building.approximate ? "approximate" : "exact"} location, nearest wet cell ${Math.round(building.nearestWetM ?? -1)} m; share of portfolio value ${(portfolio.tivShare * 100).toFixed(1)}%, terms: ${nairobi.terms.summary}`,
        `  Depth only: gross AAL ${kes(depthOnly.aalGrossKes)}, rate ${depthOnly.ratePerMilleGross.toFixed(4)} per mille`,
        `  All loss drivers: 1-in-100 gross ${kes(total.loss100GrossKes)}, gross AAL ${kes(total.aalGrossKes)}, pure rate ${total.ratePerMilleGross.toFixed(4)} per mille gross and ${total.ratePerMilleGroundUp.toFixed(4)} ground-up`,
        `  flood premium ${kes(d.premium.floodPremiumKes)} (${d.premium.floodRatePerMille.toFixed(4)} per mille), set by ${d.premium.setBy}; added to the portfolio's 1-in-100 ground-up: ${kes(portfolio.loss100ChangeKes)}`,
        `  judgement figures set by: ${JUDGEMENT_KEYS.map((key) => `${key} ${nairobi.judgement.setBy[key]}`).join(", ")}`,
        `  flags: ${nairobi.flags.map((f) => `${f.severity} ${f.id}`).join(", ")}`,
        `  conditions: ${nairobi.conditions.map((c) => c.id).join(", ")}`,
        `  broker questions: ${nairobi.questions.map((q) => q.id).join(", ")}`,
      ].join("\n"),
    );
  });

  it("no longer prices the Nairobi offer at zero: dry at the point, with a loss from drain overload and basement ingress", () => {
    if (!isPriced(nairobi)) throw new Error("the Nairobi offer should be priced");
    const { building, depthOnly, total } = nairobi.price;
    const d = nairobi.drivers;
    // Still dry at the stated point in all five tiers, with mapped water within 1 km.
    expect(building.perReturnPeriod.length).toBe(5);
    expect(building.perReturnPeriod.every((r) => r.hazard === 0 && r.terrainM === 0)).toBe(true);
    expect(building.dryOnEveryTerrainMap).toBe(true);
    expect(building.dryAtPointEveryReturnPeriod).toBe(true);
    expect(building.nearestWetM! > 0 && building.nearestWetM! < 1000).toBe(true);
    expect(depthOnly.aalGrossKes).toBe(0);
    expect(depthOnly.ratePerMilleGross).toBe(0);
    // The loss comes from the drivers that act where the point is dry, on the reference assumptions.
    expect(nairobi.judgement.agents).toBe("none");
    expect(nairobi.judgement.assumed.bufferRadiusM).toBe(REFERENCE_JUDGEMENT.bufferRadiusM);
    expect(JUDGEMENT_KEYS.every((key) => nairobi.judgement.setBy[key] === "reference" || nairobi.judgement.setBy[key] === "offer")).toBe(true);
    expect(d.perReturnPeriod.some((r) => r.groundUpKes.overload > 0)).toBe(true);
    expect(d.perReturnPeriod.some((r) => r.groundUpKes.basement > 0)).toBe(true);
    expect(d.aal.groundUpKes.overload > 0 && d.aal.groundUpKes.basement > 0).toBe(true);
    expect(d.lines.every((l) => l.sources.length > 0 && l.sources.every((s) => s.what.trim() !== ""))).toBe(true);
    expect(total.aalGrossKes > 0).toBe(true);
    expect(total.ratePerMilleGross > 0).toBe(true);
    expect(d.premium.floodRatePerMille >= REFERENCE_JUDGEMENT.minimumRatePerMille - 1e-12).toBe(true);
    expect(nairobi.summary.aalKes! > 0).toBe(true);
    expect(nairobi.flags.some((f) => f.id === "drain-overload")).toBe(true);
    expect(nairobi.flags.some((f) => f.id === "basement-ingress")).toBe(true);
    // The questions have their own list; the points do not repeat them, and the basement is one point.
    expect(nairobi.questions.length > 0).toBe(true);
    expect(nairobi.flags.some((f) => f.id.startsWith("broker-questions-") || f.id === "interruption-not-stated")).toBe(false);
    expect(nairobi.flags.some((f) => f.id === "critical-plant" || f.id === "offer-basements")).toBe(false);
    // The brief for the agents says the same about the point, in plain facts.
    const brief = offerBrief(nairobi);
    expect(brief.depthsByTier.length).toBe(5);
    expect(brief.depthsByTier.every((x) => x.pointM === 0)).toBe(true);
    expect(brief.depthsByTier.some((x) => x.overloaded === true)).toBe(true);
    expect(brief.housingClass).toBe("concrete_rcc");
    expect(brief.quotes.length <= 12).toBe(true);
  });

  it("gives the old figures for the Nairobi offer with Depth only: zero at the dry point", () => {
    if (!isPriced(nairobiPoint) || !isPriced(nairobi)) throw new Error("the Nairobi offer should be priced");
    expect(nairobiPoint.mode).toBe("depth_only");
    const totals = nairobiPoint.pricing!.totals!;
    expect(nairobiPoint.price.total.curve.map((r) => r.groundUpKes).join(",")).toBe("0,0,0,0,0");
    expect(nairobiPoint.price.total.curve.map((r) => r.grossKes).join(",")).toBe(totals.scenarios.map((s) => s.grossKes).join(","));
    expect(nairobiPoint.price.total.aalGrossKes).toBe(totals.aalGrossKes);
    expect(nairobiPoint.price.total.aalGroundUpKes).toBe(totals.aalGroundUpKes);
    expect(nairobiPoint.price.total.ratePerMilleGross).toBe(totals.ratePerMilleGross);
    expect(nairobiPoint.price.total.aalGrossKes).toBe(0);
    expect(nairobiPoint.drivers.premium.floodPremiumKes).toBe(0);
    expect(nairobiPoint.summary.aalKes).toBe(0);
    expect(nairobiPoint.price.portfolio.aalChangeKes).toBe(0);
    expect(nairobiPoint.price.portfolio.sameAsPortfolioView).toBe(true);
    // The Depth only figures shown beside the drivers are these very figures.
    expect(nairobi.price.depthOnly.aalGrossKes).toBe(nairobiPoint.price.total.aalGrossKes);
    expect(nairobi.price.depthOnly.curve.map((r) => r.grossKes).join(",")).toBe(nairobiPoint.price.total.curve.map((r) => r.grossKes).join(","));
    expect(nairobiPoint.flags.some((f) => f.id === "drain-overload" || f.id === "basement-ingress")).toBe(false);
  });

  it("stops the Nzoia offer outside the hazard maps loaded, with no loss figure, in either mode", () => {
    for (const focus of [nzoia, nzoiaPoint]) {
      expect(focus.status).toBe("outside");
      expect(focus.outside).toBe(true);
      expect(focus.outsideMessage).toBe("Outside the hazard maps loaded: flood cannot be priced here");
      expect(focus.price).toBeNull();
      expect(focus.drivers).toBeNull();
      expect(focus.judgement.agents).toBe("none");
      expect(focus.site).toBeNull();
      expect(isPriced(focus)).toBe(false);
      expect(focus.summary.outside).toBe(true);
      expect(focus.summary.loss100Kes).toBeNull();
      expect(focus.summary.aalKes).toBeNull();
      expect(focus.flags.some((f) => f.severity === "high" && f.title === "The building is outside the hazard maps loaded")).toBe(true);
    }
  });
});

describe("the offer focus without the starter kit", () => {
  it("is null when there is no offer", () => {
    const dataset: Dataset = { name: "empty", hazardKind: "depth_m", scenarios: [], buildings: [], hotspots: [], rasters: [] };
    expect(buildOfferFocus({ offer: null, session: { dataset }, active: { source: "reference", params: REFERENCE_PARAMS, result: runModel(dataset, REFERENCE_PARAMS) }, drainage: null, policyDefaults: DEFAULT_TERMS, deliberation: null, layers: null })).toBeNull();
  });

  it("answers outside, never a loss of zero, when no hazard map is loaded", () => {
    const dataset: Dataset = { name: "empty", hazardKind: "depth_m", scenarios: [], buildings: [], hotspots: [], rasters: [] };
    const e: OfferExtraction = { rows: [row({ lat: said(-1.29), lon: said(36.82) })], terms: terms(), notes: [] };
    const focus = buildOfferFocus({ offer: offerOf(e), session: { dataset }, active: { source: "reference", params: REFERENCE_PARAMS, result: runModel(dataset, REFERENCE_PARAMS) }, drainage: null, policyDefaults: DEFAULT_TERMS, deliberation: null, layers: { wards: null, waterways: null } })!;
    expect(focus.outside).toBe(true);
    expect(focus.outsideMessage).toBe(OUTSIDE_MAPS_MESSAGE);
    expect(focus.price).toBeNull();
    expect(focus.drivers).toBeNull();
    expect(focus.coverage).toBeNull();
    expect(isPriced(focus)).toBe(false);
  });
});
