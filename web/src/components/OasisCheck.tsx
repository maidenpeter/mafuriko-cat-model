"use client";

import { useEffect, useState } from "react";
import { fmtKes, fmtPct } from "@/lib/format";
import { rpLabel, rpWithChance } from "@/lib/labels";
import { bandedAal } from "@/lib/model/financial";
import type { Dataset, ModelResult } from "@/lib/model/types";
import { OASIS_COVERED_LINE, OASIS_NOT_CHECKED, oasisChecked, oasisRunFor, oasisSettings, viewName, type OasisRunFile } from "@/lib/oasisExport";
import type { Active } from "@/lib/session";
import { SourceLine } from "./charts/ChartFrame";
import { Card, Tag } from "./ui";

const diff = (ours: number, theirs: number) => (ours === 0 ? 0 : theirs / ours - 1);
const signedPct = (f: number) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(3)}%`;

const TITLE = "Independent check: the same model run through Oasis LMF";

/** The settings in force have no Oasis run made for them, so no figure is shown: never a match from other settings. */
function NotChecked() {
  return (
    <Card title={TITLE} className="mt-4" aside={<Tag kind="none">Not checked</Tag>}>
      <p className="text-sm font-semibold text-ink">{OASIS_NOT_CHECKED}</p>
      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">{OASIS_COVERED_LINE}</p>
    </Card>
  );
}

/**
 * The Oasis run made for the settings in force, beside the portfolio result on screen.
 * `dataset` and `result` are the ones in force (with drainage when it is on), and `source` says
 * whether the assumptions are the reference set or the agents'. The file is chosen for exactly
 * that combination and shown only when it carries this result's fingerprint.
 */
export function OasisCheck({ dataset, result, source }: { dataset: Dataset; result: ModelResult; source: Active["source"] }) {
  const settings = oasisSettings(dataset, result, source);
  const spec = oasisRunFor(settings);
  const file = spec?.file ?? null;
  const [loaded, setLoaded] = useState<{ file: string; run: OasisRunFile | null } | null>(null);

  useEffect(() => {
    if (!file) return;
    let live = true;
    fetch(`/oasis/${file}`)
      .then((r) => (r.ok ? (r.json() as Promise<OasisRunFile>) : null))
      .catch(() => null)
      .then((run) => {
        if (live) setLoaded({ file, run });
      });
    return () => {
      live = false;
    };
  }, [file]);

  if (!spec) return <NotChecked />;
  // Still reading the file for these settings: nothing from the settings before is shown meanwhile.
  if (loaded?.file !== file) return null;
  const run = loaded.run;
  if (!oasisChecked(spec, run, dataset, result)) return <NotChecked />;

  const byRatio = run.mode === "damage_ratios";
  const allDrivers = settings.lossesFrom === "all_drivers";
  const drainage = settings.floodSource === "terrain_drainage";
  const rows = run.events.map((e) => {
    const live = result.scenarios.find((s) => s.id === e.tier)?.lossKes ?? NaN;
    return { ...e, live, d: diff(live, e.oasisLossKes) };
  });
  const liveBanded = bandedAal(result);
  const worst = Math.max(...rows.map((x) => Math.abs(x.d)), Math.abs(diff(liveBanded, run.aal.oasisKes)));
  const agrees = worst < 0.005;

  return (
    <Card
      title={TITLE}
      className="mt-4"
      aside={
        <span className="inline-flex flex-wrap gap-2">
          <Tag kind="real">Oasis LMF {run.oasislmfVersion}</Tag>
          <Tag kind="assumption">Reference assumptions</Tag>
        </span>
      }
    >
      {/* Where the step has the room, the explanation and the notes sit in a column beside the table,
          which keeps their lines short enough to read. Below that the order is explanation, table, notes. */}
      <div className="grid gap-x-10 gap-y-4 @6xl:grid-cols-[minmax(0,1fr)_minmax(35rem,1.2fr)] @6xl:grid-rows-[auto_1fr]">
        <div className="max-w-3xl space-y-2 text-sm leading-relaxed text-ink-2">
          <p>
            <strong className="font-semibold text-ink">View checked: {viewName(settings)}, reference assumptions.</strong> It is the view in force now (result fingerprint <span className="font-mono">{run.view.fingerprint}</span>).
          </p>
          <p>
            Oasis is the open-source loss modelling framework used across the insurance industry. We wrote this portfolio as an Oasis exposure file and let the Oasis engine compute the losses and the loss curve on its own.{" "}
            {byRatio
              ? "Oasis was given this app's final damage ratio for every building, after every loss driver, so it checks the financial engine and the loss arithmetic only. It does not check the damage function or the loss drivers."
              : "Oasis was given this app's depth of water at every building and applied the damage function itself, so it checks the damage function as well as the financial engine and the loss arithmetic."}{" "}
            {agrees ? "It agrees with this app to within half a percent at every event." : "The two engines disagree by more than half a percent; see the notes below."}
          </p>
        </div>
        <div className="min-w-0 overflow-x-auto @6xl:col-start-2 @6xl:row-span-2 @6xl:row-start-1">
          <table className="w-full min-w-140 text-sm">
            <caption className="pb-3 text-left text-sm leading-relaxed text-ink-2">
              Each row is one flood event, with the ground-up loss (before deductibles and reinsurance) from each engine. The last column is how far Oasis sits from this app; under half a percent counts as agreement.
            </caption>
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="pb-2 text-left font-medium">Event (return period, annual chance)</th>
                <th scope="col" className="pb-2 text-right font-medium">Ground-up loss, this app (KES)</th>
                <th scope="col" className="pb-2 text-right font-medium">Ground-up loss, Oasis LMF (KES)</th>
                <th scope="col" className="pb-2 text-right font-medium">Difference, Oasis against this app (%)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((x) => (
                <tr key={x.tier}>
                  <td className="py-2 text-ink">
                    {rpWithChance(x.returnPeriod)} <span className="text-xs text-muted">({x.tier})</span>
                  </td>
                  <td className="tabular py-2 text-right text-ink">{fmtKes(x.live, 2)}</td>
                  <td className="tabular py-2 text-right text-ink">{fmtKes(x.oasisLossKes, 2)}</td>
                  <td className="tabular py-2 text-right text-ink-2">{signedPct(x.d)}</td>
                </tr>
              ))}
              <tr>
                <td className="py-2 text-ink">Average annual loss, step method</td>
                <td className="tabular py-2 text-right text-ink">{fmtKes(liveBanded, 2)}</td>
                <td className="tabular py-2 text-right text-ink">{fmtKes(run.aal.oasisKes, 2)}</td>
                <td className="tabular py-2 text-right text-ink-2">{signedPct(diff(liveBanded, run.aal.oasisKes))}</td>
              </tr>
            </tbody>
          </table>
          <SourceLine
            className="mt-3 border-t border-line pt-3"
            sources={[
              { kind: "synthetic", text: "Portfolio of insured buildings, the same file in both engines" },
              { kind: "real", text: dataset.hazardKind === "score" ? "Hazard maps; the score on them is a derived proxy for flooding" : "Flood depth maps" },
              {
                kind: "assumption",
                text: `Reference assumptions: return periods, depth scale, fragility and caps${drainage ? ", the drainage reach and ponding depths" : ""}${allDrivers ? ", the buffer, the drain design return period and the drain overload depth" : ""}`,
              },
            ]}
          />
        </div>
        <p className="max-w-3xl text-xs leading-relaxed text-muted @6xl:col-start-1 @6xl:row-start-2">
          The small differences come from Oasis storing {byRatio ? "damage ratios in 0.1% steps" : "depth in 1 mm steps and damage in 0.1% steps"}. Oasis counts each event only for its own band of annual probability, which gives the step value above. The average annual loss shown elsewhere in this app ({fmtKes(result.aalKes, 2)} for this view) draws a straight line between events instead, so it sits {fmtPct(result.aalKes / liveBanded - 1, 0)} higher. Both treat events more frequent than {rpLabel(result.scenarios[0]?.returnPeriod ?? NaN)} as causing no loss. Run on {run.generatedAt.slice(0, 10)}, {run.samples} samples, {run.periods.toLocaleString("en-KE")} simulated years, insured values as in the file.
        </p>
      </div>
    </Card>
  );
}
