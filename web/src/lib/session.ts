import type { Deliberation } from "./agents/orchestrate";
import type { DataProfile } from "./agents/profile";
import type { Check } from "./checks";
import type { IngestReport } from "./ingest";
import type { HotspotHit } from "./model/hotspots";
import { resultFingerprint } from "./model/pipeline";
import type { Dataset, ModelParams, ModelResult } from "./model/types";

/** Everything known once a dataset has been read and the reference run is done. */
export interface Session {
  uploadName: string;
  dataset: Dataset;
  report: IngestReport;
  reference: ModelResult;
  dataChecks: Check[];
  hazardChecks: Check[];
  hits: HotspotHit[];
  profile: DataProfile;
}

/** The assumptions currently driving the results, and where they came from. */
export interface Active {
  source: "ai" | "reference";
  params: ModelParams;
  result: ModelResult;
}

export interface LogEntry {
  at: string;
  step: string;
  message: string;
}

/**
 * What a run of the agents was made on. A run is replayed only on the same inputs: the data set by
 * its name, its building count and its total insured value, and the model by the fingerprint of
 * its reference result, so a changed model does not replay a run made before the change.
 */
export interface RunInputs {
  /** The data set's name. */
  dataset: string;
  /** How many buildings it holds. */
  buildings: number;
  /** Their total insured value, in whole KES. */
  totalTivKes: number;
  /** Fingerprint of the reference result on depth only, from the terrain maps alone. */
  reference: string;
}

/** The inputs of the session as loaded. Pass the session itself, never a view of it with drainage or the loss drivers applied. */
export function runInputs(s: Session): RunInputs {
  return { dataset: s.dataset.name, buildings: s.dataset.buildings.length, totalTivKes: Math.round(s.reference.totalTivKes), reference: resultFingerprint(s.reference) };
}

/**
 * A run as it is kept, in this browser or in a file: the deliberation without its per-building
 * results, with what it was made on and the final parameters stated beside the replies.
 */
export interface SavedRun extends Deliberation {
  /** What the run was made on. A run kept before this was recorded has none. */
  inputs?: RunInputs;
  /** The final parameters as code kept them in range. Stated for the record: a replay works them out again from the Chair's reply. */
  finalParams?: ModelParams;
}

const key = (s: Session) => `mafuriko:run:${s.dataset.name}:${s.dataset.buildings.length}:${Math.round(s.reference.totalTivKes)}`;

/** Saved without the per-building results; those are recomputed on replay, which is what proves reproducibility. */
export function slim(d: Deliberation): SavedRun {
  const kept: SavedRun = { ...d, optimist: null, cautious: null, final: null };
  if (d.final) kept.finalParams = d.final.params;
  return kept;
}

export function saveRun(s: Session, d: Deliberation) {
  try {
    localStorage.setItem(key(s), JSON.stringify({ ...slim(d), inputs: runInputs(s) }));
  } catch {
    // Storage can be unavailable (private window); the run still shows on screen.
  }
}

export function loadRun(s: Session): Deliberation | null {
  try {
    const raw = localStorage.getItem(key(s));
    return raw ? (JSON.parse(raw) as Deliberation) : null;
  } catch {
    return null;
  }
}

export function download(fileName: string, text: string, mime = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
