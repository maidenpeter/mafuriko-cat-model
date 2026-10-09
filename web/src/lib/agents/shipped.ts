import type { Dataset } from "../model/types";
import type { RunInputs, SavedRun } from "../session";
import type { OfferBrief } from "./offerBrief";
import { replay, type Deliberation } from "./orchestrate";
import { critiqueSchema, decisionSchema, proposalSchema } from "./schema";

/**
 * The runs of the agents that ship with the app, in web/public/agents.
 *
 * Each was made once with a live model and is kept exactly as the app keeps any run (SavedRun in
 * session.ts): the replies, the tokens, the model, what it was made on and the final parameters.
 * index.json lists them. When the model data has loaded and this browser holds no run of its own,
 * the app reads the index, takes the runs made on the same inputs and replays one through replay(),
 * so code works out every figure again and the usual checks run. Nothing here calls a model.
 *
 *   const shipped = await loadShipped(runInputs(session));      // null when there is nothing to replay
 *   const run = pickShipped(shipped.runs, offerKey(offerBrief(pricedFocus)));
 *   const deliberation = run && replayShipped(session.dataset, run.run);
 *   shippedLabel(run.entry)                                      // "Saved run from 8 October 2026, model x"
 *
 * Which run applies:
 *   no offer priced            the portfolio run
 *   an offer priced            the offer run whose key is that offer's, with its figures beyond flood depth;
 *                              otherwise the portfolio run, and the offer stays on the reference figures
 *   made on other inputs       ignored: `otherData` says so
 *
 * The files are written by scripts/pack-run.mjs, which holds the same list of facts for the offer key.
 */

export type ShippedKind = "portfolio" | "offer";

/** One line of index.json. */
export interface ShippedEntry {
  /** The run's file name in web/public/agents. */
  file: string;
  /** "portfolio" for a run made with no offer loaded, "offer" for one made on an offer. */
  kind: ShippedKind;
  /** When the agents ran, as an ISO date and time. */
  savedAt: string;
  /** The model that answered. */
  model: string;
  /** What the run was made on. */
  inputs: RunInputs;
  /** For an offer run: the key of the offer the agents saw (offerKey). */
  offerKey?: string;
  /**
   * What was corrected in the run's text after it was made, in plain sentences, when anything was.
   * Shown with the run wherever it is replayed, so no word is passed off as the agents' own.
   */
  corrections?: string[];
}

export interface ShippedIndex {
  runs: ShippedEntry[];
}

/** A shipped run read from its file and ready to replay. */
export interface ShippedRun {
  entry: ShippedEntry;
  run: SavedRun;
}

export interface Shipped {
  /** The shipped runs made on the inputs loaded. Empty when none was. */
  runs: ShippedRun[];
  /** True when the app ships runs and every one of them was made on other data or another model. */
  otherData: boolean;
}

/** The part of the brief that belongs to the offer itself: what the maps show at the point is left out, as sameOffer in offer/focus.ts leaves it out. */
type OfferFacts = Omit<OfferBrief, "bufferRadiusM" | "depthsByTier" | "nearestMappedWaterM">;

/** FNV-1a over the text from one starting value, as eight hex digits. */
function fnv(text: string, start: number): string {
  let h = start;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stable key for the offer the agents saw: a hash of the plain facts in its brief, the very facts
 * sameOffer compares, in the same order. Two briefs of the same offer give the same key whatever the
 * flood source, the mode or the assumptions; a changed fact or a changed sentence gives another.
 * Sixteen hex digits. scripts/pack-run.mjs works out the same key in plain JavaScript.
 */
export function offerKey(brief: OfferFacts): string {
  const whole = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v));
  const facts = JSON.stringify([
    brief.housingClass,
    brief.occupancy ?? null,
    whole(brief.insuredValueKes),
    whole(brief.floorAreaM2),
    brief.locationApproximate ?? false,
    brief.basements,
    brief.basementDepthM ?? null,
    brief.criticalPlantInBasement,
    brief.equipmentBelowGroundCount ?? 0,
    whole(brief.valueBelowGroundKes),
    brief.drainageCondition,
    brief.drainDesignRp ?? null,
    brief.sumpPumpCapacity ?? null,
    brief.sumpPumpBackup ?? null,
    brief.floodBarriers ?? null,
    brief.nonReturnValves ?? null,
    brief.biCovered ?? null,
    brief.floodLossCount,
    whole(brief.floodLossTotalKes),
    brief.floodHistoryYears,
    whole(brief.nearestRiverM),
    whole(brief.nearestDrainM),
    brief.quotes.map((q) => q.quote),
  ]);
  return fnv(facts, 0x811c9dc5) + fnv(facts, 0x9747b28c);
}

/** True when two runs were made on the same data set and the same model. */
export function sameInputs(a: RunInputs, b: RunInputs): boolean {
  return a.dataset === b.dataset && a.buildings === b.buildings && Math.round(a.totalTivKes) === Math.round(b.totalTivKes) && a.reference === b.reference;
}

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const amount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isDate = (v: string) => !Number.isNaN(new Date(v).getTime());

