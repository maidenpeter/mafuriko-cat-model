"use client";

import { fmtBytes, fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { kes1 } from "@/lib/labels";
import { HOUSING_CLASSES, HOUSING_LABELS, type HousingClass } from "@/lib/model/types";
import type { Session } from "@/lib/session";
import { stepKicker } from "@/lib/steps";
import { ChartFrame, SourceBadge } from "../charts/ChartFrame";
import { Card, CheckList, ChecksSummary, Note, Stat, StepHeader, Tag } from "../ui";

export const CLASS_COLORS: Record<HousingClass, string> = {
  informal_iron_sheet: "var(--series-1)",
  semi_permanent: "var(--series-2)",
  permanent_masonry: "var(--series-3)",
  concrete_rcc: "var(--series-4)",
};

const KIND_LABEL = { exposure: "Exposure", "hazard-raster": "Hazard map", hotspots: "Hotspots", offer: "Offer", other: "Other" } as const;

export function DataStep({ session }: { session: Session }) {
  const { dataset, report, reference } = session;
  const widest = reference.scenarios[reference.scenarios.length - 1];
  const ratio = report.tivRatio;
  const discrepancy = ratio && Math.abs(ratio.median - 1) >= 0.05;

  return (
    <div>
      <StepHeader kicker={stepKicker("data")} title="Read the data">
        {fmtInt(dataset.buildings.length)} buildings and {dataset.rasters.length} hazard maps were read from <strong className="font-semibold text-ink">{session.uploadName}</strong>. Nothing has been modelled yet; this step only confirms what was received.
      </StepHeader>

      {/* One grid for the figures, the warning, the checks and the value split, so no card leaves a hole beside a taller one.
          Two columns: the figures run across the top and the checks stand beside the warning and the value split.
          With more room the figures join the left column and the checks take the whole right side.
          The widths are in rem of the chosen text size. The last row takes up the slack, so the two columns end level.
          The taller side gets the wider column: the checks while the figures are above them, the left side once the figures join it. */}
      <div className={`grid gap-4 @3xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] @6xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] ${discrepancy ? "@3xl:grid-rows-[auto_auto_1fr]" : "@3xl:grid-rows-[auto_1fr]"}`}>
        {/* In the half-width column each figure takes the width its own text needs, so the longest label stays on one line. */}
        <div className="grid gap-4 @xl:grid-cols-3 @3xl:col-span-2 @6xl:col-span-1 @6xl:grid-cols-[repeat(3,auto)]">
          <Stat label="Buildings" value={fmtInt(dataset.buildings.length)} note={<Tag kind="synthetic" />} />
          <Stat label="Total insured value" value={kes1(reference.totalTivKes)} note={<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"><SourceBadge kind="synthetic" /> As written in the file</span>} />
          <Stat label="Hazard maps" value={dataset.rasters.length || "None"} note={<Tag kind={dataset.hazardKind === "score" ? "proxy" : "real"}>{dataset.hazardKind === "score" ? "Susceptibility score, 0 to 1" : "Flood depth, metres"}</Tag>} />
        </div>

        {discrepancy && (
          <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-2">
            <Note tone="warn">
              <strong className="font-semibold text-ink">Insured values do not match their own formula.</strong> Every row&apos;s value is {fmtNum(ratio.median, 1)}× its floor area × cost per m². The file totals {kes1(reference.totalTivKes)}; the documented formula gives {kes1(reference.totalTivKes / ratio.median)}. The model uses the values as they are in the file, so every loss figure carries this factor.
            </Note>
          </div>
        )}

        <Card title="Checks on the data" aside={<ChecksSummary checks={session.dataChecks} />} className={`@3xl:col-start-2 @3xl:row-start-2 @6xl:row-start-1 ${discrepancy ? "@3xl:row-span-2 @6xl:row-span-3" : "@6xl:row-span-2"}`}>
          <CheckList checks={session.dataChecks} />
        </Card>

        <ChartFrame
          title="Who holds the value"
          subtitle="Each housing class has two bars: its share of the buildings on top, and its share of the total insured value under it. Where the two differ, the class holds more or less money than its number of buildings suggests."
          aside={<span className="text-xs text-muted">Buildings beside money</span>}
          sources={[{ kind: "synthetic", text: "Portfolio of insured buildings and their insured values, as written in the exposure file" }]}
          className={`flex flex-col @3xl:col-start-1 ${discrepancy ? "@3xl:row-start-3" : "@3xl:row-start-2"}`}
        >
          {/* Where the card is stretched to end level with the checks, the classes share the extra height as equal rows. */}
          <div className="flex flex-1 flex-col divide-y divide-line">
            {HOUSING_CLASSES.map((c) => {
              const cls = widest.byClass[c];
              const countShare = cls.count / dataset.buildings.length;
              const valueShare = cls.tivKes / reference.totalTivKes;
              return (
                <div key={c} className="flex flex-1 flex-col justify-center py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    <span className="inline-flex items-center gap-2 text-ink"><span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CLASS_COLORS[c] }} />{HOUSING_LABELS[c]}</span>
                    <span className="tabular ml-auto text-ink-2">{fmtInt(cls.count)} buildings · {kes1(cls.tivKes)}</span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-xs text-muted">
                    <span>Buildings</span>
                    <span className="h-1.5 rounded-full bg-surface-2" title={`${HOUSING_LABELS[c]}: ${fmtInt(cls.count)} buildings, ${fmtPct(countShare, 1)} of all buildings`}><span className="block h-1.5 rounded-full" style={{ width: `${countShare * 100}%`, background: CLASS_COLORS[c] }} /></span>
                    <span className="tabular text-right">{fmtPct(countShare, 0)}</span>
                    <span>Insured value</span>
                    <span className="h-1.5 rounded-full bg-surface-2" title={`${HOUSING_LABELS[c]}: ${kes1(cls.tivKes)}, ${fmtPct(valueShare, 1)} of the total insured value`}><span className="block h-1.5 rounded-full" style={{ width: `${valueShare * 100}%`, background: CLASS_COLORS[c] }} /></span>
                    <span className="tabular text-right">{fmtPct(valueShare, valueShare < 0.01 ? 1 : 0)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </ChartFrame>
      </div>

      <Card title="Files in the upload" className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 text-left text-sm">
            <thead className="text-xs text-muted">
              <tr><th className="pb-2 font-medium">File</th><th className="pb-2 font-medium">Role</th><th className="pb-2 font-medium">Source</th><th className="pb-2 font-medium">What it holds</th><th className="pb-2 text-right font-medium">Size</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {/* An offer is not a model input, but it is used: it goes to the offer step. */}
              {report.files.map((f) => (
                <tr key={f.path} className={f.used || f.kind === "offer" ? "text-ink" : "text-muted"}>
                  <td className="py-2 pr-4 font-mono text-sm wrap-anywhere">{f.name}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{f.used || f.kind === "offer" ? KIND_LABEL[f.kind] : "Not used"}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{f.used && f.provenance !== "none" ? <Tag kind={f.provenance} /> : "-"}</td>
                  <td className="py-2 pr-4 text-ink-2">{f.note}</td>
                  <td className="tabular whitespace-nowrap py-2 text-right text-ink-2">{fmtBytes(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
