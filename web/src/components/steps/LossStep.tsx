"use client";

import { motion } from "motion/react";
import { useMemo, useState } from "react";
import type { Check } from "@/lib/checks";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { HOUSING_LABELS } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { Card, CheckList, ChecksSummary, Segmented, StepHeader, Tag } from "../ui";

export function LossStep({ session, active, checks }: { session: Session; active: Active; checks: Check[] }) {
  const { dataset } = session;
  const r = active.result;
  const isScore = dataset.hazardKind === "score";
  const last = r.scenarios.length - 1;
  const [scenario, setScenario] = useState(last);
  const k = Math.min(scenario, last);
  const maxLoss = Math.max(...r.scenarios.map((s) => s.lossKes), 1);

  // Largest losses in the chosen scenario; the trace opens on the biggest one.
  const ranked = useMemo(
    () => r.buildings.map((b, i) => ({ i, loss: b.perScenario[k].lossKes })).filter((x) => x.loss > 0).sort((a, b) => b.loss - a.loss).slice(0, 8),
    [r, k],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const traceIndex = ranked.find((x) => dataset.buildings[x.i].locId === picked)?.i ?? ranked[0]?.i ?? 0;
  const b = dataset.buildings[traceIndex];
  const t = r.buildings[traceIndex]?.perScenario[k];
  const s = r.scenarios[k];

  return (
    <div>
      <StepHeader kicker="Step 5" title="Loss engine">
        For every building and every scenario: hazard value, to depth, to damage ratio, times insured value. The scenario loss is the sum. Nothing here is estimated by a model; it is arithmetic you can follow by hand.
      </StepHeader>

      <Card title="Loss by scenario" aside={<Tag kind="synthetic">Synthetic portfolio</Tag>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="pb-2 text-left font-medium">Return period</th>
                <th className="pb-2 text-left font-medium">Scenario</th>
                <th className="pb-2 text-right font-medium">Buildings affected</th>
                <th className="pb-2 text-right font-medium">Value in affected cells</th>
                <th className="pb-2 text-right font-medium">Loss</th>
                <th className="w-[26%] pb-2 pl-4 text-left font-medium">Share of total insured value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {r.scenarios.map((sc, i) => (
                <tr key={sc.id}>
                  <td className="tabular py-2.5 font-medium text-ink">1 in {sc.returnPeriod}</td>
                  <td className="py-2.5 text-ink-2">{sc.id}</td>
                  <td className="tabular py-2.5 text-right text-ink-2">{fmtInt(sc.affected)}</td>
                  <td className="tabular py-2.5 text-right text-ink-2">{fmtKes(sc.tivExposedKes)}</td>
                  <td className="tabular py-2.5 text-right font-semibold text-ink">{fmtKes(sc.lossKes, 2)}</td>
                  <td className="py-2.5 pl-4">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-r-full bg-surface-2">
                        <motion.div className="h-2 rounded-r-full" style={{ background: "var(--accent)" }} initial={{ width: 0 }} animate={{ width: `${(sc.lossKes / maxLoss) * 100}%` }} transition={{ duration: 0.7, delay: 0.15 * i, ease: "easeOut" }} />
                      </div>
                      <span className="tabular w-14 text-right text-xs text-ink-2">{fmtPct(sc.lossKes / r.totalTivKes, 2)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        <Card title="Follow one building" aside={<Segmented label="Scenario" value={String(k)} onChange={(v) => setScenario(Number(v))} options={r.scenarios.map((sc, i) => ({ value: String(i), label: `1 in ${sc.returnPeriod}` }))} />}>
          {ranked.length === 0 || !t ? (
            <p className="text-sm text-ink-2">No building takes a loss in this scenario.</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {ranked.map((x) => {
                  const id = dataset.buildings[x.i].locId;
                  return (
                    <button key={id} onClick={() => setPicked(id)} className={`rounded-full border px-2.5 py-1 font-mono text-xs transition ${x.i === traceIndex ? "border-ink bg-ink text-surface" : "border-line text-ink-2 hover:border-axis"}`}>
                      {id}
                    </button>
                  );
                })}
                <span className="self-center pl-1 text-xs text-muted">largest losses in this scenario</span>
              </div>

              <motion.ol key={`${b.locId}-${k}`} className="space-y-2" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.12 } } }}>
                {[
                  { label: "The building", value: `${b.locId} · ${HOUSING_LABELS[b.housingClass]}`, how: `Insured value ${fmtKes(b.tivKes, 2)}, at ${fmtNum(b.lat, 4)}, ${fmtNum(b.lon, 4)}`, tag: "synthetic" as const },
                  { label: isScore ? "Hazard score" : "Flood depth", value: isScore ? fmtNum(t.hazard, 3) : `${fmtNum(t.hazard)} m`, how: `Read from the "${s.id}" map at the building's coordinates`, tag: (isScore ? "proxy" : "real") as "proxy" | "real" },
                  ...(isScore ? [{ label: "Assumed depth", value: `${fmtNum(t.depthM)} m`, how: `${fmtNum(t.hazard, 3)} × ${fmtNum(active.params.depthScaleM)} m`, tag: (active.source === "ai" ? "ai" : "assumption") as "ai" | "assumption" }] : []),
                  { label: "Depth on the curve", value: `${fmtNum(t.effectiveDepthM)} m`, how: `${fmtNum(t.depthM)} m × fragility ${fmtNum(active.params.fragility[b.housingClass])}`, tag: (active.source === "ai" ? "ai" : "assumption") as "ai" | "assumption" },
                  { label: "Damage ratio", value: fmtPct(t.damageRatio, 1), how: t.capped ? `JRC curve gives ${fmtPct(t.curveDamage, 1)}, limited by the ${fmtPct(active.params.cap[b.housingClass], 0)} cap` : `JRC curve at ${fmtNum(t.effectiveDepthM)} m; under the ${fmtPct(active.params.cap[b.housingClass], 0)} cap`, tag: "real" as const },
                  { label: "Loss", value: fmtKes(t.lossKes, 2), how: `${fmtPct(t.damageRatio, 1)} × ${fmtKes(b.tivKes, 2)}`, tag: null },
                ].map((row, i, all) => (
                  <motion.li key={row.label} variants={{ hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0 } }} className={`flex items-center justify-between gap-4 rounded-xl px-3.5 py-2.5 ${i === all.length - 1 ? "bg-ink text-surface" : "bg-surface-2"}`}>
                    <div className="min-w-0">
                      <div className={`text-xs ${i === all.length - 1 ? "opacity-70" : "text-muted"}`}>{row.label}</div>
                      <div className={`text-[13px] ${i === all.length - 1 ? "opacity-80" : "text-ink-2"}`}>{row.how}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      {row.tag && <Tag kind={row.tag}>{row.label === "Damage ratio" ? "JRC curve" : undefined}</Tag>}
                      <span className="tabular text-base font-semibold">{row.value}</span>
                    </div>
                  </motion.li>
                ))}
              </motion.ol>
            </>
          )}
        </Card>

        <Card title="Checks on the arithmetic" aside={<ChecksSummary checks={checks} />}>
          <CheckList checks={checks} />
        </Card>
      </div>
    </div>
  );
}
