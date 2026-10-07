"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aiChecks, deliberate, replay, type Deliberation } from "@/lib/agents/orchestrate";
import { buildProfile } from "@/lib/agents/profile";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/agents/schema";
import { dataChecks, financialChecks, hazardChecks, summarise, vulnerabilityChecks } from "@/lib/checks";
import { fmtInt, fmtKes } from "@/lib/format";
import { detectDatasets, loadDataset, type DatasetCandidate, type FileInfo } from "@/lib/ingest";
import { filesFromUpload } from "@/lib/ingest/zip";
import { hotspotHits } from "@/lib/model/hotspots";
import { REFERENCE_PARAMS } from "@/lib/model/params";
import { runModel } from "@/lib/model/pipeline";
import { loadRun, saveRun, type Active, type LogEntry, type Session } from "@/lib/session";
import { AgentsStep } from "./steps/AgentsStep";
import { AuditStep } from "./steps/AuditStep";
import { DataStep } from "./steps/DataStep";
import { HazardStep } from "./steps/HazardStep";
import { LossStep } from "./steps/LossStep";
import { ResultsStep } from "./steps/ResultsStep";
import { UploadStep } from "./steps/UploadStep";
import { VulnerabilityStep } from "./steps/VulnerabilityStep";
import { Button, Segmented, StatusIcon, Tag } from "./ui";

const STEPS = ["Upload", "Read the data", "Hazard", "Agents", "Vulnerability", "Loss engine", "Results", "Audit"];

type AgentStatus = { model: string; configured: Record<Role, boolean> };

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
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [hasSaved, setHasSaved] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const note = useCallback((stepName: string, message: string) => setLog((l) => [...l, { at: new Date().toISOString(), step: stepName, message }]), []);

  useEffect(() => {
    fetch("/api/agents/status").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

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
        setDeliberation(null);
        setReplayed(false);
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

  // Rehearsal shortcut: /?sample=1 loads the starter kit, and &step=6 opens a given step once it has loaded.
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

  const active = useMemo<Active | null>(() => {
    if (!session) return null;
    if (useAi && deliberation?.final) return { source: "ai", params: deliberation.final.params, result: deliberation.final.result };
    return { source: "reference", params: REFERENCE_PARAMS, result: session.reference };
  }, [session, deliberation, useAi]);

  const checks = useMemo(() => {
    if (!session || !active) return { ai: [], vulnerability: [], financial: [], all: [] };
    const ai = deliberation && !agentsBusy ? aiChecks(session.dataset, deliberation) : [];
    const vulnerability = vulnerabilityChecks(active.params);
    const financial = financialChecks(session.dataset, active.result);
    return { ai, vulnerability, financial, all: [...session.dataChecks, ...session.hazardChecks, ...ai, ...vulnerability, ...financial] };
  }, [session, active, deliberation, agentsBusy]);

  const reset = () => {
    setStep(0);
    setReached(0);
    setSession(null);
    setUpload(null);
    setDeliberation(null);
    setError(null);
    setLog([]);
  };

  const totals = summarise(checks.all);
  const isScore = session?.dataset.hazardKind === "score";

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1320px] flex-col px-4 sm:px-6">
      <header className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-plane/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold tracking-tight text-ink">Mafuriko</span>
          <span className="hidden text-sm text-ink-2 sm:inline">Flood loss model, shown step by step</span>
        </div>
        {session && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-2">{session.dataset.name}</span>
            <Tag kind="synthetic">Synthetic portfolio</Tag>
            <Tag kind={isScore ? "proxy" : "real"}>{isScore ? "Proxy hazard, not measured" : "Published depth maps"}</Tag>
            {deliberation?.final && (
              <Segmented label="Assumptions" value={useAi ? "ai" : "reference"} onChange={(v) => setUseAi(v === "ai")} options={[{ value: "ai", label: "Agreed by agents" }, { value: "reference", label: "Without AI" }]} />
            )}
          </div>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-6 py-6 lg:flex-row lg:gap-10">
        <nav aria-label="Steps" className="lg:sticky lg:top-20 lg:h-fit lg:w-52 lg:shrink-0">
          <ol className="flex gap-1 overflow-x-auto lg:flex-col">
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
                    <span className={`tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${current ? "bg-ink text-surface" : i < reached ? "bg-surface-2 text-ink-2" : "border border-line text-muted"}`}>{i}</span>
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

        <main className="min-w-0 flex-1 pb-28">
          <AnimatePresence mode="wait">
            <motion.div key={step} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.28, ease: "easeOut" }}>
              {step === 0 && (
                <UploadStep busy={busy} error={error} candidates={upload?.candidates ?? null} onFiles={handleFiles} onSample={handleSample} onPick={(c) => upload && load(c, upload.name, upload.files)} />
              )}
              {session && active && (
                <>
                  {step === 1 && <DataStep session={session} />}
                  {step === 2 && <HazardStep session={session} />}
                  {step === 3 && (
                    <AgentsStep
                      session={session}
                      deliberation={deliberation}
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
                  {step === 4 && <VulnerabilityStep session={session} active={active} checks={checks.vulnerability} />}
                  {step === 5 && <LossStep session={session} active={active} checks={checks.financial} />}
                  {step === 6 && <ResultsStep session={session} active={active} deliberation={deliberation} />}
                  {step === 7 && <AuditStep session={session} active={active} deliberation={deliberation} checks={checks.all} log={log} />}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {session && step > 0 && (
        <footer className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-plane/90 backdrop-blur">
          <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => goTo(step - 1)}>Back</Button>
              <Button variant="ghost" onClick={reset}>Start over</Button>
            </div>
            <div className="flex items-center gap-3">
              {step === 3 && !deliberation?.final && !agentsBusy && <span className="hidden text-xs text-muted sm:inline">Continuing without the agents uses reference assumptions.</span>}
              {step < STEPS.length - 1 && (
                <Button onClick={() => goTo(step + 1)} disabled={agentsBusy}>
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
