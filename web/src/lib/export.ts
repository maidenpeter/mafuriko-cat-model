import { buildLedger, type Deliberation } from "./agents/orchestrate";
import { ROLE_LABELS, ROLES } from "./agents/schema";
import { costOf, fmtUsd, usageRows, usageTotals, type Prices, type UsageSource } from "./agents/usage";
import type { Check } from "./checks";
import { DECISION_LABELS, DEDUCTIBLE_LOSS_SHARE, EVIDENCE_LABELS, NEAR_WET_CELL_M, SEVERITY_LABELS, SUBLIMIT_LOSS_SHARE, type DecisionRecord } from "./decision";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "./format";
import { DRAINAGE_DEFAULTS } from "./geo/drainage";
import { kes1, rpLabel, rpWithChance } from "./labels";
import { hotspotHits } from "./model/hotspots";
import { BOUNDS, flattenParams, REFERENCE_PARAMS } from "./model/params";
import { XOL_DEFAULT_ATTACHMENT_RP, XOL_DEFAULT_EXHAUSTION_RP, type TermsResult } from "./model/terms";
import { HOUSING_CLASSES, HOUSING_LABELS, SCORE_TIERS, type ModelParams } from "./model/types";
import { JRC_AFRICA_RESIDENTIAL } from "./model/vulnerability";
import {
  ACCUMULATION_HIGH_SHARE,
  ACCUMULATION_MEDIUM_SHARE,
  ASSUMPTION_SPREAD_RATIO,
  CONCENTRATION_HIGH_SHARE,
  CONCENTRATION_MEDIUM_SHARE,
  FREQUENT_FLOOD_RP,
  NEIGHBOUR_RADIUS_M,
  type OfferFocus,
} from "./offer/focus";
import { FOOTPRINT_RADIUS_M, OVERPASS_URL } from "./offer/footprint";
import { slim, type Active, type LogEntry, type Session } from "./session";

export const PARAM_LABELS: Record<string, string> = {
  depthScaleM: "Depth at score 1.0, widest tier (m)",
  ...Object.fromEntries(HOUSING_CLASSES.map((c) => [`fragility.${c}`, `Fragility: ${HOUSING_LABELS[c]}`])),
  ...Object.fromEntries(HOUSING_CLASSES.map((c) => [`cap.${c}`, `Damage cap: ${HOUSING_LABELS[c]}`])),
  ...Object.fromEntries(SCORE_TIERS.map((t) => [`returnPeriods.${t}`, `Return period: "${t}" tier (years)`])),
};

/** Parameters that have no effect on a depth dataset, where the data carries depths and return periods itself. */
export const unusedForDepth = (path: string) => path === "depthScaleM" || path.startsWith("returnPeriods.");

export const LIMITS = [
  "The hazard layer is a terrain-and-river proxy, not measured flooding. It cannot see drainage-driven flooding.",
  "Converting a susceptibility score to a depth is an assumption, not a measurement.",
  "The damage curve is a continental average (Africa, residential) adapted by judgement. No verified Kenya-specific curve exists.",
  "The return periods attached to the tiers are assumed.",
  "The portfolio is synthetic and randomly placed. It is not a real client's holdings.",
  "The scenarios are nested cuts of one map, not independent events.",
  "The deductible, limit, quota share and excess of loss are example terms, not taken from any real policy or treaty. Gross and net figures change with them.",
  "Average annual loss assumes no loss from events more frequent than the shortest return period, and a flat loss beyond the longest.",
  "The drainage layer is a distance rule on mapped drains and settlement outlines, not a drainage model. Unmapped or blocked drains are invisible to it.",
  "The agents run on a hosted model. They see summary figures built from the synthetic portfolio, never individual rows. Two live runs can differ; the saved run is what makes a result repeatable.",
  "Reading an offer with the hosted model sends the offer's text to that model, with email addresses, phone numbers and contact and signature blocks removed first. Names written inside ordinary sentences are not removed. Reading by the fixed rules sends nothing.",
  "The building outline on the hazard map comes from a public OpenStreetMap Overpass server. The offer building's coordinates and the search radius are sent to it, and nothing else.",
  "A value marked verified was found written in the document. That shows it was written, not that it was understood, so the source sentence is kept beside every value.",
  "The fixed rules read one building per document. An offer with several buildings needs the model, or the underwriter's own entries.",
  "An offer is priced on the residential damage curve whatever the building is used for, and water entering basements is not modelled.",
  "An offer has a ground-up and a gross loss only. Net loss is a portfolio figure and is not worked out for one offer.",
];

/** The limits that only apply to the Nairobi susceptibility maps: left out for a dataset of measured depths. */
const scoreOnlyLimit = (limit: string) => /susceptibility score|tiers are assumed|terrain-and-river proxy/.test(limit);

export const TERMS_NOTICE = "Example terms, not from any real policy or treaty";

/** One insurance term as a reader sees it: its name and its value in words. Used on the Audit step and in the written note. */
export function termRows(t: TermsResult): { term: string; value: string }[] {
  const { terms, xol } = t;
  return [
    { term: "Deductible, each building", value: `${fmtNum(terms.deductibleShare * 100)}% of insured value, and never less than ${fmtKes(terms.deductibleMinKes)}` },
    { term: "Limit, each building", value: `${fmtNum(terms.limitShare * 100)}% of insured value` },
    { term: "Quota share ceded", value: `${fmtNum(terms.quotaShareCeded * 100)}% of every gross loss` },
    { term: "Excess of loss attachment", value: `${kes1(xol.attachmentKes)} (${xol.attachmentIsDefault ? `default: the retained ${rpLabel(XOL_DEFAULT_ATTACHMENT_RP)} loss` : "typed in"})` },
    { term: "Excess of loss limit", value: `${kes1(xol.limitKes)} (${xol.limitIsDefault ? `default: the retained ${rpLabel(XOL_DEFAULT_EXHAUSTION_RP)} loss less the attachment` : "typed in"})` },
  ];
}

