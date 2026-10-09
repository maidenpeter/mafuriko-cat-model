"use client";

/**
 * Oasis check: the portfolio under the settings in force, run through Oasis LMF, an independent
 * loss engine used across the industry, on the same inputs. The demo stops here for under a minute.
 *
 *   Side by side        one row per modelled flood, this app beside Oasis, then the step average annual
 *                       loss; above the figures, never folded away, what this run did and did not check
 *   The three runs      one row per run shipped with the app: settings, what Oasis was given, what it
 *                       checked, largest flood difference, the day it ran, and which one is on screen
 *   Export and re-run   lower on the page, behind a fold: the building-level export for the settings in
 *                       force, the commands, and where the method is written up
 *
 * The check is about the portfolio's settings, so the step reads the same whatever "View" says.
 * Nothing is priced here: the result in force comes in as `active`, on the data set in `session`
 * (with drainage when it is on). The three files are read once and serve both tables.
 */

import { useEffect, useState } from "react";
import { fmtInt } from "@/lib/format";
import { resultFingerprint } from "@/lib/model/pipeline";
import { buildingExport, buildingExportCsv, OASIS_NOT_CHECKED, OASIS_RUNS, oasisChecked, oasisRunFor, oasisSettings, viewName, type OasisRunFile } from "@/lib/oasisExport";
import type { OfferFocusProps } from "@/lib/offer/focus";
import { download, type Active, type Session } from "@/lib/session";
import { STEP_NAMES, type StepId } from "@/lib/steps";
import { SourceLine } from "../charts/ChartFrame";
import { eventDiffPct, OASIS_CHECKED_SHORT, OASIS_GIVEN, OasisCheck, runDate, useOasisRuns, type LiveState } from "../OasisCheck";
import { Button, Card, Fold, StepHeader, StepLink, Tag } from "../ui";

interface Props extends OfferFocusProps {
  session: Session;
  active: Active;
  /** Opens another step of the walkthrough. */
  onOpenStep?: (id: StepId) => void;
  /** Sets the switches to the nearest settings an Oasis run exists for. */
  onShowChecked?: () => void;
}

const NOT_PRESENT = "file not present";

/** The commands that make the three shipped runs again, as oasis/README.md gives them. Run in WSL (Ubuntu) from the project root. */
const RERUN_COMMANDS = `# In WSL (Ubuntu), from the project root, with the Oasis environment set up as in oasis/README.md
cd web && node scripts/export-buildings.mjs && cd ..   # the three building-level exports, to oasis/runs/exports/

~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \\
    --depths oasis/runs/exports/team_a_nairobi_terrain_depth-only.csv --out web/public/oasis/reference.json
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \\
    --depths oasis/runs/exports/team_a_nairobi_drainage_depth-only.csv --out web/public/oasis/reference-drainage.json
~/oasis-venv/bin/python oasis/build_and_run.py --data-dir data/data/team_a_nairobi \\
    --damage-ratios oasis/runs/exports/team_a_nairobi_drainage_all-drivers.csv --out web/public/oasis/reference-drivers.json`;

