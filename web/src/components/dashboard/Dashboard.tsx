"use client";

/**
 * The dashboard: the whole model on one page, for a reader with two minutes.
 *
 *   Row 1  six headline figures
 *   Row 2  the loss curve (ground-up, gross, net) and one event taken through the insurance layers
 *   Row 3  where the loss falls: by housing class, and by ward with a small map
 *   Row 4  what the AI did: the agents' parameter changes and the latest priced offer,
 *          then the model chain with the checks on each stage
 *
 * The return period selector at the top drives the waterfall, the class bars, the ward bars and
 * the map. The headline figures defined at 1-in-100 stay at 1-in-100 and say so.
 *
 * How to mount it (Walkthrough.tsx already holds every value):
 *   <Dashboard
 *     session={view}                    the session with the drainage setting applied
 *     active={active}                   the parameters and result in force
 *     terms={termsResult}               applyTerms(view.dataset, active.result, terms)
 *     deliberation={viewDeliberation}
 *     checks={checks.all}
 *     drainageOn={drainageOn}
 *     offer={offerSummary}              or null when no offer has been priced
 *     onOpenStep={(step) => ...}        map the step name to the walkthrough's own step index
 *     offerCard={<... />}               optional: the offer drop zone
 *   />
 *
 * The calculations live in lib/dashboard.ts; this file only lays them out.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { buildLedger, type Deliberation } from "@/lib/agents/orchestrate";
import type { Check } from "@/lib/checks";
import {
  aalChange,
  chainStatus,
  chainSummary,
  classLossRows,
  hotspotCount,
  layerSteps,
  nearestEventIndex,
  paramChanges,
  signedPct,
  standardAt,
  topWards,
  type ChainStep,
} from "@/lib/dashboard";
import { PARAM_LABELS, unusedForDepth } from "@/lib/export";
import { fmtInt, fmtNum } from "@/lib/format";
import { loadGeo, type GeoLayers } from "@/lib/geo/layers";
import { assignPoints, wardAccumulation } from "@/lib/geo/spatial";
import { annualChance, EP_HELP, kes1, pct1, rpLabel, rpWithChance, type SourceKind } from "@/lib/labels";
import { STANDARD_RETURN_PERIODS } from "@/lib/model/financial";
import type { TermsResult } from "@/lib/model/terms";
import type { Active, Session } from "@/lib/session";
import { BarChart } from "../charts/BarChart";
import { ChartFrame, SourceBadge, type ChartSource } from "../charts/ChartFrame";
import { Figure } from "../charts/Figure";
import { LineChart } from "../charts/LineChart";
import { Waterfall } from "../charts/Waterfall";
import { Button, Card, Note, Segmented, StatusIcon } from "../ui";
import { WardMap } from "./WardMap";

/** The steps the dashboard can send the reader to. The wiring maps each name to its place in the walkthrough. */
export type DashboardStep = ChainStep | "agents" | "offer";

/** The latest priced offer, reduced to what the dashboard shows. */
export interface OfferSummary {
  /** The document's name. */
  name: string;
  /** How many fields were read out of the document. */
  fieldsRead: number;
  /** How many of those were found again in the document's own text by code. */
  fieldsVerified: number;
  /** The offer's loss in a 1-in-100 event, or null when it could not be priced. */
  loss100Kes: number | null;
  /** The offer's average annual loss, or null when it could not be priced. */
  aalKes: number | null;
  /** True when the risk lies outside the area the hazard maps cover. */
  outside: boolean;
}

export interface DashboardProps {
  /** The view session: the dataset with the drainage setting applied. */
  session: Session;
  /** The parameters and result in force. */
  active: Active;
  /** The insurance terms applied to the result in force. */
  terms: TermsResult;
  deliberation: Deliberation | null;
  /** Every check; the model chain groups them by stage. */
  checks: Check[];
  drainageOn: boolean;
  offer: OfferSummary | null;
  onOpenStep: (step: DashboardStep) => void;
  /** A slot for the offer drop zone card. */
  offerCard?: ReactNode;
}

const TERMS_NOTE = "Example terms, not from any real policy or treaty";

/** Columns that fit as many as the row has room for; the minimum is in rem, so it follows the text size. */
const FIGURE_GRID = "grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))]";
const PANEL_GRID = "grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(26rem,100%),1fr))]";