/**
 * The summary oasis/build_and_run.py writes to public/oasis/reference.json. Nothing here reads
 * that file: the caller fetches it and hands it over, and only these fields are used.
 */
export interface OasisReference {
  oasislmfVersion: string;
  generatedAt: string;
  /** The dataset the run was made for. It is compared with the loaded dataset's name. */
  dataset: string;
  events: { tier: string; returnPeriod: number; oasisLossKes: number; ourLossKes: number }[];
  aal: { oasisKes: number; ourTrapezoidKes: number; ourDiscreteKes: number };
}

/**
 * What the note and the audit file take beyond the portfolio run. Every field is optional, and
 * both exports read the same with none of them.
 *
 *   buildNote(session, active, deliberation, checks, terms, { offer: offerFocus, decision, oasis, dataSource, prices })
 *   buildAudit(session, active, deliberation, checks, log, terms, { offer: offerFocus, decision, oasis, dataSource, prices })
 */
export interface ExportExtras {
  /** The offer as every step sees it (offerFocus, whatever the header switch says). The note opens with it once it is priced. */
  offer?: OfferFocus | null;
  /** What the underwriter recorded on the Results step. A draft is reported as not recorded. */
  decision?: DecisionRecord | null;
  /** The saved Oasis run, as fetched from /oasis/reference.json. */
  oasis?: OasisReference | null;
  /** Where the model data came from, in the header's words: "Nairobi starter kit, from the model data folder". */
  dataSource?: string | null;
  /** US dollar prices per million tokens when they are set. Without them no cost is written. */
  prices?: Prices | null;
}

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

/** Text that is safe inside a Markdown table cell or a list item: one line, no column breaks. */
const cell = (text: string) => text.replace(/\s+/g, " ").replaceAll("|", "/").trim();
const orNa = (value: number | null | undefined) => (value === null || value === undefined ? "not modelled" : kes1(value));
const signedKes = (value: number | null) => (value === null ? "not modelled" : `${value >= 0 ? "+" : ""}${kes1(value)}`);
const depth = (m: number) => (m > 0 ? `${fmtNum(m, 2)} m` : "dry");
const diffPct = (ours: number, theirs: number) => (ours === 0 ? "n/a" : `${theirs >= ours ? "+" : ""}${((theirs / ours - 1) * 100).toFixed(3)}%`);

/** The offer reader as one more run for the usage table. null when no model was called. */
function readerRun(offer: OfferFocus | null | undefined): UsageSource | null {
  if (!offer || !offer.document.model) return null;
  return { role: "reader", label: "Offer reader", model: offer.document.model, ms: offer.document.ms, usage: offer.document.usage };
}

/** Tokens and seconds per call, with a cost only when prices are set. */
function usageRecord(deliberation: Deliberation | null, offer: OfferFocus | null | undefined, prices: Prices | null | undefined) {
  const reader = readerRun(offer);
  const sources: UsageSource[] = [...(deliberation ? ROLES.map((role) => deliberation.runs[role]) : []), ...(reader ? [reader] : [])];
  const rows = usageRows(sources);
  const totals = usageTotals(rows);
  return { rows, totals, prices: prices ?? null, costUsd: costOf(totals, prices) };
}

/** The decision as recorded, with the ticked conditions in words. null while it is a draft. */
function recordedDecision(decision: DecisionRecord | null | undefined, offer: OfferFocus | null | undefined) {
  if (!decision || decision.choice === null || decision.recordedAt === null) return null;
  const conditions = (offer?.conditions ?? []).filter((c) => decision.conditions.includes(c.id));
  return { choice: decision.choice, label: DECISION_LABELS[decision.choice], note: decision.note, recordedAt: decision.recordedAt, conditions: conditions.map((c) => ({ id: c.id, text: c.text })) };
}

/**
 * The offer for the audit file. The document's full text, the message sent to the model and the
 * model's raw reply are left out: every value is here with its quote and what code decided.
 */