export function OasisStep({ session, active, onOpenStep, onShowChecked }: Props) {
  const runs = useOasisRuns();
  const { dataset } = session;
  const settings = oasisSettings(dataset, active.result, active.source);
  const onScreen = oasisRunFor(settings);
  // The run on screen is the one made for these settings and for this very result; a stale file is not it.
  const shownFile = onScreen && runs && oasisChecked(onScreen, runs[onScreen.file], dataset, active.result) ? onScreen.file : null;
  const files = runs ? OASIS_RUNS.map((spec) => runs[spec.file]).filter((f) => f !== null) : [];
  const version = files[0]?.oasislmfVersion ?? null;
  const summarySources = [{ kind: "real" as const, text: `Oasis LMF${version ? ` ${version}` : ""} output: ${OASIS_RUNS.map((r) => r.file).join(", ")} under web/public/oasis, totals only, never a building` }];

  // Runs made on this machine, by the fingerprint of the result each was made for.
  const fingerprint = resultFingerprint(active.result);
  const [liveRuns, setLiveRuns] = useState<Record<string, OasisRunFile>>({});
  const [live, setLive] = useState<{ state: LiveState; fingerprint: string | null }>({ state: { status: "idle" }, fingerprint: null });

  // A run made earlier for this very result is picked up without running again.
  useEffect(() => {
    let dropped = false;
    fetch(`/api/oasis/run?fingerprint=${fingerprint}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { ok?: boolean; run?: OasisRunFile } | null) => {
        if (!dropped && body?.ok && body.run) setLiveRuns((all) => ({ ...all, [fingerprint]: body.run as OasisRunFile }));
      })
      .catch(() => undefined);
    return () => {
      dropped = true;
    };
  }, [fingerprint]);

  const runLive = async () => {
    if (live.state.status === "running") return;
    const started = Date.now();
    setLive({ state: { status: "running", seconds: 0 }, fingerprint });
    const tick = setInterval(() => setLive((s) => (s.state.status === "running" ? { ...s, state: { status: "running", seconds: Math.round((Date.now() - started) / 1000) } } : s)), 1000);
    try {
      const csv = buildingExportCsv(buildingExport(dataset, active.result, active.source));
      const res = await fetch("/api/oasis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: dataset.name, fingerprint, mode: settings.lossesFrom === "all_drivers" ? "damage_ratios" : "depths", csv }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; run?: OasisRunFile; reason?: string } | null;
      if (body?.ok && body.run) {
        setLiveRuns((all) => ({ ...all, [fingerprint]: body.run as OasisRunFile }));
        setLive({ state: { status: "idle" }, fingerprint });
      } else {
        setLive({ state: { status: "error", message: body?.reason ?? "Oasis could not be run from here." }, fingerprint });
      }
    } catch {
      setLive({ state: { status: "error", message: "The app's server did not answer, so Oasis was not run." }, fingerprint });
    } finally {
      clearInterval(tick);
    }
  };
  // An error belongs to the result it was raised for; a run in flight stays on show whatever the settings, as only one runs at a time.
  const liveShown: LiveState = live.fingerprint === fingerprint || live.state.status === "running" ? live.state : { status: "idle" };

  const exportBuildings = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    download(`mafuriko-${dataset.name}-${stamp}-buildings.csv`, buildingExportCsv(buildingExport(dataset, active.result, active.source)), "text/csv");
  };

  return (
    <div>
      <StepHeader title={STEP_NAMES.oasis}>
        Oasis LMF is the open-source loss engine used across the insurance and reinsurance industry. The portfolio was written as Oasis files and run through that engine on the same inputs, so the figures in {STEP_NAMES.results} are checked by an engine that is not ours.
      </StepHeader>

      <OasisCheck dataset={dataset} result={active.result} source={active.source} runs={runs} onShowChecked={onShowChecked} liveRun={liveRuns[fingerprint] ?? null} onRunLive={runLive} live={liveShown} />

      <Card title="The three runs shipped with the app" className="mt-4" aside={<Tag kind="real">Oasis LMF{version ? ` ${version}` : ""}</Tag>}>
        <p className="-mt-2 mb-3 max-w-4xl text-sm leading-relaxed text-ink-2">
          One row per run, each on the reference assumptions with nothing typed over. A run fed depths lets Oasis apply the damage curve itself; a run fed damage ratios checks only what follows the damage. The last column says which run the table above shows.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-4xl text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="pb-2 text-left font-medium">Settings</th>
                <th scope="col" className="pb-2 pl-3 text-left font-medium">Oasis was given</th>
                <th scope="col" className="pb-2 pl-3 text-left font-medium">What it checked</th>
                <th scope="col" className="pb-2 pl-3 text-right font-medium">Largest flood difference (%)</th>
                <th scope="col" className="pb-2 pl-3 text-left font-medium">Run on</th>
                <th scope="col" className="pb-2 pl-3 text-left font-medium">On screen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {OASIS_RUNS.map((spec) => {
                const file = runs ? runs[spec.file] : undefined;
                const here = spec.file === shownFile;
                const reading = runs === null;
                return (
                  <tr key={spec.file} className={here ? "font-semibold text-ink" : "text-ink-2"}>
                    <td className="py-1.5 text-ink">
                      {viewName(spec)} <span className="font-mono text-xs font-normal text-muted">{spec.file}</span>
                    </td>
                    <td className="py-1.5 pl-3">{OASIS_GIVEN[spec.mode]}</td>
                    <td className="py-1.5 pl-3">{OASIS_CHECKED_SHORT[spec.mode]}</td>
                    <td className="tabular py-1.5 pl-3 text-right whitespace-nowrap">{reading ? "Reading" : file ? eventDiffPct(file.maxEventDiffPct) : NOT_PRESENT}</td>
                    <td className="py-1.5 pl-3 whitespace-nowrap">{reading ? "Reading" : file ? runDate(file.generatedAt) : NOT_PRESENT}</td>
                    <td className="py-1.5 pl-3 whitespace-nowrap">{here ? "Yes, this one" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 max-w-4xl text-xs leading-relaxed text-muted">
          Every run is {fmtInt(dataset.buildings.length)} buildings over five floods, ground-up, no insurance terms. A file is shown above only when it carries the fingerprint of the result on screen; any other settings read &quot;{OASIS_NOT_CHECKED}&quot;.
        </p>
        <SourceLine className="mt-3 border-t border-line pt-3" sources={summarySources} />
      </Card>

      {/* For anyone who asks: the export for the settings in force, the commands, and the write-up. Closed by default. */}
      <Card className="mt-4">
        <Fold summary="Export and re-run: the building-level export, the commands, and where the method is written up">
          <div className="space-y-3 text-sm leading-relaxed text-ink-2">
            <div className="flex flex-wrap items-center gap-3">
              {/* One row per building and return period for the settings in force: what oasis/build_and_run.py reads. */}
              <Button variant="secondary" onClick={exportBuildings}>Download the building-level export</Button>
              <span className="text-xs text-muted">For {viewName(settings)}, {settings.referenceAssumptions ? "reference assumptions" : "the assumptions in force"}.</span>
            </div>
            <p className="max-w-4xl">
              The export is one row per building and return period: the depth of water at the site and the final ground-up damage ratio, with the settings and the result fingerprint on a comment line at the top. Give it to build_and_run.py with --damage-ratios for any settings, or --depths with Depth only so Oasis applies the damage curve too. The file Oasis writes names the view it was made for, and this step shows it only when the fingerprint matches. The export holds the portfolio&apos;s buildings, so it stays out of git.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink-2">{RERUN_COMMANDS}</pre>
            <p className="max-w-4xl text-xs text-muted">
              The method, every option of the script, how the model is written in Oasis terms, and what the check does and does not cover are in oasis/README.md. Every check on the figures themselves is listed in <StepLink to="audit" onOpenStep={onOpenStep} />.
            </p>
          </div>
        </Fold>
      </Card>
    </div>
  );
}
