"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { aiChecks, deliberate, replay, type Deliberation } from "@/lib/agents/orchestrate";
import { buildProfile } from "@/lib/agents/profile";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/agents/schema";
import { dataChecks, financialChecks, hazardChecks, summarise, vulnerabilityChecks } from "@/lib/checks";
import { termsChecks } from "@/lib/checks/terms";
import { fmtInt, fmtKes } from "@/lib/format";
import { prepareDrainage, withDrainage, type DrainageState } from "@/lib/geo/drainageView";
import { detectDatasets, loadDataset, type DatasetCandidate, type FileInfo } from "@/lib/ingest";
import { filesFromUpload } from "@/lib/ingest/zip";
import { hotspotHits } from "@/lib/model/hotspots";
import { REFERENCE_PARAMS } from "@/lib/model/params";
import { runModel } from "@/lib/model/pipeline";
import { applyTerms, DEFAULT_TERMS, type InsuranceTerms } from "@/lib/model/terms";
import type { Dataset } from "@/lib/model/types";
import { loadRun, saveRun, type Active, type LogEntry, type Session } from "@/lib/session";
import { DisplayControls } from "./DisplayControls";
import { AgentsStep } from "./steps/AgentsStep";
import { AuditStep } from "./steps/AuditStep";
import { DataStep } from "./steps/DataStep";
import { HazardStep } from "./steps/HazardStep";
import { LossStep } from "./steps/LossStep";
import { MapStep } from "./steps/MapStep";
import { OfferStep, type OfferState } from "./steps/OfferStep";
import { ResultsStep } from "./steps/ResultsStep";
import { UploadStep } from "./steps/UploadStep";
import { VulnerabilityStep } from "./steps/VulnerabilityStep";
import { Button, Segmented, StatusIcon, Tag } from "./ui";

const STEPS = ["Upload", "Read the data", "Hazard", "Agents", "Vulnerability", "Loss engine", "Risk map", "Results", "Price an offer", "Audit"];

type AgentStatus = { model: string; configured: Record<Role, boolean> };

// The page's side gutters, shared by the header bar, the key figures, the content and the Back and Next bar
// so their edges line up. Backgrounds run the full width of the screen; only the contents take the gutters.
// The cap is for very wide monitors, and is in rem so it widens with the text size.
const GUTTER = "mx-auto w-full max-w-[120rem] px-4 sm:px-6 2xl:px-10";
/** The small word in front of a group of controls on the navy bar, so nobody has to guess what a switch is for. */
const CAPTION = "text-xs font-medium uppercase tracking-wide text-white/65";