function offerRecord(offer: OfferFocus, decision: DecisionRecord | null | undefined) {
  const { document, price } = offer;
  return {
    document: { name: document.name, kind: document.kind, characters: document.text.length },
    line: offer.line,
    status: offer.status,
    statusLine: offer.statusLine,
    outside: offer.outside,
    coverage: offer.coverage,
    extraction: {
      path: document.path,
      why: document.why,
      sentToModel: document.sentToModel,
      model: document.model,
      ms: document.ms,
      usage: document.usage,
      removedBeforeReading: document.removed,
      counts: offer.counts,
      fields: offer.fields.map((f) => ({ id: f.id, group: f.group, building: f.row === null ? null : f.row + 1, label: f.label, value: f.value, raw: f.raw, quote: f.quote, origin: f.origin, status: f.status, reason: f.reason, holdsPricing: f.holdsPricing })),
      waiting: offer.waiting.map((w) => w.text),
    },
    buildings: offer.buildings.map((b) => ({
      locId: b.locId,
      name: b.name,
      status: b.status,
      blockers: b.blockers,
      lat: b.lat,
      lon: b.lon,
      approximate: b.approximate,
      locationHow: b.locationHow,
      ward: b.ward ? { name: b.ward.name, subcounty: b.ward.subcounty } : null,
      housingClass: b.housingClass,
      floorAreaM2: b.floorAreaM2,
      costPerM2Kes: b.costPerM2Kes,
      tivKes: b.tivKes,
      tivFrom: b.tivFrom,
    })),
    modelUsed: { dataset: offer.datasetName, hazardKind: offer.hazardKind, drainageOn: offer.drainageOn, assumptionsInForce: offer.assumptionsInForce },
    terms: { deductible: offer.terms.deductible, limit: offer.terms.limit, asNumbers: offer.terms.policy, floodCover: offer.terms.floodCover },
    site: offer.site ? { ...offer.site, neighbours: { radiusM: offer.site.neighbours.radiusM, count: offer.site.neighbours.count, tivKes: offer.site.neighbours.tivKes, nearestM: offer.site.neighbours.nearestM } } : null,
    // No loss field exists unless the offer is priced: an offer outside the maps carries none.
    price: price
      ? {
          pricedBuildings: price.pricedCount,
          building: price.building,
          total: price.total,
          portfolio: price.portfolio,
          underEachSetOfAssumptions: price.assumptions.map((a) => ({ id: a.id, label: a.label, inForce: a.inForce, loss100GrossKes: a.loss100GrossKes, loss100GroundUpKes: a.loss100GroundUpKes, loss100Extrapolated: a.loss100Extrapolated, aalGrossKes: a.aalGrossKes, aalGroundUpKes: a.aalGroundUpKes, ratePerMilleGross: a.ratePerMilleGross })),
        }
      : null,
    checks: offer.checks,
    flags: offer.flags,
    suggestedConditions: offer.conditions,
    decision: recordedDecision(decision, offer) ?? { choice: null, note: "No decision has been recorded." },
  };
}

/** The complete record of a run: inputs, assumptions, prompts, replies, results and checks, and the offer when one has been read. */
export function buildAudit(session: Session, active: Active, deliberation: Deliberation | null, checks: Check[], log: LogEntry[], terms: TermsResult, extras: ExportExtras = {}) {
  const { offer, decision, oasis, dataSource, prices } = extras;
  return {
    generatedAt: new Date().toISOString(),
    notice: "Synthetic portfolio. Hazard is a proxy unless the dataset carries measured depths. Not a real client's holdings.",
    dataset: { name: session.dataset.name, hazardKind: session.dataset.hazardKind, scenarios: session.dataset.scenarios, buildings: session.dataset.buildings.length, source: dataSource ?? null },
    // The offer with its extraction record, without the document's text. null when no offer has been read.
    offer: offer ? offerRecord(offer, decision) : null,
    ingest: session.report,
    assumptions: { source: active.source, applied: active.params, reference: REFERENCE_PARAMS, jrcCurve: JRC_AFRICA_RESIDENTIAL },
    results: {
      totalInsuredValueKes: active.result.totalTivKes,
      averageAnnualLossKes: active.result.aalKes,
      scenarios: active.result.scenarios,
      standardLosses: active.result.standardLosses,
      referenceScenarios: session.reference.scenarios.map((s) => ({ id: s.id, returnPeriod: s.returnPeriod, lossKes: s.lossKes })),
      buildings: active.result.buildings,
    },
    insuranceTerms: {
      notice: TERMS_NOTICE,
      source: "example term",
      // xolAttachmentKes and xolLimitKes are null here when the default is in force; excessOfLossApplied has the figures used.
      terms: terms.terms,
      excessOfLossApplied: {
        ...terms.xol,
        defaultAttachment: `retained loss at ${rpLabel(XOL_DEFAULT_ATTACHMENT_RP)}`,
        defaultLimit: `retained loss at ${rpLabel(XOL_DEFAULT_EXHAUSTION_RP)} less the attachment`,
      },
      // One row per modelled event: ground-up, deductibles, over limit, gross, quota share recovery, retained, excess of loss recovery, net.
      layers: terms.scenarios,
      standardLosses: terms.standard,
      averageAnnualLossKes: terms.aal,
    },
    checks,
    agents: deliberation ? slim(deliberation) : null,
    // Tokens and seconds for each agent and for the offer reader. costUsd is null unless prices are set.
    usage: usageRecord(deliberation, offer, prices),
    oasisCheck: oasis ?? null,
    offerThresholds: {
      frequentFloodReturnPeriod: FREQUENT_FLOOD_RP,
      lossShareOfSumInsured: { medium: DEDUCTIBLE_LOSS_SHARE, high: SUBLIMIT_LOSS_SHARE },
      addedToPortfolio100: { medium: ACCUMULATION_MEDIUM_SHARE, high: ACCUMULATION_HIGH_SHARE },
      shareOfPortfolioInsuredValue: { medium: CONCENTRATION_MEDIUM_SHARE, high: CONCENTRATION_HIGH_SHARE },
      cautiousOverOptimist: ASSUMPTION_SPREAD_RATIO,
      nearWaterM: NEAR_WET_CELL_M,
      neighbourRadiusM: NEIGHBOUR_RADIUS_M,
      footprintRadiusM: FOOTPRINT_RADIUS_M,
    },
    limits: LIMITS,
    log,
  };
}

// ---------------------------------------------------------------------------------------------
// The written note
// ---------------------------------------------------------------------------------------------

