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
import { lossAtReturnPeriod } from "../src/lib/model/financial";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import { applyTerms, DEFAULT_TERMS, policyLoss } from "../src/lib/model/terms";
import type { Dataset, ModelParams } from "../src/lib/model/types";
import { buildOfferFocus, isPriced, NEIGHBOUR_RADIUS_M, type OfferFocus, type OfferFocusInput, type PricedFocus } from "../src/lib/offer/focus";
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

describe.skipIf(!existsSync(KIT))("the offer focus on the Nairobi starter kit", () => {
  const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;
  const wards = geo<WardProps>("wards.geojson");
  const waterways = geo<WaterwayProps>("waterways.geojson");
  const layers = { wards, waterways };
  let dataset: Dataset;
  let state: DrainageState;
  /** A point the terrain maps flood, and one they leave dry in every tier. */
  let wet: { lat: number; lon: number };
  let dry: { lat: number; lon: number };
  /** A point the terrain maps leave dry but the drainage zone reaches. */
  let ponded: { lat: number; lon: number };

  const input = (offer: OfferState | null, more: Partial<OfferFocusInput> = {}): OfferFocusInput => ({
    offer,
    session: { dataset },
    active: { source: "reference", params: REFERENCE_PARAMS, result: runModel(dataset, REFERENCE_PARAMS) },
    drainage: null,
    policyDefaults: DEFAULT_TERMS,
    deliberation: null,
    layers,
    ...more,
  });
  const at = (p: { lat: number; lon: number }, values: Partial<OfferRow> = {}) => row({ lat: said(p.lat, "GPS: invented"), lon: said(p.lon, "GPS: invented"), ...values });
  const extraction = (rows: OfferRow[], t: Partial<OfferTerms> = {}, notes: OfferNote[] = []): OfferExtraction => ({ rows, terms: terms(t), notes });
  const priced = (focus: OfferFocus | null): PricedFocus => {
    if (!isPriced(focus)) throw new Error(`the offer should be priced, not ${focus?.status ?? "missing"}`);
    return focus;
  };

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const widest = dataset.rasters.find((r) => r.scenarioId === dataset.scenarios[dataset.scenarios.length - 1].id)!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, waterways, geo<SettlementProps>("informal-settlements.geojson"));
    state = { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) };

    // The points are found on the maps themselves, so the test does not lean on any one place.
    const narrowest = dataset.rasters.find((r) => r.scenarioId === dataset.scenarios[0].id)!;
    const value = (p: { lat: number; lon: number }, map = widest) => sampleRaster(map, p.lon, p.lat, "score").value;
    wet = dataset.buildings.find((b) => value(b, narrowest) > 0)!;
    const stress = (p: { lat: number; lon: number }) => stressAt(sampleGrid(distances.grid, distances.toDrain, p.lon, p.lat), sampleGrid(distances.grid, distances.toSettlement, p.lon, p.lat), DRAINAGE_DEFAULTS.reachM);
    dry = dataset.buildings.find((b) => value(b) === 0 && stress(b) === 0)!;
    ponded = dataset.buildings.find((b) => value(b) === 0 && stress(b) > 0)!;
    expect(wet).toBeTruthy();
    expect(dry).toBeTruthy();
    expect(ponded).toBeTruthy();
  }, 120_000);

  it("is null when there is no offer, and places nothing until the ward map has loaded", () => {
    expect(buildOfferFocus(input(null))).toBeNull();

    const focus = buildOfferFocus(input(offerOf(extraction([at(wet)])), { layers: null }))!;
    expect(focus.status).toBe("locating");
    expect(focus.price).toBeNull();
    expect(focus.pricing).toBeNull();
    expect(focus.buildings).toEqual([]);
    expect(focus.summary).toMatchObject({ name: "invented-offer.txt", loss100Kes: null, aalKes: null, outside: false });
    // What was read is there all the same: the document and its fields do not wait for the map.
    expect(focus.fields.length).toBeGreaterThan(0);
    expect(focus.document.text).toBe(DOCUMENT_TEXT);
  });

  it("follows a building inside the maps from the hazard map to the gross loss", () => {
    const notes = [note("basement_plant", "Generators in basement 2", "Standby generators are housed in basement level 2."), note("past_flood", "Car park flooded in 2024", "The lower car park flooded in April 2024.")];
    const e = extraction([at(wet)], { ...STATED_TERMS, basements: said(2, "two basement levels"), occupancy: said("commercial", "Grade A offices"), riverName: said("Nairobi River", "about 400 m from the Nairobi River"), riverDistanceM: said(400, "about 400 m from the Nairobi River"), floodCover: said("covered", "Flood cover is requested"), policyPeriod: said("1 January 2027 to 31 December 2027", "Period: 1 January 2027 to 31 December 2027") }, notes);
    const given = input(offerOf(e));
    given.portfolioTerms = applyTerms(dataset, given.active.result, DEFAULT_TERMS);
    const focus = priced(buildOfferFocus(given));
    const { price, building } = focus;

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

    // The trace: one row per return period, and every line adds up.
    const trace = price.building.perReturnPeriod;
    expect(trace.map((r) => r.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    expect(trace.map((r) => r.id)).toEqual(price.scenarios.map((s) => s.id));
    for (const r of trace) {
      close(r.groundUpKes - r.deductibleKes - r.overLimitKes, r.grossKes);
      expect(r.depthM).toBe(Math.max(r.terrainM, r.drainageM));
      expect(r.drainageM).toBe(0);
      close(r.effectiveDepthM, r.depthM * REFERENCE_PARAMS.fragility.concrete_rcc);
      close(r.damageRatio, Math.min(r.curveDamage, REFERENCE_PARAMS.cap.concrete_rcc));
      close(r.groundUpKes, r.damageRatio * 2_000_000_000);
      expect(r.capped).toBe(r.curveDamage > REFERENCE_PARAMS.cap.concrete_rcc);
      expect(r.depthFrom).toBe(r.depthM > 0 ? "terrain" : "dry");
      expect(r.nearestWetM === null).toBe(r.hazard > 0);
      const split = termsSplit([r.groundUpKes], [2_000_000_000], STATED_POLICY)[0];
      close(r.deductibleKes, split.deductibleKes);
      close(r.grossKes, split.grossKes);
    }
    expect(trace[0].depthM).toBeGreaterThan(0);
    expect(price.building.firstWetReturnPeriod).toBe(10);
    expect(price.building.dryAtEveryReturnPeriod).toBe(false);
    expect(price.building.nearestWetM).toBe(0);
    expect(price.building).toMatchObject({ locId: "OFFER-1", fragility: REFERENCE_PARAMS.fragility.concrete_rcc, cap: REFERENCE_PARAMS.cap.concrete_rcc });

    // The figures are the engine's own, and one building is the whole offer.
    const totals = focus.pricing!.totals!;
    expect(price.total.aalGrossKes).toBe(totals.aalGrossKes);
    expect(price.total.aalGroundUpKes).toBe(totals.aalGroundUpKes);
    expect(price.total.ratePerMilleGross).toBe(totals.ratePerMilleGross);
    expect(price.building.aalGrossKes).toBe(totals.aalGrossKes);
    expect(price.total.loss100GrossKes).toBe(lossAtReturnPeriod(totals.scenarios.map((s) => ({ returnPeriod: s.returnPeriod, lossKes: s.grossKes })), 100).lossKes);
    expect(price.total.loss100GroundUpKes).toBe(trace[3].groundUpKes);
    expect(price.total.standard.map((s) => s.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    expect(price.total.loss100GrossKes!).toBeLessThanOrEqual(500_000_000);
    expect(price.pricedCount).toBe(1);

    // The portfolio is not discarded: the same engine, with and without the offer.
    const own = given.active.result;
    const p = price.portfolio;
    expect(p.sameAsPortfolioView).toBe(true);
    expect(p.without.aalKes).toBe(own.aalKes);
    expect(p.with.buildings).toBe(own.buildingCount + 1);
    close(p.aalChangeKes, price.total.aalGroundUpKes);
    close(p.loss100ChangeKes!, price.total.loss100GroundUpKes!);
    close(p.tivShare, 2_000_000_000 / (own.totalTivKes + 2_000_000_000));
    close(p.timesLargest!, 2_000_000_000 / Math.max(...dataset.buildings.map((b) => b.tivKes)));
    close(p.gross!.change100Kes!, price.total.loss100GrossKes!);
    close(p.gross!.aalWithKes - p.gross!.aalWithoutKes, price.total.aalGrossKes);
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
    expect(flag("past-flood-loss")).toMatchObject({ evidence: { kind: "quote" } });
    expect(flag("offer-curve")).toMatchObject({ evidence: { kind: "quote", text: "Grade A offices" } });
    expect(flag("offer-basements")).toMatchObject({ evidence: { kind: "quote", text: "two basement levels" } });
    expect(flag("proxy-hazard")).toMatchObject({ severity: "low" });
    expect(flag("example-terms")).toBeUndefined();

    expect(focus.facts).toMatchObject({ basements: 2, criticalPlantInBasement: true, pastFloodLoss: true, dryInEveryTier: false, nearestWetCellM: 0, approximateLocation: false, unverifiedValues: 0, commercialOnResidentialCurve: true, tivKes: 2_000_000_000 });
    expect(focus.facts.grossLoss100Kes).toBe(price.total.loss100GrossKes);
    expect(focus.conditions.map((c) => c.id)).toEqual(expect.arrayContaining(["relocate_plant", "confirm_occupancy"]));

    expect(focus.summary).toEqual({ name: "invented-offer.txt", fieldsRead: focus.counts.verified, fieldsVerified: focus.counts.verified, loss100Kes: price.total.loss100GrossKes, aalKes: price.total.aalGrossKes, outside: false });
    expect(focus.checks.length).toBeGreaterThan(1);
    expect(focus.rows).toHaveLength(1);
  });

  it("says a dry building is dry, and how close the mapped water comes", () => {
    const focus = priced(buildOfferFocus(input(offerOf(extraction([at(dry)])))));
    const b = focus.price.building;
    expect(b.dryOnEveryTerrainMap).toBe(true);
    expect(b.dryAtEveryReturnPeriod).toBe(true);
    expect(b.firstWetReturnPeriod).toBeNull();
    expect(b.perReturnPeriod.every((r) => r.depthFrom === "dry" && r.groundUpKes === 0 && r.grossKes === 0 && r.deductibleKes === 0)).toBe(true);
    expect(b.nearestWetM).toBe(Math.min(...b.perReturnPeriod.map((r) => r.nearestWetM!)));
    expect(b.nearestWetM!).toBeGreaterThan(0);
    expect(focus.price.total.aalGrossKes).toBe(0);
    expect(focus.facts.dryInEveryTier).toBe(true);
    expect(focus.flags.find((f) => f.id === "flood-depth")).toBeUndefined();
  });

  it("stops outside the maps with the one sentence and no loss fields", () => {
    const focus = buildOfferFocus(input(offerOf(extraction([row({ lat: said(0.12), lon: said(34.1) })], STATED_TERMS))))!;
    expect(focus.status).toBe("outside");
    expect(focus.outside).toBe(true);
    expect(focus.outsideMessage).toBe("Outside the hazard maps loaded: flood cannot be priced here");
    expect(focus.outsideMessage).toBe(OUTSIDE_MAPS_MESSAGE);
    expect(focus.statusLine).toContain(OUTSIDE_MAPS_MESSAGE);
    expect(isPriced(focus)).toBe(false);
    // No loss figure of any kind, not even a zero.
    expect(focus.price).toBeNull();
    expect(focus.site).toBeNull();
    expect(focus.pricing!.totals).toBeNull();
    expect(focus.summary).toMatchObject({ loss100Kes: null, aalKes: null, outside: true });
    expect(focus.facts).toMatchObject({ grossLoss100Kes: null, tivKes: null, nearestWetCellM: null });
    expect(focus.building).toMatchObject({ status: "outside", lat: 0.12, lon: 34.1, ward: null });
    expect(focus.coverage).toContain("team_a_nairobi");
    expect(focus.flags[0]).toMatchObject({ severity: "high", title: "The building is outside the hazard maps loaded" });
    expect(JSON.stringify(focus.building)).not.toMatch(/Kes":0|lossKes/);
  });

  it("waits for an unverified value, says which, and prices once it is confirmed", () => {
    const e = extraction([at(wet, { tivKes: doubted(2_000_000_000, "The number 2,000,000,000 is not in the sentence given for it.") })]);
    const focus = buildOfferFocus(input(offerOf(e)))!;
    expect(focus.status).toBe("waiting");
    expect(focus.price).toBeNull();
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

  it("prices the same rows under each set of assumptions, and the light pricing agrees with the engine", () => {
    const softer: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 2.5, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 0.5 } };
    const harder: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 5.5, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 1.1 }, returnPeriods: { extreme: 5, severe: 15, moderate: 40, occasional: 80, common: 200 } };
    const agreed: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 4.5, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 0.8 } };
    // Only the parameters are read from a deliberation, so the results are left out of this stand-in.
    const scored = (params: ModelParams) => ({ params, adjustments: [] }) as unknown as Scored;
    const deliberation: Pick<Deliberation, "optimist" | "cautious" | "final"> = { optimist: scored(softer), cautious: scored(harder), final: scored(agreed) };
    const offer = offerOf(extraction([at(wet)], STATED_TERMS));

    // No agents: the reference set alone, and it is the one in force.
    const alone = priced(buildOfferFocus(input(offer)));
    expect(alone.price.assumptions.map((a) => a.id)).toEqual(["reference"]);
    expect(alone.price.assumptions[0]).toMatchObject({ inForce: true, label: "Reference, no AI", aalGrossKes: alone.price.total.aalGrossKes, loss100GrossKes: alone.price.total.loss100GrossKes });
    expect(alone.assumptionsInForce).toBe("reference");

    // Agents have run and their set is in force.
    const withAgents = priced(buildOfferFocus(input(offer, { deliberation, active: { source: "ai", params: agreed, result: runModel(dataset, agreed) } })));
    const by = Object.fromEntries(withAgents.price.assumptions.map((a) => [a.id, a]));
    expect(withAgents.price.assumptions.map((a) => a.id)).toEqual(["reference", "optimist", "cautious", "agreed"]);
    expect(withAgents.price.assumptions.filter((a) => a.inForce).map((a) => a.id)).toEqual(["agreed"]);
    expect(withAgents.assumptionsInForce).toBe("ai");
    expect(by.agreed.aalGrossKes).toBe(withAgents.price.total.aalGrossKes);
    expect(by.optimist.aalGrossKes).toBeLessThan(by.agreed.aalGrossKes);
    expect(by.cautious.aalGrossKes).toBeGreaterThan(by.agreed.aalGrossKes);
    expect(by.cautious.params).toBe(harder);
    expect(by.cautious.building.map((r) => r.returnPeriod)).toEqual([5, 15, 40, 80, 200]);
    // The Cautious set's rarest flood is 1-in-200, so its 1-in-100 loss is read off the curve, not held flat.
    expect(by.cautious.loss100Extrapolated).toBe(false);

    // The reference entry was priced without running the portfolio again. It must equal the engine's
    // own figures for a run on the reference set, and the same goes for every other set.
    close(by.reference.aalGrossKes, alone.price.total.aalGrossKes);
    close(by.reference.aalGroundUpKes, alone.price.total.aalGroundUpKes);
    close(by.reference.loss100GrossKes!, alone.price.total.loss100GrossKes!);
    by.reference.building.forEach((r, k) => {
      const engine = alone.price.building.perReturnPeriod[k];
      expect(r.returnPeriod).toBe(engine.returnPeriod);
      close(r.depthM, engine.depthM);
      close(r.damageRatio, engine.damageRatio);
      close(r.groundUpKes, engine.groundUpKes);
      close(r.grossKes, engine.grossKes);
    });
    for (const [id, params] of [["optimist", softer], ["cautious", harder]] as const) {
      const engine = priced(buildOfferFocus(input(offer, { active: { source: "ai", params, result: runModel(dataset, params) }, deliberation: { optimist: null, cautious: null, final: scored(params) } })));
      close(by[id].aalGrossKes, engine.price.total.aalGrossKes);
      close(by[id].aalGroundUpKes, engine.price.total.aalGroundUpKes);
      close(by[id].ratePerMilleGross, engine.price.total.ratePerMilleGross);
      expect(by[id].loss100Extrapolated).toBe(engine.price.total.loss100Extrapolated);
      close(by[id].loss100GrossKes!, engine.price.total.loss100GrossKes!);
    }
    // A wide gap between the two agents is itself a point to weigh.
    expect(by.cautious.aalGrossKes).toBeGreaterThanOrEqual(2 * by.optimist.aalGrossKes);
    expect(withAgents.flags.find((f) => f.id === "assumption-spread")).toMatchObject({ severity: "medium", evidence: { kind: "figure" } });
  });

  it("adds drainage ponding at the building when drainage is on, in the trace and under every set of assumptions", () => {
    const view = withDrainage(dataset, state);
    const offer = offerOf(extraction([at(ponded)]));
    const drained = (params: ModelParams, more: Partial<OfferFocusInput> = {}) => input(offer, { session: { dataset: view }, drainage: state, active: { source: "reference", params, result: runModel(view, params) }, ...more });
    const focus = priced(buildOfferFocus(drained(REFERENCE_PARAMS)));
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
    }
    close(focus.price.building.perReturnPeriod[4].drainageM, stress * DRAINAGE_DEFAULTS.depthM.common);
    expect(focus.price.building.dryOnEveryTerrainMap).toBe(true);
    expect(focus.price.building.dryAtEveryReturnPeriod).toBe(false);
    expect(focus.price.building.firstWetReturnPeriod).toBe(10);
    expect(focus.flags.find((f) => f.id === "drainage-ponding")).toMatchObject({ severity: "low" });
    expect(focus.conditions.map((c) => c.id)).toContain("drainage_evidence");

    // The same point with drainage off is dry, and no stress is reported.
    const off = priced(buildOfferFocus(input(offer)));
    expect(off.site.drainageStress).toBeNull();
    expect(off.price.building.dryAtEveryReturnPeriod).toBe(true);

    // The light pricing carries the ponding too.
    const harder: ModelParams = { ...REFERENCE_PARAMS, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: 1.2 } };
    const scored = (params: ModelParams) => ({ params, adjustments: [] }) as unknown as Scored;
    const both = priced(buildOfferFocus(drained(REFERENCE_PARAMS, { deliberation: { optimist: null, cautious: scored(harder), final: null } })));
    const engine = priced(buildOfferFocus(drained(harder)));
    close(both.price.assumptions.find((a) => a.id === "cautious")!.aalGrossKes, engine.price.total.aalGrossKes);
  });

  it("follows the first priced building of several and says so", () => {
    const e = extraction([row({ name: said("Not Located House") }), at(wet, { name: said("Invented Tower") }), at(dry, { name: said("Dry Annex"), tivKes: said(500_000_000) })], STATED_TERMS);
    const focus = priced(buildOfferFocus(input(offerOf(e))));
    expect(focus.several).toBe(true);
    expect(focus.buildings.map((b) => b.status)).toEqual(["not_ready", "priced", "priced"]);
    expect(focus.building).toMatchObject({ index: 1, locId: "OFFER-2", name: "Invented Tower" });
    expect(focus.severalLine).toContain("3 buildings");
    expect(focus.severalLine).toContain("Invented Tower");
    expect(focus.price.pricedCount).toBe(2);
    expect(focus.price.building.locId).toBe("OFFER-2");
    expect(focus.price.total.tivKes).toBe(2_500_000_000);
    expect(focus.price.building.tivKes).toBe(2_000_000_000);
    // The dry annex adds no loss, so the terms fall on the one building that floods.
    close(focus.price.total.aalGrossKes, focus.price.building.aalGrossKes);
    expect(focus.line.sumInsuredKes).toBe(4_500_000_000);
    expect(focus.buildings[0].blockers.length).toBeGreaterThan(0);
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
  });

  it("is quick enough to run on every edit of a field", () => {
    const offer = offerOf(extraction([at(wet)], STATED_TERMS));
    const softer: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 3 };
    const scored = (params: ModelParams) => ({ params, adjustments: [] }) as unknown as Scored;
    const view = withDrainage(dataset, state);
    const given = input(offer, { session: { dataset: view }, drainage: state, active: { source: "reference", params: REFERENCE_PARAMS, result: runModel(view, REFERENCE_PARAMS) }, deliberation: { optimist: scored(softer), cautious: scored(softer), final: scored(softer) } });
    buildOfferFocus(given);
    const runs = 5;
    const started = performance.now();
    for (let i = 0; i < runs; i++) buildOfferFocus(given);
    const ms = (performance.now() - started) / runs;
    console.log(`Offer focus on ${dataset.buildings.length} buildings with drainage and four sets of assumptions: ${ms.toFixed(1)} ms a run`);
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
  let nairobi: OfferFocus;
  let nzoia: OfferFocus;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    const dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const result = runModel(dataset, REFERENCE_PARAMS);
    const knownPlaces = [...wards.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
    const read = async (file: string): Promise<OfferFocus> => {
      const text = await docxToText(readFileSync(join(TEST_DATA, file)));
      const run = await extractOffer(text, { rulesOnly: true, knownPlaces });
      const offer: OfferState = { document: { name: "test-offer.docx", kind: "docx", text }, run, extraction: run.extraction };
      return buildOfferFocus({ offer, session: { dataset }, active: { source: "reference", params: REFERENCE_PARAMS, result }, drainage: null, policyDefaults: DEFAULT_TERMS, portfolioTerms: applyTerms(dataset, result, DEFAULT_TERMS), deliberation: null, layers: { wards, waterways } })!;
    };
    nairobi = await read(nairobiMemo!);
    nzoia = await read(nzoiaMemo!);
  }, 120_000);

  it("prices the Nairobi offer and gives every step what it needs about that building", () => {
    expect(nairobi.status).toBe("priced");
    if (!isPriced(nairobi)) throw new Error("the Nairobi offer should be priced");
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
    const { total, building, portfolio } = nairobi.price;
    console.log(
      `Nairobi test offer by the rules: ${nairobi.fields.filter((f) => f.status !== "missing").length} values read, class ${nairobi.building.housingClass}, ${nairobi.building.approximate ? "approximate" : "exact"} location, first wet at ${building.firstWetReturnPeriod ?? "never"}; ` +
        `1-in-100 gross KES ${Math.round(total.loss100GrossKes ?? 0).toLocaleString("en-KE")}, gross AAL KES ${Math.round(total.aalGrossKes).toLocaleString("en-KE")}, rate ${total.ratePerMilleGross.toFixed(3)} per mille, share of portfolio value ${(portfolio.tivShare * 100).toFixed(1)}%, terms: ${nairobi.terms.summary}
` +
        `  flags: ${nairobi.flags.map((f) => `${f.severity} ${f.id}`).join(", ")}
  conditions: ${nairobi.conditions.map((c) => c.id).join(", ")}`,
    );
  });

  it("stops the Nzoia offer outside the hazard maps loaded, with no loss figure", () => {
    expect(nzoia.status).toBe("outside");
    expect(nzoia.outside).toBe(true);
    expect(nzoia.outsideMessage).toBe("Outside the hazard maps loaded: flood cannot be priced here");
    expect(nzoia.price).toBeNull();
    expect(nzoia.site).toBeNull();
    expect(isPriced(nzoia)).toBe(false);
    expect(nzoia.summary.outside).toBe(true);
    expect(nzoia.summary.loss100Kes).toBeNull();
    expect(nzoia.summary.aalKes).toBeNull();
    expect(nzoia.flags.some((f) => f.severity === "high" && f.title === "The building is outside the hazard maps loaded")).toBe(true);
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
    expect(focus.coverage).toBeNull();
    expect(isPriced(focus)).toBe(false);
  });
});
