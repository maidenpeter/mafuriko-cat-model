"use client";

import { fmtBytes, fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { HOUSING_CLASSES, HOUSING_LABELS, type HousingClass } from "@/lib/model/types";
import type { Session } from "@/lib/session";
import { Card, CheckList, ChecksSummary, Note, Stat, StepHeader, Tag } from "../ui";

export const CLASS_COLORS: Record<HousingClass, string> = {
  informal_iron_sheet: "var(--series-1)",
  semi_permanent: "var(--series-2)",
  permanent_masonry: "var(--series-3)",
  concrete_rcc: "var(--series-4)",
};

const KIND_LABEL = { exposure: "Exposure", "hazard-raster": "Hazard map", hotspots: "Hotspots", other: "Other" } as const;

export function DataStep({ session }: { session: Session }) {
  const { dataset, report, reference } = session;
  const widest = reference.scenarios[reference.scenarios.length - 1];
  const ratio = report.tivRatio;
  const discrepancy = ratio && Math.abs(ratio.median - 1) >= 0.05;

  return (
    <div>
      <StepHeader kicker="Step 1" title="Read the data">
        {fmtInt(dataset.buildings.length)} buildings and {dataset.rasters.length} hazard maps were read from <strong className="font-semibold text-ink">{session.uploadName}</strong>. Nothing has been modelled yet; this step only confirms what was received.
      </StepHeader>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Buildings" value={fmtInt(dataset.buildings.length)} note={<Tag kind="synthetic" />} />
        <Stat label="Total insured value" value={fmtKes(reference.totalTivKes)} note="As written in the file" />
        <Stat label="Hazard maps" value={dataset.rasters.length || "None"} note={<Tag kind={dataset.hazardKind === "score" ? "proxy" : "real"}>{dataset.hazardKind === "score" ? "Susceptibility score, 0 to 1" : "Flood depth, metres"}</Tag>} />
      </div>

      {discrepancy && (
        <div className="mt-4">
          <Note tone="warn">
            <strong className="font-semibold text-ink">Insured values do not match their own formula.</strong> Every row&apos;s value is {fmtNum(ratio.median, 1)}× its floor area × cost per m². The file totals {fmtKes(reference.totalTivKes)}; the documented formula gives {fmtKes(reference.totalTivKes / ratio.median)}. The model uses the values as they are in the file, so every loss figure carries this factor.
          </Note>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Checks on the data" aside={<ChecksSummary checks={session.dataChecks} />}>
          <CheckList checks={session.dataChecks} />
        </Card>

        <div className="min-w-0 space-y-4">
          <Card title="Who holds the value" aside={<span className="text-xs text-muted">Buildings beside money</span>}>
            <div className="space-y-3">
              {HOUSING_CLASSES.map((c) => {
                const cls = widest.byClass[c];
                const countShare = cls.count / dataset.buildings.length;
                const valueShare = cls.tivKes / reference.totalTivKes;
                return (
                  <div key={c}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                      <span className="inline-flex items-center gap-2 text-ink"><span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CLASS_COLORS[c] }} />{HOUSING_LABELS[c]}</span>
                      <span className="tabular ml-auto text-ink-2">{fmtInt(cls.count)} buildings · {fmtKes(cls.tivKes)}</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-[4.5rem_1fr_3rem] items-center gap-2 text-xs text-muted">
                      <span>Buildings</span>
                      <span className="h-1.5 rounded-full bg-surface-2"><span className="block h-1.5 rounded-full" style={{ width: `${countShare * 100}%`, background: CLASS_COLORS[c] }} /></span>
                      <span className="tabular text-right">{fmtPct(countShare, 0)}</span>
                      <span>Value</span>
                      <span className="h-1.5 rounded-full bg-surface-2"><span className="block h-1.5 rounded-full" style={{ width: `${valueShare * 100}%`, background: CLASS_COLORS[c] }} /></span>
                      <span className="tabular text-right">{fmtPct(valueShare, valueShare < 0.01 ? 1 : 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      <Card title="Files in the upload" className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 text-left text-sm">
            <thead className="text-xs text-muted">
              <tr><th className="pb-2 font-medium">File</th><th className="pb-2 font-medium">Role</th><th className="pb-2 font-medium">Source</th><th className="pb-2 font-medium">What it holds</th><th className="pb-2 text-right font-medium">Size</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {report.files.map((f) => (
                <tr key={f.path} className={f.used ? "text-ink" : "text-muted"}>
                  <td className="py-2 pr-4 font-mono text-sm wrap-anywhere">{f.name}</td>
                  <td className="py-2 pr-4">{f.used ? KIND_LABEL[f.kind] : "Not used"}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{f.used && f.provenance !== "none" ? <Tag kind={f.provenance} /> : "-"}</td>
                  <td className="py-2 pr-4 text-ink-2">{f.note}</td>
                  <td className="tabular py-2 text-right text-ink-2">{fmtBytes(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