/** The offer at the head of the note: its line, the figures, the trace, the flags and the decision. */
function offerSection(offer: OfferFocus, decision: DecisionRecord | null | undefined): string[] {
  const lines: string[] = [`## The offer`, ``, `**${offer.line.text || offer.documentName}**`, ``, `Document: ${offer.documentName}. ${offer.document.why}`, ``];
  const { price } = offer;

  if (offer.outside) {
    lines.push(`**${offer.outsideMessage}.** ${offer.coverage ?? ""} No loss figure exists for this offer.`.trim(), ``);
    return lines;
  }
  if (!price) {
    lines.push(`**The offer is not priced.** ${offer.statusLine}`, ``);
    for (const w of offer.waiting) lines.push(`- ${cell(w.text)}`);
    if (offer.waiting.length) lines.push(``);
    return lines;
  }

  const { total, portfolio, building } = price;
  const gross = portfolio.gross;
  if (offer.severalLine) lines.push(offer.severalLine, ``);
  if (offer.building) lines.push(`Location: ${offer.building.locationHow}`, ``);
  lines.push(`| Figure | Value |`, `|---|---|`);
  lines.push(`| Sum insured | ${kes1(total.tivKes)} |`);
  lines.push(`| ${rpWithChance(100)} gross loss${total.loss100Extrapolated ? ", held flat beyond the rarest flood modelled" : ""} | ${orNa(total.loss100GrossKes)} |`);
  lines.push(`| Average annual loss, gross | ${kes1(total.aalGrossKes)} |`);
  lines.push(`| Pure flood rate, gross | ${fmtNum(total.ratePerMilleGross, 3)} per mille of sum insured, before expense, profit and uncertainty loadings |`);
  lines.push(
    gross
      ? `| Change to the portfolio's ${rpLabel(100)} gross loss | ${signedKes(gross.change100Kes)}${gross.change100Share !== null ? ` (${fmtPct(gross.change100Share, 2)})` : ""}: from ${orNa(gross.without100Kes)} to ${orNa(gross.with100Kes)} |`
      : `| Change to the portfolio's ${rpLabel(100)} ground-up loss | ${signedKes(portfolio.loss100ChangeKes)}${portfolio.loss100ChangeShare !== null ? ` (${fmtPct(portfolio.loss100ChangeShare, 2)})` : ""}: from ${orNa(portfolio.without.loss100Kes)} to ${orNa(portfolio.with.loss100Kes)} |`,
  );
  lines.push(`| Share of the portfolio's insured value, with the offer in it | ${fmtPct(portfolio.tivShare, 1)} |`, ``);
  if (building.dryAtEveryReturnPeriod) {
    lines.push(`The model shows no water at this point in any flood modelled${offer.drainageOn ? ", terrain and drainage ponding both" : ""}, so every loss above is zero. That is a statement about the maps at these coordinates, not a finding that the building cannot flood: read the flags below.`, ``);
  }

  lines.push(`Terms used for the gross loss:`, ``, `- Deductible: ${offer.terms.deductible.text} (${offer.terms.deductible.source})`, `- Limit: ${offer.terms.limit.text} (${offer.terms.limit.source})`, ``);

  lines.push(`The building, flood by flood (${offer.building?.housingLabel ?? HOUSING_LABELS[building.housingClass]}: fragility ${fmtNum(building.fragility)}, damage cap ${fmtNum(building.cap)}):`, ``);
  lines.push(`| Return period | Depth used | From | Damage ratio | Ground-up | Deductible | Over the limit | Gross |`, `|---|---|---|---|---|---|---|---|`);
  for (const r of building.perReturnPeriod) {
    const from = r.depthFrom === "dry" ? "dry on both" : r.depthFrom === "drainage" ? `drainage ponding (terrain ${depth(r.terrainM)})` : `terrain map${r.drainageM > 0 ? ` (ponding ${depth(r.drainageM)})` : ""}`;
    lines.push(`| ${rpWithChance(r.returnPeriod)} | ${depth(r.depthM)} | ${from} | ${fmtPct(r.damageRatio, 1)}${r.capped ? " (at the cap)" : ""} | ${kes1(r.groundUpKes)} | ${kes1(r.deductibleKes)} | ${kes1(r.overLimitKes)} | ${kes1(r.grossKes)} |`);
  }
  lines.push(``);

  lines.push(`### Points to weigh`, ``);
  if (offer.flags.length === 0) lines.push(`No flag was raised.`, ``);
  else {
    lines.push(`| Severity | Point | Evidence |`, `|---|---|---|`);
    for (const f of offer.flags) {
      // A flag made from a check carries its detail as the evidence: it is written once.
      const same = f.evidence.text.trim() === f.detail.trim();
      const evidence = f.evidence.kind === "quote" ? `"${cell(f.evidence.text)}"` : cell(f.evidence.text);
      lines.push(`| ${SEVERITY_LABELS[f.severity]} | ${cell(f.title)}${same ? "" : `. ${cell(f.detail)}`} | ${EVIDENCE_LABELS[f.evidence.kind]}: ${evidence} |`);
    }
    lines.push(``);
  }

  const recorded = recordedDecision(decision, offer);
  if (offer.conditions.length > 0) {
    lines.push(`### Suggested conditions`, ``);
    for (const c of offer.conditions) lines.push(`- ${recorded ? (recorded.conditions.some((x) => x.id === c.id) ? "[x] " : "[ ] ") : ""}${cell(c.text)} *${cell(c.why)}*`);
    lines.push(``);
  }

  lines.push(`### The underwriter's decision`, ``);
  if (recorded) {
    lines.push(`**${recorded.label}**, recorded ${recorded.recordedAt.slice(0, 16).replace("T", " ")} UTC.${recorded.note ? ` Note: ${cell(recorded.note)}` : ""}`, ``);
    if (recorded.conditions.length > 0) lines.push(`Conditions applied: ${recorded.conditions.length} of the ${offer.conditions.length} suggested, ticked above.`, ``);
  } else {
    lines.push(`No decision has been recorded. The tool does not accept or decline: it sets out the figures and the points to weigh.`, ``);
  }
  return lines;
}

/**
 * The short written note the hackathon asks for: data sources, assumptions, AI features, drainage,
 * insurance terms, the Oasis check and the limits. When a priced offer is passed in, the note
 * opens with it. Works with no extras at all.
 */
