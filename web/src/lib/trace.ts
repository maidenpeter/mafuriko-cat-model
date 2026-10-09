/**
 * The trace block every result, export, Oasis file, written note and decision note carries: the
 * model data version and its file hashes, the build of the app, the parameters and the figures
 * beyond depth in force with who set each, the agent run, the offer document by name and hash,
 * and when the block was made. With it, every number on a page can be traced back to the exact
 * data and assumptions behind it.
 *
 * How to use it, in the shell, once per export or save:
 *
 *   const sha256 = await hashText(focus.document.text);          // once per document, in the browser
 *   const trace = buildTrace({
 *     version,                                                    // the model data version in force
 *     active: { source: active.source, params: active.params },  // the assumptions in force
 *     mode,                                                       // "depth_only" or "all_drivers"
 *     judgement,                                                  // the FocusJudgement every step receives
 *     deliberation: shownDeliberation,                            // the agents' run in force, or null
 *     shippedLabel: shippedName,                                  // when that run shipped with the app
 *     offer: focus ? { fileName: focus.documentName, sha256 } : null,
 *   });
 *   traceLines(trace)               // plain lines for the written note, the Audit step and the decision log
 *   traceLines(trace, "summary")    // the same without the per-file and per-figure lines, for the one-page note
 *   traceCompact(trace)             // one line for a header or a footer
 *
 * Pure apart from hashText, which uses the browser's crypto.subtle. Nothing here reads the disk,
 * hashes a raster (the manifest's hashes are trusted) or calls a model. The block is plain JSON
 * and round-trips through a saved file unchanged.
 *
 * The app's build comes from next.config.ts, which sets NEXT_PUBLIC_APP_VERSION to the short git
 * commit at build time ("unknown" when git is absent) and NEXT_PUBLIC_APP_PACKAGE_VERSION to the
 * version in package.json.
 */
import type { Deliberation } from "./agents/orchestrate";
import { LOSS_MODE_LABELS, SETTER_ORDER, SETTER_WORDS, type SetterKind } from "./labels";
import type { LossMode } from "./model/drivers";
import { flattenParams, REFERENCE_PARAMS } from "./model/params";
import type { ModelParams } from "./model/types";
import { hashesOf, type ModelDataVersion } from "./modelData/version";
import type { FocusJudgement, JudgementSetter } from "./offer/focus";
import { JUDGEMENT_KEYS, JUDGEMENT_LABELS, REFERENCE_JUDGEMENT, type OfferJudgement } from "./offer/judgement";

/** One input file of the model data version, as the manifest lists it. */
export interface TraceFile {
  name: string;
  role: string;
  provenance: "real" | "proxy" | "synthetic";
  sha256: string;
  bytes: number;
}

/** One of the model's parameters, as it was in force. */
export interface TraceParam {
  /** "depthScaleM", "fragility.concrete_rcc", "returnPeriods.common": the path flattenParams gives. */
  path: string;
  value: number;
  /** The reference value for the same parameter, so a reader sees at once whether it was moved. */
  reference: number;
  /** "agents" when the set the agents agreed is in force, otherwise "reference". No parameter is typed on screen. */
  setBy: "reference" | "agents";
}

/** One of the figures beyond depth, as it was in force. */
export interface TraceFigure {
  key: keyof OfferJudgement;
  /** Its plain name, with the unit, from JUDGEMENT_LABELS. */
  label: string;
  value: number;
  reference: number;
  /** Who set it: the offer document, the agents, the underwriter, the reference set, or "not recorded" when the block was made without the screen's setter map. */
  setBy: SetterKind;
}

export interface TraceBlock {
  /** The shape of this block. Raised only when a field changes meaning, so an old saved record can be told apart. */
  format: 1;
  /** When the block was made, as an ISO date and time. */
  generatedAt: string;
  /** The build of the app: the short git commit ("unknown" when git was absent at build time) and the version in package.json. */
  app: { commit: string; version: string };
  /** The model data version the figures rest on. */
  modelData: {
    /** The version's folder name, "<YYYY-MM-DD>_<short-label>", or "none" when the app runs on the bundled sample. */
    id: string;
    label: string;
    date: string;
    status: ModelDataVersion["status"] | "none";
    /** The area the version covers, by id and name. null when there is no version. */
    area: { id: string; name: string } | null;
    /** Every file of the version with its sha256, as the manifest lists them, sorted by name. */
    files: TraceFile[];
    /** hashesOf(version): sixteen hex characters from every file hash, the same key the browser cache uses. "none" without files. */
    hashes: string;
  };
  /** The model's parameters in force. */
  params: {
    /** Whose set: the reference set, or the set the agents agreed. */
    source: "reference" | "agents";
    /** Every parameter, in the order of flattenParams. */
    values: TraceParam[];
  };
  /** The figures beyond depth in force. */
  judgement: {
    /** "depth_only" or "all_drivers", as the header switch said. */
    mode: LossMode;
    /** Every figure, in the order of JUDGEMENT_KEYS. */
    values: TraceFigure[];
  };
  /** The agents' run in force. Every field is null when the figures rest on the reference set alone. */
  agentRun: {
    /** The run's id: when it started, as an ISO date and time. */
    id: string | null;
    startedAt: string | null;
    /** The depth-only fingerprint of its agreed result, which a replay must reproduce. */
    fingerprint: string | null;
    /** The model that answered the Chair. */
    model: string | null;
    /** "Saved run from 8 October 2026, model x" when the run shipped with the app; null for a run made in this browser. */
    label: string | null;
  };
  /** The offer document: its file name and the sha256 of its text. null when no offer is read. */
  offer: { fileName: string; sha256: string | null } | null;
}