export function Dashboard({ session, active, terms, deliberation, checks, drainageOn, offer, onOpenStep, offerCard }: DashboardProps) {
  const { dataset, reference } = session;
  const result = active.result;
  const usingAi = active.source === "ai";
  const isScore = dataset.hazardKind === "score";

  // The chosen event is kept by its id, which stays the same when new assumptions move its return period.
  const [picked, setPicked] = useState<string | null>(null);
  const pickedIndex = picked === null ? -1 : result.scenarios.findIndex((s) => s.id === picked);
  const k = pickedIndex >= 0 ? pickedIndex : nearestEventIndex(result.scenarios.map((s) => s.returnPeriod), 100);

  // The ward outlines load once per page. null: still loading. wards null: the file is missing.
  const [geo, setGeo] = useState<GeoLayers | null>(null);
  useEffect(() => {
    let live = true;
    loadGeo().then((layers) => {
      if (live) setGeo(layers);
    });
    return () => {
      live = false;
    };
  }, []);
  const wards = geo?.wards ?? null;
  const wardOf = useMemo(() => (wards ? assignPoints(dataset.buildings, wards) : null), [wards, dataset]);
  const wardRows = useMemo(() => (wards && wardOf && k >= 0 ? wardAccumulation(dataset, result, wardOf, wards, k) : []), [wards, wardOf, dataset, result, k]);
  const wardTop = useMemo(() => topWards(wardRows, 10), [wardRows]);

  const stages = useMemo(() => chainStatus(checks), [checks]);
  const changes = useMemo(() => {
    if (!deliberation?.final) return null;
    const ledger = buildLedger(reference.params, deliberation).filter((row) => isScore || !unusedForDepth(row.path));
    return { moved: paramChanges(ledger), of: ledger.length };
  }, [deliberation, reference, isScore]);

  const scenario = k >= 0 ? result.scenarios[k] : undefined;
  const layer = k >= 0 ? terms.scenarios[k] : undefined;
  if (!scenario || !layer) return <Note tone="warn">The model has no events to show yet.</Note>;

  const rp = scenario.returnPeriod;
  const event = rpLabel(rp);
  const assumptions = usingAi ? "Agreed assumptions" : "Reference assumptions";
  const lossSource: SourceKind = usingAi ? "ai" : "assumption";

  // Row 1.
  const at100 = standardAt(terms.standard, 100);
  const net100 = at100?.netKes ?? null;
  const hotspots = hotspotCount(session.hits);
  const agentsAal = usingAi ? result.aalKes : deliberation?.final?.result.aalKes ?? null;
  const aiChange = aalChange(reference.aalKes, agentsAal);

  // Row 2.
  const points = (pick: (row: TermsResult["scenarios"][number]) => number) => terms.scenarios.map((row) => ({ x: row.returnPeriod, y: pick(row) }));
  const eventRps = terms.scenarios.map((row) => row.returnPeriod);
  const firstRp = Math.min(...eventRps);
  const lastRp = Math.max(...eventRps);
  const standardTicks = STANDARD_RETURN_PERIODS.filter((x) => x >= firstRp && x <= lastRp);
  const xTicks = standardTicks.length >= 2 ? standardTicks : eventRps;
  const hoverXs = [...new Set([...eventRps, ...xTicks])].sort((a, b) => a - b);

  // Row 3.
  const classes = classLossRows(scenario);

  const lossSources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings" },
    { kind: "real", text: "Hazard maps supplied with the starter kit" },
    { kind: "assumption", text: isScore ? "Return periods and flood depths" : "Damage curves" },
    ...(usingAi ? [{ kind: "ai" as const, text: "Damage and depth assumptions agreed by the agents" }] : []),
  ];
  const termsSource: ChartSource = { kind: "assumption", text: TERMS_NOTE };

  return (
    <div className="min-w-0">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Overview</div>
          <h2 className="mt-1 text-3xl font-semibold tracking-tight text-ink">Dashboard</h2>
          <p className="mt-2 max-w-3xl wrap-anywhere text-base leading-relaxed text-ink-2">
            What a flood could cost this portfolio, how often, and where the loss falls. Using the {assumptions.toLowerCase()}{drainageOn ? ", with drainage-driven flooding switched on" : ""}.
          </p>
        </div>
        <div className="min-w-0">
          <div className="mb-1.5 text-sm text-ink-2">Flood event shown in the charts below</div>
          <Segmented
            label="Return period of the flood event shown in the charts"
            value={scenario.id}
            onChange={setPicked}
            options={result.scenarios.map((s) => ({
              value: s.id,
              label: (
                <span className="whitespace-nowrap">
                  {rpLabel(s.returnPeriod)} <span className="text-xs text-muted">{annualChance(s.returnPeriod)}</span>
                </span>
              ),
            }))}
          />
        </div>
      </header>

      {/* Row 1: the headline figures. */}
      <div className={FIGURE_GRID}>
        <Figure label="Total insured value" value={kes1(result.totalTivKes)} sub="As written in the exposure file" source="synthetic" sourceText="Synthetic portfolio" />
        <Figure
          label="Buildings insured"
          value={fmtInt(result.buildingCount)}
          sub={`${fmtInt(scenario.affected)} flooded in a ${event} event`}
          source="synthetic"
          sourceText="Synthetic portfolio"
        />
        <Figure
          strong
          label={`Net loss, ${rpWithChance(100)}`}
          value={kes1(net100)}
          sub={
            net100 === null
              ? "1-in-100 is more frequent than any event the model covers."
              : `${pct1(net100 / (result.totalTivKes || 1))} of insured value, after deductibles and reinsurance${at100?.extrapolated ? ". Held flat beyond the rarest modelled event." : ""}`
          }
          source={lossSource}
          sourceText={`${assumptions}. ${TERMS_NOTE}.`}
        />
        <Figure
          label="Average annual loss, net"
          value={kes1(terms.aal.netKes)}
          sub={`Ground-up ${kes1(terms.aal.groundUpKes)}, gross ${kes1(terms.aal.grossKes)}, a year on average`}
          source={lossSource}
          sourceText={`${assumptions}. ${TERMS_NOTE}.`}
        />
        <Figure
          label="Known flood areas matched"
          value={hotspots.total > 0 ? `${fmtInt(hotspots.matched)} of ${fmtInt(hotspots.total)}` : "n/a"}
          sub={hotspots.total === 0 ? "The data has no list of known flood areas." : drainageOn ? "With drainage-driven flooding switched on" : "Terrain hazard maps only, drainage switched off"}
          source="real"
          sourceText="Named flood areas against the hazard maps"
        />
        <Figure
          label="What the AI changed: average annual loss"
          value={aiChange ? (aiChange.fraction === null ? kes1(aiChange.agentsKes) : signedPct(aiChange.fraction)) : "Not run yet"}
          sub={
            aiChange
              ? `Ground-up: ${kes1(aiChange.referenceKes)} on reference assumptions, ${kes1(aiChange.agentsKes)} on the agents' assumptions${usingAi ? "" : ". This page is using the reference assumptions."}`
              : "Run the agents to see how their assumptions move the loss."
          }
          source="ai"
          sourceText="Assumptions chosen by the agents, loss worked out by code"
        />
      </div>

      {/* Row 2: how large a loss, how often, and who bears it. The curve takes the larger share of a wide row. */}
      <div className="mt-4 flex flex-wrap gap-4">
        <ChartFrame
          className="flex-[3_1_32rem]"
          title="Loss curve: how large a loss, how often"
          subtitle="Three lines, from top to bottom: ground-up (before insurance terms, dotted with squares), gross (after deductibles and limits, dashed with triangles) and net (after reinsurance, solid with circles). Each marker is a modelled event."
          help={EP_HELP}
          sources={[...lossSources, termsSource]}
        >
          <LineChart
            ariaLabel="Loss curve: ground-up, gross and net loss at each return period"
            xScale="log"
            xTicks={xTicks}
            xFormat={rpLabel}
            xSubFormat={annualChance}
            tooltipTitle={rpWithChance}
            yFormat={kes1}
            xLabel="Return period, with the chance of it being exceeded in any one year. Further right is rarer."
            yLabel="Loss (KES)"
            hoverXs={hoverXs}
            height={340}
            endLabels
            series={[
              { id: "ground-up", label: "Ground-up", endLabel: "Ground-up", color: "var(--ink-2)", points: points((row) => row.groundUpKes), marker: "square", dash: "2 5" },
              { id: "gross", label: "Gross", endLabel: "Gross", color: "var(--series-2)", points: points((row) => row.grossKes), marker: "triangle", dash: "9 6" },
              { id: "net", label: "Net", endLabel: "Net", color: "var(--accent)", points: points((row) => row.netKes), marker: "circle" },
            ]}
          />
          <dl className="mt-4 grid gap-x-6 gap-y-2 grid-cols-[repeat(auto-fit,minmax(min(11rem,100%),1fr))]">
            {[
              { name: "Ground-up", value: terms.aal.groundUpKes },
              { name: "Gross", value: terms.aal.grossKes },
              { name: "Net", value: terms.aal.netKes },
            ].map((item) => (
              <div key={item.name} className="min-w-0 border-l-2 border-line pl-3">
                <dt className="text-sm text-ink-2">Average annual loss, {item.name.toLowerCase()}</dt>
                <dd className="tabular text-lg font-semibold text-ink">{kes1(item.value)}</dd>
              </div>
            ))}
          </dl>
        </ChartFrame>

        <ChartFrame
          className="flex-[2_1_28rem]"
          title={`From ground-up loss to net loss in a ${event} event`}
          subtitle={`Read left to right: each striped bar is what one party takes off the loss, and each solid bar is what is left. ${rpWithChance(rp)}.`}
          sources={[...lossSources, termsSource]}
        >
          <Waterfall
            title={`From ground-up loss to net loss in a ${event} event`}
            yLabel={`Loss in a ${event} event, KES`}
            steps={layerSteps(layer)}
            totalLabel="Loss left"
            decreaseLabel="Taken off"
            height={300}
          />
        </ChartFrame>
      </div>

      {/* Row 3: where the loss falls. Both charts show ground-up loss: reinsurance works on the portfolio total, so net loss has no split by class or ward. */}
      <div className="mt-4 flex flex-wrap gap-4">
        <ChartFrame
          className="flex-[1_1_26rem]"
          title={`Loss by housing class in a ${event} event`}
          subtitle="Each bar is the ground-up loss to that class, before insurance terms. The diamond is where the bar would end if the class lost in line with its share of insured value: a bar past its diamond loses more than its share."
          sources={lossSources}
        >
          <BarChart
            title={`Loss by housing class in a ${event} event`}
            rows={classes.map((c) => ({ label: c.label, value: c.lossKes, share: c.tivShare, note: `${fmtInt(c.affected)} of ${fmtInt(c.buildings)} flooded` }))}
            xLabel={`Ground-up loss in a ${rpWithChance(rp)} event, KES`}
            format={kes1}
            valueLabel="Ground-up loss"
            mark={{ label: "Share of insured value", scale: "ofTotal", format: pct1 }}
          />
        </ChartFrame>

        <ChartFrame
          className="flex-[2_1_34rem]"
          title={`The ten wards with the most loss in a ${event} event`}
          subtitle="Each bar is the ground-up loss to the insured buildings in that ward. The numbers beside the ward names are the numbers on the map."
          sources={[...lossSources, { kind: "real", text: "Ward boundaries: Omare and Omare 2017, CC BY 4.0" }]}
        >
          {geo === null ? (
            <p className="text-sm text-ink-2">Loading the ward outlines.</p>
          ) : !wards ? (
            <p className="text-sm text-ink-2">The ward outlines are not available, so the loss cannot be split by ward.</p>
          ) : wardTop.length === 0 ? (
            <p className="text-sm text-ink-2">No ward has a loss in a {event} event.</p>
          ) : (
            <div className="grid items-start gap-x-8 gap-y-5 grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))]">
              <div className="min-w-0">
                <BarChart
                  title={`The ten wards with the most loss in a ${event} event`}
                  rows={wardTop.map((w) => ({ label: `${w.rank}. ${w.name}`, value: w.lossKes, note: `${w.subcounty ? `${w.subcounty}, ` : ""}${pct1(w.lossShare)} of the loss` }))}
                  xLabel={`Ground-up loss in a ${rpWithChance(rp)} event, KES`}
                  format={kes1}
                  valueLabel="Ground-up loss"
                />
              </div>
              <div className="min-w-0">
                <WardMap title={`Wards shaded by ground-up loss in a ${event} event`} wards={wards} rows={wardRows} top={wardTop} valueLabel="Ground-up loss" />
              </div>
            </div>
          )}
        </ChartFrame>
      </div>

      {/* Row 4: what the AI did, then the chain the figures came through. */}
      <div className={`mt-4 ${PANEL_GRID}`}>
        <Card title="What the agents changed" aside={<SourceBadge kind="ai" />}>
          {changes === null ? (
            <div>
              <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
                The agents have not agreed a set of assumptions yet. Every figure on this page uses the reference assumptions.
              </p>
              <Button variant="secondary" className="mt-3" onClick={() => onOpenStep("agents")}>Open the agents step</Button>
            </div>
          ) : (
            <div>
              <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
                {changes.moved.length === 0
                  ? `The agents kept all ${changes.of} parameters at their reference values.`
                  : `The agents moved ${changes.moved.length} of ${changes.of} parameters away from the reference. The rest are unchanged.`}
                {usingAi ? "" : " This page is using the reference assumptions."}
              </p>
              {changes.moved.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[26rem] text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th scope="col" className="pb-2 text-left font-medium">Parameter</th>
                        <th scope="col" className="pb-2 pl-3 text-right font-medium">Reference</th>
                        <th scope="col" className="pb-2 pl-3 text-right font-medium">Agreed</th>
                        <th scope="col" className="pb-2 pl-3 text-right font-medium">Change</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {changes.moved.map((c) => (
                        <tr key={c.path}>
                          <th scope="row" className="py-1.5 text-left font-normal text-ink">
                            {PARAM_LABELS[c.path] ?? c.path}
                            {c.adjusted && <span className="block text-xs text-muted">Pulled back inside its allowed range by code</span>}
                          </th>
                          <td className="tabular py-1.5 pl-3 text-right text-ink-2">{fmtNum(c.reference)}</td>
                          <td className="tabular py-1.5 pl-3 text-right font-semibold text-ink">{fmtNum(c.agreed)}</td>
                          <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right text-ink-2">{signedPct(c.fraction)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Button variant="secondary" className="mt-3" onClick={() => onOpenStep("agents")}>See the agents&apos; reasons</Button>
            </div>
          )}
        </Card>

        <Card title="Latest priced offer" aside={<SourceBadge kind="ai" />}>
          {offer === null ? (
            <div>
              <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
                No offer has been priced yet. Give the model a broker&apos;s offer document and it reads the fields, checks each one against the document, and prices the risk.
              </p>
              <Button variant="secondary" className="mt-3" onClick={() => onOpenStep("offer")}>Price an offer</Button>
            </div>
          ) : (
            <div>
              <p className="mb-3 wrap-anywhere text-sm font-medium text-ink">{offer.name}</p>
              <dl className="grid gap-x-6 gap-y-3 grid-cols-[repeat(auto-fit,minmax(min(11rem,100%),1fr))]">
                <div className="min-w-0 border-l-2 border-line pl-3">
                  <dt className="text-sm text-ink-2">Fields read from the document</dt>
                  <dd className="tabular text-lg font-semibold text-ink">{fmtInt(offer.fieldsRead)}</dd>
                </div>
                <div className="min-w-0 border-l-2 border-line pl-3">
                  <dt className="text-sm text-ink-2">Verified against the document by code</dt>
                  <dd className="tabular text-lg font-semibold text-ink">{fmtInt(offer.fieldsVerified)} of {fmtInt(offer.fieldsRead)}</dd>
                </div>
                <div className="min-w-0 border-l-2 border-line pl-3">
                  <dt className="text-sm text-ink-2">Loss, {rpWithChance(100)}</dt>
                  <dd className="tabular text-lg font-semibold text-ink">{kes1(offer.loss100Kes)}</dd>
                </div>
                <div className="min-w-0 border-l-2 border-line pl-3">
                  <dt className="text-sm text-ink-2">Average annual loss</dt>
                  <dd className="tabular text-lg font-semibold text-ink">{kes1(offer.aalKes)}</dd>
                </div>
              </dl>
              {offer.outside && (
                <p className="mt-3 flex max-w-3xl gap-2 text-sm leading-relaxed text-ink-2">
                  <span className="mt-0.5"><StatusIcon status="warn" size={16} /></span>
                  <span className="min-w-0">This risk lies outside the area the hazard maps cover, so the model cannot say how deep the water would be there.</span>
                </p>
              )}
              <Button variant="secondary" className="mt-3" onClick={() => onOpenStep("offer")}>Open the offer</Button>
            </div>
          )}
        </Card>

        {offerCard && <div className="min-w-0">{offerCard}</div>}
      </div>

      <Card title="Model chain" className="mt-4" aside={<span className="text-sm text-ink-2">Each stage with the checks code ran on it</span>}>
        <ol className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))]">
          {stages.map((stage, i) => (
            <li key={stage.step} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="flex items-start gap-2">
                <span className="mt-0.5"><StatusIcon status={stage.status === "none" ? "idle" : stage.status} /></span>
                <div className="min-w-0">
                  <div className="wrap-anywhere text-sm font-semibold text-ink">{i + 1}. {stage.label}</div>
                  <div className="mt-0.5 wrap-anywhere text-sm leading-snug text-ink-2">{chainSummary(stage)}</div>
                </div>
              </div>
              <div className="mt-auto pt-3">
                <Button variant="secondary" className="w-full" aria-label={`Open the ${stage.label} step: ${chainSummary(stage)}`} onClick={() => onOpenStep(stage.step)}>
                  Open step
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