export function buildNote(session: Session, active: Active, deliberation: Deliberation | null, checks: Check[], terms: TermsResult, extras: ExportExtras = {}): string {
  const { offer, decision, oasis, dataSource, prices } = extras;
  const { dataset, report, reference } = session;
  const r = active.result;
  const p: ModelParams = active.params;
  const isScore = dataset.hazardKind === "score";
  const ledger = deliberation ? buildLedger(REFERENCE_PARAMS, deliberation).filter((row) => isScore || !unusedForDepth(row.path)) : [];
  // The offer's checks are added once, whether or not the caller already put them in the list.
  const allChecks = [...checks, ...(offer?.checks ?? []).filter((c) => !checks.some((x) => x.id === c.id))];
  const counts = { pass: allChecks.filter((c) => c.status === "pass").length, warn: allChecks.filter((c) => c.status === "warn").length, fail: allChecks.filter((c) => c.status === "fail").length };
  const rarest = r.scenarios[r.scenarios.length - 1];
  const fromAgents = active.source === "ai";
  let n = 0;
  const heading = (title: string) => `## ${++n}. ${title}`;

  const lines: string[] = [];
  lines.push(`# Mafuriko model note`, ``, `Dataset: **${dataset.name}**${dataSource ? ` (${dataSource})` : ""} · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, ``);
  lines.push(`> The portfolio is synthetic. ${isScore ? "The hazard layer is a constructed proxy, not measured flood depth." : "The hazard layer is a published set of flood depth maps."} Nothing here describes a real client's holdings.`, ``);
  lines.push(`Three words for loss, used the same way throughout: **ground-up** is the damage before any insurance terms, **gross** is after the policy deductible and limit, and **net** is after reinsurance, which is a portfolio figure only. No loss figure in this note came from a language model: models read the offer and chose assumptions, and code checked, located, priced and reconciled.`, ``);

  if (offer) lines.push(...offerSection(offer, decision));

  // --- Data sources ---------------------------------------------------------------------------
  lines.push(heading("Data sources"), ``, `Files read for this run:`, ``, `| File | Role | Real or synthetic |`, `|---|---|---|`);
  for (const f of report.files.filter((f) => f.used)) {
    lines.push(`| ${f.name} | ${cell(f.note)} | ${{ real: "Real data", proxy: "Derived proxy", synthetic: "Synthetic", none: "-" }[f.provenance]} |`);
  }
  lines.push(``, `Where they come from:`, ``);
  if (isScore) {
    lines.push(
      `- **Hazard maps** (hackathon starter kit): five maps of a 0 to 1 flood susceptibility score, built by the organisers from the Copernicus GLO-30 elevation model (https://doi.org/10.5270/ESA-c5d3d65) and the distance to rivers and streams mapped in OpenStreetMap (https://www.openstreetmap.org/copyright). Real terrain and real rivers; the reading of the score as flood hazard is a constructed proxy.`,
      `- **Exposure file** (hackathon starter kit): ${fmtInt(dataset.buildings.length)} buildings with a location, a construction class and an insured value. Fully synthetic and randomly placed.`,
      `- **County flood areas** (hackathon starter kit): the flood hotspots named by Nairobi County in its mapping of March 2026, geocoded by the organisers through OpenStreetMap. Real places, used only to test the hazard maps.`,
    );
  } else {
    lines.push(`- **Hazard maps and exposure file**: from the uploaded data set. The maps carry flood depth in metres at stated return periods; the exposure file is synthetic.`);
  }
  lines.push(
    `- **Rivers, streams, drains, ditches and canals; informal settlement outlines; schools, health facilities, fire and police stations**: © OpenStreetMap contributors, Open Database License 1.0 (https://www.openstreetmap.org/copyright), from extracts dated February and May 2025. Settlement outlines are partial.`,
    `- **Ward, sub-county and county boundaries**: Omare, B.D.A. and Omare, G.J.M. (2017), Kenya County Assembly Boundaries, CC BY 4.0, distributed by geoBoundaries (https://www.geoboundaries.org).`,
    `- **Building outline of an offer**: the nearest OpenStreetMap building within ${fmtInt(FOOTPRINT_RADIUS_M)} m of the stated coordinates, looked up live through the public Overpass service (${OVERPASS_URL}).`,
    `- **Damage curve**: ${JRC_AFRICA_RESIDENTIAL.source}. https://publications.jrc.ec.europa.eu/repository/handle/JRC105688`,
    `- **Background map**: OpenFreeMap styles on OpenStreetMap data; terrain shading from Mapzen Terrain Tiles on AWS Open Data. The model does not use either.`,
    `- **Independent engine**: Oasis LMF, https://github.com/OasisLMF/OasisLMF`,
    ``,
    `The processing of each map layer is written up in web/public/geo/SOURCES.md.`,
    ``,
  );

  // --- Assumptions ----------------------------------------------------------------------------
  lines.push(heading("Assumptions"), ``);
  lines.push(`Assumptions in force: **${fromAgents ? "agreed by the agent panel" : "reference values (no AI)"}**. A value outside its allowed range is pulled back to the range by code.`, ``);
  lines.push(`| Assumption | Value in force | Reference value | Allowed range | Where the value came from |`, `|---|---|---|---|---|`);
  const refByPath = new Map(flattenParams(REFERENCE_PARAMS).map((x) => [x.path, x.value]));
  for (const { path, value } of flattenParams(p)) {
    if (!isScore && unusedForDepth(path)) continue;
    const ref = refByPath.get(path) ?? value;
    const range = path === "depthScaleM" ? BOUNDS.depthScaleM : path.startsWith("fragility.") ? BOUNDS.fragility : path.startsWith("cap.") ? BOUNDS.cap : BOUNDS.returnPeriod;
    const origin = !fromAgents ? "Reference value" : Math.abs(value - ref) < 1e-9 ? "Agreed by the agents, same as the reference" : "Agreed by the agents";
    lines.push(`| ${PARAM_LABELS[path] ?? path} | ${fmtNum(value)} | ${fmtNum(ref)} | ${fmtNum(range.min)} to ${fmtNum(range.max)} | ${origin} |`);
  }
  lines.push(``, `Fixed by the model, the same in every run:`, ``);
  if (isScore) lines.push(`- Depth (m) = score × tier slope × depth scale. Each tier map is rescaled to run 0 to 1, so the tier slope (${r.scenarios.map((s) => `${s.id} ${fmtNum(s.tierSlope, 3)}`).join(", ")}) puts every tier back on the widest tier's scale and depth grows as the event gets rarer. The slopes are fitted from the maps. The score is a susceptibility proxy, so this conversion is assumed.`);
  lines.push(`- Damage ratio = the lower of the damage curve read at depth × fragility, and the cap. Curve points (depth in m: damage): ${JRC_AFRICA_RESIDENTIAL.depthsM.map((d, i) => `${fmtNum(d)}: ${fmtNum(JRC_AFRICA_RESIDENTIAL.damage[i])}`).join(", ")}, with straight lines between them. Fragility and cap per class are our adaptation of that curve.`);
  lines.push(`- Return periods: ${r.scenarios.map((s) => `${s.id} = ${s.returnPeriod} years`).join(", ")}${isScore ? " (assumed)" : " (from the data)"}.`);
  lines.push(`- Ground-up loss = damage ratio × insured value. Insured values are used as they appear in the file.`);
  lines.push(`- Losses at 10, 25, 50, 100 and 250 years are read off the curve by interpolating against the logarithm of the return period. Average annual loss is the area under loss against annual chance, with no loss from events more frequent than the shortest return period and a flat loss beyond the longest.`);
  if (report.tivRatio && Math.abs(report.tivRatio.median - 1) >= 0.05) {
    lines.push(`- **Data discrepancy:** insured values are ${fmtNum(report.tivRatio.median, 1)}× floor area × cost per m². The portfolio totals ${fmtKes(r.totalTivKes)}; the documented formula would give ${fmtKes(r.totalTivKes / report.tivRatio.median)}.`);
  }
  lines.push(``, `Thresholds behind the points raised on an offer (all assumptions of this app):`, ``);
  lines.push(
    `- Water at the building in a flood of ${rpLabel(FREQUENT_FLOOD_RP)} or more frequent is marked high; rarer water is medium.`,
    `- A ${rpLabel(100)} gross loss of ${fmtPct(DEDUCTIBLE_LOSS_SHARE, 0)} of the sum insured or more is marked medium and supports a higher deductible; ${fmtPct(SUBLIMIT_LOSS_SHARE, 0)} or more is marked high and supports a flood sub-limit.`,
    `- An offer adding ${fmtPct(ACCUMULATION_MEDIUM_SHARE, 0)} or more to the portfolio's ${rpLabel(100)} ground-up loss is marked medium; ${fmtPct(ACCUMULATION_HIGH_SHARE, 0)} or more is high.`,
    `- An offer holding ${fmtPct(CONCENTRATION_MEDIUM_SHARE, 0)} or more of the portfolio's insured value is marked medium; ${fmtPct(CONCENTRATION_HIGH_SHARE, 0)} or more is high.`,
    `- The price is said to rest on the assumptions when the Cautious agent's average annual loss is ${fmtNum(ASSUMPTION_SPREAD_RATIO)} times the Optimist's or more.`,
    `- A dry site within ${fmtInt(NEAR_WET_CELL_M)} m of mapped flood water is marked as near water and supports a survey.`,
    `- Portfolio buildings within ${fmtInt(NEIGHBOUR_RADIUS_M)} m of the site count as its neighbours.`,
    ``,
  );

  // --- Drainage -------------------------------------------------------------------------------
  lines.push(heading("Drainage layer"), ``);
  if (dataset.drainage) {
    const dr = dataset.drainage;
    const withD = hotspotHits(dataset);
    const without = hotspotHits({ ...dataset, drainage: undefined });
    lines.push(
      `Switched on for this run. The terrain maps cannot see water that ponds where drains are missing or blocked, so a second layer adds shallow ponding within ${fmtNum(dr.reachM, 0)} m of OpenStreetMap drains, ditches and canals and inside informal settlements, fading to nothing at the edge of that reach. Each building takes the deeper of terrain depth and ponding.`,
      ``,
      `- Ponding depth at full stress: ${dataset.scenarios.map((sc, i) => `${fmtNum(dr.depthM[i])} m (${sc.id})`).join(", ")}.`,
      `- Test against the county's named flood areas: ${withD.filter((h) => h.hit).length} of ${withD.length} flagged with the layer, ${without.filter((h) => h.hit).length} on terrain alone.`,
      `- The reach and the depths are assumptions. The Hazard map step shows how the match moves for other reaches.`,
      ``,
    );
  } else if (isScore) {
    lines.push(`Switched off for this run: every depth comes from the terrain maps alone. When on, it adds shallow ponding within ${fmtInt(DRAINAGE_DEFAULTS.reachM)} m of mapped drains and inside informal settlements (${SCORE_TIERS.map((t) => `${fmtNum(DRAINAGE_DEFAULTS.depthM[t])} m for ${t}`).join(", ")}).`, ``);
  } else {
    lines.push(`Not used: this data set carries flood depths of its own.`, ``);
  }

  // --- Portfolio results ----------------------------------------------------------------------
  lines.push(heading("Portfolio results"), ``, `| Return period | Scenario | Buildings affected | Ground-up loss | Share of insured value |`, `|---|---|---|---|---|`);
  for (const s of r.scenarios) lines.push(`| ${rpWithChance(s.returnPeriod)} | ${s.id} | ${fmtInt(s.affected)} of ${fmtInt(r.buildingCount)} | ${fmtKes(s.lossKes, 2)} | ${fmtPct(s.lossKes / r.totalTivKes, 2)} |`);
  lines.push(``, `Total insured value ${fmtKes(r.totalTivKes)} · average annual loss ${fmtKes(r.aalKes, 2)}, ground-up.`, ``);

  // --- Insurance terms ------------------------------------------------------------------------
  lines.push(heading("Insurance terms"), ``, `**${TERMS_NOTICE}.** They apply to the portfolio, and to an offer wherever its document states no term of its own.`, ``);
  for (const row of termRows(terms)) lines.push(`- ${row.term}: ${row.value}`);
  const at100 = terms.standard.find((l) => l.returnPeriod === 100);
  lines.push(``, `| Portfolio | Ground-up | Gross | Net |`, `|---|---|---|---|`);
  if (at100) lines.push(`| ${rpWithChance(100)} loss${at100.extrapolated ? ", held flat beyond the rarest modelled event" : ""} | ${orNa(at100.groundUpKes)} | ${orNa(at100.grossKes)} | ${orNa(at100.netKes)} |`);
  lines.push(`| Average annual loss | ${kes1(terms.aal.groundUpKes)} | ${kes1(terms.aal.grossKes)} | ${kes1(terms.aal.netKes)} |`, ``);

  // --- AI features ----------------------------------------------------------------------------
  lines.push(heading("AI features and what each changed"), ``, `### The agent panel`, ``);
  if (deliberation?.final) {
    const agreed = deliberation.final.result;
    const moved = ledger.filter((row) => Math.abs(row.final - row.reference) > 1e-9);
    const ref100 = reference.standardLosses.find((l) => l.returnPeriod === 100);
    const new100 = agreed.standardLosses.find((l) => l.returnPeriod === 100);
    lines.push(
      `Three agents ran in parallel (${deliberation.runs.optimist.model ?? "model"}): an Optimist and a Cautious voice each proposed a full set of assumptions with a reason per value, and a Critic challenged the data and the reference assumptions. Code ran the loss engine on both proposals. A Chair then settled the final set and answered each challenge. The agents read a summary of the data, never individual rows, and returned assumptions only.`,
      ``,
      `What they changed: ${moved.length} of ${ledger.length} assumptions moved from their reference value${moved.length ? ` (${moved.map((row) => `${PARAM_LABELS[row.path]} ${fmtNum(row.reference)} to ${fmtNum(row.final)}`).join("; ")})` : ""}.`,
      ``,
      `| Portfolio, ground-up | Reference, no AI | Agreed by agents |`,
      `|---|---|---|`,
    );
    if (ref100 && new100) lines.push(`| ${rpWithChance(100)} loss | ${orNa(ref100.lossKes)} | ${orNa(new100.lossKes)} |`);
    lines.push(
      `| Rarest scenario loss | ${fmtKes(reference.scenarios[reference.scenarios.length - 1].lossKes, 2)} | ${fmtKes(agreed.scenarios[agreed.scenarios.length - 1].lossKes, 2)} |`,
      `| Average annual loss | ${fmtKes(reference.aalKes, 2)} | ${fmtKes(agreed.aalKes, 2)} |`,
      ``,
    );
    if (!fromAgents) lines.push(`The agreed set is not the one in force for the figures in this note: the reference values were chosen on screen.`, ``);
    const chair = deliberation.runs.chair.output;
    if (chair) lines.push(`Chair's summary: ${chair.summary}`, ``);
    lines.push(`| Parameter | Reference | Optimist | Cautious | Agreed | Reason |`, `|---|---|---|---|---|---|`);
    for (const row of ledger) lines.push(`| ${PARAM_LABELS[row.path]} | ${fmtNum(row.reference)} | ${row.optimist === null ? "-" : fmtNum(row.optimist)} | ${row.cautious === null ? "-" : fmtNum(row.cautious)} | ${fmtNum(row.final)} | ${cell(row.reason)} |`);
    lines.push(``);
    const critic = deliberation.runs.critic.output;
    if (critic && chair) {
      lines.push(`Critic's challenges and the Chair's answers:`, ``);
      for (const c of critic.challenges) {
        const a = chair.responses.find((x) => x.challengeId === c.id);
        lines.push(`- **${c.id} ${c.title}** (${c.severity}). ${c.detail} Answer: *${a ? `${a.verdict}: ${a.response}` : "not answered"}*`);
      }
      lines.push(``);
    }
    const failed = ROLES.filter((role) => deliberation.runs[role].status === "error");
    if (failed.length) lines.push(`Agents that did not return a valid reply: ${failed.map((f) => ROLE_LABELS[f]).join(", ")}.`, ``);
  } else {
    lines.push(`The agent panel was not run for this result, so it changed nothing: every figure uses reference values, and the rarest scenario loss is ${fmtKes(rarest.lossKes, 2)}.`, ``);
  }
  if (offer?.price && offer.price.assumptions.length > 1) {
    lines.push(`The same offer priced under each set of assumptions (gross):`, ``, `| Assumptions | ${rpLabel(100)} loss | Average annual loss | Pure rate per mille |`, `|---|---|---|---|`);
    for (const a of offer.price.assumptions) lines.push(`| ${a.label}${a.inForce ? " (in force)" : ""} | ${orNa(a.loss100GrossKes)} | ${kes1(a.aalGrossKes)} | ${fmtNum(a.ratePerMilleGross, 3)} |`);
    lines.push(``);
  }

  lines.push(`### The offer reader`, ``);
  if (!offer) {
    lines.push(`No offer was read in this session. When one is, the hosted model (or fixed rules, with no key) turns the document into rows in the exposure file's shape, and code checks every value against the document's own words before anything is priced.`, ``);
  } else {
    const c = offer.counts;
    const read = c.verified + c.unverified + c.confirmed + c.edited;
    const byModel = offer.document.path === "model";
    lines.push(
      `${byModel ? `The hosted model (${offer.document.model ?? "model"}) read` : "The fixed rules read"} "${offer.documentName}". ${cell(offer.document.why)}`,
      ``,
      `- Values read: ${read}. Verified by code against the document's words: ${c.verified}. Not verified: ${c.unverified}. Confirmed by the underwriter: ${c.confirmed}. Typed by the underwriter: ${c.edited}. Not stated in the document: ${c.missing}.`,
      `- ${cell(offer.document.removedLine)}`,
      `- What it changed: ${byModel ? "the document became priced rows without retyping. The reader supplied values and the sentence each rests on; it supplied no loss figure." : "nothing was sent to a model for this offer. The rows came from fixed rules, so this reading involved no AI."} A value that fails its check is shown and holds the price back until the underwriter confirms, edits or clears it.`,
      ``,
    );
  }

  const usage = usageRecord(deliberation, offer, prices);
  if (usage.rows.length > 0) {
    const withCost = usage.prices !== null;
    lines.push(`### Usage`, ``, `| Call | Model | Tokens in | Tokens out | Thinking tokens | Seconds |${withCost ? " Estimated cost |" : ""}`, `|---|---|---|---|---|---|${withCost ? "---|" : ""}`);
    const tokens = (v: number | null) => (v === null ? "not reported" : fmtInt(v));
    for (const row of usage.rows) lines.push(`| ${row.label} | ${row.model ?? "-"} | ${tokens(row.inputTokens)} | ${tokens(row.outputTokens)} | ${tokens(row.thinkingTokens)} | ${row.seconds === null ? "-" : fmtNum(row.seconds, 1)} |${withCost ? ` ${fmtUsd(costOf(row, usage.prices))} |` : ""}`);
    lines.push(`| Total | ${usage.totals.models.join(", ") || "-"} | ${fmtInt(usage.totals.inputTokens)} | ${fmtInt(usage.totals.outputTokens)} | ${fmtInt(usage.totals.thinkingTokens)} | ${fmtNum(usage.totals.seconds, 1)} |${withCost ? ` ${fmtUsd(usage.costUsd)} |` : ""}`, ``);
    lines.push(`${withCost ? "Cost uses the prices per million tokens set in web/.env.local." : "No cost is shown because no price per million tokens is set in web/.env.local."} Seconds are time worked: agents that ran side by side are each counted in full.`, ``);
  }

  // --- Oasis ----------------------------------------------------------------------------------
  lines.push(heading("Independent check with Oasis LMF"), ``);
  if (oasis && oasis.dataset === dataset.name) {
    lines.push(
      `The portfolio and the reference assumptions were written as Oasis model files and run through the open-source Oasis engine (oasislmf ${oasis.oasislmfVersion}, run saved ${oasis.generatedAt.slice(0, 10)}). Ground-up, terrain maps only, no insurance terms.`,
      ``,
      `| Return period | This engine | Oasis LMF | Difference |`,
      `|---|---|---|---|`,
    );
    for (const e of oasis.events) lines.push(`| ${rpWithChance(e.returnPeriod)} (${e.tier}) | ${fmtKes(e.ourLossKes, 2)} | ${fmtKes(e.oasisLossKes, 2)} | ${diffPct(e.ourLossKes, e.oasisLossKes)} |`);
    lines.push(
      `| Average annual loss, step method | ${fmtKes(oasis.aal.ourDiscreteKes, 2)} | ${fmtKes(oasis.aal.oasisKes, 2)} | ${diffPct(oasis.aal.ourDiscreteKes, oasis.aal.oasisKes)} |`,
      ``,
      `The app's own average annual loss draws a straight line between events (${fmtKes(oasis.aal.ourTrapezoidKes, 2)} on these inputs), so it sits above the step value; the gap is the shape assumed between the points and nothing else. The check covers the arithmetic of the loss engine. It does not test the hazard maps, the damage curve or the insured values, which both engines read alike. See oasis/README.md.`,
      ``,
    );
  } else if (oasis) {
    lines.push(`The saved Oasis run was made for "${oasis.dataset}", not for this data set, so it is not compared here. See oasis/README.md to produce one.`, ``);
  } else {
    lines.push(`The loss engine is checked against the open-source Oasis LMF engine on the reference assumptions; the comparison is on the Results step and the method is in oasis/README.md. The figures were not available when this note was written.`, ``);
  }

  // --- Checks ---------------------------------------------------------------------------------
  lines.push(heading("Checks"), ``, `${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed${offer ? ", the offer's checks included" : ""}.`, ``);
  for (const c of allChecks.filter((c) => c.status !== "pass")) lines.push(`- **${c.status === "warn" ? "Warning" : "Fail"}: ${c.title}.** ${c.detail}`);

  lines.push(``, heading("Limits"), ``);
  for (const l of LIMITS.filter((l) => isScore || !scoreOnlyLimit(l))) lines.push(`- ${l}`);
  lines.push(``);
  return lines.join("\n");
}
