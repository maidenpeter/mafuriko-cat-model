import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildProfile } from "../src/lib/agents/profile";
import { dataChecks, financialChecks, hazardChecks, summarise, type Check } from "../src/lib/checks";
import { beyondDepthAssumptions, buildAudit, buildNote, judgementRange, LIMITS, PORTFOLIO_DRIVERS_LINE, SETTER_LABELS, settersLine } from "../src/lib/export";
import { drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage, type DrainageState } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WardProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { kes1, LOSS_MODE_LABELS, perMille, selectMode, SETTER_WORDS, shareText } from "../src/lib/labels";
import type { LossMode } from "../src/lib/model/drivers";
import { hotspotHits } from "../src/lib/model/hotspots";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import { applyTerms, DEFAULT_TERMS } from "../src/lib/model/terms";
import type { Dataset, ModelResult } from "../src/lib/model/types";
import { OFFER_DRIVER_CHECK_IDS, offerDriverChecks } from "../src/lib/offer/checks";
import { extractOffer } from "../src/lib/offer/client";
import { docxToText } from "../src/lib/offer/docx";
import { historyFields } from "../src/lib/offer/fields";
import { buildOfferFocus, isPriced, originOf, portfolioJudgement, type OfferFocus, type PricedFocus } from "../src/lib/offer/focus";
import { BASEMENT_LADDER, JUDGEMENT_BOUNDS, JUDGEMENT_KEYS, JUDGEMENT_LABELS, ladderRung, OUTAGE_LADDER } from "../src/lib/offer/judgement";
import { OUTSIDE_MAPS_MESSAGE, type ExtractionRun, type OfferExtraction, type OfferNote, type OfferRow, type OfferState, type OfferTerms, type Quoted } from "../src/lib/offer/types";
import type { Active, Session } from "../src/lib/session";

/**
 * The audit file and the written note, as the Audit step downloads them: in each position of the
 * header switch, for an invented offer, for the two test offers read by the fixed rules, and with
 * no offer at all. Also what the exports rest on: one list of checks on the focus, and the table of
 * the 19 assumptions beyond flood depth.
 *
 * Nothing here prints or holds any of the test documents' text. What is said of them is tested one
 * plain value at a time, so a failure cannot print a word of a document.
 */

const KIT = join(__dirname, "..", "..", "data", "data");
const TEST_DATA = join(__dirname, "..", "..", "data", "test-data");

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

const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;
const MODES: LossMode[] = ["depth_only", "all_drivers"];
/** An en dash or an em dash, by code point, so this file holds neither. */
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

// --- an invented offer ---------------------------------------------------------------------------
// Nothing here comes from a real document: every name, figure and sentence is made up for the test.

const said = <T,>(value: T, quote = "An invented sentence."): Quoted<T> => ({ value, quote, status: "verified", reason: null });
const missing = <T,>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });
const TIV = 2_000_000_000;

const row = (p: { lat: number; lon: number }, values: Partial<OfferRow> = {}): OfferRow => ({
  name: said("Invented Tower", "INSURED PROPERTY: Invented Tower"),
  lat: said(p.lat, "GPS: invented"),
  lon: said(p.lon, "GPS: invented"),
  housingClass: said("concrete_rcc", "reinforced concrete frame"),
  floorAreaM2: said(20_000, "GROSS FLOOR AREA: 20,000 m2"),
  costPerM2Kes: missing(),
  tivKes: said(TIV, "TOTAL SUM INSURED: KES 2,000,000,000"),
  path: "model",
  coordinates: null,
  ...values,
});

const terms = (values: Partial<OfferTerms> = {}): OfferTerms => ({
  basements: said(2, "two basement levels"),
  occupancy: said("commercial", "a commercial office block"),
  floodDeductiblePct: said(5, "Flood deductible 5% of each and every loss"),
  floodDeductibleMinKes: said(1_000_000, "minimum KES 1,000,000"),
  floodDeductibleBasis: missing(),
  floodLimitKes: said(500_000_000, "Flood sub-limit KES 500,000,000 any one event"),
  policyPeriod: missing(),
  floodCover: said("covered", "Flood is to be covered."),
  placeName: missing(),
  riverName: missing(),
  riverDistanceM: missing(),
  // What the loss drivers read. The drain design, the pump backup and the valves are left out: they are the open questions.
  valueBelowGroundKes: said(150_000_000, "Plant and contents in the basements are valued at KES 150,000,000."),
  biCovered: said("covered", "Loss of rent is to be insured."),
  annualRentKes: said(146_000_000, "Annual rent roll KES 146,000,000."),
  floodBarriers: said("absent", "No flood barriers are fitted at the ramps."),
  valueBuildingKes: said(1_500_000_000, "Building KES 1,500,000,000"),
  valueMachineryKes: said(300_000_000, "Plant and machinery KES 300,000,000"),
  valueContentsKes: said(200_000_000, "Contents KES 200,000,000"),
  premiumKes: said(6_000_000, "Annual premium KES 6,000,000 all risks."),
  floodHistoryYears: said(10, "Loss history: 10 years."),
  ...values,
});

const NOTES: OfferNote[] = [{ ...said("Storm drain blocked", "The storm drain on the east side is blocked with silt."), kind: "drainage_condition" }];

