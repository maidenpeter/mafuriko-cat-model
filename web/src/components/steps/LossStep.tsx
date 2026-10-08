"use client";

import { motion } from "motion/react";
import { useMemo, useState } from "react";
import type { Check } from "@/lib/checks";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { annualChance, kes1, rpLabel, rpWithChance } from "@/lib/labels";
import type { InsuranceTerms, TermsResult } from "@/lib/model/terms";
import { HOUSING_LABELS } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, stepKicker } from "@/lib/steps";
import { ChartFrame, SourceLine, type ChartSource } from "../charts/ChartFrame";
import { Waterfall, type WaterfallStep } from "../charts/Waterfall";
import { TermsPanel } from "../TermsPanel";
import { Card, CheckList, ChecksSummary, Segmented, StepHeader, Tag } from "../ui";

interface Props {
  session: Session;
  active: Active;
  /** The checks on the arithmetic, the checks on the insurance terms among them. */
  checks: Check[];
  /** The insurance terms in force and what they do to every event. */
  terms: TermsResult;
  onTermsChange: (t: InsuranceTerms) => void;
}

export function LossStep({ session, active, checks, terms, onTermsChange }: Props) {
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

  // How the terms act, event by event. The chart opens on the event nearest 1-in-100.
  const layers = terms.scenarios;
  const anyOverLimit = layers.some((row) => row.overLimitKes > 0);
  const nearest100 = layers.reduce((best, row, i) => (Math.abs(Math.log(row.returnPeriod / 100)) < Math.abs(Math.log(layers[best].returnPeriod / 100)) ? i : best), 0);
  const [event, setEvent] = useState<string | null>(null);
  const layer = layers.find((row) => row.id === event) ?? layers[nearest100];
  const steps: WaterfallStep[] = layer
    ? [
        { label: "Ground-up", value: layer.groundUpKes, kind: "total" },
        { label: "Minus deductibles", value: layer.deductiblesKes, kind: "decrease" },
        ...(layer.overLimitKes > 0 ? [{ label: "Minus over limit", value: layer.overLimitKes, kind: "decrease" as const }] : []),
        { label: "Gross", value: layer.grossKes, kind: "total" },
        { label: "Minus quota share", value: layer.quotaShareKes, kind: "decrease" },
        { label: "Minus excess of loss", value: layer.xolKes, kind: "decrease" },
        { label: "Net", value: layer.netKes, kind: "total" },
      ]
    : [];
  const waterfallTitle = layer ? `From ground-up loss to net loss in a ${rpLabel(layer.returnPeriod)} event` : "";
  // Where the ground-up figures come from. The hazard maps are real data; a hazard score read from them is a proxy.
  const usingAi = active.source === "ai";
  const groundUpSources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
    { kind: "real", text: isScore ? "Hazard maps (the hazard score read from them is a derived proxy, not a measured depth) and the JRC depth-damage curve" : "Flood depth maps and the JRC depth-damage curve" },
    { kind: "assumption", text: isScore ? "Return periods of the hazard tiers, depth scale, fragility and damage caps" : "Fragility and damage caps" },
    ...(dataset.drainage ? [{ kind: "assumption" as const, text: "Drainage ponding depths" }] : []),
    ...(usingAi ? [{ kind: "ai" as const, text: "Hazard and damage assumptions agreed by the agents" }] : []),
  ];
  const termsSources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
    { kind: "assumption", text: "Insurance terms: example terms, not from any real policy or treaty" },
    { kind: isScore ? "assumption" : "real", text: isScore ? "Return periods attached to the hazard tiers" : "Return periods carried by the hazard maps" },
  ];

  return (
    <div>
      <StepHeader kicker={stepKicker("loss")} title={STEP_NAMES.loss}>
        For every building and every scenario: hazard value, to depth, to damage ratio, times insured value. The scenario loss is the sum. The insurance terms then turn that ground-up loss into the gross loss the insurer pays and the net loss it keeps. Nothing here is estimated by a model; it is arithmetic you can follow by hand.
      </StepHeader>

      {/* Each card takes the full width, in the order the arithmetic runs: ground-up loss, one building followed
          through, the insurance terms, what they do to every event, then the checks. On a wide step the worked
          building becomes one row of stages and the checks run down two columns. */}
      <div className="grid gap-4">
        <Card title="Ground-up loss by scenario" aside={<Tag kind="synthetic">Synthetic portfolio</Tag>}>
          <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
            Each row is one flood scenario, from the most frequent to the rarest. The ground-up loss is the damage to the insured buildings before any insurance terms. The bar is that loss as a share of total insured value, drawn against the largest scenario.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-176 text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="pb-2 text-left font-medium">Return period (chance in any year)</th>
                  <th className="pb-2 text-left font-medium">Scenario</th>
                  <th className="pb-2 text-right font-medium">Buildings affected</th>
                  <th className="pb-2 pl-3 text-right font-medium">Insured value in affected cells (KES)</th>
                  <th className="pb-2 pl-3 text-right font-medium">Ground-up loss (KES)</th>
                  <th className="w-[26%] pb-2 pl-4 text-left font-medium">Ground-up loss as a share of total insured value (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.scenarios.map((sc, i) => (
                  <tr key={sc.id}>
                    <td className="tabular py-2.5 pr-3 font-medium whitespace-nowrap text-ink">{rpWithChance(sc.returnPeriod)}</td>
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
          <SourceLine sources={groundUpSources} className="mt-4 border-t border-line pt-3" />
        </Card>

        <Card title="Follow one building" aside={<Segmented label="Scenario" value={String(k)} onChange={(v) => setScenario(Number(v))} options={r.scenarios.map((sc, i) => ({ value: String(i), label: rpLabel(sc.returnPeriod) }))} />}>
          {ranked.length === 0 || !t ? (
            <p className="text-sm text-ink-2">No building takes a loss in this scenario.</p>
          ) : (
            <>
              <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
                One building in a {rpWithChance(s.returnPeriod)} flood, read in order: each stage takes the figure before it and shows the sum that gives the next. The badge beside a figure says where it comes from. Depths are in metres and amounts in KES.
              </p>
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

              {/* A list down the card, or on a wide step a row of stages read left to right; the building's name gets the widest one. */}
              <motion.ol key={`${b.locId}-${k}`} className="flex flex-col gap-2 @7xl:grid @7xl:auto-cols-[minmax(0,1fr)] @7xl:grid-flow-col @7xl:grid-cols-[minmax(0,1.35fr)]" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.12 } } }}>
                {[
                  { label: "The building", value: `${b.locId} · ${HOUSING_LABELS[b.housingClass]}`, how: `Insured value ${fmtKes(b.tivKes, 2)}, at ${fmtNum(b.lat, 4)}, ${fmtNum(b.lon, 4)}`, tag: "synthetic" as const },
                  { label: isScore ? "Hazard score" : "Flood depth", value: isScore ? fmtNum(t.hazard, 3) : `${fmtNum(t.hazard)} m`, how: `Read from the "${s.id}" map at the building's coordinates`, tag: (isScore ? "proxy" : "real") as "proxy" | "real" },
                  ...(isScore ? [{ label: "Assumed depth", value: `${fmtNum(t.depthM)} m`, how: t.drainageM > 0 && t.drainageM >= t.depthM ? `Drainage ponding near a drain or in a settlement; the terrain gives ${fmtNum(t.hazard > 0 ? t.hazard * s.tierSlope * active.params.depthScaleM : 0)} m` : `${fmtNum(t.hazard, 3)} × tier slope ${fmtNum(s.tierSlope, 3)} × ${fmtNum(active.params.depthScaleM)} m`, tag: (usingAi ? "ai" : "assumption") as "ai" | "assumption" }] : []),
                  { label: "Depth on the curve", value: `${fmtNum(t.effectiveDepthM)} m`, how: `${fmtNum(t.depthM)} m × fragility ${fmtNum(active.params.fragility[b.housingClass])}`, tag: (usingAi ? "ai" : "assumption") as "ai" | "assumption" },
                  { label: "Damage ratio", value: fmtPct(t.damageRatio, 1), how: t.capped ? `JRC curve gives ${fmtPct(t.curveDamage, 1)}, limited by the ${fmtPct(active.params.cap[b.housingClass], 0)} cap` : `JRC curve at ${fmtNum(t.effectiveDepthM)} m; under the ${fmtPct(active.params.cap[b.housingClass], 0)} cap`, tag: "real" as const },
                  { label: "Ground-up loss", value: fmtKes(t.lossKes, 2), how: `${fmtPct(t.damageRatio, 1)} × ${fmtKes(b.tivKes, 2)}`, tag: null },
                ].map((row, i, all) => (
                  // The figure sits beside its explanation where both fit, and drops to its own line where they do not.
                  <motion.li key={row.label} variants={{ hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0 } }} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl px-3.5 py-2.5 @7xl:flex-col @7xl:flex-nowrap @7xl:items-start @7xl:justify-start @7xl:gap-y-3 @7xl:py-3.5 ${i === all.length - 1 ? "bg-ink text-surface" : "bg-surface-2"}`}>
                    <div className="min-w-0">
                      <div className={`text-xs ${i === all.length - 1 ? "opacity-70" : "text-muted"}`}>{row.label}</div>
                      <div className={`text-sm ${i === all.length - 1 ? "opacity-80" : "text-ink-2"}`}>{row.how}</div>
                    </div>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 text-right @7xl:mt-auto @7xl:ml-0 @7xl:justify-start @7xl:text-left">
                      {row.tag && <Tag kind={row.tag}>{row.label === "Damage ratio" ? "JRC curve" : undefined}</Tag>}
                      <span className="tabular text-base font-semibold">{row.value}</span>
                    </div>
                  </motion.li>
                ))}
              </motion.ol>
            </>
          )}
        </Card>

        <TermsPanel terms={terms} onChange={onTermsChange} />

        <Card title="How the terms act on each event">
          <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
            Read each row from left to right. Ground-up loss less the deductibles{anyOverLimit ? " and anything over the policy limits" : ""} is the gross loss. Gross less the quota share recovery is what the insurer retains. Retained less the excess of loss recovery is the net loss.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-232 text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="pb-2 text-left font-medium">Event (chance in any year), amounts in KES</th>
                  <th className="pb-2 pl-3 text-right font-medium">Ground-up</th>
                  <th className="pb-2 pl-3 text-right font-medium">Deductibles</th>
                  {anyOverLimit && <th className="pb-2 pl-3 text-right font-medium">Over limit</th>}
                  <th className="pb-2 pl-3 text-right font-medium">Gross</th>
                  <th className="pb-2 pl-3 text-right font-medium">Quota share recovery</th>
                  <th className="pb-2 pl-3 text-right font-medium">Retained</th>
                  <th className="pb-2 pl-3 text-right font-medium">Excess of loss recovery</th>
                  <th className="pb-2 pl-3 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {layers.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="tabular py-2.5 text-left font-medium whitespace-nowrap text-ink">{rpWithChance(row.returnPeriod)}</th>
                    <td className="tabular py-2.5 pl-3 text-right text-ink-2">{kes1(row.groundUpKes)}</td>
                    <td className="tabular py-2.5 pl-3 text-right text-ink-2">{kes1(row.deductiblesKes)}</td>
                    {anyOverLimit && <td className="tabular py-2.5 pl-3 text-right text-ink-2">{kes1(row.overLimitKes)}</td>}
                    <td className="tabular py-2.5 pl-3 text-right font-semibold text-ink">{kes1(row.grossKes)}</td>
                    <td className="tabular py-2.5 pl-3 text-right text-ink-2">{kes1(row.quotaShareKes)}</td>
                    <td className="tabular py-2.5 pl-3 text-right text-ink-2">{kes1(row.retainedKes)}</td>
                    <td className="tabular py-2.5 pl-3 text-right text-ink-2">{kes1(row.xolKes)}</td>
                    <td className="tabular py-2.5 pl-3 text-right font-semibold text-ink">{kes1(row.netKes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            The excess of loss pays the part of the retained loss above {kes1(terms.xol.attachmentKes)}, up to {kes1(terms.xol.limitKes)} in one event.
          </p>
          <SourceLine sources={termsSources} className="mt-4 border-t border-line pt-3" />
        </Card>

        {layer && (
          <ChartFrame
            title={waterfallTitle}
            subtitle={`Read from left to right. A solid bar is a loss measured from zero; a striped bar is what a deductible or a reinsurer takes off the bar before it. A loss this size or larger has about a ${annualChance(layer.returnPeriod).replace(" a year", "")} chance in any year.`}
            sources={termsSources}
            aside={layers.length > 1 ? <Segmented label="Event" value={layer.id} onChange={setEvent} options={layers.map((row) => ({ value: row.id, label: rpLabel(row.returnPeriod) }))} /> : undefined}
          >
            <Waterfall
              title={waterfallTitle}
              yLabel={`Loss in a ${rpLabel(layer.returnPeriod)} event, KES`}
              steps={steps}
              totalLabel="Loss at this stage"
              decreaseLabel="Taken off by a deductible or a reinsurer"
            />
          </ChartFrame>
        )}

        <Card title="Checks on the arithmetic and the terms" aside={<ChecksSummary checks={checks} />}>
          {/* Full width, the list runs down two columns so the right half of the card is not left empty. */}
          <div className="@5xl:columns-2 @5xl:gap-10 @5xl:[&_li]:break-inside-avoid">
            <CheckList checks={checks} />
          </div>
        </Card>
      </div>
    </div>
  );
}
