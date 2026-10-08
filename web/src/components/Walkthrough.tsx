"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { aiChecks, deliberate, replay, type Deliberation } from "@/lib/agents/orchestrate";
import { buildProfile } from "@/lib/agents/profile";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/agents/schema";
import type { Prices } from "@/lib/agents/usage";
import { dataChecks, financialChecks, hazardChecks, summarise, vulnerabilityChecks } from "@/lib/checks";
import { termsChecks } from "@/lib/checks/terms";
import { emptyDecision, type DecisionRecord } from "@/lib/decision";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { prepareDrainage, withDrainage, type DrainageState } from "@/lib/geo/drainageView";
import { loadGeo, type GeoLayers } from "@/lib/geo/layers";
import { detectDatasets, loadDataset, type DatasetCandidate, type FileInfo, type FileSource } from "@/lib/ingest";
import { filesFromUpload } from "@/lib/ingest/zip";
import { kes1 } from "@/lib/labels";
import { hotspotHits } from "@/lib/model/hotspots";
import { REFERENCE_PARAMS } from "@/lib/model/params";
import { runModel } from "@/lib/model/pipeline";
import { applyTerms, DEFAULT_TERMS, type InsuranceTerms } from "@/lib/model/terms";
import type { Dataset } from "@/lib/model/types";
import { loadModelFiles, pickNairobi } from "@/lib/modelData/client";
import { buildOfferFocus, isPriced, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import type { ExtractionRun, OfferState } from "@/lib/offer/types";
import { loadRun, saveRun, type Active, type LogEntry, type Session } from "@/lib/session";
import { STEP_IDS, STEP_NAMES, stepIndex, type StepId } from "@/lib/steps";
import { Dashboard, type DashboardStep } from "./dashboard/Dashboard";
import { OfferDropCard } from "./dashboard/OfferDropCard";
import { DisplayControls } from "./DisplayControls";
import { AgentsStep } from "./steps/AgentsStep";
import { AuditStep } from "./steps/AuditStep";
import { DataStep } from "./steps/DataStep";
import { HazardStep } from "./steps/HazardStep";
import { LossStep } from "./steps/LossStep";
import { OfferStep } from "./steps/OfferStep";
import { ResultsStep } from "./steps/ResultsStep";
import { ReplaceDataPanel } from "./steps/UploadStep";
import { VulnerabilityStep } from "./steps/VulnerabilityStep";
import { Button, Note, Segmented, StatusIcon, Tag } from "./ui";

/** What /api/agents/status answers: the model, which agents have a key, and the token prices when both are set. Never a key. */
type AgentStatus = { model: string; configured: Record<Role, boolean>; prices?: Prices | null };

/** Which view every step shows: the priced offer's building, or the whole portfolio as before. */
type Mode = "offer" | "portfolio";

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

/** A data set is named after its folder ("team_a_nairobi"). This is the name a reader sees. */
function dataSetLabel(name: string): string {
  const place = /nairobi/i.test(name) ? "Nairobi" : /nzoia/i.test(name) ? "Nzoia" : null;
  if (place) return `${place} starter kit`;
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Unnamed data set";
}

const uploadOrigin = (name: string): DataOrigin => ({ source: "upload", from: `from your upload (${name})`, reason: "", folderName: name });

/** What every step but the Dashboard is handed besides its own props: the offer, and a way to open another step. */
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

/**
 * A step with more props than its own Props type names yet. The offer props, and a few values kept
 * here, are handed to every step that can use them; a step takes one up by adding the same name
 * and type to its own Props, optional or required, and nothing here has to change when it does.
 * Until then the step simply does not read it.
 */
const handed = <E,>() => <P,>(step: ComponentType<P>) => step as ComponentType<P & E>;

const DashboardView = handed<OfferFocusProps>()(Dashboard);
const DataView = handed<StepExtras>()(DataStep);
/** The hazard maps and the risk map are one step, so it is handed what the map step took as well: the assumptions and result in force. */
const HazardView = handed<StepExtras & { active: Active }>()(HazardStep);
const AgentsView = handed<StepExtras & { prices: Prices | null }>()(AgentsStep);
const VulnerabilityView = handed<StepExtras>()(VulnerabilityStep);
const LossView = handed<StepExtras>()(LossStep);
const ResultsView = handed<StepExtras & DecisionExtras & { onDecision: (next: DecisionRecord) => void }>()(ResultsStep);
const AuditView = handed<StepExtras & DecisionExtras & { prices: Prices | null }>()(AuditStep);

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

// The page's side gutters, shared by the header bar, the key figures, the content and the Back and Next bar
// so their edges line up. Backgrounds run the full width of the screen; only the contents take the gutters.
// The cap is for very wide monitors, and is in rem so it widens with the text size.
const GUTTER = "mx-auto w-full max-w-[120rem] px-4 sm:px-6 2xl:px-10";
/** The small word in front of a group of controls on the navy bar, so nobody has to guess what a switch is for. */
const CAPTION = "text-xs font-medium uppercase tracking-wide text-white/65";
/** A button on the navy bar, drawn in white like the display controls beside it. */
const BAR_BUTTON =
  "whitespace-nowrap rounded-full border border-white/30 px-3 py-1 text-sm font-medium text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

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
  const [deliberation, setDeliberation] = useState<Deliberation | null>(null);
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [replayed, setReplayed] = useState(false);
  const [useAi, setUseAi] = useState(true);
  // Drainage-driven flooding: worked out once per dataset in the background, on by default once ready.
  const [drainage, setDrainage] = useState<{ dataset: Dataset; state: DrainageState } | null>(null);
  const [useDrainage, setUseDrainage] = useState(true);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [hasSaved, setHasSaved] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  // The offer being priced in the offer step. Kept here so it is still there after a look at another step.
  const [offer, setOffer] = useState<OfferState | null>(null);
  // What the underwriter chose on the header switch. null leaves it to the app: Offer once an offer is priced, Portfolio otherwise.
  const [userMode, setUserMode] = useState<Mode | null>(null);
  // The underwriter's decision on the offer, recorded on the Results step and listed on the Audit step.
  const [decision, setDecision] = useState<DecisionRecord>(emptyDecision);
  // The ward map and the waterways, loaded once: the offer is placed and measured against them.
  const [geo, setGeo] = useState<GeoLayers | null>(null);
  // An offer on its way to the offer step: from the dashboard card, an upload or the rehearsal link.
  // A new seq means a new offer, even when the file is the same one.
  const [incoming, setIncoming] = useState<{ file?: File; text?: string; seq: number } | null>(null);
  // The insurance terms applied after the damage model: example terms until someone edits them in the loss engine step.
  const [terms, setTerms] = useState<InsuranceTerms>(DEFAULT_TERMS);

  const note = useCallback((stepName: string, message: string) => setLog((l) => [...l, { at: new Date().toISOString(), step: stepName, message }]), []);

  useEffect(() => {
    fetch("/api/agents/status").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
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
   * header switch back to the app and starts the decision afresh. An edit to the values of the same
   * document keeps the draft, but a decision already recorded goes back to being a draft: the
   * figures it was recorded against have moved.
   */
  const offerRun = useRef<ExtractionRun | null>(null);
  const changeOffer = useCallback((next: OfferState | null) => {
    const run = next?.run ?? null;
    if (run !== offerRun.current) {
      offerRun.current = run;
      setUserMode(null);
      setDecision(emptyDecision());
    } else {
      setDecision((d) => (d.recordedAt ? { ...d, recordedAt: null } : d));
    }
    setOffer(next);
  }, []);

  const stepId = STEP_IDS[step];

  const stepsRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  const giveOffer = useCallback((input: { file?: File; text?: string }) => {
    offerSeq.current += 1;
    setIncoming({ ...input, seq: offerSeq.current });
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
        setHasSaved(loadRun(next) !== null);
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
        giveOffer({ file: new File([await source.arrayBuffer()], name) });
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
        giveOffer({ file: new File([await res.blob()], name, { type: res.headers.get("Content-Type") ?? "" }) });
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

  const runAgents = async () => {
    if (!session) return;
    setAgentsBusy(true);
    setReplayed(false);
    note(STEP_NAMES.agents, "Round 1 started: Optimist, Cautious and Critic in parallel");
    const d = await deliberate(session.dataset, session.profile, setDeliberation);
    for (const role of ROLES) {
      const run = d.runs[role];
      note(STEP_NAMES.agents, `${ROLE_LABELS[role]}: ${run.status === "done" ? `valid reply in ${((run.ms ?? 0) / 1000).toFixed(1)} s` : `no valid reply (${run.error ?? run.status})`}`);
    }
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
    const d = replay(session.dataset, saved);
    setDeliberation(d);
    setReplayed(true);
    setUseAi(true);
    note(STEP_NAMES.agents, `${source}: agent replies from ${saved.startedAt}; engine re-run now`);
  };

  // What every step shows: the loaded dataset, with drainage-driven flooding added when it is switched on.
  const view = useMemo<Session | null>(() => {
    if (!session) return null;
    if (!useDrainage || !drainage || drainage.dataset !== session.dataset) return session;
    const dataset = withDrainage(session.dataset, drainage.state);
    return { ...session, dataset, reference: runModel(dataset, REFERENCE_PARAMS), hits: hotspotHits(dataset), hazardChecks: hazardChecks(dataset, session.report) };
  }, [session, drainage, useDrainage]);
  const drainageOn = !!view && view !== session;

  // The agents decide on the terrain-only data; their assumptions are re-run on whichever view is shown.
  const viewDeliberation = useMemo<Deliberation | null>(() => (deliberation && view && drainageOn ? replay(view.dataset, deliberation) : deliberation), [deliberation, view, drainageOn]);

  const active = useMemo<Active | null>(() => {
    if (!view) return null;
    if (useAi && viewDeliberation?.final) return { source: "ai", params: viewDeliberation.final.params, result: viewDeliberation.final.result };
    return { source: "reference", params: REFERENCE_PARAMS, result: view.reference };
  }, [view, viewDeliberation, useAi]);

  // The same assumptions on terrain flooding alone, for the "what drainage adds" comparison.
  const terrainResult = useMemo(() => {
    if (!session || !active || !drainageOn) return null;
    return active.source === "ai" && deliberation?.final ? deliberation.final.result : session.reference;
  }, [session, active, drainageOn, deliberation]);

  // Ground-up losses taken through the policy terms and the reinsurance: gross and net for every event.
  const termsResult = useMemo(() => (view && active ? applyTerms(view.dataset, active.result, terms) : null), [view, active, terms]);

  // One picture of the offer, worked out once and handed to every step: located, priced and checked by
  // code on the maps, the flood source, the assumptions and the terms in force. null when no offer is read.
  const drainageInForce = drainageOn && drainage ? drainage.state : null;
  const layers = useMemo(() => (geo ? { wards: geo.wards, waterways: geo.waterways } : null), [geo]);
  const offerFocus = useMemo(
    () => (view && active ? buildOfferFocus({ offer, session: view, active, drainage: drainageInForce, policyDefaults: terms, portfolioTerms: termsResult, deliberation: viewDeliberation, layers }) : null),
    [offer, view, active, drainageInForce, terms, termsResult, viewDeliberation, layers],
  );
  // Offer mode needs a priced offer. Until there is one, and whenever the underwriter chooses it, every step shows the portfolio.
  const pricedFocus: PricedFocus | null = isPriced(offerFocus) ? offerFocus : null;
  const mode: Mode = pricedFocus && userMode !== "portfolio" ? "offer" : "portfolio";
  const focus = mode === "offer" ? pricedFocus : null;
  // The same two props for every step: `focus` in Offer mode only, `offerFocus` whatever the mode.
  const follow: OfferFocusProps = { focus, offerFocus };
  const prices = status?.prices ?? null;

  const checks = useMemo(() => {
    if (!session || !view || !active || !termsResult) return { ai: [], vulnerability: [], financial: [], all: [] };
    // The agents are checked on the data they decided on. Their saved fingerprint belongs to that
    // run, so re-running the engine on the drainage view would never match it.
    const ai = deliberation && !agentsBusy ? aiChecks(session.dataset, deliberation) : [];
    const vulnerability = vulnerabilityChecks(active.params);
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

  const totals = summarise(checks.all);
  const isScore = session?.dataset.hazardKind === "score";
  // Until a model is on screen the panel stands in for every step: it shows the first load, and what went wrong with it.
  const showPanel = !session || replaceOpen;
  const nextId: StepId | undefined = STEP_IDS[step + 1];
  const modelDataLine = session && origin ? `${dataSetLabel(session.dataset.name)}, ${origin.from}` : opening || busy ? "opening" : "none loaded";
  const openStep = (id: StepId) => goTo(stepIndex(id));

  return (
    <div
      className="flex min-h-screen w-full flex-col"
      style={headerHeight != null ? ({ "--header-height": `${headerHeight}px` } as CSSProperties) : undefined}
    >
      <header ref={headerRef} className="z-20 lg:sticky lg:top-0">
        <div className="@container bg-navy text-white">
          <div className={`${GUTTER} flex flex-wrap items-center gap-x-2 gap-y-2.5 py-3`}>
            {/* The brand asks only for the room its mark and name need, then takes what is left over.
                That keeps the display controls beside it on the first row, down to a phone at the largest text. */}
            <div className="flex min-w-0 flex-1 basis-28 items-center gap-2 sm:gap-3 @min-[104rem]:flex-none">
              <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 9c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" />
                  <path d="M2 14c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" opacity="0.75" />
                  <path d="M2 19c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2" opacity="0.5" />
                </svg>
              </span>
              <div className="min-w-0 leading-tight">
                <div className="font-display text-lg font-semibold tracking-tight">Mafuriko</div>
                <div className="text-xs text-white/75">A Nairobi centered CAT model</div>
              </div>
            </div>
            <DisplayControls className="ml-auto @min-[104rem]:order-last" />
            {/* The model data and its switches take their own row, so the bar does not rearrange itself
                when a switch appears partway through. Where the bar is wide enough to hold everything they sit
                on the first row, after the brand: a new switch is added at their right end and nothing moves. */}
            <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 border-white/20 @min-[104rem]:ml-4 @min-[104rem]:min-w-0 @min-[104rem]:flex-1 @min-[104rem]:basis-0 @min-[104rem]:border-l @min-[104rem]:pl-6">
              <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
                {/* The reason the sample is in use is also written out on the Dashboard; here it is one hover away. */}
                <span className="min-w-0 text-sm text-white wrap-anywhere" title={origin?.reason || undefined}>
                  Model data: {modelDataLine}
                </span>
                <button type="button" className={BAR_BUTTON} onClick={openReplace}>Replace model data</button>
              </span>
              {session && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className={CAPTION}>Data</span>
                  <Tag kind="synthetic">Synthetic portfolio</Tag>
                  <Tag kind={isScore ? "proxy" : "real"}>{isScore ? "Proxy hazard, not measured" : "Published depth maps"}</Tag>
                </span>
              )}
              {/* Always there once the model has loaded, so it sits before the switches that appear later. */}
              {session && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className={CAPTION}>View</span>
                  <ModeSwitch mode={mode} offerReady={pricedFocus !== null} onChange={setUserMode} />
                </span>
              )}
              {session && drainage && drainage.dataset === session.dataset && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className={CAPTION}>Flood source</span>
                  <Segmented label="Flood source" value={useDrainage ? "on" : "off"} onChange={(v) => setUseDrainage(v === "on")} options={[{ value: "off", label: "Terrain only" }, { value: "on", label: "Terrain + drainage" }]} />
                </span>
              )}
              {session && deliberation?.final && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className={CAPTION}>Assumptions</span>
                  <Segmented label="Assumptions" value={useAi ? "ai" : "reference"} onChange={(v) => setUseAi(v === "ai")} options={[{ value: "ai", label: "Agreed by agents" }, { value: "reference", label: "Reference, no AI" }]} />
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="h-[3px] bg-brand" />
        {view && active && (focus ? <OfferKeyFigures focus={focus} /> : <KeyFigures active={active} hazard={drainageOn ? "Terrain + drainage" : "Terrain only"} />)}
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
                      deliberation={viewDeliberation}
                      checks={checks.all}
                      drainageOn={drainageOn}
                      offer={offerFocus?.status === "locating" ? null : (offerFocus?.summary ?? null)}
                      onOpenStep={(target) => openStep(DASHBOARD_LINKS[target])}
                      offerCard={<OfferDropCard onOffer={giveOffer} onReplaceData={(zip) => void handleFiles([zip])} />}
                      {...follow}
                    />
                  )}
                  {stepId === "offer" && (
                    <OfferStep
                      session={view}
                      active={active}
                      modelReady={status ? status.configured.chair : null}
                      offer={offer}
                      onOffer={changeOffer}
                      onLog={(message) => note(STEP_NAMES.offer, message)}
                      incoming={incoming}
                      focus={focus}
                      offerFocus={offerFocus}
                    />
                  )}
                  {stepId === "data" && <DataView session={view} {...follow} onOpenStep={openStep} />}
                  {/* The hazard maps and the risk map are one step. It is handed everything the map step took (session, active) as well. */}
                  {stepId === "hazard" && (
                    <HazardView
                      session={view}
                      active={active}
                      drainage={session.dataset.hazardKind === "score" ? { state: drainage && drainage.dataset === session.dataset ? drainage.state : null, enabled: useDrainage, onToggle: setUseDrainage } : undefined}
                      {...follow}
                      onOpenStep={openStep}
                    />
                  )}
                  {stepId === "agents" && (
                    <AgentsView
                      session={view}
                      deliberation={viewDeliberation}
                      busy={agentsBusy}
                      checks={checks.ai}
                      status={status}
                      hasSaved={hasSaved}
                      replayed={replayed}
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
                      deliberation={viewDeliberation}
                      engineSession={session}
                      terrainResult={terrainResult}
                      terms={termsResult}
                      decision={decision}
                      onDecision={setDecision}
                      dataSource={modelDataLine}
                      {...follow}
                      onOpenStep={openStep}
                    />
                  )}
                  {stepId === "audit" && (
                    <AuditView
                      session={view}
                      active={active}
                      deliberation={viewDeliberation}
                      checks={checks.all}
                      log={log}
                      terms={termsResult}
                      modelSource={origin && origin.source !== "upload" ? { source: origin.source, folderName: origin.folderName, reason: origin.reason || null } : undefined}
                      prices={prices}
                      decision={decision}
                      dataSource={modelDataLine}
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
              {stepId === "agents" && !deliberation?.final && !agentsBusy && <span className="hidden text-xs text-muted sm:inline">Continuing without the agents uses reference assumptions.</span>}
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

/**
 * The header switch between the priced offer and the portfolio. Drawn like the Segmented control
 * beside it; it is its own piece because "Offer" has to be switched off until an offer is priced.
 */
function ModeSwitch({ mode, offerReady, onChange }: { mode: Mode; offerReady: boolean; onChange: (mode: Mode) => void }) {
  const option = (value: Mode, label: string, disabled: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === mode}
      disabled={disabled}
      title={disabled ? "Read and price an offer first" : undefined}
      onClick={() => onChange(value)}
      className={`rounded-full px-3 py-1 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${value === mode ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-2 enabled:hover:text-ink"}`}
    >
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="Show the offer or the portfolio" className="inline-flex flex-wrap gap-1 rounded-full border border-line bg-surface-2 p-1">
      {option("offer", "Offer", !offerReady)}
      {option("portfolio", "Portfolio", false)}
    </div>
  );
}

/** One band of figures under the header: two columns on a phone, three on a tablet, then one row with a rule between figures. */
function FigureStrip({ items, lead }: { items: { label: string; value: string; strong?: boolean }[]; lead?: string }) {
  return (
    <div className="@container border-b border-line bg-plane/95 backdrop-blur">
      {lead && <p className={`${GUTTER} pt-2 text-xs leading-snug text-ink-2 wrap-anywhere`}>{lead}</p>}
      {/* The steps are measured against the strip in rem, so a larger text size keeps the rows until one band fits. */}
      <dl className={`${GUTTER} grid grid-cols-2 gap-x-6 gap-y-2 py-2 @2xl:grid-cols-3 @4xl:grid-cols-[repeat(6,auto)] @4xl:gap-x-4 @5xl:gap-x-6`}>
        {items.map((x) => (
          <div key={x.label} className="min-w-0 border-line @4xl:border-l @4xl:pl-4 @4xl:first:border-l-0 @4xl:first:pl-0 @5xl:pl-6">
            <dt className="text-xs uppercase tracking-wide text-muted">{x.label}</dt>
            <dd className={`tabular text-sm font-semibold @5xl:text-base ${x.strong ? "text-brand" : "text-ink"}`}>{x.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The same strip in Offer mode: the offer's own figures, each labelled as the offer's. Every loss is
 * from the engine. Gross is after the policy deductible and limit; the change to the portfolio is ground-up.
 */
function OfferKeyFigures({ focus }: { focus: PricedFocus }) {
  const { total, portfolio } = focus.price;
  const rate = total.ratePerMilleGross;
  const added = portfolio.loss100ChangeKes;
  const addedShare = portfolio.loss100ChangeShare;
  const sign = added !== null && added < 0 ? "-" : "+";
  const items: { label: string; value: string; strong?: boolean }[] = [
    { label: "Offer sum insured", value: kes1(total.tivKes) },
    { label: "Offer 1-in-100 gross loss · 1% a year", value: total.loss100GrossKes !== null ? kes1(total.loss100GrossKes) : "not modelled", strong: true },
    { label: "Offer average annual loss, gross", value: kes1(total.aalGrossKes) },
    { label: "Offer pure flood rate, gross", value: `${fmtNum(rate, rate !== 0 && Math.abs(rate) < 0.1 ? 4 : 2)} per mille` },
    {
      label: "Added to portfolio 1-in-100, ground-up",
      value: added === null ? "not modelled" : Math.abs(added) < 0.5 ? "no change" : `${sign}${kes1(Math.abs(added))}${addedShare !== null ? ` (${sign}${fmtPct(Math.abs(addedShare), Math.abs(addedShare) < 0.001 ? 3 : 1)})` : ""}`,
    },
    { label: "Offer terms used", value: focus.terms.summary },
  ];
  const lead = `Figures for this offer: ${[focus.line.insured ?? focus.building.name, focus.line.location].filter(Boolean).join(", ")} (${focus.documentName}). Switch to Portfolio in the bar above for the whole portfolio.`;
  return <FigureStrip items={items} lead={lead} />;
}

/** The figures an underwriter looks for first, kept in view on every step. The losses are ground-up: before any insurance terms. */
function KeyFigures({ active, hazard }: { active: Active; hazard: string }) {
  const r = active.result;
  const at = (rp: number) => r.standardLosses.find((l) => l.returnPeriod === rp)?.lossKes ?? null;
  const loss100 = at(100);
  const loss250 = at(250);
  const items: { label: string; value: string; strong?: boolean }[] = [
    { label: "Total insured value", value: fmtKes(r.totalTivKes) },
    { label: "1-in-100 ground-up loss · 1% a year", value: loss100 != null ? fmtKes(loss100, 2) : "not modelled", strong: true },
    { label: "1-in-250 ground-up loss · 0.4% a year", value: loss250 != null ? fmtKes(loss250, 2) : "not modelled" },
    { label: "Ground-up average annual loss", value: fmtKes(r.aalKes, 2) },
    { label: "Flood source", value: hazard },
    { label: "Assumptions", value: active.source === "ai" ? "Agreed by agents" : "Reference, no AI" },
  ];
  return <FigureStrip items={items} />;
}
