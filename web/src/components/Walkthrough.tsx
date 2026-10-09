"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { aiChecks, deliberate, replay, type Deliberation, type ModelBasis } from "@/lib/agents/orchestrate";
import { buildProfile } from "@/lib/agents/profile";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/agents/schema";
import { loadShipped, offerKey, pickShipped, replayShipped, shippedLabel, type Shipped } from "@/lib/agents/shipped";
import type { Prices } from "@/lib/agents/usage";
import { dataChecks, financialChecks, hazardChecks, summarise, vulnerabilityChecks } from "@/lib/checks";
import { termsChecks } from "@/lib/checks/terms";
import { emptyDecision, type DecisionRecord } from "@/lib/decision";
import { fmtInt, fmtKes } from "@/lib/format";
import { prepareDrainage, withDrainage, type DrainageState } from "@/lib/geo/drainageView";
import { loadGeo, type GeoLayers } from "@/lib/geo/layers";
import { detectDatasets, loadDataset, type DatasetCandidate, type FileInfo, type FileSource } from "@/lib/ingest";
import { filesFromUpload } from "@/lib/ingest/zip";
import type { LossMode } from "@/lib/model/drivers";
import { hotspotHits } from "@/lib/model/hotspots";
import { REFERENCE_PARAMS } from "@/lib/model/params";
import { runModel } from "@/lib/model/pipeline";
import { applyTerms, DEFAULT_TERMS, type InsuranceTerms } from "@/lib/model/terms";
import type { Dataset } from "@/lib/model/types";
import { loadModelFiles, pickNairobi } from "@/lib/modelData/client";
import { assumedJudgement, buildOfferFocus, isPriced, offerBrief, PORTFOLIO_KEYS, portfolioJudgement, type FocusJudgement, type OfferFocus, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import { JUDGEMENT_KEYS, type OfferJudgement } from "@/lib/offer/judgement";
import type { ExtractionRun, OfferState } from "@/lib/offer/types";
import { loadRun, runInputs, saveRun, type Active, type LogEntry, type SavedRun, type Session } from "@/lib/session";
import { STEP_IDS, STEP_NAMES, STEPS_WITH_VIEW, stepIndex, type StepId } from "@/lib/steps";
import { Dashboard, type DashboardStep } from "./dashboard/Dashboard";
import { ControlBar, type ViewMode } from "./shell/ControlBar";
import { FiguresRow } from "./shell/FiguresRow";
import { GUTTER } from "./shell/layout";
import { TopBar } from "./shell/TopBar";
import { AgentsStep } from "./steps/AgentsStep";
import { AuditStep } from "./steps/AuditStep";
import { DataStep } from "./steps/DataStep";
import { HazardStep } from "./steps/HazardStep";
import { LossStep } from "./steps/LossStep";
import { OasisStep } from "./steps/OasisStep";
import { OfferStep } from "./steps/OfferStep";
import { ResultsStep } from "./steps/ResultsStep";
import { ReplaceDataPanel } from "./steps/UploadStep";
import { VulnerabilityStep } from "./steps/VulnerabilityStep";
import { Button, Note, StatusIcon } from "./ui";

/** What /api/agents/status answers: the model, which agents have a key, and the token prices when both are set. Never a key. */
type AgentStatus = { model: string; configured: Record<Role, boolean>; prices?: Prices | null };

/** Two sets of assumptions give a portfolio building the same water: drivers 1 to 3 read PORTFOLIO_KEYS and no others. */
const sameSite = (a: OfferJudgement, b: OfferJudgement) => PORTFOLIO_KEYS.every((key) => a[key] === b[key]);
/**
 * The basis a run of the engine is made on: the header switch and the assumptions behind the loss drivers.
 * The assumptions travel as text and are read afresh for each run, so no two runs share an object.
 */
const basisOf = (mode: LossMode, assumedKey: string): ModelBasis => ({ mode, judgement: JSON.parse(assumedKey) as OfferJudgement });
/** True when a result or a saved run was worked out on this basis. Depth only reads no judgement figure, so only the mode counts there. */
const onBasis = (ran: { mode?: LossMode; judgement?: OfferJudgement } | null | undefined, basis: ModelBasis) =>
  (ran?.mode ?? "depth_only") === basis.mode && (basis.mode === "depth_only" || (!!ran?.judgement && sameSite(ran.judgement, basis.judgement)));

/** Where the loaded model data came from, in the words the header shows after the data set's name. */
interface DataOrigin {
  source: "folder" | "sample" | "upload";
  /** "from the model data folder", "from the built-in sample", "from your upload (name)". */
  from: string;
  /** Why the built-in sample had to be used. Empty for the other two. */
  reason: string;
  /** The folder's own name, the sample's, or the upload's: for the Audit step's record of the source. */
  folderName: string;
}

/** Everything one load needs, kept so "Start over" can read the same data set again. */
interface LoadRequest {
  candidate: DatasetCandidate;
  /** What the data was read from, for the sentence on the data step. */
  name: string;
  files: FileInfo[];
  origin: DataOrigin;
}

const FOLDER_ORIGIN = "from the model data folder";
const SAMPLE_ORIGIN = "from the built-in sample";
/** The name the run log files under for loading and replacing the model data. It is not a step. */
const MODEL_DATA = "Model data";

/** Where each link on the dashboard leads. The dashboard names the model's stages; the walkthrough names its steps. */
const DASHBOARD_LINKS: Record<DashboardStep, StepId> = {
  hazard: "hazard",
  vulnerability: "vulnerability",
  exposure: "data",
  financial: "loss",
  results: "results",
  agents: "agents",
  offer: "offer",
};

/**
 * A data set is named after its folder ("team_a_nairobi"). This is the name a reader sees. Only the
 * starter kit's own two folders are called the starter kit: any other data set shows its folder
 * name in words, so data brought in later is never passed off as the kit.
 */
function dataSetLabel(name: string): string {
  const kit = /^team_[a-z]_(nairobi|nzoia)$/i.exec(name.trim());
  if (kit) return `${kit[1][0].toUpperCase()}${kit[1].slice(1).toLowerCase()} starter kit`;
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unnamed data set";
}

const uploadOrigin = (name: string): DataOrigin => ({ source: "upload", from: `from your upload (${name})`, reason: "", folderName: name });

/** What every step but the Dashboard is handed besides its own props: the offer, its judgement figures, and a way to open another step. */
interface StepExtras extends OfferFocusProps {
  /** Opens another step of the walkthrough by its id from lib/steps. */
  onOpenStep: (id: StepId) => void;
}

/** What the Results and Audit steps are handed for the underwriter's decision and the note that records it. */
interface DecisionExtras {
  /** The decision as it stands: a draft until recordedAt is set. */
  decision: DecisionRecord;
  /** Where the model data came from, in the header's words, for the footer of the decision note. */
  dataSource: string;
}

/** What the Results and Audit steps are handed to name the run of the agents that sets the assumptions. */
interface RunExtras {
  /** "Saved run from 8 October 2026, model x" while the run that ships with the app sets the assumptions in force. null for the reader's own run and for the reference assumptions. */
  savedRunLabel: string | null;
}

/**
 * A step with more props than its own Props type names yet. The offer props, and a few values kept
 * here, are handed to every step that can use them; a step takes one up by adding the same name
 * and type to its own Props, optional or required, and nothing here has to change when it does.
 * Until then the step simply does not read it.
 */
const handed = <E,>() => <P,>(step: ComponentType<P>) => step as ComponentType<P & E>;

const DashboardView = handed<OfferFocusProps>()(Dashboard);
const OfferView = handed<OfferFocusProps>()(OfferStep);
const DataView = handed<StepExtras>()(DataStep);
/** The hazard maps and the risk map are one step, so it is handed what the map step took as well: the assumptions and result in force. */
const HazardView = handed<StepExtras & { active: Active }>()(HazardStep);
const AgentsView = handed<StepExtras & { prices: Prices | null }>()(AgentsStep);
const VulnerabilityView = handed<StepExtras>()(VulnerabilityStep);
const LossView = handed<StepExtras>()(LossStep);
const ResultsView = handed<StepExtras & DecisionExtras & RunExtras & { onDecision: (next: DecisionRecord) => void }>()(ResultsStep);
/** The Oasis check reads the settings in force from the result and the data set it was run on, whatever View says. */
const OasisView = handed<StepExtras & { onShowChecked: () => void }>()(OasisStep);
const AuditView = handed<StepExtras & DecisionExtras & RunExtras & { prices: Prices | null }>()(AuditStep);

const fileNameOf = (path: string) => path.split("/").pop() || path;

/** The file name out of a Content-Disposition header, or null when it carries none. */
function fileNameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // Not valid percent-encoding: fall back to the plain name.
    }
  }
  return /filename\s*=\s*"([^"]+)"/i.exec(disposition)?.[1] ?? null;
}