/** A run file is fetched by this name from the same folder as the index: a plain file name, never a path or an address. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

function readInputs(raw: unknown): RunInputs | null {
  const r = record(raw);
  const dataset = text(r?.dataset);
  const buildings = amount(r?.buildings);
  const totalTivKes = amount(r?.totalTivKes);
  const reference = text(r?.reference);
  return dataset !== null && buildings !== null && totalTivKes !== null && reference !== null ? { dataset, buildings, totalTivKes, reference } : null;
}

/**
 * index.json as it was fetched, cut back to the lines that can be used. A line that is not whole
 * (no file name, no date, no inputs, an offer run without its key) is dropped, and anything that is
 * not an index at all reads as an index with no runs.
 */
export function readShippedIndex(raw: unknown): ShippedIndex {
  const list = record(raw)?.runs;
  if (!Array.isArray(list)) return { runs: [] };
  const runs: ShippedEntry[] = [];
  for (const item of list) {
    const r = record(item);
    const file = text(r?.file);
    const kind = r?.kind === "portfolio" || r?.kind === "offer" ? r.kind : null;
    const savedAt = text(r?.savedAt);
    const model = text(r?.model);
    const inputs = readInputs(r?.inputs);
    const key = text(r?.offerKey);
    if (file === null || !FILE_NAME.test(file) || kind === null || savedAt === null || !isDate(savedAt) || model === null || inputs === null) continue;
    if (kind === "offer" && key === null) continue;
    // What was put right in the run after it was made, kept only as plain sentences.
    const said = Array.isArray(r?.corrections) ? r.corrections.filter((c): c is string => typeof c === "string" && c.trim() !== "") : [];
    const corrections = said.length > 0 ? { corrections: said } : {};
    runs.push(kind === "offer" ? { file, kind, savedAt, model, inputs, offerKey: key!, ...corrections } : { file, kind, savedAt, model, inputs, ...corrections });
  }
  return { runs };
}

/**
 * A run file as it was fetched, checked and made ready to replay, or null when it cannot be used:
 * every agent must have replied in the required shape, and the file must be for the inputs its line
 * of the index names.
 *
 * A portfolio run carries no figures for an offer. An offer run is handed on without the brief it
 * was made with: its line of the index holds that brief's key, the run is used only while the offer
 * on screen has the same key, and so its figures are taken to be for that offer.
 */
export function readShippedRun(raw: unknown, entry: ShippedEntry): SavedRun | null {
  const r = record(raw);
  const runs = record(r?.runs);
  if (!r || !runs || text(r.startedAt) === null) return null;
  const replied = (role: string, shape: { safeParse: (v: unknown) => { success: boolean } }) => {
    const run = record(runs[role]);
    return run?.status === "done" && shape.safeParse(run.output).success;
  };
  if (!replied("optimist", proposalSchema) || !replied("cautious", proposalSchema) || !replied("critic", critiqueSchema) || !replied("chair", decisionSchema)) return null;
  const made = r.inputs === undefined ? entry.inputs : readInputs(r.inputs);
  if (!made || !sameInputs(made, entry.inputs)) return null;

  const { offerJudgement, ...rest } = r as unknown as SavedRun;
  if (entry.kind === "portfolio") return rest;
  if (!record(offerJudgement)) return null;
  const figures = { ...offerJudgement! };
  delete figures.brief;
  return { ...rest, offerJudgement: figures };
}

const fetchShipped = async (name: string): Promise<unknown> => {
  const res = await fetch(`/agents/${name}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
};

/**
 * The shipped runs made on these inputs, read from /agents. null when there is nothing to say: the
 * index lists no runs, or it could not be fetched or read. Never throws and never waits on anything
 * but its own requests, so with no network the app is as it is without shipped runs.
 * `read` fetches one file of the folder by name; the tests hand in their own.
 */
export async function loadShipped(inputs: RunInputs, read: (name: string) => Promise<unknown> = fetchShipped): Promise<Shipped | null> {
  try {
    const index = readShippedIndex(await read("index.json"));
    if (index.runs.length === 0) return null;
    const made = index.runs.filter((entry) => sameInputs(entry.inputs, inputs));
    const found = await Promise.all(
      made.map(async (entry): Promise<ShippedRun | null> => {
        try {
          const run = readShippedRun(await read(entry.file), entry);
          return run && { entry, run };
        } catch {
          return null;
        }
      }),
    );
    return { runs: found.filter((x): x is ShippedRun => x !== null), otherData: made.length === 0 };
  } catch {
    return null;
  }
}

/**
 * The shipped run that applies. `key` is the key of the priced offer on screen (offerKey), or null
 * when none is priced. An offer run is used only for its own offer; in every other case the
 * portfolio run applies, and null when there is none.
 */
export function pickShipped(runs: readonly ShippedRun[], key: string | null): ShippedRun | null {
  const own = key === null ? undefined : runs.find((r) => r.entry.kind === "offer" && r.entry.offerKey === key);
  return own ?? runs.find((r) => r.entry.kind === "portfolio") ?? null;
}

/** A shipped run re-scored on the data loaded, on the basis it was made with. No model is called. null when it gives no agreed set. */
export function replayShipped(dataset: Dataset, run: SavedRun): Deliberation | null {
  try {
    const replayed = replay(dataset, run);
    return replayed.final ? replayed : null;
  } catch {
    return null;
  }
}

/** 8 October 2026, in Nairobi time. */
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Nairobi" });

/** How a shipped run is named wherever it is the run in force: "Saved run from 8 October 2026, model x". */
export function shippedLabel(entry: Pick<ShippedEntry, "savedAt" | "model">): string {
  return `Saved run from ${day(entry.savedAt)}, model ${entry.model}`;
}
