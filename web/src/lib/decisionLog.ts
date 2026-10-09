/**
 * The decision log: one JSON record per underwriter decision, saved under data/decisions on this
 * machine (never in git) and downloadable. A record holds the offer, the figures it was priced
 * at, the flags, the conditions ticked, the decision and its note, and the trace block, so the
 * decision can be read back years later against the exact data and assumptions behind it.
 *
 * How to use it, on the decision page, once validateDecision returns nothing:
 *
 *   const record = recordFromDecision({ decision, focus, trace });        // focus: the PricedFocus on screen
 *   await fetch("/api/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: toJson(record) });
 *   download(fileNameFor(record), toJson(record));                       // session.ts download: the same file for the underwriter
 *
 * Reading back, from GET /api/decisions and GET /api/decisions?id=<id>:
 *   { ok: true, records: DecisionSummary[] }      newest first
 *   { ok: true, record: DecisionRecord }          one record
 *
 * Pure: no React, no storage, no network, nothing from Node. The route in app/api/decisions does
 * the disk work and uses readDecisionRecord to check what it is given.
 *
 * Names: decision.ts exports DecisionRecord for the draft the underwriter fills in on screen
 * (choice, note, conditions, recordedAt). It is imported here as Decision. The DecisionRecord of
 * this module is what is saved.
 */
import { DECISION_CHOICES, DECISION_LABELS, SEVERITY_ORDER, type DecisionChoice, type DecisionRecord as Decision, type Flag, type Severity, type SuggestedCondition } from "./decision";
import type { LossMode } from "./model/drivers";
import type { FloodSource } from "./oasisExport";
import type { OfferDrivers } from "./offer/drivers";
import type { FocusBuilding, LossFigures, OfferLine } from "./offer/focus";
import type { TraceBlock } from "./trace";

/**
 * What recordFromDecision reads of the offer on screen. A PricedFocus has all of it; so does an
 * OfferFocus that is not priced, whose figures are then null. Pass `focus` as it is.
 */
export interface DecisionFocus {
  /** The document's name: the file name, or "typed text". */
  documentName: string;
  line: Pick<OfferLine, "insured" | "sumInsuredKes">;
  /** The building the steps follow. null only while locating or when the offer has no row. */
  building: Pick<FocusBuilding, "name"> | null;
  /** The headline figures under the mode in force. null unless the offer is priced. */
  price: { total: Pick<LossFigures, "ratePerMilleGross" | "loss100GrossKes" | "aalGrossKes"> } | null;
  /** The premium build-up. null unless the offer is priced. */
  drivers: { premium: Pick<OfferDrivers["premium"], "floodPremiumKes" | "floodRatePerMille" | "setBy"> } | null;
  mode: LossMode;
  /** True when drainage ponding was part of the run. */
  drainageOn: boolean;
  assumptionsInForce: "ai" | "reference";
  flags: Pick<Flag, "id" | "severity" | "title">[];
  /** Every suggested condition on the page. The ticked ones are read from the decision. */
  conditions: Pick<SuggestedCondition, "id" | "text">[];
}

/** The saved record. Plain JSON: every field survives toJson and JSON.parse unchanged. */
export interface DecisionRecord {
  /** The shape of this record. Raised only when a field changes meaning. */
  format: 1;
  /** "<savedAt with : and . as ->_<offer slug>": the file name without ".json". Safe as a file name on every platform. */
  id: string;
  /** When the record was made, as an ISO date and time. */
  savedAt: string;
  offer: {
    /** The document's file name, or "typed text". */
    fileName: string;
    /** The followed building's name as stated, or "Building 1". "" when the offer has no row. */
    buildingName: string;
    /** The insured or the building name as stated. null when none could be used. */
    insured: string | null;
    /** The sum insured of the offer. null when the document does not state it. */
    sumInsuredKes: number | null;
    /** The sha256 of the document's text, from the trace block. null when it was not worked out. */
    hash: string | null;
  };
  figures: {
    /** The flood rate per mille of the sum insured: the premium build-up's headline. null when not priced. */
    ratePerMille: number | null;
    /** The pure rate per mille, gross: average annual loss over the sum insured, before the capital load and the minimum. null when not priced. */
    pureRatePerMille: number | null;
    /** The flood premium in shillings a year. null when not priced. */
    floodPremiumKes: number | null;
    /** "modelled" or "minimum rate": which set the flood premium. null when not priced. */
    premiumSetBy: "modelled" | "minimum rate" | null;
    /** Gross loss in a 1-in-100 flood. null when not priced, or when 100 years is more frequent than anything modelled. */
    loss100GrossKes: number | null;
    /** Average annual loss, gross. null when not priced. */
    aalGrossKes: number | null;
    /** "depth_only" or "all_drivers", as the header switch said. */
    mode: LossMode;
    /** "terrain" or "terrain_drainage", as the Flood source switch said. */
    floodSource: FloodSource;
    /** "agents" when the agents' assumptions were in force, "reference" for the reference set. */
    assumptions: "agents" | "reference";
  };
  /** The points for the underwriter as the page showed them, worst first. */
  flags: { id: string; severity: Severity; title: string }[];
  /** The conditions the underwriter ticked, with their words, in the order of the page. */
  conditions: { id: string; text: string }[];
  decision: {
    choice: DecisionChoice;
    /** "Accept", "Accept with conditions", "Refer", "Decline". */
    label: string;
    /** When the decision was recorded on screen. null when it was saved as a draft. */
    recordedAt: string | null;
  };
  /** The underwriter's note, trimmed. */
  note: string;
  trace: TraceBlock;
}

