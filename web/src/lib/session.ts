import type { Deliberation } from "./agents/orchestrate";
import type { DataProfile } from "./agents/profile";
import type { Check } from "./checks";
import type { IngestReport } from "./ingest";
import type { HotspotHit } from "./model/hotspots";
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

const key = (s: Session) => `mafuriko:run:${s.dataset.name}:${s.dataset.buildings.length}:${Math.round(s.reference.totalTivKes)}`;

/** Saved without the per-building results; those are recomputed on replay, which is what proves reproducibility. */
export function slim(d: Deliberation): Deliberation {
  return { ...d, optimist: null, cautious: null, final: null };
}

export function saveRun(s: Session, d: Deliberation) {
  try {
    localStorage.setItem(key(s), JSON.stringify(slim(d)));
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
