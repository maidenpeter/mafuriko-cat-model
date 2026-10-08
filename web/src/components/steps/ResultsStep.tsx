"use client";

import { useMemo, useState } from "react";
import type { Deliberation } from "@/lib/agents/orchestrate";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { EP_HELP, annualChance, kes1, pct1, rpLabel, rpWithChance } from "@/lib/labels";
import { lossAtReturnPeriod, STANDARD_RETURN_PERIODS } from "@/lib/model/financial";
import type { TermsResult } from "@/lib/model/terms";
import { HOUSING_CLASSES, HOUSING_LABELS, type ModelResult } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { ChartFrame, SourceBadge, type ChartSource } from "../charts/ChartFrame";
import { Figure } from "../charts/Figure";
import { LineChart, valueAt, type Point } from "../charts/LineChart";
import { OasisCheck } from "../OasisCheck";
import { Card, Note, Segmented, StepHeader, Tag } from "../ui";
import { CLASS_COLORS } from "./DataStep";

const curve = (r: ModelResult): Point[] => r.scenarios.map((s) => ({ x: s.returnPeriod, y: s.lossKes }));
const signed = (fraction: number) => `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(0)}%`;
const RP_TICKS = [2, 5, ...STANDARD_RETURN_PERIODS, 500, 1000];
const ticksBetween = (xs: number[]) => RP_TICKS.filter((x) => x >= Math.min(...xs) && x <= Math.max(...xs));
const snapPoints = (xs: number[], ticks: number[]) => [...new Set([...xs, ...ticks])].sort((a, b) => a - b);