export function Walkthrough() {
  // The current step, as its place in STEP_IDS. Steps are told apart by id, never by this number.
  const [step, setStep] = useState(stepIndex("dashboard"));
  // The page opens by reading the model data, so the first thing on screen is that progress.
  const [busy, setBusy] = useState<string[] | null>(["Opening the model data folder"]);
  const [opening, setOpening] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; files: FileInfo[]; candidates: DatasetCandidate[]; offer: FileSource | null } | null>(null);
  const [origin, setOrigin] = useState<DataOrigin | null>(null);
  // The "Replace model data" panel, shown in place of the step while it is open.
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  // The reader's own run: made live here, replayed from this browser, or loaded from a file. While there is one, it is the run in force.
  const [ownDeliberation, setDeliberation] = useState<Deliberation | null>(null);
  // The runs that ship with the app and were made on this data set, read once it has loaded when this browser holds no run of its own.
  const [shipped, setShipped] = useState<{ dataset: Dataset; found: Shipped } | null>(null);
  // The key of the priced offer on screen, when a shipped run was made on that very offer. null leaves the shipped portfolio run to apply.
  const [shippedOfferKey, setShippedOfferKey] = useState<string | null>(null);
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [replayed, setReplayed] = useState(false);
  const [useAi, setUseAi] = useState(true);
  // Drainage-driven flooding: worked out once per dataset in the background, on by default once ready.
  const [drainage, setDrainage] = useState<{ dataset: Dataset; state: DrainageState } | null>(null);
  const [useDrainage, setUseDrainage] = useState(true);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  // True when the server could not be asked which agents have a key. A live run cannot start then either.
  const [statusFailed, setStatusFailed] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  // The offer being priced in the offer step. Kept here so it is still there after a look at another step.
  const [offer, setOffer] = useState<OfferState | null>(null);
  // The judgement figures the underwriter typed over the reference or the agents' values. Empty until one is typed.
  const [typedJudgement, setTypedJudgement] = useState<Partial<OfferJudgement>>({});
  // What the underwriter chose on the header switch. null leaves it to the app: Offer once an offer is priced, Portfolio otherwise.
  const [userMode, setUserMode] = useState<ViewMode | null>(null);
  // What a loss comes from: the depth at the point and ponding alone, or all six loss drivers. The portfolio follows the same switch.
  const [mode, setMode] = useState<LossMode>("all_drivers");
  // The underwriter's decision on the offer, recorded on the Results step and listed on the Audit step.
  const [decision, setDecision] = useState<DecisionRecord>(emptyDecision);
  // The ward map and the waterways, loaded once: the offer is placed and measured against them.
  const [geo, setGeo] = useState<GeoLayers | null>(null);
  // An offer on its way to the offer step, always as a file: from an upload of model data or the rehearsal link.
  // A new seq means a new offer, even when the file is the same one.
  const [incoming, setIncoming] = useState<{ file: File; seq: number } | null>(null);
  // The insurance terms applied after the damage model: example terms until someone edits them in the loss engine step.
  const [terms, setTerms] = useState<InsuranceTerms>(DEFAULT_TERMS);

  const note = useCallback((stepName: string, message: string) => setLog((l) => [...l, { at: new Date().toISOString(), step: stepName, message }]), []);

  useEffect(() => {
    fetch("/api/agents/status").then((r) => r.json()).then(setStatus).catch(() => {
      setStatus(null);
      setStatusFailed(true);
    });
  }, []);

  useEffect(() => {
    let live = true;
    loadGeo().then((layers) => {
      if (live) setGeo(layers);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Every change to the offer goes through here. A newly read document, or no offer at all, hands the
   * header switch back to the app, drops any judgement figure typed for the last offer and starts the
   * decision afresh. An edit to the values of the same document keeps the draft, but a decision
   * already recorded goes back to being a draft: the figures it was recorded against have moved.
   */
  const offerRun = useRef<ExtractionRun | null>(null);
  const changeOffer = useCallback((next: OfferState | null) => {
    const run = next?.run ?? null;
    if (run !== offerRun.current) {
      offerRun.current = run;
      setUserMode(null);
      setTypedJudgement({});
      setDecision(emptyDecision());
    } else {
      setDecision((d) => (d.recordedAt ? { ...d, recordedAt: null } : d));
    }
    setOffer(next);
  }, []);

  /**
   * The underwriter types over judgement figures. A figure named in `next` replaces what was typed
   * for it; one given as undefined goes back to the reference or the agents' value; an empty object
   * clears everything typed. Code keeps each figure inside its allowed range when it prices. A
   * decision already recorded goes back to being a draft, as the price it was recorded against has moved.
   */
  const changeJudgement = useCallback((next: Partial<OfferJudgement>) => {
    setTypedJudgement((typed) => {
      const named = JUDGEMENT_KEYS.filter((key) => key in next);
      if (named.length === 0) return {};
      const out = { ...typed };
      for (const key of named) {
        const value = next[key];
        if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
        else delete out[key];
      }
      return out;
    });
    setDecision((d) => (d.recordedAt ? { ...d, recordedAt: null } : d));
  }, []);

  /** The header switch between Depth only and All loss drivers. Every figure moves, so a recorded decision goes back to being a draft. */
  const changeMode = useCallback((next: LossMode) => {
    setMode(next);
    setDecision((d) => (d.recordedAt ? { ...d, recordedAt: null } : d));
  }, []);

  const stepId = STEP_IDS[step];

  const stepsRef = useRef<HTMLOListElement>(null);
  // A new step opens at its top, at once and before it paints. A smooth scroll here started from
  // wherever the last page was left, so a long page handed over to the bottom of the next one.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step]);

  useEffect(() => {
    // On a phone the steps are one row that scrolls sideways: bring the current one to the middle of it.
    const list = stepsRef.current;
    const item = list?.children[step];
    if (list && item) {
      const left = item.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
      list.scrollTo({ left: left - (list.clientWidth - item.clientWidth) / 2, behavior: "smooth" });
    }
  }, [step]);

  // The header's height changes with the text size and with how many rows the bar needs.
  // The step list sticks just below it, so the height is measured, not assumed.
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState<number | null>(null);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(() => setHeaderHeight(header.offsetHeight));
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const goTo = useCallback((i: number) => {
    setStep(i);
    setReplaceOpen(false);
    // An offer handed over is read once, on arrival. Leaving the offer step lets go of it, so coming back does not read it again.
    if (STEP_IDS[i] !== "offer") setIncoming(null);
  }, []);

  // Hands an offer to the offer step and opens that step, which reads it straight away.
  const offerSeq = useRef(0);
  const giveOffer = useCallback((file: File) => {
    offerSeq.current += 1;
    setIncoming({ file, seq: offerSeq.current });
    setReplaceOpen(false);
    setStep(stepIndex("offer"));
  }, []);

  const lastLoad = useRef<LoadRequest | null>(null);

  /** Reads one data set and lands on the Dashboard. False when it could not be read: what was loaded before then stays. */
  const load = useCallback(
    async (request: LoadRequest): Promise<boolean> => {
      const { candidate, name, files } = request;
      setError(null);
      const messages: string[] = [];
      const progress = (m: string) => {
        messages.push(m);
        setBusy([...messages]);
        note(STEP_NAMES.data, m);
      };
      try {
        progress(`Dataset: ${candidate.name}`);
        const started = performance.now();
        const { dataset, report } = await loadDataset(candidate, files, progress);
        if (dataset.buildings.length === 0) throw new Error("The exposure file has no usable rows.");
        progress("Running the model on reference assumptions");
        const reference = runModel(dataset, REFERENCE_PARAMS);
        const dChecks = dataChecks(dataset, report);
        const hChecks = hazardChecks(dataset, report);
        const next: Session = {
          uploadName: name,
          dataset,
          report,
          reference,
          dataChecks: dChecks,
          hazardChecks: hChecks,
          hits: hotspotHits(dataset),
          profile: buildProfile(dataset, report, reference, [...dChecks, ...hChecks]),
        };
        note(STEP_NAMES.data, `${fmtInt(dataset.buildings.length)} buildings, ${dataset.rasters.length} hazard maps, total insured value ${fmtKes(reference.totalTivKes)}; ${Math.round(performance.now() - started)} ms`);
        lastLoad.current = request;
        setSession(next);
        setOrigin(request.origin);
        setDrainage(null);
        prepareDrainage(dataset)
          .then((state) => {
            if (!state) return;
            setDrainage({ dataset, state });
            const row = state.sensitivity.rows.find((x) => x.reachM === 300);
            if (row) note(STEP_NAMES.hazard, `Drainage zone ready: ${row.hits} of ${dataset.hotspots.length} named flood areas flagged (terrain alone ${state.sensitivity.baseHits}), +${row.addedAreaKm2.toFixed(0)} km² flooded`);
          })
          .catch(() => setDrainage(null));
        setDeliberation(null);
        setReplayed(false);
        changeOffer(null);
        setIncoming(null);
        const stored = loadRun(next) !== null;
        setHasSaved(stored);
        // With no run of its own in this browser, the app replays the one that ships with it. Nothing waits for
        // this: with no network, or nothing shipped, the answer is null and the model stays as it is.
        setShipped(null);
        if (!stored) {
          void loadShipped(runInputs(next)).then((found) => {
            if (!found) return;
            setShipped({ dataset, found });
            if (found.runs.length > 0) setUseAi(true);
            const first = pickShipped(found.runs, null);
            if (first) note(STEP_NAMES.agents, `${shippedLabel(first.entry)}: replayed from the run saved with the app; engine re-run now`);
            const onOffers = found.runs.filter((r) => r.entry.kind === "offer").length;
            if (onOffers > 0) note(STEP_NAMES.agents, `${onOffers} saved ${onOffers === 1 ? "run" : "runs"} made on an offer ${onOffers === 1 ? "ships" : "ship"} with the app, replayed while that offer is the one priced`);
            if (found.otherData) note(STEP_NAMES.agents, "The run saved with the app was made on different model data, so it is not replayed");
          });
        }
        setBusy(null);
        setReplaceOpen(false);
        setStep(stepIndex("dashboard"));
        return true;
      } catch (e) {
        setBusy(null);
        setError(`Could not read the dataset: ${(e as Error).message}`);
        note(STEP_NAMES.data, `Failed: ${(e as Error).message}`);
        return false;
      }
    },
    [note, changeOffer],
  );

  /** First load: the Nairobi set from the model data folder, or from the built-in sample when the folder cannot be read. */
  const loadModel = useCallback(async (): Promise<boolean> => {
    setError(null);
    setUpload(null);
    setOpening(true);
    setBusy(["Opening the model data folder"]);
    try {
      const loaded = await loadModelFiles();
      const fromFolder = loaded.source === "folder";
      note(MODEL_DATA, fromFolder ? `Model data folder: ${loaded.files.length} files` : `The built-in sample is in use. ${loaded.reason}`);
      const found = await detectDatasets(loaded.files, loaded.folderName);
      const candidate = pickNairobi(found.candidates);
      if (!candidate) {
        setBusy(null);
        setError(
          `No data set was found in ${fromFolder ? "the model data folder" : "the built-in sample"}. It needs an exposure CSV (with lat, lon and tiv_kes columns) and hazard maps named by tier or return period.${loaded.reason ? ` ${loaded.reason}` : ""}`,
        );
        return false;
      }
      return await load({
        candidate,
        name: fromFolder ? "the model data folder" : "the built-in sample (sample-data.zip)",
        files: found.files,
        origin: { source: loaded.source, from: fromFolder ? FOLDER_ORIGIN : SAMPLE_ORIGIN, reason: loaded.reason, folderName: loaded.folderName },
      });
    } catch (e) {
      setBusy(null);
      setError(`The model data could not be loaded. ${(e as Error).message}`);
      note(MODEL_DATA, `Failed: ${(e as Error).message}`);
      return false;
    } finally {
      setOpening(false);
    }
  }, [load, note]);

  /** An offer found inside an upload goes to the offer step as a file, as if it had been chosen there. */
  const handOffer = useCallback(
    async (source: FileSource) => {
      try {
        const name = fileNameOf(source.path);
        giveOffer(new File([await source.arrayBuffer()], name));
        note(MODEL_DATA, `${name} is an offer: handed to the ${STEP_NAMES.offer} step`);
      } catch (e) {
        setError(`The offer in the upload could not be opened: ${(e as Error).message}`);
      }
    },
    [giveOffer, note],
  );

  const hasModel = session !== null;
  /** The "Replace model data" path: a zip, or loose files. An offer among them is handed on once the data set has loaded. */
  const handleFiles = useCallback(
    async (list: File[]) => {
      setError(null);
      setUpload(null);
      setReplaceOpen(true);
      setBusy(["Opening the upload"]);
      try {
        const { name, files } = await filesFromUpload(list);
        note(MODEL_DATA, `${name}: ${files.length} files`);
        const found = await detectDatasets(files, name);
        const offerFile = found.offers[0] ?? null;
        if (found.candidates.length === 0) {
          setBusy(null);
          // An offer on its own replaces nothing: it is priced against the model already loaded.
          if (offerFile && hasModel) await handOffer(offerFile);
          else if (offerFile) setError("This upload holds an offer but no model data, and no model is loaded to price it against. Load the model data first.");
          else setError("No dataset found. The upload needs an exposure CSV (with lat, lon and tiv_kes columns) and hazard maps named by tier or return period.");
          return;
        }
        setUpload({ name, files: found.files, candidates: found.candidates, offer: offerFile });
        if (found.candidates.length === 1) {
          const ok = await load({ candidate: found.candidates[0], name, files: found.files, origin: uploadOrigin(name) });
          if (ok && offerFile) await handOffer(offerFile);
        } else {
          setBusy(null);
        }
      } catch (e) {
        setBusy(null);
        setError(`Could not open the upload: ${(e as Error).message}`);
      }
    },
    [load, note, handOffer, hasModel],
  );

  /** One data set chosen from an upload that holds several. */
  const pickCandidate = async (candidate: DatasetCandidate) => {
    if (!upload) return;
    const ok = await load({ candidate, name: upload.name, files: upload.files, origin: uploadOrigin(upload.name) });
    if (ok && upload.offer) await handOffer(upload.offer);
  };

  /** Rehearsal: the Nairobi test offer, read in place by the server when the test data sits beside the model data. */
  const openTestOffer = useCallback(async () => {
    try {
      const res = await fetch("/api/test-offer", { cache: "no-store" });
      if (res.ok) {
        const name = fileNameFrom(res.headers.get("Content-Disposition")) ?? "test-offer.docx";
        giveOffer(new File([await res.blob()], name, { type: res.headers.get("Content-Type") ?? "" }));
        return;
      }
    } catch {
      // No test offer to be had: the step opens empty, as it does when the server answers 404.
    }
    goTo(stepIndex("offer"));
  }, [giveOffer, goTo]);

  // The model loads by itself on first load. Rehearsal shortcuts: /?step=4 opens that step once the model has
  // loaded, and /?offer=1 opens the offer step with the Nairobi test offer. /?sample=1 is an old link and changes nothing.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const query = new URLSearchParams(window.location.search);
    loadModel().then(async (ok) => {
      if (!ok) return;
      if (query.get("offer") === "1") {
        await openTestOffer();
        return;
      }
      const asked = (query.get("step") ?? "").trim();
      const target = asked === "" ? NaN : Number(asked);
      if (Number.isInteger(target) && target >= 0 && target < STEP_IDS.length) goTo(target);
    });
    // Runs once on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The run that ships with the app, for the data on screen: the one made on the priced offer when there is one,
  // otherwise the portfolio run. Its replies are re-scored by code here, on the basis it was made with; the
  // views below re-run it on whatever basis is shown, as they do for any run.
  const shippedHere = session && shipped && shipped.dataset === session.dataset ? shipped.found : null;
  const shippedRun = useMemo(() => (shippedHere ? pickShipped(shippedHere.runs, shippedOfferKey) : null), [shippedHere, shippedOfferKey]);
  const shippedDeliberation = useMemo(() => (session && shippedRun ? replayShipped(session.dataset, shippedRun.run) : null), [session, shippedRun]);
  // The run in force: the reader's own once there is one, otherwise the shipped run.
  const deliberation = ownDeliberation ?? shippedDeliberation;
  const shippedInForce = !ownDeliberation && shippedDeliberation ? shippedRun : null;

  // The assumptions behind the loss drivers that the portfolio's buildings are run with: the reference values, the
  // agents' agreed figures while "Agreed by agents" is on and an offer is on screen, and anything typed over them.
  // Held as text, so a new copy of the same figures does not run the model again.
  const assumedKey = JSON.stringify(assumedJudgement(useAi && offer ? deliberation?.offerJudgement?.final : null, typedJudgement));
  // The same without the agents: the reference values and anything typed over them. The reference run is made on
  // these, so "without AI" never carries a figure the agents set, and their buffer counts as part of what they change.
  const referenceKey = JSON.stringify(assumedJudgement(null, typedJudgement));

  const runAgents = async () => {
    if (!session) return;
    // With a priced offer loaded the agents are also given its flood facts, and argue the assumptions behind its
    // loss drivers beside the model's parameters. With none they work exactly as before. Either way the engine
    // scores their proposals on the basis the screen shows: the mode of the header switch and the judgement in force.
    const brief = pricedFocus ? offerBrief(pricedFocus) : null;
    setAgentsBusy(true);
    setReplayed(false);
    note(STEP_NAMES.agents, `Round 1 started: Optimist, Cautious and Critic in parallel${brief ? ", with the facts of the offer" : ""}`);
    // The run carries what it was made on, so a file saved from it says so (scripts/pack-run.mjs reads it).
    const inputs = runInputs(session);
    const d = await deliberate(
      session.dataset,
      session.profile,
      (update) => {
        const made: SavedRun = { ...update, inputs };
        setDeliberation(made);
      },
      brief,
      basisOf(mode, assumedKey),
    );
    for (const role of ROLES) {
      const run = d.runs[role];
      note(STEP_NAMES.agents, `${ROLE_LABELS[role]}: ${run.status === "done" ? `valid reply in ${((run.ms ?? 0) / 1000).toFixed(1)} s` : `no valid reply (${run.error ?? run.status})`}`);
    }
    if (brief) note(STEP_NAMES.agents, d.offerJudgement?.final ? "The assumptions behind the offer's loss drivers were agreed and applied to its price" : "No agreed assumptions for the offer's loss drivers. Its price stays on the reference figures.");
    if (d.final) {
      saveRun(session, d);
      setHasSaved(true);
      setUseAi(true);
      note(STEP_NAMES.agents, `Agreed assumptions applied; result fingerprint ${d.fingerprint}`);
    } else {
      note(STEP_NAMES.agents, "No agreed set. The model stays on reference assumptions.");
    }
    setAgentsBusy(false);
  };

  const applySaved = (saved: Deliberation, source: string) => {
    if (!session) return;
    const d = replay(session.dataset, saved, basisOf(mode, assumedKey));
    setDeliberation(d);
    setReplayed(true);
    setUseAi(true);
    note(STEP_NAMES.agents, `${source}: agent replies from ${saved.startedAt}; engine re-run now`);
  };

  /** Back to the run that ships with the app, after the reader's own run took over. */
  const backToShipped = () => {
    setDeliberation(null);
    setReplayed(false);
    setUseAi(true);
  };

  // What every step shows: the loaded dataset, with drainage-driven flooding added when it is switched on.
  const drainageOn = !!session && useDrainage && !!drainage && drainage.dataset === session.dataset;
  const viewData = useMemo(() => {
    if (!session) return null;
    if (!drainageOn || !drainage) return { dataset: session.dataset, hits: session.hits, hazardChecks: session.hazardChecks };
    const dataset = withDrainage(session.dataset, drainage.state);
    return { dataset, hits: hotspotHits(dataset), hazardChecks: hazardChecks(dataset, session.report) };
  }, [session, drainage, drainageOn]);
  // The reference run follows the switch too, on the figures no agent set. Depth only on the terrain maps is the run made when the data was loaded.
  const view = useMemo<Session | null>(() => {
    if (!session || !viewData) return null;
    const reference = mode === "depth_only" && viewData.dataset === session.dataset ? session.reference : runModel(viewData.dataset, REFERENCE_PARAMS, basisOf(mode, referenceKey));
    return { ...session, ...viewData, reference };
  }, [session, viewData, mode, referenceKey]);

  // The agents decide on the terrain-only data, on the basis in force when they ran. Their assumptions are
  // re-run on whichever view and basis is shown now, without calling any model.
  const viewDeliberation = useMemo<Deliberation | null>(() => {
    if (!deliberation || !view) return deliberation;
    const basis = basisOf(mode, assumedKey);
    return drainageOn || !onBasis(deliberation.basis, basis) ? replay(view.dataset, deliberation, basis) : deliberation;
  }, [deliberation, view, drainageOn, mode, assumedKey]);

  const assumptions = useMemo<Active | null>(() => {
    if (!view) return null;
    if (useAi && viewDeliberation?.final) return { source: "ai", params: viewDeliberation.final.params, result: viewDeliberation.final.result };
    return { source: "reference", params: REFERENCE_PARAMS, result: view.reference };
  }, [view, viewDeliberation, useAi]);

  // One picture of the offer, worked out once and handed to every step: located, priced and checked by
  // code on the maps, the flood source, the mode, the assumptions, the judgement figures and the terms in
  // force. null when no offer is read. The agents' judgement figures travel inside the deliberation, and the
  // focus uses them only when they were argued for the offer now on screen.
  const drainageInForce = drainageOn && drainage ? drainage.state : null;
  const layers = useMemo(() => (geo ? { wards: geo.wards, waterways: geo.waterways } : null), [geo]);
  const offerFocus = useMemo(
    () => (view && assumptions ? buildOfferFocus({ offer, session: view, active: assumptions, drainage: drainageInForce, policyDefaults: terms, deliberation: viewDeliberation, layers, mode, judgement: typedJudgement }) : null),
    [offer, view, assumptions, drainageInForce, terms, viewDeliberation, layers, mode, typedJudgement],
  );
  // The judgement figures in force and who set each: the offer's, or the portfolio's own when no offer is read.
  const ownJudgement = useMemo(() => portfolioJudgement(typedJudgement), [typedJudgement]);
  const judgement: FocusJudgement = offerFocus?.judgement ?? ownJudgement;
  // The same held as text: what the portfolio is run with once the offer has settled whose figures count.
  const settledKey = JSON.stringify(judgement.assumed);

  // The offer settles whose judgement figures count: when the agents argued another offer theirs are left out.
  // Each of the agents' sets is then shown on the settled figures, so it is measured the same way as the offer.
  // Nearly always that is the run made above. The reference run stays as it is: it never holds an agents' figure.
  const shownDeliberation = useMemo<Deliberation | null>(() => {
    if (!viewDeliberation || !view) return viewDeliberation;
    const basis = basisOf(mode, settledKey);
    return onBasis(viewDeliberation.basis, basis) ? viewDeliberation : replay(view.dataset, viewDeliberation, basis);
  }, [viewDeliberation, view, mode, settledKey]);

  // The assumptions in force and the portfolio's result under them, on the settled figures.
  const active = useMemo<Active | null>(() => {
    if (!view || !assumptions) return null;
    if (assumptions.source === "ai" && shownDeliberation?.final) return { source: "ai", params: shownDeliberation.final.params, result: shownDeliberation.final.result };
    return { source: "reference", params: REFERENCE_PARAMS, result: view.reference };
  }, [view, shownDeliberation, assumptions]);

  // The same assumptions on terrain flooding alone, for the "what drainage adds" comparison.
  const terrainResult = useMemo(() => {
    if (!session || !active || !drainageOn) return null;
    const ready = active.source === "ai" ? deliberation?.final?.result : session.reference;
    const basis = basisOf(mode, settledKey);
    return ready && onBasis(ready, basis) ? ready : runModel(session.dataset, active.params, basis);
  }, [session, active, drainageOn, deliberation, mode, settledKey]);

  // Ground-up losses taken through the policy terms and the reinsurance: gross and net for every event.
  const termsResult = useMemo(() => (view && active ? applyTerms(view.dataset, active.result, terms) : null), [view, active, terms]);

  // Offer mode needs a priced offer. Until there is one, and whenever the underwriter chooses it, every step shows the portfolio.
  const pricedFocus: PricedFocus | null = isPriced(offerFocus) ? offerFocus : null;
  const viewMode: ViewMode = pricedFocus && userMode !== "portfolio" ? "offer" : "portfolio";
  const focus = viewMode === "offer" ? pricedFocus : null;
  // The same props for every step: `focus` in Offer mode only, `offerFocus` whatever the mode, the mode of
  // the loss drivers, and the judgement figures in force with the way to type over them.
  const follow: OfferFocusProps = { focus, offerFocus, mode, judgement, onJudgement: changeJudgement };
  const prices = status?.prices ?? null;

  // A shipped run made on an offer is used for that offer alone. The offer's key comes from its facts, which no
  // run of the agents moves, so this settles in one pass: when the key on screen changes, the render starts again
  // with the right shipped run before anything is shown. With no shipped offer run nothing is worked out here.
  const shippedOffers = useMemo(() => (shippedHere?.runs ?? []).flatMap((r) => (r.entry.offerKey ? [r.entry.offerKey] : [])), [shippedHere]);
  const offerKeyOnScreen = useMemo(() => (shippedOffers.length > 0 && pricedFocus ? offerKey(offerBrief(pricedFocus)) : null), [shippedOffers, pricedFocus]);
  const wantedOfferKey = offerKeyOnScreen !== null && shippedOffers.includes(offerKeyOnScreen) ? offerKeyOnScreen : null;
  if (wantedOfferKey !== shippedOfferKey) setShippedOfferKey(wantedOfferKey);

  // How the shipped run is named while it is the run in force, and the same for the steps that say who set the assumptions.
  const shippedName = shippedInForce ? shippedLabel(shippedInForce.entry) : null;
  const savedRunLabel = active?.source === "ai" ? shippedName : null;

  const checks = useMemo(() => {
    if (!session || !view || !active || !termsResult) return { ai: [], vulnerability: [], financial: [], all: [] };
    // The agents are checked on the data they decided on. Their saved fingerprint belongs to that
    // run, so re-running the engine on the drainage view would never match it.
    const ai = deliberation && !agentsBusy ? aiChecks(session.dataset, deliberation) : [];
    const vulnerability = vulnerabilityChecks(active.params);
    // financialChecks ends with driverChecks (lib/checks/drivers.ts): the split by loss driver, read back from the result.
    const financial = [...financialChecks(view.dataset, active.result), ...termsChecks(termsResult)];
    return { ai, vulnerability, financial, all: [...view.dataChecks, ...view.hazardChecks, ...ai, ...vulnerability, ...financial] };
  }, [session, view, active, termsResult, deliberation, agentsBusy]);

  /** Start over: the agents' run, the offer, the terms and the log are dropped, and the same data set is read again. */
  const reset = () => {
    setStep(stepIndex("dashboard"));
    setSession(null);
    setOrigin(null);
    setUpload(null);
    setReplaceOpen(false);
    setDeliberation(null);
    setDrainage(null);
    changeOffer(null);
    setIncoming(null);
    setTerms(DEFAULT_TERMS);
    setError(null);
    setLog([]);
    const again = lastLoad.current;
    if (again) {
      setOpening(true);
      void load(again).finally(() => setOpening(false));
    } else {
      void loadModel();
    }
  };

  const openReplace = () => {
    setError(null);
    setUpload(null);
    setReplaceOpen(true);
  };

  // The offer's own checks count too, whenever the Audit step lists them: in Offer mode, and for an offer that could not be priced.
  const auditedOffer: OfferFocus | null = focus ?? (offerFocus && offerFocus.status !== "locating" && !pricedFocus ? offerFocus : null);
  const totals = summarise([...checks.all, ...(auditedOffer?.checks ?? [])]);
  // Until a model is on screen the panel stands in for every step: it shows the first load, and what went wrong with it.
  const showPanel = !session || replaceOpen;
  // The step on screen, for the header: its name in the top bar, and whether the control bar offers the View switch. null while the panel stands in.
  const shownStep: StepId | null = showPanel ? null : stepId;
  const showView = shownStep !== null && STEPS_WITH_VIEW.includes(shownStep);
  // A step without the View switch reads the same whatever it says, so the figures row shows the priced offer there and never disagrees with the page.
  const figuresFocus = showView ? focus : pricedFocus;
  const nextId: StepId | undefined = STEP_IDS[step + 1];
  const modelDataLine = session && origin ? `${dataSetLabel(session.dataset.name)}, ${origin.from}` : opening || busy ? "Opening" : "None loaded";
  const openStep = (id: StepId) => goTo(stepIndex(id));
  // Oasis was run on the reference assumptions; with all loss drivers it was run with drainage on.
  const showOasisChecked = () => {
    setUseAi(false);
    if (mode === "all_drivers") setUseDrainage(true);
  };

  return (
    <div
      className="flex min-h-screen w-full flex-col"
      style={headerHeight != null ? ({ "--header-height": `${headerHeight}px` } as CSSProperties) : undefined}
    >
      <header ref={headerRef} className="z-20 lg:sticky lg:top-0">
        <TopBar step={shownStep} />
        <div className="h-[3px] bg-brand" />
        <ControlBar
          loaded={!!session}
          showView={showView}
          viewMode={viewMode}
          onViewMode={setUserMode}
          offerFocus={offerFocus}
          mode={mode}
          onMode={changeMode}
          drainage={session && drainage && drainage.dataset === session.dataset ? useDrainage : null}
          onDrainage={setUseDrainage}
          useAi={deliberation?.final ? useAi : null}
          onUseAi={setUseAi}
          dataLine={modelDataLine}
          dataReason={origin?.reason ?? ""}
          hazardKind={session?.dataset.hazardKind ?? null}
          onReplaceData={openReplace}
        />
        {view && active && <FiguresRow focus={figuresFocus} offerFocus={offerFocus} active={active} buildings={view.dataset.buildings.length} tivRatio={view.report.tivRatio?.median} />}
      </header>

      <div className={`${GUTTER} flex flex-1 flex-col gap-6 py-6 lg:flex-row lg:gap-8 2xl:gap-10`}>
        {/* Stuck just below the header and never taller than the room between it and the Back and Next bar:
            on a short screen at the larger sizes the list scrolls inside itself instead of running off the bottom. */}
        <nav
          aria-label="Steps"
          className="lg:sticky lg:top-[calc(var(--header-height,9rem)+1rem)] lg:h-fit lg:max-h-[calc(100dvh-var(--header-height,9rem)-5.25rem)] lg:w-44 lg:shrink-0 lg:overflow-y-auto 2xl:w-52 lg:scrollbar-thin"
        >
          <ol ref={stepsRef} className="flex gap-1 overflow-x-auto lg:flex-col">
            {STEP_IDS.map((id, i) => {
              // Every step is open once the model has loaded; before that there is nothing for a step to show.
              const locked = !session;
              const current = id === stepId && !showPanel;
              return (
                <li key={id}>
                  <button
                    disabled={locked}
                    onClick={() => goTo(i)}
                    aria-current={current ? "step" : undefined}
                    className={`flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm transition ${current ? "bg-surface font-semibold text-ink shadow-sm ring-1 ring-line" : locked ? "text-muted" : "text-ink-2 hover:bg-surface"}`}
                  >
                    <span className={`tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${current ? "bg-brand text-white" : locked ? "border border-line text-muted" : "bg-surface-2 text-ink-2"}`}>{i}</span>
                    {STEP_NAMES[id]}
                  </button>
                </li>
              );
            })}
          </ol>
          {session && (
            <div className="mt-4 hidden rounded-xl border border-line bg-surface p-3 text-xs leading-relaxed text-ink-2 lg:block">
              <div className="mb-1 font-semibold text-ink">Checks so far</div>
              <div className="flex items-center gap-1.5"><StatusIcon status="pass" size={13} /> {totals.pass} passed</div>
              <div className="flex items-center gap-1.5"><StatusIcon status="warn" size={13} /> {totals.warn} warnings</div>
              <div className="flex items-center gap-1.5"><StatusIcon status="fail" size={13} /> {totals.fail} failed</div>
            </div>
          )}
        </nav>

        {/* A container, so a step can lay itself out by the room it really has (the @ variants, measured in rem
            of the chosen text size) and not by the width of the screen. */}
        <main className="@container min-w-0 flex-1 pb-28">
          <AnimatePresence mode="wait">
            <motion.div key={showPanel ? "model-data" : stepId} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.28, ease: "easeOut" }}>
              {showPanel && (
                <ReplaceDataPanel
                  busy={busy}
                  error={error}
                  candidates={upload?.candidates ?? null}
                  opening={opening && !session}
                  onFiles={handleFiles}
                  onPick={pickCandidate}
                  onCancel={session ? () => { setReplaceOpen(false); setError(null); setUpload(null); } : undefined}
                />
              )}
              {!showPanel && session && view && active && termsResult && (
                <>
                  {origin?.source === "sample" && (stepId === "dashboard" || stepId === "data") && (
                    <div className="mb-6">
                      <Note tone="warn">
                        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                          <span className="min-w-0">
                            <strong className="font-semibold text-ink">The built-in sample is in use, not the model data folder.</strong> {origin.reason}
                          </span>
                          <Button variant="secondary" className="whitespace-nowrap" onClick={openReplace}>Replace model data</Button>
                        </div>
                      </Note>
                    </div>
                  )}
                  {stepId === "dashboard" && (
                    <DashboardView
                      session={view}
                      active={active}
                      terms={termsResult}
                      deliberation={shownDeliberation}
                      checks={checks.all}
                      drainageOn={drainageOn}
                      decision={decision}
                      onOpenStep={(target) => openStep(DASHBOARD_LINKS[target])}
                      {...follow}
                    />
                  )}
                  {stepId === "offer" && (
                    <OfferView
                      session={view}
                      modelReady={status ? status.configured.chair : null}
                      offer={offer}
                      onOffer={changeOffer}
                      onLog={(message) => note(STEP_NAMES.offer, message)}
                      incoming={incoming}
                      {...follow}
                      offerFocus={offerFocus}
                      onOpenStep={openStep}
                    />
                  )}
                  {stepId === "data" && <DataView session={view} {...follow} onOpenStep={openStep} />}
                  {/* The hazard maps and the risk map are one step. It is handed everything the map step took (session, active) as well. */}
                  {stepId === "hazard" && (
                    <HazardView
                      session={view}
                      active={active}
                      drainage={session.dataset.hazardKind === "score" ? { state: drainage && drainage.dataset === session.dataset ? drainage.state : null, enabled: useDrainage } : undefined}
                      {...follow}
                      onOpenStep={openStep}
                    />
                  )}
                  {stepId === "agents" && (
                    <AgentsView
                      session={view}
                      deliberation={shownDeliberation}
                      busy={agentsBusy}
                      checks={checks.ai}
                      status={status}
                      hasSaved={hasSaved}
                      replayed={replayed}
                      shippedLabel={shippedName}
                      shippedKind={shippedInForce?.entry.kind ?? null}
                      shippedCorrections={shippedInForce?.entry.corrections ?? null}
                      shippedOtherData={shippedHere?.otherData ?? false}
                      statusFailed={statusFailed}
                      onShipped={ownDeliberation && shippedDeliberation ? backToShipped : undefined}
                      onRun={runAgents}
                      onReplay={() => { const saved = loadRun(session); if (saved) applySaved(saved, "Replayed the saved run"); }}
                      onImport={async (file) => {
                        try {
                          applySaved(JSON.parse(await file.text()) as Deliberation, `Loaded ${file.name}`);
                        } catch {
                          note(STEP_NAMES.agents, `Could not read ${file.name} as a saved run`);
                        }
                      }}
                      prices={prices}
                      {...follow}
                      onOpenStep={openStep}
                    />
                  )}
                  {stepId === "vulnerability" && <VulnerabilityView session={view} active={active} checks={checks.vulnerability} {...follow} onOpenStep={openStep} />}
                  {stepId === "loss" && <LossView session={view} active={active} checks={checks.financial} terms={termsResult} onTermsChange={setTerms} {...follow} onOpenStep={openStep} />}
                  {stepId === "results" && (
                    <ResultsView
                      session={view}
                      active={active}
                      deliberation={shownDeliberation}
                      engineSession={session}
                      terrainResult={terrainResult}
                      terms={termsResult}
                      decision={decision}
                      onDecision={setDecision}
                      dataSource={modelDataLine}
                      savedRunLabel={savedRunLabel}
                      {...follow}
                      onOpenStep={openStep}
                    />
                  )}
                  {stepId === "oasis" && <OasisView session={view} active={active} {...follow} onOpenStep={openStep} onShowChecked={showOasisChecked} />}
                  {stepId === "audit" && (
                    <AuditView
                      session={view}
                      active={active}
                      deliberation={shownDeliberation}
                      checks={checks.all}
                      log={log}
                      terms={termsResult}
                      modelSource={origin && origin.source !== "upload" ? { source: origin.source, folderName: origin.folderName, reason: origin.reason || null } : undefined}
                      prices={prices}
                      decision={decision}
                      dataSource={modelDataLine}
                      savedRunLabel={savedRunLabel}
                      {...follow}
                      onOpenStep={openStep}
                    />
                  )}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {session && !showPanel && (
        <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-plane/90 backdrop-blur">
          {/* On a phone at the larger sizes the three buttons do not fit side by side: Next drops to a second row instead of breaking its label. */}
          <div className={`${GUTTER} flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3`}>
            <div className="flex items-center gap-2">
              <Button variant="secondary" className="whitespace-nowrap" onClick={() => goTo(step - 1)} disabled={step === 0}>Back</Button>
              <Button variant="ghost" className="whitespace-nowrap" onClick={reset}>Start over</Button>
            </div>
            <div className="ml-auto flex items-center gap-3">
              {stepId === "agents" && !deliberation?.final && !agentsBusy && <span className="hidden text-xs text-muted sm:inline">Continuing without the agents uses reference assumptions{pricedFocus ? ", for the model and for the offer's price" : ""}.</span>}
              {nextId && (
                <Button className="whitespace-nowrap" onClick={() => goTo(step + 1)} disabled={agentsBusy}>
                  Next: {STEP_NAMES[nextId]}
                </Button>
              )}
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
