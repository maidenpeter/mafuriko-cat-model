"use client";

/**
 * The side-by-side comparison with Oasis LMF, drawn on the Oasis check step.
 *
 *   useOasisRuns()           reads the three run files under /oasis once: null while reading, then one
 *                            entry per file name, null where the file is not present
 *   OasisCheck               the portfolio result in force beside the Oasis run made for exactly these
 *                            settings, or the exact "Not checked" words when there is none
 *   OASIS_CHECKED_LINE       what a run did and did not check, in the words shown above the table
 *   OASIS_GIVEN, OASIS_CHECKED_SHORT, runDate   the short forms the three-run summary uses
 *
 * Nothing stale: the file is chosen for exactly the settings in force and shown only when it
 * carries this result's fingerprint. Any other case shows no figure from any run.
 */

import { useEffect, useState } from "react";
import { fmtInt, fmtPct } from "@/lib/format";
import { kes1, LOSS_MODE_LABELS, rpLabel, rpWithChance } from "@/lib/labels";
import { bandedAal } from "@/lib/model/financial";
import { resultFingerprint } from "@/lib/model/pipeline";
import type { Dataset, ModelResult } from "@/lib/model/types";
import { FLOOD_SOURCE_LABELS, OASIS_COVERED_LINE, OASIS_NOT_CHECKED, OASIS_RUNS, oasisChecked, oasisRunFor, oasisSettings, viewName, type OasisRunFile, type OasisRunMode, type OasisSettings } from "@/lib/oasisExport";
import type { Active } from "@/lib/session";
import { SourceLine } from "./charts/ChartFrame";
import { Button, Card, Tag } from "./ui";

/** The three run files by name, as read from /oasis. null for a file that is not present. */
export type OasisRuns = Record<string, OasisRunFile | null>;

