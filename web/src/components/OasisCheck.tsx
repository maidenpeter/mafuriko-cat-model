"use client";

import { useEffect, useState } from "react";
import { fmtKes, fmtPct } from "@/lib/format";
import { bandedAal } from "@/lib/model/financial";
import { flattenParams, REFERENCE_PARAMS } from "@/lib/model/params";
import type { ModelParams } from "@/lib/model/types";
import type { Session } from "@/lib/session";
import { Card, Tag } from "./ui";

/** The summary written by oasis/build_and_run.py after a run through the Oasis LMF engine. */
interface OasisRun {
  engine: string;
  oasislmfVersion: string;
  generatedAt: string;
  dataset: string;
  tivBasis: "file" | "documented";
  params: ModelParams;
  samples: number;
  periods: number;
  events: { tier: string; returnPeriod: number; oasisLossKes: number; ourLossKes: number }[];
  aal: { oasisKes: number; ourTrapezoidKes: number; ourDiscreteKes: number };
  maxEventDiffPct: number;
  notes: string[];
}

const sameParams = (a: ModelParams, b: ModelParams) => {
  const fa = flattenParams(a);
  const fb = new Map(flattenParams(b).map((p) => [p.path, p.value]));
  return fa.every((p) => Math.abs(p.value - (fb.get(p.path) ?? NaN)) < 1e-9);
};

const diff = (ours: number, theirs: number) => (ours === 0 ? 0 : theirs / ours - 1);
const signedPct = (f: number) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(3)}%`;

export function OasisCheck({ session }: { session: Session }) {
  const [run, setRun] = useState<OasisRun | null | "missing">(null);

  useEffect(() => {
    fetch("/oasis/reference.json")
      .then((r) => (r.ok ? r.json() : "missing"))
      .then(setRun)
      .catch(() => setRun("missing"));
  }, []);

  const ref = session.reference;
  const title = "Independent check: the same model run through Oasis LMF";

  if (run === null) return null;
  if (run === "missing" || run.dataset !== session.dataset.name || run.tivBasis !== "file" || !sameParams(run.params, REFERENCE_PARAMS)) {
    return (
      <Card title={title} className="mt-4" aside={<Tag kind="none">Not run for this data</Tag>}>
        <p className="text-sm leading-relaxed text-ink-2">
          No Oasis run matches this dataset and the reference assumptions. Run <code className="font-mono text-sm">python oasis/build_and_run.py</code> from the project folder (see <code className="font-mono text-sm">oasis/README.md</code>) to produce one.
        </p>
      </Card>
    );
  }

  const rows = run.events.map((e) => {
    const live = ref.scenarios.find((s) => s.id === e.tier)?.lossKes ?? NaN;
    return { ...e, live, d: diff(live, e.oasisLossKes) };
  });

  // The run records what our engine gave at the time. If that no longer matches the live engine,
  // the data or the engine has changed since, and the comparison would mislead.
  const stale = rows.some((x) => !(Math.abs(diff(x.live, x.ourLossKes)) < 0.001));
  if (stale) {
    return (
      <Card title={title} className="mt-4" aside={<Tag kind="none">Out of date</Tag>}>
        <p className="text-sm leading-relaxed text-ink-2">
          The saved Oasis run ({run.generatedAt.slice(0, 10)}) was made for different data or an earlier version of the engine, so it is not compared here. Run <code className="font-mono text-sm">python oasis/build_and_run.py</code> again to refresh it.
        </p>
      </Card>
    );
  }
  const liveBanded = bandedAal(ref);
  const worst = Math.max(...rows.map((x) => Math.abs(x.d)), Math.abs(diff(liveBanded, run.aal.oasisKes)));
  const agrees = worst < 0.005;

  return (
    <Card
      title={title}
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
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
          Oasis is the open-source loss modelling framework used across the insurance industry. We wrote this portfolio as an Oasis exposure file and our hazard and damage assumptions as Oasis model files, then let the Oasis engine compute the losses and the loss curve on its own. {agrees ? "It agrees with this app to within half a percent at every event." : "The two engines disagree by more than half a percent; see the notes below."}
        </p>
        <div className="min-w-0 overflow-x-auto @6xl:col-start-2 @6xl:row-span-2 @6xl:row-start-1">
          <table className="w-full min-w-140 text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="pb-2 text-left font-medium">Event</th>
                <th className="pb-2 text-right font-medium">This app</th>
                <th className="pb-2 text-right font-medium">Oasis LMF</th>
                <th className="pb-2 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((x) => (
                <tr key={x.tier}>
                  <td className="py-2 text-ink">
                    1 in {x.returnPeriod} <span className="text-xs text-muted">({x.tier})</span>
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
        </div>
        <p className="max-w-3xl text-xs leading-relaxed text-muted @6xl:col-start-1 @6xl:row-start-2">
          The small differences come from Oasis storing depth in 1 mm steps and damage in 0.1% steps. Oasis counts each event only for its own band of annual probability, which gives the step value above. The average annual loss shown elsewhere in this app ({fmtKes(ref.aalKes, 2)} on reference assumptions) draws a straight line between events instead, so it sits {fmtPct(ref.aalKes / liveBanded - 1, 0)} higher. Both treat events more frequent than 1 in {ref.scenarios[0]?.returnPeriod} as causing no loss. Run on {run.generatedAt.slice(0, 10)}, {run.samples} samples, {run.periods.toLocaleString("en-KE")} simulated years, insured values as in the file.
        </p>
      </div>
    </Card>
  );
}