export function Walkthrough() {
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [busy, setBusy] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ name: string; files: FileInfo[]; candidates: DatasetCandidate[] } | null>(null);
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
  // The offer being priced in step 8. Kept here so it is still there after a look at another step.
  const [offer, setOffer] = useState<OfferState | null>(null);
  // The insurance terms applied after the damage model: example terms until someone edits them in step 5.
  const [terms, setTerms] = useState<InsuranceTerms>(DEFAULT_TERMS);

  const note = useCallback((stepName: string, message: string) => setLog((l) => [...l, { at: new Date().toISOString(), step: stepName, message }]), []);

  useEffect(() => {
    fetch("/api/agents/status").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

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

  const goTo = (i: number) => {
    setStep(i);
    setReached((r) => Math.max(r, i));
  };

  const load = useCallback(
    async (candidate: DatasetCandidate, name: string, files: FileInfo[]) => {
      setError(null);
      const messages: string[] = [];
      const progress = (m: string) => {
        messages.push(m);
        setBusy([...messages]);
        note("Read the data", m);
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
        note("Read the data", `${fmtInt(dataset.buildings.length)} buildings, ${dataset.rasters.length} hazard maps, total insured value ${fmtKes(reference.totalTivKes)}; ${Math.round(performance.now() - started)} ms`);
        setSession(next);
        setDrainage(null);
        prepareDrainage(dataset)
          .then((state) => {
            if (!state) return;
            setDrainage({ dataset, state });
            const row = state.sensitivity.rows.find((x) => x.reachM === 300);
            if (row) note("Hazard", `Drainage zone ready: ${row.hits} of ${dataset.hotspots.length} named flood areas flagged (terrain alone ${state.sensitivity.baseHits}), +${row.addedAreaKm2.toFixed(0)} km² flooded`);
          })
          .catch(() => setDrainage(null));
        setDeliberation(null);
        setReplayed(false);
        setOffer(null);
        setHasSaved(loadRun(next) !== null);
        setBusy(null);
        setStep(1);
        setReached(1);
      } catch (e) {
        setBusy(null);
        setError(`Could not read the dataset: ${(e as Error).message}`);
        note("Read the data", `Failed: ${(e as Error).message}`);
      }
    },
    [note],
  );

  const handleFiles = useCallback(
    async (list: File[]) => {
      setError(null);
      setUpload(null);
      setBusy(["Opening the upload"]);
      try {
        const { name, files } = await filesFromUpload(list);
        note("Upload", `${name}: ${files.length} files`);
        const found = await detectDatasets(files, name);
        if (found.candidates.length === 0) {
          setBusy(null);
          setError("No dataset found. The upload needs an exposure CSV (with lat, lon and tiv_kes columns) and hazard maps named by tier or return period.");
          return;
        }
        setUpload({ name, files: found.files, candidates: found.candidates });
        if (found.candidates.length === 1) await load(found.candidates[0], name, found.files);
        else setBusy(null);
      } catch (e) {
        setBusy(null);
        setError(`Could not open the upload: ${(e as Error).message}`);
      }
    },
    [load, note],
  );

  const handleSample = useCallback(async () => {
    setError(null);
    setBusy(["Fetching the starter kit"]);
    try {
      const res = await fetch("/sample-data.zip");
      if (!res.ok) throw new Error("sample-data.zip is not in web/public");
      await handleFiles([new File([await res.blob()], "starter-kit.zip")]);
    } catch (e) {
      setBusy(null);
      setError(`Could not load the starter kit: ${(e as Error).message}`);
    }
  }, [handleFiles]);

  // Rehearsal shortcut: /?sample=1 loads the starter kit, and &step=7 opens a given step once it has loaded.
  const deepLinked = useRef(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("sample") !== "1" || deepLinked.current) return;
    deepLinked.current = true;
    const target = Number(query.get("step") ?? 1);
    handleSample().then(() => {
      if (target > 1 && target < STEPS.length) {
        setStep(target);
        setReached(target);
      }
    });
    // Runs once on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAgents = async () => {
    if (!session) return;
    setAgentsBusy(true);
    setReplayed(false);
    note("Agents", "Round 1 started: Optimist, Cautious and Critic in parallel");
    const d = await deliberate(session.dataset, session.profile, setDeliberation);
    for (const role of ROLES) {
      const run = d.runs[role];
      note("Agents", `${ROLE_LABELS[role]}: ${run.status === "done" ? `valid reply in ${((run.ms ?? 0) / 1000).toFixed(1)} s` : `no valid reply (${run.error ?? run.status})`}`);
    }
    if (d.final) {
      saveRun(session, d);
      setHasSaved(true);
      setUseAi(true);
      note("Agents", `Agreed assumptions applied; result fingerprint ${d.fingerprint}`);
    } else {
      note("Agents", "No agreed set. The model stays on reference assumptions.");
    }
    setAgentsBusy(false);
  };

  const applySaved = (saved: Deliberation, origin: string) => {
    if (!session) return;
    const d = replay(session.dataset, saved);
    setDeliberation(d);
    setReplayed(true);
    setUseAi(true);
    note("Agents", `${origin}: agent replies from ${saved.startedAt}; engine re-run now`);
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

  const checks = useMemo(() => {
    if (!session || !view || !active || !termsResult) return { ai: [], vulnerability: [], financial: [], all: [] };
    // The agents are checked on the data they decided on. Their saved fingerprint belongs to that
    // run, so re-running the engine on the drainage view would never match it.
    const ai = deliberation && !agentsBusy ? aiChecks(session.dataset, deliberation) : [];
    const vulnerability = vulnerabilityChecks(active.params);
    const financial = [...financialChecks(view.dataset, active.result), ...termsChecks(termsResult)];
    return { ai, vulnerability, financial, all: [...view.dataChecks, ...view.hazardChecks, ...ai, ...vulnerability, ...financial] };
  }, [session, view, active, termsResult, deliberation, agentsBusy]);

  const reset = () => {
    setStep(0);
    setReached(0);
    setSession(null);
    setUpload(null);
    setDeliberation(null);
    setDrainage(null);
    setOffer(null);
    setTerms(DEFAULT_TERMS);
    setError(null);
    setLog([]);
  };

  const totals = summarise(checks.all);
  const isScore = session?.dataset.hazardKind === "score";

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
            {/* The loaded dataset and its switches take their own row, so the bar does not rearrange itself
                when a switch appears partway through. Where the bar is wide enough to hold everything they sit
                on the first row, after the brand: a new switch is added at their right end and nothing moves. */}
            {session && (
              <div className="flex basis-full flex-wrap items-center gap-2 border-white/20 @min-[104rem]:ml-4 @min-[104rem]:min-w-0 @min-[104rem]:flex-1 @min-[104rem]:basis-0 @min-[104rem]:border-l @min-[104rem]:pl-6">
                <span className={CAPTION}>Data</span>
                <Tag kind="synthetic">Synthetic portfolio</Tag>
                <Tag kind={isScore ? "proxy" : "real"}>{isScore ? "Proxy hazard, not measured" : "Published depth maps"}</Tag>
                {drainage && drainage.dataset === session.dataset && (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className={CAPTION}>Flood source</span>
                    <Segmented label="Flood source" value={useDrainage ? "on" : "off"} onChange={(v) => setUseDrainage(v === "on")} options={[{ value: "off", label: "Terrain only" }, { value: "on", label: "Terrain + drainage" }]} />
                  </span>
                )}
                {deliberation?.final && (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span className={CAPTION}>Assumptions</span>
                    <Segmented label="Assumptions" value={useAi ? "ai" : "reference"} onChange={(v) => setUseAi(v === "ai")} options={[{ value: "ai", label: "Agreed by agents" }, { value: "reference", label: "Reference, no AI" }]} />
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="h-[3px] bg-brand" />
        {view && active && <KeyFigures active={active} hazard={drainageOn ? "Terrain + drainage" : "Terrain only"} />}
      </header>

      <div className={`${GUTTER} flex flex-1 flex-col gap-6 py-6 lg:flex-row lg:gap-8 2xl:gap-10`}>
        {/* Stuck just below the header and never taller than the room between it and the Back and Next bar:
            on a short screen at the larger sizes the list scrolls inside itself instead of running off the bottom. */}
        <nav
          aria-label="Steps"
          className="lg:sticky lg:top-[calc(var(--header-height,9rem)+1rem)] lg:h-fit lg:max-h-[calc(100dvh-var(--header-height,9rem)-5.25rem)] lg:w-44 lg:shrink-0 lg:overflow-y-auto 2xl:w-52 lg:scrollbar-thin"
        >
          <ol ref={stepsRef} className="flex gap-1 overflow-x-auto lg:flex-col">
            {STEPS.map((name, i) => {
              const locked = i > reached;
              const current = i === step;
              return (
                <li key={name}>
                  <button
                    disabled={locked}
                    onClick={() => goTo(i)}
                    aria-current={current ? "step" : undefined}
                    className={`flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm transition ${current ? "bg-surface font-semibold text-ink shadow-sm ring-1 ring-line" : locked ? "text-muted" : "text-ink-2 hover:bg-surface"}`}
                  >
                    <span className={`tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${current ? "bg-brand text-white" : i < reached ? "bg-surface-2 text-ink-2" : "border border-line text-muted"}`}>{i}</span>
                    {name}
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
            <motion.div key={step} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.28, ease: "easeOut" }}>
              {step === 0 && (
                <UploadStep busy={busy} error={error} candidates={upload?.candidates ?? null} onFiles={handleFiles} onSample={handleSample} onPick={(c) => upload && load(c, upload.name, upload.files)} />
              )}
              {session && view && active && termsResult && (
                <>
                  {step === 1 && <DataStep session={view} />}
                  {step === 2 && (
                    <HazardStep
                      session={view}
                      drainage={session.dataset.hazardKind === "score" ? { state: drainage && drainage.dataset === session.dataset ? drainage.state : null, enabled: useDrainage, onToggle: setUseDrainage } : undefined}
                    />
                  )}
                  {step === 3 && (
                    <AgentsStep
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
                          note("Agents", `Could not read ${file.name} as a saved run`);
                        }
                      }}
                    />
                  )}
                  {step === 4 && <VulnerabilityStep session={view} active={active} checks={checks.vulnerability} />}
                  {step === 5 && <LossStep session={view} active={active} checks={checks.financial} terms={termsResult} onTermsChange={setTerms} />}
                  {step === 6 && <MapStep session={view} active={active} />}
                  {step === 7 && <ResultsStep session={view} active={active} deliberation={viewDeliberation} engineSession={session} terrainResult={terrainResult} terms={termsResult} />}
                  {step === 8 && (
                    <OfferStep
                      session={view}
                      active={active}
                      drainage={drainageOn && drainage ? drainage.state : null}
                      modelReady={status ? status.configured.chair : null}
                      offer={offer}
                      onOffer={setOffer}
                      policyDefaults={terms}
                      onLog={(message) => note("Price an offer", message)}
                    />
                  )}
                  {step === 9 && <AuditStep session={view} active={active} deliberation={viewDeliberation} checks={checks.all} log={log} terms={termsResult} />}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {session && step > 0 && (
        <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-plane/90 backdrop-blur">
          {/* On a phone at the larger sizes the three buttons do not fit side by side: Next drops to a second row instead of breaking its label. */}
          <div className={`${GUTTER} flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3`}>
            <div className="flex items-center gap-2">
              <Button variant="secondary" className="whitespace-nowrap" onClick={() => goTo(step - 1)}>Back</Button>
              <Button variant="ghost" className="whitespace-nowrap" onClick={reset}>Start over</Button>
            </div>
            <div className="ml-auto flex items-center gap-3">
              {step === 3 && !deliberation?.final && !agentsBusy && <span className="hidden text-xs text-muted sm:inline">Continuing without the agents uses reference assumptions.</span>}
              {step < STEPS.length - 1 && (
                <Button className="whitespace-nowrap" onClick={() => goTo(step + 1)} disabled={agentsBusy}>
                  Next: {STEPS[step + 1]}
                </Button>
              )}
            </div>
          </div>
        </footer>
      )}
    </div>
  );
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
  return (
    <div className="@container border-b border-line bg-plane/95 backdrop-blur">
      {/* Two columns on a phone, three on a tablet, then one band across the whole bar with a rule between figures.
          The steps are measured against the strip in rem, so a larger text size keeps the rows until one band fits. */}
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