/** What buildTrace needs. The shell holds every one of these already. */
export interface TraceInput {
  /** The model data version in force, as the version listing gives it. null when the app runs on the bundled sample. */
  version: ModelDataVersion | null;
  /** The assumptions in force: "ai" for the set the agents agreed, "reference" for the reference set, and the parameters themselves. The shell's `active`. */
  active: { source: "ai" | "reference"; params: ModelParams };
  /** "depth_only" or "all_drivers", as the header switch says. */
  mode: LossMode;
  /**
   * The figures beyond depth in force and who set each: the `judgement` every step receives
   * (FocusJudgement). A plain OfferJudgement is accepted where no setter map exists, and each
   * figure is then "reference" when it is the reference value and "not recorded" otherwise.
   * null means the reference values.
   */
  judgement: Pick<FocusJudgement, "inForce" | "setBy"> | OfferJudgement | null;
  /** The agents' run in force, when there is one: the deliberation shown on screen. */
  deliberation: (Pick<Deliberation, "startedAt" | "fingerprint"> & { runs?: { chair?: { model?: string } } }) | null;
  /** shippedLabel(entry) when the run in force shipped with the app. Left out or null for a run made in this browser. */
  shippedLabel?: string | null;
  /** The offer document: its file name and the sha256 of its text from hashText, or null while the hash is still being worked out. null when no offer is read. */
  offer: { fileName: string; sha256: string | null } | null;
  /** When the block is made. Now when left out. */
  generatedAt?: Date | string;
  /** The app's build, for a block made outside the browser. Read from the build when left out. */
  app?: Partial<TraceBlock["app"]>;
}

/**
 * The sha256 of a text as 64 lowercase hex digits, worked out in the browser with crypto.subtle.
 * Call it once per offer document and keep the result; buildTrace takes the hash, never the text.
 */