export function ResultsStep({
  session,
  active,
  deliberation,
  engineSession,
  terrainResult,
  terms,
}: {
  session: Session;
  active: Active;
  deliberation: Deliberation | null;
  /** The terrain-only session, which the Oasis check was run against. */
  engineSession?: Session;
  /** The same assumptions on terrain flooding alone, shown when drainage is switched on. */
  terrainResult?: ModelResult | null;
  /** The insurance terms applied to the result in force: ground-up, gross and net for every event. */
  terms: TermsResult;
}) {
  const { dataset, reference } = session;
  const r = active.result;
  const isScore = dataset.hazardKind === "score";
  const last = r.scenarios.length - 1;
  const [scenario, setScenario] = useState(last);
  const k = Math.min(scenario, last);
  const s = r.scenarios[k];
  const rarest = r.scenarios[last];
  const usingAi = active.source === "ai";
  const basis = usingAi ? "ai" : "assumption";
  const basisText = usingAi ? "Assumptions agreed by the agents" : "Reference assumptions";

  // The three lines of the main chart: one event at each modelled return period, before and after the terms.
  const layers = terms.scenarios;
  const groundUp: Point[] = layers.map((l) => ({ x: l.returnPeriod, y: l.groundUpKes }));
  const gross: Point[] = layers.map((l) => ({ x: l.returnPeriod, y: l.grossKes }));
  const net: Point[] = layers.map((l) => ({ x: l.returnPeriod, y: l.netKes }));
  const layerXs = layers.map((l) => l.returnPeriod);
  const layerTicks = ticksBetween(layerXs);

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

  const compareXs = [...main, ...curve(reference), ...(band ? band.lower : [])].map((p) => p.x);
  const compareTicks = ticksBetween(compareXs);

  // The headline is the 1-in-100 event. A data set that stops short of it falls back to its rarest scenario.
  const at100 = terms.standard.find((l) => l.returnPeriod === 100);
  const lastLayer = layers[layers.length - 1];
  const headline =
    at100 && at100.groundUpKes !== null && at100.grossKes !== null && at100.netKes !== null
      ? { rp: 100, groundUpKes: at100.groundUpKes, grossKes: at100.grossKes, netKes: at100.netKes, extrapolated: at100.extrapolated }
      : { rp: lastLayer.returnPeriod, groundUpKes: lastLayer.groundUpKes, grossKes: lastLayer.grossKes, netKes: lastLayer.netKes, extrapolated: false };
  const anyHeldFlat = terms.standard.some((l) => l.extrapolated);
  const perYear = (aal: number) => `${fmtPct(aal / r.totalTivKes, 3)} of insured value a year`;

  const refRarest = reference.scenarios[reference.scenarios.length - 1];
  const top = useMemo(
    () => r.buildings.map((b, i) => ({ i, p: b.perScenario[k] })).filter((x) => x.p.lossKes > 0).sort((a, b) => b.p.lossKes - a.p.lossKes).slice(0, 10),
    [r, k],
  );
  const top10Share = top.reduce((t, x) => t + x.p.lossKes, 0) / (s.lossKes || 1);
  const maxClassLoss = Math.max(...HOUSING_CLASSES.map((c) => s.byClass[c].lossKes), 1);

  const aiCard = usingAi && Boolean(deliberation?.final);
  const drainageCard = Boolean(terrainResult && dataset.drainage);
  const paired = aiCard && drainageCard;
  const summary = deliberation?.runs.chair.output?.summary;

  const curveSources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
    { kind: "assumption", text: isScore ? "Return periods of the flood scenarios and the depth scale" : "Return periods of the flood scenarios" },
    { kind: "assumption", text: "Example insurance terms, not from any real policy or treaty" },
    ...(usingAi ? [{ kind: "ai" as const, text: "Hazard and damage assumptions agreed by the agents" }] : []),
  ];

  return (
    <div>
      <StepHeader kicker="Step 7" title="Results">
        What an underwriter needs: how large the loss could be at each level of rarity, what an average year costs, and where the loss comes from.
      </StepHeader>

      {/* The columns follow the room the step has at the chosen text size, not the screen width. */}
      <div className="grid gap-4 @3xl:grid-cols-[1.4fr_1fr_1fr]">
        <Figure
          strong
          label={`Net loss in a ${rpWithChance(headline.rp)} flood`}
          value={kes1(headline.netKes)}
          sub={<>What the insurer keeps after deductibles, limits and reinsurance. {pct1(headline.netKes / r.totalTivKes)} of insured value{headline.extrapolated ? ", held flat beyond the rarest modelled scenario" : ""}.</>}
          source={basis}
          sourceText={`${basisText}, example terms, synthetic portfolio`}
        />
        <Figure
          label={`Gross loss, ${rpLabel(headline.rp)}`}
          value={kes1(headline.grossKes)}
          sub="What the insurer pays: ground-up loss less policy deductibles, capped at policy limits."
          source="assumption"
          sourceText="Example policy terms"
        />
        <Figure
          label={`Ground-up loss, ${rpLabel(headline.rp)}`}
          value={kes1(headline.groundUpKes)}
          sub="Damage to the insured buildings, before any insurance terms."
          source={basis}
          sourceText={basisText}
        />
      </div>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))] gap-4">
        <Figure label="Average annual loss, ground-up" value={kes1(terms.aal.groundUpKes)} sub={perYear(terms.aal.groundUpKes)} source={basis} sourceText={basisText} />
        <Figure label="Average annual loss, gross" value={kes1(terms.aal.grossKes)} sub={perYear(terms.aal.grossKes)} source="assumption" sourceText="Example policy terms" />
        <Figure label="Average annual loss, net" value={kes1(terms.aal.netKes)} sub={perYear(terms.aal.netKes)} source="assumption" sourceText="Example reinsurance terms" />
        <Figure label="Total insured value" value={kes1(r.totalTivKes)} sub={`${fmtInt(r.buildingCount)} buildings, values as written in the exposure file`} source="synthetic" sourceText="Synthetic portfolio" />
        <Figure
          label={`Insured value in flooded cells, rarest scenario (${rpLabel(rarest.returnPeriod)})`}
          value={fmtPct(rarest.tivExposedKes / r.totalTivKes, 0)}
          sub={`${kes1(rarest.tivExposedKes)} of accumulation, ${fmtInt(rarest.affected)} of ${fmtInt(r.buildingCount)} buildings affected`}
          source="synthetic"
          sourceText="Synthetic portfolio on the flood map"
        />
      </div>

      <ChartFrame
        className="mt-4"
        title="Loss curve: how large a loss, how often, before and after insurance terms"
        subtitle="Each point is the loss from one flood event of that rarity. Ground-up is the damage to the buildings, gross is what the insurer pays after deductibles and limits, and net is what the insurer keeps after reinsurance. Further right is rarer."
        help={EP_HELP}
        sources={curveSources}
        aside={<Tag kind={basis}>{usingAi ? "Agreed assumptions in force" : "Reference assumptions in force"}</Tag>}
      >
        {/* Where there is room the figures sit beside the curve, so both are read together. Side by side, the curve also
            grows with the height of the screen, up to what fits above the bar at the bottom. */}
        <div className="grid gap-x-8 gap-y-4 @6xl:grid-cols-[minmax(0,1fr)_minmax(31rem,0.75fr)]">
          <div className="flex min-w-0 flex-col @6xl:min-h-[min(100dvh_-_var(--header-height,9rem)_-_29rem,30rem)]">
            <LineChart
              fill
              endLabels
              xScale="log"
              xTicks={layerTicks}
              xFormat={rpLabel}
              xSubFormat={annualChance}
              tooltipTitle={(x) => `${rpWithChance(x)} flood`}
              yFormat={kes1}
              yLabel="Loss from one event (KES)"
              xLabel="Return period (years), with the chance of a loss this large or larger in any year. Further right is rarer."
              ariaLabel="Loss curve: ground-up, gross and net loss in KES against return period in years"
              hoverXs={snapPoints(layerXs, layerTicks)}
              series={[
                { id: "ground-up", label: "Ground-up loss", endLabel: "Ground-up", color: "var(--series-3)", points: groundUp, dash: "2 6", marker: "triangle" },
                { id: "gross", label: "Gross loss, after deductibles and limits", endLabel: "Gross", color: "var(--series-2)", points: gross, dash: "9 6", marker: "square" },
                { id: "net", label: "Net loss, after reinsurance", endLabel: "Net", color: "var(--series-1)", points: net, marker: "circle" },
              ]}
            />
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="overflow-x-auto">
              <table className="w-full min-w-120 text-sm">
                <caption className="pb-2 text-left text-sm font-medium text-ink">Loss at each standard return period, KES</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="pb-2 text-left font-medium">Return period (chance a year)</th>
                    <th className="pb-2 pl-3 text-right font-medium">Ground-up</th>
                    <th className="pb-2 pl-3 text-right font-medium">Gross</th>
                    <th className="pb-2 pl-3 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {terms.standard.map((l) => {
                    const cell = (v: number | null) => (v === null ? "not modelled" : `${kes1(v)}${l.extrapolated ? " †" : ""}`);
                    return (
                      <tr key={l.returnPeriod}>
                        <td className="tabular py-2 text-ink">{rpWithChance(l.returnPeriod)}</td>
                        <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{cell(l.groundUpKes)}</td>
                        <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{cell(l.grossKes)}</td>
                        <td className="tabular whitespace-nowrap py-2 pl-3 text-right font-semibold text-ink">{cell(l.netKes)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="py-2 text-ink">Average annual loss</td>
                    <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{kes1(terms.aal.groundUpKes)}</td>
                    <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{kes1(terms.aal.grossKes)}</td>
                    <td className="tabular whitespace-nowrap py-2 pl-3 text-right font-semibold text-ink">{kes1(terms.aal.netKes)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
              Between modelled scenarios, loss is read off a straight line against the logarithm of the return period. &ldquo;Not modelled&rdquo; means the event is more frequent than the most frequent scenario.{anyHeldFlat ? " † held flat beyond the rarest scenario." : ""} The excess of loss used here attaches at {kes1(terms.xol.attachmentKes)} with a limit of {kes1(terms.xol.limitKes)}, after a quota share of {fmtPct(terms.terms.quotaShareCeded, 0)}.
            </p>
          </div>
        </div>
      </ChartFrame>

      {usingAi && (
        <ChartFrame
          className="mt-4"
          title="Compare with reference assumptions: ground-up loss with and without the agents"
          subtitle="The solid line uses the assumptions the agents agreed. The dashed line uses the reference assumptions, without AI. The shaded band runs from the Optimist's proposal to the Cautious one. All figures are ground-up, before insurance terms."
          sources={[
            { kind: "ai", text: "Agreed assumptions and the two proposals" },
            { kind: "assumption", text: "Reference assumptions and return periods" },
            { kind: "synthetic", text: "Portfolio of insured buildings" },
          ]}
        >
          <div className="grid gap-x-8 gap-y-4 @6xl:grid-cols-[minmax(0,1fr)_minmax(34rem,1fr)]">
            <div className="min-w-0">
              <LineChart
                height={280}
                xScale="log"
                xTicks={compareTicks}
                xFormat={rpLabel}
                xSubFormat={annualChance}
                tooltipTitle={(x) => `${rpWithChance(x)} flood`}
                yFormat={kes1}
                yLabel="Ground-up loss from one event (KES)"
                xLabel="Return period (years), with the chance in any year. Further right is rarer."
                ariaLabel="Ground-up loss in KES against return period in years, agreed assumptions beside reference assumptions"
                hoverXs={snapPoints(compareXs, compareTicks)}
                band={band}
                series={[
                  { id: "main", label: "Agreed assumptions", color: "var(--accent)", points: main, marker: "circle" },
                  { id: "reference", label: "Reference assumptions, without AI", color: "var(--muted)", points: curve(reference), dash: "7 5", marker: "diamond" },
                ]}
              />
            </div>
            <div className="flex min-w-0 flex-col">
              <div className="overflow-x-auto">
                <table className="w-full min-w-130 text-sm">
                  <caption className="pb-2 text-left text-sm font-medium text-ink">Ground-up loss at each standard return period, KES</caption>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th className="pb-2 text-left font-medium">Return period</th>
                      <th className="pb-2 pl-3 text-right font-medium">Agreed</th>
                      <th className="pb-2 pl-3 text-right font-medium">Without AI</th>
                      {deliberation?.optimist && <th className="pb-2 pl-3 text-right font-medium">Optimist</th>}
                      {deliberation?.cautious && <th className="pb-2 pl-3 text-right font-medium">Cautious</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.standardLosses.map((l) => {
                      const cell = (res: ModelResult) => {
                        const v = lossAtReturnPeriod(res.scenarios.map((x) => ({ returnPeriod: x.returnPeriod, lossKes: x.lossKes })), l.returnPeriod);
                        return v.lossKes === null ? "not modelled" : `${kes1(v.lossKes)}${v.extrapolated ? " †" : ""}`;
                      };
                      return (
                        <tr key={l.returnPeriod}>
                          <td className="tabular py-2 text-ink">{rpLabel(l.returnPeriod)}</td>
                          <td className="tabular whitespace-nowrap py-2 pl-3 text-right font-semibold text-ink">{cell(r)}</td>
                          <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{cell(reference)}</td>
                          {deliberation?.optimist && <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{cell(deliberation.optimist.result)}</td>}
                          {deliberation?.cautious && <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{cell(deliberation.cautious.result)}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">&ldquo;Not modelled&rdquo; means the event is more frequent than the most frequent scenario. † held flat beyond the rarest scenario.</p>
            </div>
          </div>
        </ChartFrame>
      )}

      {/* On a wide screen the two cards share a row. Each then lays itself out for half the width. */}
      <div className={`mt-4 grid gap-4 ${paired ? "@7xl:grid-cols-2" : ""}`}>
        {aiCard ? (
          <Card title="What the AI changed" className="flex flex-col" aside={<Tag kind="ai" />}>
            {/* The Chair's summary sits beside the figures where there is room, which also keeps its lines short enough to read.
                Next to a taller card, the figures spread down the height they are given. */}
            <div className={`grid grow gap-x-8 gap-y-4 ${!summary ? "" : paired ? "@7xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" : "@7xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"}`}>
              <div className="grid content-between gap-4 grid-cols-[repeat(auto-fit,minmax(min(15.5rem,100%),1fr))]">
                <div><div className="text-sm text-ink-2">Rarest scenario loss, ground-up</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(refRarest.lossKes, 2)} → {fmtKes(rarest.lossKes, 2)}</div><div className="text-xs text-muted">{signed(rarest.lossKes / refRarest.lossKes - 1)} against reference{rarest.returnPeriod !== refRarest.returnPeriod ? `; return period ${rpLabel(refRarest.returnPeriod)} → ${rpLabel(rarest.returnPeriod)}` : ""}</div></div>
                <div><div className="text-sm text-ink-2">Average annual loss, ground-up</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(reference.aalKes, 2)} → {fmtKes(r.aalKes, 2)}</div><div className="text-xs text-muted">{signed(r.aalKes / reference.aalKes - 1)} against reference</div></div>
                {deliberation?.optimist && deliberation.cautious && (
                  <div><div className="text-sm text-ink-2">Range of average annual loss, ground-up</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(Math.min(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes), 2)} to {fmtKes(Math.max(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes), 2)}</div><div className="text-xs text-muted">Optimist to Cautious</div></div>
                )}
              </div>
              {summary && <p className="max-w-3xl text-sm leading-relaxed text-ink-2">{summary}</p>}
            </div>
          </Card>
        ) : (
          <Note>These results use the reference assumptions only. Run the agents in step 3 to see how their agreed assumptions change the curve.</Note>
        )}

        {drainageCard && terrainResult && (
          <Card title="What drainage-driven flooding adds to the ground-up loss" aside={<span className="inline-flex flex-wrap gap-2"><SourceBadge kind="real" /><Tag kind="assumption">Drainage ponding assumed</Tag></span>}>
            {/* With the whole row to itself, the explanation sits beside the table and not in one long line under it. */}
            <div className={`grid gap-x-8 gap-y-3 @6xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] ${paired ? "@7xl:grid-cols-1" : ""}`}>
              <div className="min-w-0 overflow-x-auto">
                <table className="w-full min-w-130 text-sm">
                  <caption className="pb-2 text-left text-xs text-muted">Ground-up loss from one event in KES, with terrain flooding alone and with drainage ponding added.</caption>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th className="pb-2 text-left font-medium">Event (chance a year)</th>
                      <th className="pb-2 text-right font-medium">Buildings flooded</th>
                      <th className="pb-2 text-right font-medium">Terrain only</th>
                      <th className="pb-2 text-right font-medium">Terrain + drainage</th>
                      <th className="pb-2 text-right font-medium">Added</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {r.scenarios.map((sc) => {
                      const base = terrainResult.scenarios.find((x) => x.id === sc.id);
                      if (!base) return null;
                      return (
                        <tr key={sc.id}>
                          <td className="tabular py-2 text-ink">{rpWithChance(sc.returnPeriod)}</td>
                          <td className="tabular py-2 text-right text-ink-2">
                            {fmtInt(base.affected)} to {fmtInt(sc.affected)}
                          </td>
                          <td className="tabular py-2 text-right text-ink-2">{fmtKes(base.lossKes, 2)}</td>
                          <td className="tabular py-2 text-right font-semibold text-ink">{fmtKes(sc.lossKes, 2)}</td>
                          <td className="tabular py-2 text-right text-ink-2">{base.lossKes > 0 ? signed(sc.lossKes / base.lossKes - 1) : "new"}</td>
                        </tr>
                      );
                    })}
                    <tr>
                      <td className="py-2 text-ink">Average annual loss</td>
                      <td />
                      <td className="tabular py-2 text-right text-ink-2">{fmtKes(terrainResult.aalKes, 2)}</td>
                      <td className="tabular py-2 text-right font-semibold text-ink">{fmtKes(r.aalKes, 2)}</td>
                      <td className="tabular py-2 text-right text-ink-2">{signed(r.aalKes / (terrainResult.aalKes || 1) - 1)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="max-w-3xl text-xs leading-relaxed text-muted">
                Ponding is shallow, so it adds most where it reaches buildings the terrain map leaves dry, and adds proportionally more to frequent events. The added loss rests on open drain and settlement maps and on our assumed ponding depths; it is a first estimate of a peril the proxy leaves out, not a measurement.
              </p>
            </div>
          </Card>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink">Where the loss comes from</h3>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">Pick a flood scenario to see which buildings carry its loss. Amounts are in KES.</p>
        </div>
        <Segmented label="Scenario" value={String(k)} onChange={(v) => setScenario(Number(v))} options={r.scenarios.map((sc, i) => ({ value: String(i), label: rpLabel(sc.returnPeriod) }))} />
      </div>

      <div className="mt-3 grid gap-4 @3xl:grid-cols-2">
        {/* Beside the longer list of single losses this card is the shorter one, so its four rows share out the spare height. */}
        <Card title={`Ground-up loss by construction class, ${rpWithChance(s.returnPeriod)} flood`} className="flex flex-col" aside={<SourceBadge kind="synthetic" />}>
          <div className="grow overflow-x-auto">
            <table className="h-full w-full text-sm">
              <thead className="text-xs text-muted">
                <tr><th className="pb-2 text-left font-medium">Class</th><th className="pb-2 pl-2 text-right font-medium">Buildings affected</th><th className="pb-2 pl-2 text-right font-medium">Insured value (KES)</th><th className="pb-2 pl-2 text-right font-medium">Ground-up loss (KES)</th></tr>
              </thead>
              <tbody>
                {HOUSING_CLASSES.map((c) => {
                  const cls = s.byClass[c];
                  return (
                    <tr key={c} className="border-t border-line align-top">
                      <td className="py-2 pr-2">
                        <span className="inline-flex items-center gap-2 text-ink"><span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CLASS_COLORS[c] }} />{HOUSING_LABELS[c]}</span>
                        <div className="mt-1.5 h-1.5 rounded-r-full bg-surface-2"><div className="h-1.5 rounded-r-full" style={{ width: `${(cls.lossKes / maxClassLoss) * 100}%`, background: CLASS_COLORS[c] }} /></div>
                      </td>
                      <td className="tabular py-2 pl-2 text-right text-ink-2">{fmtInt(cls.affected)} of {fmtInt(cls.count)}</td>
                      <td className="tabular whitespace-nowrap py-2 pl-2 text-right text-ink-2">{fmtKes(cls.tivKes)}</td>
                      <td className="tabular whitespace-nowrap py-2 pl-2 text-right font-semibold text-ink">{fmtKes(cls.lossKes, 2)}<div className="text-xs font-normal text-muted">{fmtPct(cls.lossKes / (s.lossKes || 1), 1)} of loss</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">Each bar is that class’s loss beside the largest class. Loss follows insured value, so a few large concrete buildings dominate. The informal and semi-permanent buildings are many, but carry little insured value.</p>
        </Card>

        <Card title={`Largest single losses, ${rpWithChance(s.returnPeriod)} flood`} aside={<span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted">Top {top.length} are {fmtPct(top10Share, 0)} of this scenario <SourceBadge kind="synthetic" /></span>}>
          {top.length === 0 ? (
            <p className="text-sm text-ink-2">No losses in this scenario.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr><th className="pb-2 text-left font-medium">Building</th><th className="pb-2 pl-3 text-left font-medium">Class</th><th className="pb-2 pl-3 text-right font-medium">{isScore ? "Hazard score (0 to 1)" : "Depth (m)"}</th><th className="pb-2 pl-3 text-right font-medium">Damage (% of value)</th><th className="pb-2 pl-3 text-right font-medium">Ground-up (KES)</th><th className="pb-2 pl-3 text-right font-medium">Gross (KES)</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {top.map(({ i, p }) => (
                    <tr key={dataset.buildings[i].locId}>
                      <td className="whitespace-nowrap py-1.5 font-mono text-xs text-ink">{dataset.buildings[i].locId}</td>
                      <td className="py-1.5 pl-3 text-ink-2">{HOUSING_LABELS[dataset.buildings[i].housingClass]}</td>
                      <td className="tabular py-1.5 pl-3 text-right text-ink-2">{fmtNum(p.hazard, isScore ? 3 : 2)}</td>
                      <td className="tabular py-1.5 pl-3 text-right text-ink-2">{fmtPct(p.damageRatio, 0)}</td>
                      <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right font-semibold text-ink">{fmtKes(p.lossKes, 2)}</td>
                      <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right text-ink-2">{fmtKes(terms.buildingGrossKes[i]?.[k], 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <OasisCheck session={engineSession ?? session} />
    </div>
  );
}