/** One line of the list GET /api/decisions returns. */
export interface DecisionSummary {
  id: string;
  savedAt: string;
  /** The followed building's name, or the insured's, or the file name: the first that is not empty. */
  building: string;
  /** "Accept", "Accept with conditions", "Refer", "Decline". */
  decision: string;
}

/** The shape of a record id and of its file name: a time stamp, an underscore, a slug of the offer's name. Nothing else is read from disk or written to it. */
export const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

const MAX_SLUG_CHARS = 48;

/** "Landmark Plaza offer (final).docx" becomes "landmark-plaza-offer-final". "offer" when nothing usable is left. */
export function offerSlug(fileName: string): string {
  const stem = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return slug || "offer";
}

/** The ISO time as it goes into a file name: colons and the dot replaced, so "2026-10-09T20:15:30.123Z" reads "2026-10-09T20-15-30-123Z". */
export const stampFor = (savedAt: string): string => savedAt.replace(/[:.]/g, "-");

const iso = (when: Date | string | undefined): string => {
  const d = when === undefined ? new Date() : when instanceof Date ? when : new Date(when);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/**
 * The record for the decision on screen. Call it only when validateDecision returns nothing: a
 * draft without a choice cannot be saved, and this throws on one. The trace block is the one the
 * page's exports carry (buildTrace in trace.ts), made with the same offer and settings.
 */
export function recordFromDecision(input: { decision: Decision; focus: DecisionFocus; trace: TraceBlock; savedAt?: Date | string }): DecisionRecord {
  const { decision, focus, trace } = input;
  if (decision.choice === null) throw new Error("Choose Accept, Accept with conditions, Refer or Decline before saving the decision.");
  const savedAt = iso(input.savedAt);
  const fileName = focus.documentName || "typed text";
  const ticked = new Set(decision.conditions);
  const price = focus.price?.total ?? null;
  const premium = focus.drivers?.premium ?? null;
  return {
    format: 1,
    id: `${stampFor(savedAt)}_${offerSlug(fileName)}`,
    savedAt,
    offer: {
      fileName,
      buildingName: focus.building?.name ?? "",
      insured: focus.line.insured,
      sumInsuredKes: focus.line.sumInsuredKes,
      hash: trace.offer?.sha256 ?? null,
    },
    figures: {
      ratePerMille: premium?.floodRatePerMille ?? null,
      pureRatePerMille: price?.ratePerMilleGross ?? null,
      floodPremiumKes: premium?.floodPremiumKes ?? null,
      premiumSetBy: premium?.setBy ?? null,
      loss100GrossKes: price?.loss100GrossKes ?? null,
      aalGrossKes: price?.aalGrossKes ?? null,
      mode: focus.mode,
      floodSource: focus.drainageOn ? "terrain_drainage" : "terrain",
      assumptions: focus.assumptionsInForce === "ai" ? "agents" : "reference",
    },
    flags: focus.flags.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
    conditions: focus.conditions.filter((c) => ticked.has(c.id)).map((c) => ({ id: c.id, text: c.text })),
    decision: { choice: decision.choice, label: DECISION_LABELS[decision.choice], recordedAt: decision.recordedAt },
    note: decision.note.trim(),
    trace,
  };
}

/** The record as the file holds it: indented JSON, so it reads in a text editor. */
export const toJson = (record: DecisionRecord): string => JSON.stringify(record, null, 2);

/** The file the record is saved as and downloaded as: "<id>.json". */
export const fileNameFor = (record: Pick<DecisionRecord, "id">): string => `${record.id}.json`;

/** The line of the list for one record. */
export function summaryOf(record: DecisionRecord): DecisionSummary {
  return { id: record.id, savedAt: record.savedAt, building: record.offer.buildingName || record.offer.insured || record.offer.fileName, decision: record.decision.label };
}

/** Newest first, then by id, so the order never changes between two listings of the same files. */
export function sortNewestFirst<T extends { id: string; savedAt: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDate = (v: string) => !Number.isNaN(new Date(v).getTime());
const isChoice = (v: unknown): v is DecisionChoice => typeof v === "string" && (DECISION_CHOICES as string[]).includes(v);
const isSeverity = (v: unknown): v is Severity => typeof v === "string" && (SEVERITY_ORDER as string[]).includes(v);

/**
 * A record as it was parsed from a request body or a file, checked field by field and rebuilt
 * from those fields alone, or null when it is not a record: the id must match ID_PATTERN and the
 * time it was saved, the decision must be one of the four, and every list must hold what it
 * says. Anything else in the input is left out, so nothing unexpected reaches the disk.
 */
export function readDecisionRecord(raw: unknown): DecisionRecord | null {
  const r = record(raw);
  if (!r || r.format !== 1) return null;
  const id = text(r.id);
  const savedAt = text(r.savedAt);
  if (id === null || !ID_PATTERN.test(id) || savedAt === null || !isDate(savedAt) || !id.startsWith(`${stampFor(new Date(savedAt).toISOString())}_`)) return null;

  const offer = record(r.offer);
  const fileName = text(offer?.fileName);
  if (!offer || fileName === null) return null;
  const buildingName = text(offer.buildingName) ?? "";
  const hash = text(offer.hash);
  if (hash !== null && !/^[0-9a-f]{64}$/.test(hash)) return null;

  const figures = record(r.figures);
  const mode = figures?.mode;
  const floodSource = figures?.floodSource;
  const assumptions = figures?.assumptions;
  if (!figures || (mode !== "depth_only" && mode !== "all_drivers") || (floodSource !== "terrain" && floodSource !== "terrain_drainage") || (assumptions !== "agents" && assumptions !== "reference")) return null;
  const setBy = figures.premiumSetBy;
  const premiumSetBy: DecisionRecord["figures"]["premiumSetBy"] | undefined = setBy === "modelled" || setBy === "minimum rate" ? setBy : setBy === null || setBy === undefined ? null : undefined;
  if (premiumSetBy === undefined) return null;

  const decision = record(r.decision);
  if (!decision || !isChoice(decision.choice)) return null;
  const recordedAt = text(decision.recordedAt);
  if (recordedAt !== null && !isDate(recordedAt)) return null;

  const trace = record(r.trace);
  if (!trace || trace.format !== 1 || text(trace.generatedAt) === null || !record(trace.modelData) || !record(trace.params) || !record(trace.judgement) || !record(trace.agentRun) || !record(trace.app)) return null;

  if (!Array.isArray(r.flags) || !Array.isArray(r.conditions)) return null;
  const flags: DecisionRecord["flags"] = [];
  for (const item of r.flags) {
    const f = record(item);
    const flagId = text(f?.id);
    const title = text(f?.title);
    if (!f || flagId === null || title === null || !isSeverity(f.severity)) return null;
    flags.push({ id: flagId, severity: f.severity, title });
  }
  const conditions: DecisionRecord["conditions"] = [];
  for (const item of r.conditions) {
    const c = record(item);
    const conditionId = text(c?.id);
    const words = text(c?.text);
    if (!c || conditionId === null || words === null) return null;
    conditions.push({ id: conditionId, text: words });
  }

  return {
    format: 1,
    id,
    savedAt,
    offer: { fileName, buildingName, insured: text(offer.insured), sumInsuredKes: amount(offer.sumInsuredKes), hash },
    figures: {
      ratePerMille: amount(figures.ratePerMille),
      pureRatePerMille: amount(figures.pureRatePerMille),
      floodPremiumKes: amount(figures.floodPremiumKes),
      premiumSetBy,
      loss100GrossKes: amount(figures.loss100GrossKes),
      aalGrossKes: amount(figures.aalGrossKes),
      mode,
      floodSource,
      assumptions,
    },
    flags,
    conditions,
    decision: { choice: decision.choice, label: DECISION_LABELS[decision.choice], recordedAt },
    note: text(r.note) ?? "",
    trace: trace as unknown as TraceBlock,
  };
}