/** Reads the three run files once, all together. null until every answer is in. */
export function useOasisRuns(): OasisRuns | null {
  const [runs, setRuns] = useState<OasisRuns | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(
      OASIS_RUNS.map(async (spec): Promise<[string, OasisRunFile | null]> => {
        try {
          const r = await fetch(`/oasis/${spec.file}`);
          return [spec.file, r.ok ? ((await r.json()) as OasisRunFile) : null];
        } catch {
          return [spec.file, null];
        }
      }),
    ).then((entries) => {
      if (live) setRuns(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, []);
  return runs;
}

/**
 * What each kind of run checked and what it did not, said in full above the table. The damage
 * ratio sentence is the one agreed with the owner, word for word.
 */
export const OASIS_CHECKED_LINE: Record<OasisRunMode, string> = {
  depths: "Oasis was given the depth of water at every building and applied the damage curve itself, so it checked the damage curve as well as the loss arithmetic and return period maths.",
  damage_ratios: "Oasis checked the loss arithmetic and return period maths for these damage ratios. It did not check the damage curve or the loss driver assumptions.",
};

/** What Oasis was given, for a table cell. */
export const OASIS_GIVEN: Record<OasisRunMode, string> = { depths: "Depth at every building", damage_ratios: "Final damage ratio at every building" };

/** What it checked, for a table cell. */
export const OASIS_CHECKED_SHORT: Record<OasisRunMode, string> = {
  depths: "Damage curve, loss arithmetic, return period maths",
  damage_ratios: "Loss arithmetic and return period maths only",
};

/** The day a run was made, from the file's timestamp: "8 October 2026". */
export const runDate = (generatedAt: string): string => {
  const date = new Date(generatedAt);
  return Number.isNaN(date.getTime()) ? generatedAt.slice(0, 10) : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

/** A loss in millions of shillings with one decimal, for a column whose heading carries the unit: "2,688.7". */
const millions = (kes: number) => (kes / 1e6).toLocaleString("en-KE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const diff = (ours: number, theirs: number) => (ours === 0 ? 0 : theirs / ours - 1);
/** A difference as a signed percentage with three decimals: the gaps are hundredths of a percent, so one decimal would hide them. */
const signedPct = (f: number) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(3)}%`;
/** The file's own largest event difference, written the same way. */
export const eventDiffPct = (pct: number) => `${pct.toFixed(3)}%`;

const TITLE = "Side by side for the settings on screen";

/** Which switches to set for a run to exist: for the "Not checked" card. Empty when the settings are covered. */
function switchHint(settings: OasisSettings): string {
  const hints: string[] = [];
  if (!settings.referenceAssumptions) hints.push('select Reference, no AI under "Assumptions" and put any figure typed over the loss drivers back to its reference value');
  if (settings.floodSource === "terrain" && settings.lossesFrom === "all_drivers") hints.push(`select ${FLOOD_SOURCE_LABELS.terrain_drainage} under "Flood source", or ${LOSS_MODE_LABELS.depth_only} under "Losses from"`);
  return hints.length ? `By hand, in the bar above: ${hints.join("; ")}.` : "";
}

/**
 * No figure is shown: never a match from other settings. `why` says what is missing when a run was
 * made for these settings but not for this very result: a file not present, or one made for another result.
 */
function NotChecked({ settings, why, onShowChecked }: { settings: OasisSettings; why?: string; onShowChecked?: () => void }) {
  const hint = switchHint(settings);
  return (
    <Card title={TITLE} aside={<Tag kind="none">Not checked</Tag>}>
      <p className="text-base font-semibold text-ink">{OASIS_NOT_CHECKED}</p>
      <p className="mt-1 max-w-4xl text-sm leading-relaxed text-ink-2">
        The settings on screen are {viewName(settings)}, {settings.referenceAssumptions ? "reference assumptions" : "with assumptions agreed by the agents or typed over"}. {OASIS_COVERED_LINE}
        {why ? ` ${why}` : ""}
      </p>
      {hint && onShowChecked && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button onClick={onShowChecked}>Show the checked settings</Button>
          <span className="text-sm text-muted">Sets the switches in the bar above to the nearest settings Oasis was run on.</span>
        </div>
      )}
      <p className="mt-3 max-w-4xl text-sm leading-relaxed text-muted">
        {hint ? `${hint} ` : ""}To check any other settings, download the building-level export below and run it through Oasis as described there.
      </p>
    </Card>
  );
}

/**
 * The Oasis run made for the settings in force, beside the portfolio result on screen. `dataset`
 * and `result` are the ones in force (with drainage when it is on), and `source` says whether the
 * assumptions are the reference set or the agents'. `runs` is what useOasisRuns read. `onShowChecked`
 * sets the switches to the nearest settings a run exists for, for the button on the "Not checked" card.
 */
export function OasisCheck({ dataset, result, source, runs, onShowChecked }: { dataset: Dataset; result: ModelResult; source: Active["source"]; runs: OasisRuns | null; onShowChecked?: () => void }) {
  const settings = oasisSettings(dataset, result, source);
  const spec = oasisRunFor(settings);
  if (!spec) return <NotChecked settings={settings} onShowChecked={onShowChecked} />;
  if (!runs) {
    return (
      <Card title={TITLE}>
        <p className="text-sm text-muted">Reading the Oasis run for {viewName(settings)}, reference assumptions.</p>
      </Card>
    );
  }
  const run = runs[spec.file];
  if (!oasisChecked(spec, run, dataset, result)) {
    const why = run === null || run === undefined
      ? `The file for these settings, ${spec.file}, is not present under web/public/oasis.`
      : `The file for these settings, ${spec.file}, was made for another result (fingerprint ${run.view?.fingerprint ?? "none"}; this result is ${resultFingerprint(result)}), so it is not shown.`;
    return <NotChecked settings={settings} why={why} />;
  }

  // oasisChecked has settled that the file was fed the way the spec says, so the spec's mode is the file's.
  const byRatio = spec.mode === "damage_ratios";
  const allDrivers = settings.lossesFrom === "all_drivers";
  const drainage = settings.floodSource === "terrain_drainage";
  const rows = run.events.map((e) => {
    const live = result.scenarios.find((s) => s.id === e.tier)?.lossKes ?? NaN;
    return { ...e, live, d: diff(live, e.oasisLossKes) };
  });
  const liveBanded = bandedAal(result);
  const aalDiff = diff(liveBanded, run.aal.oasisKes);
  const worst = Math.max(...rows.map((x) => Math.abs(x.d)), Math.abs(aalDiff));
  const agrees = worst < 0.005;

  return (
    <Card
      title={TITLE}
      aside={
        <span className="inline-flex flex-wrap gap-2">
          <Tag kind="real">Oasis LMF {run.oasislmfVersion}</Tag>
          <Tag kind="assumption">Reference assumptions</Tag>
        </span>
      }
    >
      <p className="-mt-2 text-sm leading-relaxed text-ink-2">
        <strong className="font-semibold text-ink">View checked: {viewName(settings)}, reference assumptions.</strong> It is the view in force now (result fingerprint <span className="font-mono">{run.view.fingerprint}</span>).
      </p>
      {/* What this run did and did not check: said in full, above the figures, and never folded away. */}
      <p className="mt-2 max-w-4xl text-base font-semibold leading-relaxed text-ink">{OASIS_CHECKED_LINE[spec.mode]}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-xl text-sm">
          <caption className="pb-2 text-left text-sm leading-relaxed text-ink-2">
            One row per modelled flood, with the ground-up loss (before deductibles and reinsurance) from each engine, then the average annual loss by the step method both can share. The last column is how far Oasis sits from this app; under half a percent counts as agreement.
          </caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="pb-2 text-left font-medium">Flood (return period, annual chance)</th>
              <th scope="col" className="pb-2 pl-3 text-right font-medium">This app (KES m)</th>
              <th scope="col" className="pb-2 pl-3 text-right font-medium">Oasis LMF (KES m)</th>
              <th scope="col" className="pb-2 pl-3 text-right font-medium">Difference (%)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((x) => (
              <tr key={x.tier}>
                <td className="py-1.5 text-ink">
                  {rpWithChance(x.returnPeriod)} <span className="text-xs text-muted">({x.tier})</span>
                </td>
                <td className="tabular py-1.5 pl-3 text-right text-ink">{millions(x.live)}</td>
                <td className="tabular py-1.5 pl-3 text-right text-ink">{millions(x.oasisLossKes)}</td>
                <td className="tabular py-1.5 pl-3 text-right text-ink-2">{signedPct(x.d)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-axis">
              <td className="py-1.5 font-semibold text-ink">Average annual loss, step method</td>
              <td className="tabular py-1.5 pl-3 text-right font-semibold text-ink">{millions(liveBanded)}</td>
              <td className="tabular py-1.5 pl-3 text-right font-semibold text-ink">{millions(run.aal.oasisKes)}</td>
              <td className="tabular py-1.5 pl-3 text-right text-ink-2">{signedPct(aalDiff)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-4xl text-sm leading-relaxed text-ink-2">
        <strong className="font-semibold text-ink">Largest gap at any flood: {eventDiffPct(run.maxEventDiffPct)}.</strong>{" "}
        {agrees ? "Oasis agrees with this app to within half a percent at every flood and on the step average annual loss." : "The two engines disagree by more than half a percent somewhere; see oasis/README.md before relying on these figures."}{" "}
        The gap is Oasis storing {byRatio ? "damage ratios in 0.1% steps" : "depth in 1 mm steps and damage in 0.1% steps"}, nothing else.
      </p>
      <p className="mt-2 max-w-4xl text-xs leading-relaxed text-muted">
        The headline average annual loss elsewhere in this app is {kes1(result.aalKes)} for this view: it draws a straight line between the five floods on the loss against annual chance chart, which adds half of each step, so it sits {fmtPct(result.aalKes / liveBanded - 1, 0)} above the step figure. Oasis counts each flood for its own band of annual chance only, and so does the row above. Both treat floods more frequent than {rpLabel(result.scenarios[0]?.returnPeriod ?? NaN)} as causing no loss. Run on {runDate(run.generatedAt)}, {fmtInt(run.samples)} samples, {fmtInt(run.periods)} simulated years, insured values as in the file.
      </p>
      <SourceLine
        className="mt-3 border-t border-line pt-3"
        sources={[
          { kind: "real", text: `Oasis LMF ${run.oasislmfVersion} output, ${spec.file}: totals only, never a building` },
          { kind: "synthetic", text: "Portfolio of insured buildings, the same file in both engines" },
          { kind: "real", text: dataset.hazardKind === "score" ? "Hazard maps; the score on them is a derived proxy for flooding" : "Flood depth maps" },
          {
            kind: "assumption",
            text: `Reference assumptions: return periods, depth scale, fragility and caps${drainage ? ", the drainage reach and ponding depths" : ""}${allDrivers ? ", the buffer, the drain design return period and the drain overload depth" : ""}`,
          },
        ]}
      />
    </Card>
  );
}