const inventedExtraction = (rows: OfferRow[], t: Partial<OfferTerms> = {}): OfferExtraction => ({
  rows,
  terms: terms(t),
  notes: NOTES,
  floodLosses: [{ year: said(2019, "2019: water damage"), amountKes: said(4_000_000, "2019: water damage, KES 4,000,000 paid") }],
  equipmentBelowGround: [{ item: said("Standby generator", "The standby generator is in basement 2.") }, { item: said("Switchgear", "Main switchgear room, basement 1.") }],
});

function offerOf(extraction: OfferExtraction): OfferState {
  const text = "INSURED PROPERTY: Invented Tower";
  return {
    document: { name: "invented-offer.txt", kind: "txt", text },
    run: { extraction, documentText: text, removed: { emails: 0, phones: 0, blocks: [] }, path: "model", fallbackReason: null, sentToModel: true, prompt: { system: "instructions", user: text }, model: "invented-model", usage: { promptTokens: 900, outputTokens: 300 }, ms: 1200, replyJson: '{"entries":[]}' },
    extraction,
  };
}

describe.skipIf(!existsSync(KIT))("the audit file and the written note, on the Nairobi starter kit with drainage on", () => {
  let dataset: Dataset;
  let drained: Dataset;
  let drainage: DrainageState;
  let session: Session;
  let modelChecks: Record<LossMode, Check[]>;
  const layers = { wards: geo<WardProps>("wards.geojson"), waterways: geo<WaterwayProps>("waterways.geojson") };
  const results = {} as Record<LossMode, ModelResult>;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    const loaded = await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files);
    dataset = loaded.dataset;
    const widest = dataset.rasters.find((r) => r.scenarioId === "common")!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, layers.waterways, geo<SettlementProps>("informal-settlements.geojson"));
    drainage = { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) };
    drained = withDrainage(dataset, drainage);
    for (const mode of MODES) results[mode] = runModel(drained, REFERENCE_PARAMS, { mode, judgement: portfolioJudgement().assumed });
    // The session as the shell holds it for the view with drainage on.
    const reference = runModel(drained, REFERENCE_PARAMS);
    const dChecks = dataChecks(drained, loaded.report);
    const hChecks = hazardChecks(drained, loaded.report);
    session = { uploadName: "starter kit", dataset: drained, report: loaded.report, reference, dataChecks: dChecks, hazardChecks: hChecks, hits: hotspotHits(drained), profile: buildProfile(drained, loaded.report, reference, [...dChecks, ...hChecks]) };
    modelChecks = { depth_only: [...dChecks, ...hChecks, ...financialChecks(drained, results.depth_only)], all_drivers: [...dChecks, ...hChecks, ...financialChecks(drained, results.all_drivers)] };
  }, 120_000);

  const activeOf = (mode: LossMode): Active => ({ source: "reference", params: REFERENCE_PARAMS, result: results[mode] });
  const focusOf = (offer: OfferState, mode: LossMode): OfferFocus => {
    const focus = buildOfferFocus({ offer, session: { dataset: drained }, active: activeOf(mode), drainage, policyDefaults: DEFAULT_TERMS, deliberation: null, layers, mode });
    if (!focus) throw new Error("an offer was read, so there should be a focus");
    return focus;
  };
  const priced = (focus: OfferFocus): PricedFocus => {
    if (!isPriced(focus)) throw new Error(`the offer should be priced, not ${focus.status}`);
    return focus;
  };
  /** Both exports as the Audit step makes them: the model's checks, no agents, the example terms, and the offer when there is one. */
  const exportsOf = (mode: LossMode, offer: OfferFocus | null) => {
    const active = activeOf(mode);
    const termsResult = applyTerms(drained, active.result, DEFAULT_TERMS);
    const extras = offer ? { offer } : {};
    return { audit: buildAudit(session, active, null, modelChecks[mode], [], termsResult, extras), note: buildNote(session, active, null, modelChecks[mode], termsResult, extras) };
  };
  /** The rows of a Markdown table in the note, by its header line: each row as its cells. */
  const tableRows = (note: string, header: string): string[][] => {
    const lines = note.split("\n");
    const start = lines.indexOf(header);
    if (start < 0) return [];
    const out: string[][] = [];
    for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) out.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
    return out;
  };
  const ASSUMPTIONS_HEADER = "| Assumption | Value in force | Reference value | Allowed range | Who set it | Source | Used for |";
  /** The line of the note that counts the checks. */
  const countLine = (note: string) => note.split("\n").find((l) => / passed, \d+ warnings, \d+ failed/.test(l)) ?? "";
  /** True when the note has this line exactly: "## The offer" is not "### The offer reader". */
  const hasLine = (note: string, line: string) => note.split("\n").includes(line);
  const driverCheckIds =(checks: readonly { id: string }[]) => checks.map((c) => c.id).filter((id) => (OFFER_DRIVER_CHECK_IDS as readonly string[]).includes(id));
  const invented = () => offerOf(inventedExtraction([row(dataset.buildings[0])]));

  /** The table of assumptions beyond flood depth, in the audit file and in the note: 19 rows, each with a value, a range and who set it. */
  const expectAssumptionsTable = (audit: ReturnType<typeof buildAudit>, note: string, mode: LossMode) => {
    const rows = audit.assumptionsBeyondFloodDepth.rows;
    expect(rows).toHaveLength(19);
    expect(rows.map((r) => r.key)).toEqual(JUDGEMENT_KEYS);
    expect(audit.assumptionsBeyondFloodDepth.inUse).toBe(mode === "all_drivers");
    for (const r of rows) {
      expect(Number.isFinite(r.inForce), r.key).toBe(true);
      expect(r.value.length > 0 && r.value !== "n/a", r.key).toBe(true);
      expect(r.range).toEqual(JUDGEMENT_BOUNDS[r.key]);
      expect(r.range.min <= r.range.max, r.key).toBe(true);
      expect(r.rangeText.includes(" to "), r.key).toBe(true);
      expect(Object.keys(SETTER_LABELS), r.key).toContain(r.setBy);
      expect(r.setByText, r.key).toBe(SETTER_LABELS[r.setBy]);
      expect(r.source.length > 0, r.key).toBe(true);
      // An assumption stays inside its range; only a figure the offer states itself may lie outside it.
      if (r.setBy !== "offer") expect(r.inForce >= r.range.min && r.inForce <= r.range.max, r.key).toBe(true);
    }
    const table = tableRows(note, ASSUMPTIONS_HEADER);
    expect(table).toHaveLength(19);
    table.forEach((cells, i) => {
      expect(cells).toHaveLength(7);
      expect(cells.every((c) => c.length > 0), rows[i].key).toBe(true);
      expect(cells[1] === rows[i].value && cells[3] === rows[i].rangeText && cells[4] === rows[i].setByText, rows[i].key).toBe(true);
    });
  };

  it("keeps one name for each setting of the header switch, and both exports say which is in force", () => {
    expect(LOSS_MODE_LABELS).toEqual({ depth_only: "Depth only", all_drivers: "All loss drivers" });
    for (const mode of MODES) {
      const { audit, note } = exportsOf(mode, focusOf(invented(), mode));
      expect(audit.lossesFrom.mode).toBe(mode);
      expect(audit.lossesFrom.label).toBe(LOSS_MODE_LABELS[mode]);
      expect(audit.offer?.modelUsed.lossesFromLabel).toBe(LOSS_MODE_LABELS[mode]);
      expect(note).toContain(`Losses from: **${LOSS_MODE_LABELS[mode]}**.`);
      expect(note).toContain(`In force for this note: **${LOSS_MODE_LABELS[mode]}**.`);
    }
  });

  it("names things once: the first line with Depth only, the rungs of a ladder, who set a figure, the portfolio's drivers", () => {
    // With Depth only the loss at the point is not called Surrounding flooding, and drivers that are off have no column.
    const point = exportsOf("depth_only", focusOf(invented(), "depth_only")).note;
    expect(point).toContain("| Return period | Depth at the point |");
    expect(point).not.toContain("| Return period | Surrounding flooding |");
    expect(point).toMatch(/Not in this price: .*Basement ingress.*Uncertainty loading\./);
    const all = exportsOf("all_drivers", focusOf(invented(), "all_drivers")).note;
    expect(all).toContain("| Return period | Surrounding flooding |");
    // A rung is named by its place and its flood, the same in the note, the audit file and on screen.
    expect(JUDGEMENT_LABELS.basementDamageExtreme).toBe("Basement damage ratio, rung 1 of 5, most frequent flood (share of value below ground)");
    expect(JUDGEMENT_LABELS.basementDamageModerate).toBe("Basement damage ratio, rung 3 of 5 (share of value below ground)");
    expect(JUDGEMENT_LABELS.outageDaysCommon).toBe("Outage, rung 5 of 5, rarest flood (days)");
    expect(ladderRung("basementDamageSevere")).toEqual({ ladder: "basement", rung: 2, of: 5, text: "rung 2 of 5" });
    expect(ladderRung("outageDaysOccasional", [10, 25, 50, 100, 250])?.text).toBe("rung 4 of 5, 1-in-100 flood");
    expect(ladderRung("bufferRadiusM")).toBeNull();
    for (const key of [...BASEMENT_LADDER, ...OUTAGE_LADDER]) {
      expect(JUDGEMENT_LABELS[key], key).not.toMatch(/tier|extreme|common/);
      expect(judgementRange(key), key).toContain("never below the more frequent rung");
      expect(all, key).toContain(`| ${JUDGEMENT_LABELS[key]} |`);
    }
    // Who set a figure: one table of words, read by the table cell and by the count.
    expect(SETTER_LABELS).toEqual({ offer: "Offer", agents: "Agents", typed: "Typed", reference: "Reference", "not recorded": "Not recorded" });
    expect(SETTER_WORDS.typed).toEqual({ short: "Typed", sentence: "typed by the underwriter", counted: "typed by the underwriter" });
    const rows = beyondDepthAssumptions(portfolioJudgement({ bufferRadiusM: 100 }), null, results.all_drivers);
    expect(settersLine(rows)).toBe("1 typed by the underwriter, 18 reference values");
    // The portfolio's drivers: one sentence, once in each record.
    expect(LIMITS.filter((l) => l === PORTFOLIO_DRIVERS_LINE)).toHaveLength(1);
    expect(LIMITS.filter((l) => /not modelled for/.test(l))).toHaveLength(1);
    expect(all.split(PORTFOLIO_DRIVERS_LINE)).toHaveLength(2);
    // The shared wording helpers.
    expect(selectMode("all_drivers")).toBe('Select All loss drivers under "Losses from" in the bar above');
    expect([shareText(0.125), shareText(0.08), shareText(0.075)]).toEqual(["12.5%", "8%", "7.5%"]);
    expect([perMille(8.021), perMille(0.0512), perMille(null)]).toEqual(["8.02 per mille", "0.0512 per mille", "n/a"]);
    // The mode is named without quotes, and nothing is called underinsurance in one place and under-insurance in another.
    expect(all).not.toMatch(/"Depth only"|"All loss drivers"|underinsurance/);
  });

  it("says in the list of assumptions when code raised a ladder rung, and who pushed it up", () => {
    const judgement = portfolioJudgement({ basementDamageExtreme: 0.9 });
    const rows = beyondDepthAssumptions(judgement, null, results.all_drivers);
    const rung = (key: string) => rows.find((r) => r.key === key)!;
    expect(rung("basementDamageExtreme")).toMatchObject({ setBy: "typed", value: "90%", source: "Typed over on screen by the underwriter." });
    for (const key of BASEMENT_LADDER.slice(1)) {
      // In force at 90%, so never "Reference value" beside it.
      expect(rung(key), key).toMatchObject({ setBy: "typed", value: "90%" });
      expect(rung(key).source, key).toContain("Raised by code to keep the ladder rising");
      expect(rung(key).source, key).toContain(`Its own value was ${rung(key).referenceText}.`);
      expect(rung(key).source, key).not.toMatch(/^Reference value/);
    }
    for (const key of OUTAGE_LADDER) expect(rung(key), key).toMatchObject({ setBy: "reference" });
    expect(settersLine(rows)).toBe("5 typed by the underwriter, 14 reference values");
  });

  it("works the capital load out from the gross change and sets the loss history beside the gross loss, in the note as on screen", () => {
    const focus = priced(focusOf(invented(), "all_drivers"));
    const { audit, note } = exportsOf("all_drivers", focus);
    const premium = focus.drivers.premium;
    // One figure for what the offer adds to the portfolio's 1-in-100: gross, in the key figures and in the capital load.
    expect(premium.capital).toMatchObject({ basis: "gross", addedLoss100Kes: focus.price.total.loss100GrossKes });
    expect(note).toContain(`| Change to the portfolio's 1-in-100 gross loss | +${kes1(focus.price.portfolio.gross!.change100Kes)}`);
    expect(note).toContain(`a year of the ${kes1(premium.capital.addedLoss100Kes)} the offer adds to the portfolio's 1-in-100 gross loss.`);
    expect(kes1(premium.capital.addedLoss100Kes)).toBe(kes1(focus.price.portfolio.gross!.change100Kes));
    expect(note.split(/\r?\n/).some((line) => line.includes("Capital load") && line.includes("ground-up"))).toBe(false);
    expect(audit.offer!.lossDrivers!.premiumBuildUp.capital.basis).toBe("gross");
    // The caption says once that every driver's line is gross; no driver's row repeats it.
    expect(note.split("gross: after the deductible and the limit.")).toHaveLength(2);
    // The loss history: one modelled figure beside it, the gross average annual loss, in the note as in the point raised on a past flood.
    const beside = `a modelled average annual loss of ${kes1(premium.history.modelledAalKes)} gross.`;
    expect(premium.history.usable).toBe(true);
    expect(premium.history.modelledAalKes).toBe(focus.price.total.aalGrossKes);
    expect(note).toContain(`beside ${beside}`);
    // The questions are listed once in the offer's part of the note, and no point repeats one.
    expect(note.split("### Questions for the broker")).toHaveLength(2);
    expect(focus.flags.some((f) => f.id.startsWith("broker-questions-"))).toBe(false);
  });

  it("writes the invented offer in both modes: the drivers, the premium, the questions and the table of assumptions", () => {
    for (const mode of MODES) {
      const focus = priced(focusOf(invented(), mode));
      const { audit, note } = exportsOf(mode, focus);
      const all = mode === "all_drivers";
      const record = audit.offer!;
      expect(record.status).toBe("priced");
      expect(record.lossDrivers?.mode).toBe(mode);
      expect(record.price?.total.aalGrossKes).toBe(focus.price.total.aalGrossKes);
      expect(note).toContain("## The offer");
      expect(note).toContain("### Water at the site");
      expect(note).toContain("### Loss by driver");
      expect(note.includes("### Premium build-up")).toBe(all);
      expect(note).toContain("### Questions for the broker");
      expectAssumptionsTable(audit, note, mode);
      // Who set each: the offer states the value below ground and a year's rent, and nothing else is typed or argued.
      const setBy = Object.fromEntries(audit.assumptionsBeyondFloodDepth.rows.map((r) => [r.key, r.setBy]));
      expect(setBy.belowGroundShare).toBe("offer");
      expect(setBy.annualRentShare).toBe("offer");
      expect(setBy.drainDesignRp).toBe("reference");
      expect(audit.assumptionsBeyondFloodDepth.rows.find((r) => r.key === "belowGroundShare")?.quote).toBe("Plant and contents in the basements are valued at KES 150,000,000.");
      expect(audit.assumptionsBeyondFloodDepth.rows.every((r) => r.setBy === "offer" || r.setBy === "reference")).toBe(true);
      // The questions carry what the model uses until each is answered, as the focus has it.
      expect(record.brokerQuestions.map((q) => q.assumes)).toEqual(focus.questions.map((q) => q.assumes));
      expect(record.brokerQuestions.find((q) => q.id === "drainDesignRp")?.assumes?.keys).toEqual(["drainDesignRp"]);
      // The document's own loss history is in the list of values, with every other value.
      const ids = record.extraction.fields.map((f) => f.id);
      for (const h of historyFields(focus.extraction)) expect(ids, h.id).toContain(h.id);
      expect(new Set(ids).size).toBe(ids.length);
      // No dash that is not a hyphen in anything written for an invented offer.
      expect(LONG_DASH.test(note)).toBe(false);
      expect(LONG_DASH.test(JSON.stringify(audit))).toBe(false);
    }
  });

  it("Depth only writes the point pricing, and All loss drivers writes the same offer with Depth only beside it", () => {
    const depth = priced(focusOf(invented(), "depth_only"));
    const all = priced(focusOf(invented(), "all_drivers"));
    const depthAudit = exportsOf("depth_only", depth).audit.offer!;
    const allAudit = exportsOf("all_drivers", all).audit.offer!;
    expect(depthAudit.price?.total.aalGrossKes).toBe(depth.pricing!.totals!.aalGrossKes);
    expect(depthAudit.price?.total.curve.map((c) => c.groundUpKes)).toEqual(depth.pricing!.totals!.scenarios.map((s) => s.groundUpKes));
    expect(depthAudit.price?.depthOnly).toEqual(depthAudit.price?.total);
    expect(allAudit.price?.depthOnly.aalGrossKes).toBe(depthAudit.price?.total.aalGrossKes);
    expect(allAudit.price!.total.aalGroundUpKes).toBeGreaterThanOrEqual(depthAudit.price!.total.aalGroundUpKes);
    for (const r of depthAudit.lossDrivers!.perReturnPeriod) for (const id of ["overload", "basement", "interruption", "uncertainty"] as const) expect(r.groundUpKes[id]).toBe(0);
    // The premium build-up of the audit file carries the flood rate as a share of the stated all-risks rate.
    const stated = allAudit.lossDrivers!.premiumBuildUp.stated!;
    expect(stated.premiumKes).toBe(6_000_000);
    expect(stated.floodShareOfAllRisks).toBe(allAudit.lossDrivers!.premiumBuildUp.floodPremiumKes / 6_000_000);
    expect(Math.abs(stated.floodShareOfAllRisks - allAudit.lossDrivers!.premiumBuildUp.floodRatePerMille / stated.ratePerMille)).toBeLessThan(1e-9);
  });

  it("holds the three loss driver checks once, in the focus's own list, and neither export adds them again", () => {
    for (const mode of MODES) {
      const focus = priced(focusOf(invented(), mode));
      expect(driverCheckIds(focus.checks)).toEqual([...OFFER_DRIVER_CHECK_IDS]);
      expect(new Set(focus.checks.map((c) => c.id)).size).toBe(focus.checks.length);
      // They are the moved checks, worked out from the focus's own figures, and they pass.
      const own = offerDriverChecks({ drivers: focus.drivers, total: focus.price.total, depthOnly: focus.price.depthOnly, point: focus.pricing!.totals });
      expect(focus.checks.filter((c) => (OFFER_DRIVER_CHECK_IDS as readonly string[]).includes(c.id))).toEqual(own);
      expect(own.map((c) => c.status)).toEqual(["pass", "pass", "pass"]);
      expect(own.every((c) => c.group === "financial")).toBe(true);
      // A passing check raises no flag.
      expect(focus.flags.some((f) => (OFFER_DRIVER_CHECK_IDS as readonly string[]).includes(f.id))).toBe(false);

      const { audit, note } = exportsOf(mode, focus);
      expect(audit.offer!.checks).toBe(focus.checks);
      expect(driverCheckIds(audit.checks)).toEqual([]);
      // The note counts the model's checks and the offer's, each once.
      const counts = summarise([...modelChecks[mode], ...focus.checks]);
      expect(countLine(note)).toBe(`${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed, the offer's checks included.`);
      // The same count when the caller has already put the offer's checks in the list.
      const active = activeOf(mode);
      const again = buildNote(session, active, null, [...modelChecks[mode], ...focus.checks], applyTerms(drained, active.result, DEFAULT_TERMS), { offer: focus });
      expect(countLine(again)).toBe(countLine(note));
    }
  });

  it("fails the moved checks when the parts do not add up, the depths are out of order or Depth only moves", () => {
    const focus = priced(focusOf(invented(), "all_drivers"));
    const base = { drivers: focus.drivers, total: focus.price.total, depthOnly: focus.price.depthOnly, point: focus.pricing!.totals };
    const status = (input: typeof base) => Object.fromEntries(offerDriverChecks(input).map((c) => [c.id, c.status]));
    const rows = focus.drivers.perReturnPeriod;
    const broken = { ...focus.drivers, perReturnPeriod: rows.map((r, k) => (k === 0 ? { ...r, groundUpTotalKes: r.groundUpTotalKes + 1000, depths: { ...r.depths, pointM: r.depths.bufferM + 1 } } : r)) };
    expect(status({ ...base, drivers: broken })).toMatchObject({ "offer-drivers-add-up": "fail", "offer-buffer-ge-point": "fail", "offer-depth-only-point": "pass" });
    const moved = { ...base.depthOnly, aalGrossKes: base.depthOnly.aalGrossKes + 1000 };
    expect(status({ ...base, depthOnly: moved })["offer-depth-only-point"]).toBe("fail");
    expect(status({ ...base, point: null })["offer-depth-only-point"]).toBe("warn");
  });

  it("lists the document's own loss history with the other values, under the one origin rule", () => {
    expect(originOf("missing", "model")).toEqual({ origin: "not stated", mark: null });
    expect(originOf("verified", "model")).toEqual({ origin: "AI, verified", mark: "verified" });
    expect(originOf("unverified", "model")).toEqual({ origin: "AI, unverified", mark: "unverified" });
    expect(originOf("verified", "rules")).toEqual({ origin: "rules", mark: "rules" });
    expect(originOf("unverified", "rules")).toEqual({ origin: "rules", mark: "unverified" });
    expect(originOf("confirmed", "rules")).toEqual({ origin: "confirmed", mark: "confirmed" });
    expect(originOf("edited", "model")).toEqual({ origin: "edited", mark: "edited" });

    const focus = focusOf(invented(), "all_drivers");
    const field = (id: string) => focus.fields.find((f) => f.id === id);
    expect(field("terms:floodHistoryYears")).toMatchObject({ group: "terms", row: null, label: "Years of loss history", raw: 10, quote: "Loss history: 10 years.", origin: "AI, verified", mark: "verified", holdsPricing: false });
    expect(field("loss:0:year")).toMatchObject({ ref: { scope: "loss", index: 0, key: "year" }, raw: 2019, origin: "AI, verified" });
    expect(field("loss:0:amountKes")).toMatchObject({ raw: 4_000_000, quote: "2019: water damage, KES 4,000,000 paid", status: "verified" });
    // After the notes, in the order historyFields gives, each once.
    const ids = focus.fields.map((f) => f.id);
    expect(ids.slice(-3)).toEqual(historyFields(focus.extraction).map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
    // An offer with no loss history still has the one entry, not stated.
    const bare = focusOf(offerOf({ ...inventedExtraction([row(dataset.buildings[0])], { floodHistoryYears: undefined }), floodLosses: [] }), "all_drivers");
    expect(bare.fields.filter((f) => f.id.startsWith("loss:") || f.id === "terms:floodHistoryYears").map((f) => [f.id, f.origin])).toEqual([["terms:floodHistoryYears", "not stated"]]);
  });

  it("fills the facts behind the conditions from the document's usable values, once the offer is priced", () => {
    const focus = priced(focusOf(invented(), "all_drivers"));
    expect(focus.facts).toMatchObject({ equipmentBelowGround: 2, drainDesignStated: false, sumpPumpBackup: null, floodBarriers: "absent", nonReturnValves: null, interruptionCover: "covered", drainagePoor: true, basements: 2 });
    const ids = focus.conditions.map((c) => c.id);
    for (const id of ["relocate_plant", "drain_design", "pump_backup", "ingress_protection", "drainage_evidence"]) expect(ids, id).toContain(id);
    expect(ids).not.toContain("confirm_interruption");
    // The report of poor drainage is the support, by the id of the flag that carries its sentence.
    expect(focus.conditions.find((c) => c.id === "drainage_evidence")?.because).toEqual(["drainage-condition"]);

    // Everything stated and nothing reported: none of the five is suggested, though questions on other values stay open.
    const settled = priced(focusOf(offerOf({ ...inventedExtraction([row(dataset.buildings[0])], { drainDesignRp: said(50, "Storm drains are designed for a 50-year event."), sumpPumpBackup: said("yes", "The pumps are on the standby generator."), floodBarriers: said("present", "Flood gates at both ramps."), nonReturnValves: said("present", "Non-return valves on all basement drains.") }), notes: [] }), "all_drivers"));
    expect(settled.facts).toMatchObject({ drainDesignStated: true, sumpPumpBackup: "yes", floodBarriers: "present", nonReturnValves: "present", drainagePoor: false });
    expect(settled.questions.length).toBeGreaterThan(0);
    for (const id of ["drain_design", "pump_backup", "ingress_protection", "confirm_interruption", "drainage_evidence"]) expect(settled.conditions.map((c) => c.id), id).not.toContain(id);

    // A value that was read but failed its check is the underwriter's to settle: the fact is left out, not read as "does not say".
    const doubted = priced(focusOf(offerOf(inventedExtraction([row(dataset.buildings[0])], { sumpPumpBackup: { value: "no", quote: "a sentence that does not say so", status: "unverified", reason: "Not found in the document." } })), "all_drivers"));
    expect(doubted.facts.sumpPumpBackup).toBeUndefined();
    expect(doubted.conditions.map((c) => c.id)).not.toContain("pump_backup");
  });

  it("carries the day's rent, the stated value split and whose depths are shown on the focus's drivers", () => {
    const one = priced(focusOf(invented(), "all_drivers")).drivers;
    const rent = one.components.find((c) => c.id === "interruption")!;
    expect(rent.on).toBe(true);
    expect(rent.valueKes).toBe(146_000_000);
    expect(rent.dailyKes).toBe(146_000_000 / 365);
    for (const r of rent.perReturnPeriod) expect(Math.abs(r.lossKes - (r.days ?? 0) * rent.dailyKes!)).toBeLessThan(1e-6);
    expect(one.components.find((c) => c.id === "structure")?.dailyKes).toBeUndefined();
    // With Depth only the part is off and a day costs nothing.
    expect(priced(focusOf(invented(), "depth_only")).drivers.components.find((c) => c.id === "interruption")).toMatchObject({ on: false, valueKes: 0, dailyKes: 0 });

    // The three stated parts come to the insured value.
    expect(one.valueSplit).toMatchObject({ statedCount: 3, statedKes: TIV, complete: true, gapKes: 0, agrees: true });
    expect(one.valueSplit.parts.map((p) => [p.id, p.label, p.kes, p.quote])).toEqual([
      ["building", "Building", 1_500_000_000, "Building KES 1,500,000,000"],
      ["machinery", "Plant and machinery", 300_000_000, "Plant and machinery KES 300,000,000"],
      ["contents", "Contents", 200_000_000, "Contents KES 200,000,000"],
    ]);
    // They do not: the gap is the stated total less the insured value.
    const off = priced(focusOf(offerOf(inventedExtraction([row(dataset.buildings[0])], { valueContentsKes: said(150_000_000, "Contents KES 150,000,000") })), "all_drivers")).drivers.valueSplit;
    expect(off).toMatchObject({ statedCount: 3, statedKes: 1_950_000_000, complete: true, gapKes: -50_000_000, agrees: false });
    // One part is missing: there is a total of what is stated, and nothing to say about agreement.
    const part = priced(focusOf(offerOf(inventedExtraction([row(dataset.buildings[0])], { valueContentsKes: missing() })), "all_drivers")).drivers.valueSplit;
    expect(part).toMatchObject({ statedCount: 2, statedKes: 1_800_000_000, complete: false, gapKes: null, agrees: null });
    expect(part.parts[2]).toMatchObject({ id: "contents", kes: null, quote: "" });
    // The split changes no loss.
    expect(priced(focusOf(offerOf(inventedExtraction([row(dataset.buildings[0])], { valueContentsKes: missing() })), "all_drivers")).price.total.aalGrossKes).toBe(priced(focusOf(invented(), "all_drivers")).price.total.aalGrossKes);

    // One building: nothing to say about whose depths these are. Two: the field names the building followed.
    expect(one.depthsFor).toBeNull();
    const two = priced(focusOf(offerOf(inventedExtraction([row(dataset.buildings[0], { name: said("Invented Tower A", "Block A") }), row(dataset.buildings[1], { name: said("Invented Tower B", "Block B") })])), "all_drivers"));
    expect(two.drivers.buildings).toBe(2);
    expect(two.drivers.depthsFor).toBe(`The depths, the damage ratios and the components are those of ${two.building.name}, one of the 2 buildings priced. The losses and the premium are all 2 added up.`);
    expect(exportsOf("all_drivers", two).audit.offer!.lossDrivers!.depthsFor).toBe(two.drivers.depthsFor);
    expect(exportsOf("all_drivers", two).audit.offer!.lossDrivers!.statedValueSplit).toEqual(two.drivers.valueSplit);
  });

  it("writes both exports with no offer at all: 19 reference assumptions and the model's checks alone", () => {
    for (const mode of MODES) {
      const { audit, note } = exportsOf(mode, null);
      expect(audit.offer).toBeNull();
      expect(hasLine(note, "## The offer")).toBe(false);
      expectAssumptionsTable(audit, note, mode);
      expect(audit.assumptionsBeyondFloodDepth.rows.every((r) => r.setBy === "reference")).toBe(true);
      expect(beyondDepthAssumptions(portfolioJudgement(), null, results[mode]).map((r) => r.setBy)).toEqual(audit.assumptionsBeyondFloodDepth.rows.map((r) => r.setBy));
      const counts = summarise(modelChecks[mode]);
      expect(countLine(note)).toBe(`${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed.`);
      expect(audit.results.lossByDriver === null).toBe(mode === "depth_only");
    }
  });

  const memos = existsSync(TEST_DATA) ? readdirSync(TEST_DATA).filter((f) => f.toLowerCase().endsWith(".docx")) : [];
  const nairobiFile = memos.find((f) => f.toUpperCase().includes("NAIROBI"));
  const nzoiaFile = memos.find((f) => f.toUpperCase().includes("NZOIA"));

  describe.skipIf(!nairobiFile || !nzoiaFile)("the two test offers, read by the rules", () => {
    let nairobi: ExtractionRun;
    let nzoia: ExtractionRun;
    const read = (text: string) => {
      const knownPlaces = [...layers.wards.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
      return extractOffer(text, { rulesOnly: true, knownPlaces });
    };
    const stateOf = (run: ExtractionRun, name: string): OfferState => ({ document: { name, kind: "typed", text: run.documentText }, run, extraction: run.extraction });

    beforeAll(async () => {
      nairobi = await read(await docxToText(readFileSync(join(TEST_DATA, nairobiFile!))));
      nzoia = await read(await docxToText(readFileSync(join(TEST_DATA, nzoiaFile!))));
    }, 120_000);

    it("writes the Nairobi offer in both modes, with every driver check passing and all 19 assumptions set by the offer or the reference", () => {
      for (const mode of MODES) {
        const focus = priced(focusOf(stateOf(nairobi, "nairobi offer"), mode));
        const { audit, note } = exportsOf(mode, focus);
        const all = mode === "all_drivers";
        const record = audit.offer!;
        expect(record.status).toBe("priced");
        expect(record.outside).toBe(false);
        expect(record.extraction.path).toBe("rules");
        expect(record.extraction.sentToModel).toBe(false);
        expect(record.modelUsed.lossesFromLabel).toBe(LOSS_MODE_LABELS[mode]);
        expectAssumptionsTable(audit, note, mode);
        expect(audit.assumptionsBeyondFloodDepth.rows.every((r) => r.setBy === "offer" || r.setBy === "reference")).toBe(true);
        // A figure the offer set carries the offer's sentence, or was typed; a reference figure carries none.
        for (const r of audit.assumptionsBeyondFloodDepth.rows) expect(r.setBy === "offer" || r.quote === "", r.key).toBe(true);

        expect(driverCheckIds(record.checks)).toEqual([...OFFER_DRIVER_CHECK_IDS]);
        expect(record.checks.filter((c) => (OFFER_DRIVER_CHECK_IDS as readonly string[]).includes(c.id)).every((c) => c.status === "pass")).toBe(true);
        expect(record.checks).toBe(focus.checks);
        const counts = summarise([...modelChecks[mode], ...focus.checks]);
        expect(countLine(note) === `${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed, the offer's checks included.`).toBe(true);

        const d = record.lossDrivers!;
        expect(d.mode).toBe(mode);
        expect(d.averageAnnualLossKes.groundUpKes.overload > 0).toBe(all);
        expect(d.averageAnnualLossKes.groundUpKes.basement > 0).toBe(all);
        expect(d.depthsFor).toBeNull();
        expect(d.statedValueSplit.parts).toHaveLength(3);
        // Depth only is the engine's point pricing, in the file as on screen.
        if (!all) expect(record.price!.total.aalGrossKes).toBe(focus.pricing!.totals!.aalGrossKes);
        else expect(record.price!.depthOnly.aalGrossKes).toBe(focus.pricing!.totals!.aalGrossKes);

        // Every open question says what stands in for it, or that nothing does.
        expect(record.brokerQuestions.length).toBe(focus.questions.length);
        for (const q of record.brokerQuestions) {
          expect(q.why.length > 0, q.id).toBe(true);
          expect(q.assumes === null || (q.assumes.text.length > 0 && q.assumes.keys.every((k) => JUDGEMENT_KEYS.includes(k))), q.id).toBe(true);
        }
        expect(hasLine(note, "## The offer")).toBe(true);
        expect(note.includes(`Losses from: **${LOSS_MODE_LABELS[mode]}**.`)).toBe(true);
        expect(note.includes("### Loss by driver")).toBe(true);
        expect(note.includes("### Premium build-up")).toBe(all);
        expect(note.includes(OUTSIDE_MAPS_MESSAGE)).toBe(false);
      }
    });

    it("writes the Nzoia offer as outside the hazard maps loaded, with no figure, no driver check and nothing assumed", () => {
      for (const mode of MODES) {
        const focus = focusOf(stateOf(nzoia, "nzoia offer"), mode);
        expect(focus.status).toBe("outside");
        const { audit, note } = exportsOf(mode, focus);
        const record = audit.offer!;
        expect(record.status).toBe("outside");
        expect(record.outside).toBe(true);
        expect(record.statusLine).toBe(`${OUTSIDE_MAPS_MESSAGE}.`);
        // No figure of any kind for the offer.
        expect(record.price).toBeNull();
        expect(record.lossDrivers).toBeNull();
        expect(record.site).toBeNull();
        expect(driverCheckIds(record.checks)).toEqual([]);
        expect(record.checks).toBe(focus.checks);
        // The questions are listed, without the assumption a price would have used.
        expect(record.brokerQuestions.length).toBe(focus.questions.length);
        expect(record.brokerQuestions.every((q) => q.why === "" && q.assumes === null)).toBe(true);
        // Nothing is suggested on the facts behind the loss drivers: they are left out until there is a price.
        for (const key of ["equipmentBelowGround", "drainDesignStated", "sumpPumpBackup", "floodBarriers", "nonReturnValves", "interruptionCover"] as const) expect(focus.facts[key], key).toBeUndefined();
        for (const id of ["drain_design", "pump_backup", "ingress_protection", "confirm_interruption"]) expect(focus.conditions.some((c) => c.id === id), id).toBe(false);

        expect(note.includes(`**${OUTSIDE_MAPS_MESSAGE}.**`)).toBe(true);
        expect(note.includes("No loss figure exists for this offer.")).toBe(true);
        for (const heading of ["### Water at the site", "### Loss by driver", "### Premium build-up", "### Points to weigh", "### Suggested conditions"]) expect(note.includes(heading), heading).toBe(false);
        // The portfolio's part of the record is whole: the table of assumptions is there, all reference values.
        expectAssumptionsTable(audit, note, mode);
        expect(audit.assumptionsBeyondFloodDepth.rows.every((r) => r.setBy === "offer" || r.setBy === "reference")).toBe(true);
      }
    });
  });
});
