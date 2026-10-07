"use client";

import { useMemo, useState } from "react";
import type { Deliberation } from "@/lib/agents/orchestrate";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { lossAtReturnPeriod, STANDARD_RETURN_PERIODS } from "@/lib/model/financial";
import { HOUSING_CLASSES, HOUSING_LABELS, type ModelResult } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { LineChart, valueAt, type Point } from "../charts/LineChart";
import { OasisCheck } from "../OasisCheck";
import { Card, Note, Segmented, Stat, StepHeader, Tag } from "../ui";
import { CLASS_COLORS } from "./DataStep";

const curve = (r: ModelResult): Point[] => r.scenarios.map((s) => ({ x: s.returnPeriod, y: s.lossKes }));
const signed = (fraction: number) => `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(0)}%`;

export function ResultsStep({ session, active, deliberation }: { session: Session; active: Active; deliberation: Deliberation | null }) {
  const { dataset, reference } = session;
  const r = active.result;
  const isScore = dataset.hazardKind === "score";
  const last = r.scenarios.length - 1;
  const [scenario, setScenario] = useState(last);
  const k = Math.min(scenario, last);
  const s = r.scenarios[k];
  const rarest = r.scenarios[last];
  const usingAi = active.source === "ai";

  const main = curve(r);
  const optimist = deliberation?.optimist ? curve(deliberation.optimist.result) : null;
  const cautious = deliberation?.cautious ? curve(deliberation.cautious.result) : null;

  // The range between the two proposals, drawn only where both curves exist.
  const band = useMemo(() => {
    if (!usingAi || !optimist || !cautious) return undefined;
    const lo = Math.max(optimist[0].x, cautious[0].x);
    const hi = Math.min(optimist[optimist.length - 1].x, cautious[cautious.length - 1].x);
    if (!(hi > lo)) return undefined;
    const xs = [...new Set([lo, hi, ...optimist.map((p) => p.x), ...cautious.map((p) => p.x)])].filter((x) => x >= lo && x <= hi).sort((a, b) => a - b);
    const at = (x: number) => [valueAt(optimist, x, "log")!, valueAt(cautious, x, "log")!];
    return { label: "Range between Optimist and Cautious", lower: xs.map((x) => ({ x, y: Math.min(...at(x)) })), upper: xs.map((x) => ({ x, y: Math.max(...at(x)) })) };
  }, [usingAi, optimist, cautious]);

  const allX = [...main, ...(usingAi ? curve(reference) : []), ...(band ? [...band.lower] : [])].map((p) => p.x);
  const xMin = Math.min(...allX);
  const xMax = Math.max(...allX);
  const xTicks = [2, 5, ...STANDARD_RETURN_PERIODS, 500, 1000].filter((x) => x >= xMin && x <= xMax);
  const hoverXs = [...new Set([...allX, ...xTicks])].sort((a, b) => a - b);

  const at100 = r.standardLosses.find((l) => l.returnPeriod === 100);
  const headline = at100?.lossKes != null ? { rp: 100, loss: at100.lossKes, extrapolated: at100.extrapolated } : { rp: rarest.returnPeriod, loss: rarest.lossKes, extrapolated: false };

  const refRarest = reference.scenarios[reference.scenarios.length - 1];
  const top = useMemo(
    () => r.buildings.map((b, i) => ({ i, p: b.perScenario[k] })).filter((x) => x.p.lossKes > 0).sort((a, b) => b.p.lossKes - a.p.lossKes).slice(0, 10),
    [r, k],
  );
  const top10Share = top.reduce((t, x) => t + x.p.lossKes, 0) / (s.lossKes || 1);
  const maxClassLoss = Math.max(...HOUSING_CLASSES.map((c) => s.byClass[c].lossKes), 1);

  return (
    <div>
      <StepHeader kicker="Step 7" title="Results">
        What an underwriter needs: how large the loss could be at each level of rarity, what an average year costs, and where the loss comes from.
      </StepHeader>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr_1fr]">
        <Stat
          hero
          label={`Loss in a 1-in-${headline.rp}-year flood`}
          value={fmtKes(headline.loss, 2)}
          note={<>{fmtPct(headline.loss / r.totalTivKes, 2)} of insured value{headline.extrapolated ? " · held flat beyond the rarest modelled scenario" : ""} · <Tag kind={usingAi ? "ai" : "assumption"}>{usingAi ? "Agreed assumptions" : "Reference assumptions"}</Tag></>}
        />
        <div className="grid gap-4">
          <Stat label="Total insured value" value={fmtKes(r.totalTivKes)} note={<><Tag kind="synthetic" /> {fmtInt(r.buildingCount)} buildings</>} />
          <Stat label="Average annual loss" value={fmtKes(r.aalKes, 2)} note={`${fmtPct(r.aalKes / r.totalTivKes, 3)} of insured value per year`} />
        </div>
        <div className="grid gap-4">
          <Stat label={`Rarest scenario modelled (1 in ${rarest.returnPeriod})`} value={fmtKes(rarest.lossKes, 2)} note={`${fmtInt(rarest.affected)} of ${fmtInt(r.buildingCount)} buildings affected`} />
          <Stat label="Value in affected cells, rarest scenario" value={fmtPct(rarest.tivExposedKes / r.totalTivKes, 0)} note={`${fmtKes(rarest.tivExposedKes)} of accumulation`} />
        </div>
      </div>

      <Card title="Loss curve: how large a loss, how often" className="mt-4" aside={<span className="inline-flex flex-wrap gap-2">{isScore && <Tag kind="assumption">Return periods assumed</Tag>}<Tag kind="synthetic" /></span>}>
        <LineChart
          xScale="log"
          xTicks={xTicks}
          xFormat={(x) => `1 in ${fmtNum(x, 0)}`}
          yFormat={(y) => fmtKes(y, y >= 1e9 ? 1 : 0)}
          xLabel="Return period (years). Further right is rarer."
          hoverXs={hoverXs}
          band={band}
          series={[
            { id: "main", label: usingAi ? "Agreed assumptions" : "Reference assumptions", color: "var(--accent)", points: main, markers: true },
            ...(usingAi ? [{ id: "reference", label: "Reference assumptions, without AI", color: "var(--muted)", points: curve(reference), quiet: true }] : []),
          ]}
        />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="pb-2 text-left font-medium">Return period</th>
                <th className="pb-2 text-right font-medium">{usingAi ? "Agreed" : "Reference"}</th>
                {usingAi && <th className="pb-2 text-right font-medium">Without AI</th>}
                {usingAi && deliberation?.optimist && <th className="pb-2 text-right font-medium">Optimist</th>}
                {usingAi && deliberation?.cautious && <th className="pb-2 text-right font-medium">Cautious</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {r.standardLosses.map((l) => {
                const cell = (res: ModelResult) => {
                  const v = lossAtReturnPeriod(res.scenarios.map((x) => ({ returnPeriod: x.returnPeriod, lossKes: x.lossKes })), l.returnPeriod);
                  return v.lossKes === null ? "not modelled" : `${fmtKes(v.lossKes, 2)}${v.extrapolated ? " †" : ""}`;
                };
                return (
                  <tr key={l.returnPeriod}>
                    <td className="tabular py-2 text-ink">1 in {l.returnPeriod}</td>
                    <td className="tabular py-2 text-right font-semibold text-ink">{cell(r)}</td>
                    {usingAi && <td className="tabular py-2 text-right text-ink-2">{cell(reference)}</td>}
                    {usingAi && deliberation?.optimist && <td className="tabular py-2 text-right text-ink-2">{cell(deliberation.optimist.result)}</td>}
                    {usingAi && deliberation?.cautious && <td className="tabular py-2 text-right text-ink-2">{cell(deliberation.cautious.result)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs leading-relaxed text-muted">Between modelled scenarios, loss is read off a straight line against the logarithm of the return period. &ldquo;Not modelled&rdquo; means the event is more frequent than the most frequent scenario. † held flat beyond the rarest scenario.</p>
        </div>
      </Card>

      {usingAi && deliberation?.final ? (
        <Card title="What the AI changed" className="mt-4" aside={<Tag kind="ai" />}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><div className="text-sm text-ink-2">Rarest scenario loss</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(refRarest.lossKes, 2)} → {fmtKes(rarest.lossKes, 2)}</div><div className="text-xs text-muted">{signed(rarest.lossKes / refRarest.lossKes - 1)} against reference{rarest.returnPeriod !== refRarest.returnPeriod ? `; return period 1 in ${refRarest.returnPeriod} → 1 in ${rarest.returnPeriod}` : ""}</div></div>
            <div><div className="text-sm text-ink-2">Average annual loss</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(reference.aalKes, 2)} → {fmtKes(r.aalKes, 2)}</div><div className="text-xs text-muted">{signed(r.aalKes / reference.aalKes - 1)} against reference</div></div>
            {deliberation.optimist && deliberation.cautious && (
              <div><div className="text-sm text-ink-2">Range of average annual loss</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(Math.min(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes), 2)} – {fmtKes(Math.max(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes), 2)}</div><div className="text-xs text-muted">Optimist to Cautious</div></div>
            )}
          </div>
          {deliberation.runs.chair.output && <p className="mt-4 text-sm leading-relaxed text-ink-2">{deliberation.runs.chair.output.summary}</p>}
        </Card>
      ) : (
        <div className="mt-4"><Note>These results use the reference assumptions only. Run the agents in step 3 to see how their agreed assumptions change the curve.</Note></div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-ink">Where the loss comes from</h3>
        <Segmented label="Scenario" value={String(k)} onChange={(v) => setScenario(Number(v))} options={r.scenarios.map((sc, i) => ({ value: String(i), label: `1 in ${sc.returnPeriod}` }))} />
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <Card title="By construction class" aside={<span className="text-xs text-muted">Buildings beside money</span>}>
          <table className="w-full text-[13px]">
            <thead className="text-xs text-muted">
              <tr><th className="pb-2 text-left font-medium">Class</th><th className="pb-2 text-right font-medium">Affected</th><th className="pb-2 text-right font-medium">Insured value</th><th className="pb-2 text-right font-medium">Loss</th></tr>
            </thead>
            <tbody>
              {HOUSING_CLASSES.map((c) => {
                const cls = s.byClass[c];
                return (
                  <tr key={c} className="border-t border-line align-top">
                    <td className="py-2 pr-2">
                      <span className="inline-flex items-center gap-2 text-ink"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CLASS_COLORS[c] }} />{HOUSING_LABELS[c]}</span>
                      <div className="mt-1.5 h-1.5 rounded-r-full bg-surface-2"><div className="h-1.5 rounded-r-full" style={{ width: `${(cls.lossKes / maxClassLoss) * 100}%`, background: CLASS_COLORS[c] }} /></div>
                    </td>
                    <td className="tabular py-2 text-right text-ink-2">{fmtInt(cls.affected)} of {fmtInt(cls.count)}</td>
                    <td className="tabular py-2 text-right text-ink-2">{fmtKes(cls.tivKes)}</td>
                    <td className="tabular py-2 text-right font-semibold text-ink">{fmtKes(cls.lossKes, 2)}<div className="text-xs font-normal text-muted">{fmtPct(cls.lossKes / (s.lossKes || 1), 1)} of loss</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs leading-relaxed text-muted">Loss follows insured value, so a few large concrete buildings dominate. The informal and semi-permanent buildings are many, but carry little insured value.</p>
        </Card>

        <Card title="Largest single losses" aside={<span className="text-xs text-muted">Top {top.length} are {fmtPct(top10Share, 0)} of this scenario</span>}>
          {top.length === 0 ? (
            <p className="text-sm text-ink-2">No losses in this scenario.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-xs text-muted">
                <tr><th className="pb-2 text-left font-medium">Building</th><th className="pb-2 text-left font-medium">Class</th><th className="pb-2 text-right font-medium">{isScore ? "Score" : "Depth"}</th><th className="pb-2 text-right font-medium">Damage</th><th className="pb-2 text-right font-medium">Loss</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {top.map(({ i, p }) => (
                  <tr key={dataset.buildings[i].locId}>
                    <td className="py-1.5 font-mono text-xs text-ink">{dataset.buildings[i].locId}</td>
                    <td className="py-1.5 text-ink-2">{HOUSING_LABELS[dataset.buildings[i].housingClass]}</td>
                    <td className="tabular py-1.5 text-right text-ink-2">{fmtNum(p.hazard, isScore ? 3 : 2)}</td>
                    <td className="tabular py-1.5 text-right text-ink-2">{fmtPct(p.damageRatio, 0)}</td>
                    <td className="tabular py-1.5 text-right font-semibold text-ink">{fmtKes(p.lossKes, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <OasisCheck session={session} />
    </div>
  );
}