export async function hashText(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The build of the app as next.config.ts set it. Each is "unknown" outside a build. */
export function appVersion(): TraceBlock["app"] {
  // Written out in full so the build can replace each one with its value in the browser bundle.
  const commit = (process.env.NEXT_PUBLIC_APP_VERSION ?? "").trim();
  const version = (process.env.NEXT_PUBLIC_APP_PACKAGE_VERSION ?? "").trim();
  return { commit: commit || "unknown", version: version || "unknown" };
}

const iso = (when: Date | string | undefined): string => {
  const d = when === undefined ? new Date() : when instanceof Date ? when : new Date(when);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

function modelDataOf(version: ModelDataVersion | null): TraceBlock["modelData"] {
  if (!version) return { id: "none", label: "No model data version: the bundled sample", date: "", status: "none", area: null, files: [], hashes: "none" };
  const files: TraceFile[] = [...version.files]
    .map((f) => ({ name: f.name, role: f.role, provenance: f.provenance, sha256: f.sha256, bytes: f.bytes }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { id: version.id, label: version.label, date: version.date, status: version.status, area: { id: version.area.id, name: version.area.name }, files, hashes: files.length > 0 ? hashesOf(version) : "none" };
}

function figuresOf(judgement: TraceInput["judgement"]): TraceFigure[] {
  const inForce: OfferJudgement = judgement === null ? REFERENCE_JUDGEMENT : "setBy" in judgement ? judgement.inForce : judgement;
  const setBy: Partial<Record<keyof OfferJudgement, JudgementSetter>> | null = judgement !== null && "setBy" in judgement ? judgement.setBy : null;
  return JUDGEMENT_KEYS.map((key) => {
    const value = inForce[key];
    const reference = REFERENCE_JUDGEMENT[key];
    const who: SetterKind = setBy ? (setBy[key] ?? "not recorded") : value === reference ? "reference" : "not recorded";
    return { key, label: JUDGEMENT_LABELS[key], value, reference, setBy: who };
  });
}

/** The trace block for the figures on screen. Pure: the same input gives the same block, apart from generatedAt when it is left out. */
export function buildTrace(input: TraceInput): TraceBlock {
  const source: TraceParam["setBy"] = input.active.source === "ai" ? "agents" : "reference";
  const reference = new Map(flattenParams(REFERENCE_PARAMS).map((p) => [p.path, p.value]));
  const values: TraceParam[] = flattenParams(input.active.params).map(({ path, value }) => ({ path, value, reference: reference.get(path) ?? value, setBy: source }));
  const d = input.deliberation;
  const built = appVersion();
  return {
    format: 1,
    generatedAt: iso(input.generatedAt),
    app: { commit: input.app?.commit || built.commit, version: input.app?.version || built.version },
    modelData: modelDataOf(input.version),
    params: { source, values },
    judgement: { mode: input.mode, values: figuresOf(input.judgement) },
    agentRun: d
      ? { id: d.startedAt, startedAt: d.startedAt, fingerprint: d.fingerprint ?? null, model: d.runs?.chair?.model ?? null, label: input.shippedLabel ?? null }
      : { id: null, startedAt: null, fingerprint: null, model: null, label: null },
    offer: input.offer ? { fileName: input.offer.fileName, sha256: input.offer.sha256 ?? null } : null,
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 from the offer, 14 agreed by the agents, 2 reference values", in the one order every screen uses. */
function settersLine(values: readonly TraceFigure[]): string {
  const counts = new Map<SetterKind, number>();
  for (const v of values) counts.set(v.setBy, (counts.get(v.setBy) ?? 0) + 1);
  return SETTER_ORDER.filter((who) => counts.has(who))
    .map((who) => `${counts.get(who)} ${SETTER_WORDS[who].counted}`)
    .join(", ");
}

const paramsWord = (source: TraceBlock["params"]["source"]) => (source === "agents" ? "agreed by the agents" : "the reference set");

/**
 * The block as plain lines, for the written note, the Audit step and the decision log. "full"
 * lists every file, every parameter and every figure under its heading; "summary" keeps the
 * headings alone, for the one-page decision note. No line holds a long dash.
 */
export function traceLines(trace: TraceBlock, detail: "full" | "summary" = "full"): string[] {
  const full = detail === "full";
  const m = trace.modelData;
  const lines: string[] = [];
  lines.push(`Model data: ${m.id} (${m.label}, ${m.status}), ${count(m.files.length, "file")}, file hashes ${m.hashes}`);
  if (full) for (const f of m.files) lines.push(`  ${f.name}: ${f.role}, ${f.provenance}, sha256 ${f.sha256}, ${f.bytes} bytes`);
  lines.push(`App: commit ${trace.app.commit}, version ${trace.app.version}`);
  const moved = trace.params.values.filter((v) => v.value !== v.reference).length;
  lines.push(`Parameters: ${paramsWord(trace.params.source)}, ${moved} of ${trace.params.values.length} differ from the reference`);
  if (full) for (const v of trace.params.values) lines.push(`  ${v.path}: ${v.value} (${SETTER_WORDS[v.setBy].short}${v.value !== v.reference ? `, reference ${v.reference}` : ""})`);
  lines.push(`Figures beyond depth: ${LOSS_MODE_LABELS[trace.judgement.mode]}; ${settersLine(trace.judgement.values)}`);
  if (full) for (const v of trace.judgement.values) lines.push(`  ${v.label}: ${v.value} (${SETTER_WORDS[v.setBy].short}${v.value !== v.reference ? `, reference ${v.reference}` : ""})`);
  const run = trace.agentRun;
  lines.push(
    run.id === null
      ? "Agent run: none, the reference set alone"
      : `Agent run: ${run.id}, fingerprint ${run.fingerprint ?? "none"}, model ${run.model ?? "not recorded"}${run.label ? `, ${run.label}` : ""}`,
  );
  lines.push(trace.offer ? `Offer: ${trace.offer.fileName}, sha256 ${trace.offer.sha256 ?? "not yet worked out"}` : "Offer: none");
  lines.push(`Generated: ${trace.generatedAt}`);
  return lines;
}

/** The block in one line, for a header or a footer: the version and its hash key, the build, whose assumptions, the mode, the run, the offer and the time. */
export function traceCompact(trace: TraceBlock): string {
  const offer = trace.offer ? `${trace.offer.fileName} ${trace.offer.sha256 ? trace.offer.sha256.slice(0, 12) : "unhashed"}` : "none";
  return [
    `Model data ${trace.modelData.id} (${trace.modelData.hashes})`,
    `app ${trace.app.commit}`,
    `parameters ${paramsWord(trace.params.source)}`,
    LOSS_MODE_LABELS[trace.judgement.mode],
    `agent run ${trace.agentRun.id ?? "none"}`,
    `offer ${offer}`,
    trace.generatedAt,
  ].join(" · ");
}
