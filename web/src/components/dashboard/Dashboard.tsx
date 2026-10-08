"use client";

/**
 * The dashboard: the offer first, then the model that prices it, on one page.
 *
 *   Top    the offer. With none read: the card that takes one, beside the path a demo follows.
 *          With one read: its one line, its four figures, how it was read, the worst points to
 *          weigh, the decision recorded, and the way on through the steps. An offer outside the
 *          hazard maps, or one waiting for a value, says so here and shows no loss figure.
 *   Then   "The model behind every price": the portfolio the offer would join
 *   Row 1  the return period selector and six headline figures of the portfolio
 *   Row 2  the loss curve (ground-up, gross, net) and one event taken through the insurance layers
 *   Row 3  where the loss falls: by housing class, and by ward with a small map (the offer's
 *          building is marked on it)
 *   Row 4  what the agents changed, then the model chain with the checks on each stage
 *
 * The return period selector drives every portfolio chart: the readout under the loss curve, the
 * waterfall, the class bars, the ward bars and the map. The headline figures defined at 1-in-100
 * stay at 1-in-100 and say so. Every offer figure comes from the focus (lib/offer/focus):
 * nothing is priced here.
 *
 * How to mount it (Walkthrough.tsx already holds every value):
 *   <Dashboard
 *     session={view}                    the session with the drainage setting applied
 *     active={active}                   the parameters and result in force
 *     terms={termsResult}               applyTerms(view.dataset, active.result, terms)
 *     deliberation={viewDeliberation}
 *     checks={checks.all}
 *     drainageOn={drainageOn}
 *     offerFocus={offerFocus}           the offer as every step sees it, or null when none has been read
 *     decision={decision}               the underwriter's decision record, when the walkthrough hands it over
 *     onOpenStep={(step) => ...}        open dashboardStepId(step) from lib/dashboard, a StepId
 *     offerCard={<OfferDropCard />}     the offer drop zone: first on the page until an offer is read
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
  dashboardStepId,
  flagCountText,
  headlineFlags,
  hotspotCount,
  layerSteps,
  nearestEventIndex,
  paramChanges,
  portfolioChangeText,
  signedPct,
  standardAt,
  topWards,
  type DashboardStep,
} from "@/lib/dashboard";
import { DECISION_LABELS, SEVERITY_LABELS, type DecisionRecord } from "@/lib/decision";
import { fmtNoteDate } from "@/lib/decisionNote";
import { PARAM_LABELS, unusedForDepth } from "@/lib/export";
import { fmtInt, fmtNum } from "@/lib/format";
import { loadGeo, type GeoLayers } from "@/lib/geo/layers";
import { assignPoints, wardAccumulation } from "@/lib/geo/spatial";
import { annualChance, EP_HELP, kes1, pct1, rpLabel, rpWithChance, type SourceKind } from "@/lib/labels";
import { STANDARD_RETURN_PERIODS } from "@/lib/model/financial";
import type { TermsResult } from "@/lib/model/terms";
import { isPriced, type OfferFocus, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { Active, Session } from "@/lib/session";
import { STEP_IDS, STEP_NAMES, stepIndex, stepKicker, type StepId } from "@/lib/steps";
import { BarChart } from "../charts/BarChart";
import { ChartFrame, SourceBadge, type ChartSource } from "../charts/ChartFrame";
import { Figure } from "../charts/Figure";
import { LineChart } from "../charts/LineChart";
import { Waterfall } from "../charts/Waterfall";
import { Button, Card, Note, Segmented, StatusIcon, StepHeader } from "../ui";
import { WardMap } from "./WardMap";

/** The steps the dashboard can send the reader to. dashboardStepId() in lib/dashboard gives each one's place in the walkthrough. */
export type { DashboardStep };

/** The latest priced offer, reduced to what the dashboard shows. */
export interface OfferSummary {
  /** The document's name. */
  name: string;
  /** How many fields were read out of the document. */
  fieldsRead: number;
  /** How many of those were found again in the document's own text by code. */
  fieldsVerified: number;
  /** The offer's gross loss in a 1-in-100 event, or null when it could not be priced. */
  loss100Kes: number | null;
  /** The offer's gross average annual loss, or null when it could not be priced. */
  aalKes: number | null;
  /** True when the risk lies outside the area the hazard maps cover. */
  outside: boolean;
}

export interface DashboardProps extends OfferFocusProps {
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
  /** The offer's summary. The page now reads the offer from `offerFocus`; this stays so an older caller still compiles. */
  offer?: OfferSummary | null;
  /** The underwriter's decision on the offer, as recorded on the Results step. Left out, the page says none is recorded. */
  decision?: DecisionRecord | null;
  onOpenStep: (step: DashboardStep) => void;
  /** A slot for the offer drop zone card. */
  offerCard?: ReactNode;
}

const TERMS_NOTE = "Example terms, not from any real policy or treaty";
/** Said beside every net figure, so "net" is never left unexplained. */
const NET_MEANS = "Net is what is left after the example insurance terms: deductibles, policy limits, quota share and excess of loss.";

/** "step 3, Hazard": a step's number and name, both from lib/steps. */
const stepRef = (step: DashboardStep) => {
  const id = dashboardStepId(step);
  return `step ${stepIndex(id)}, ${STEP_NAMES[id]}`;
};

/** Columns that fit as many as the row has room for; the minimum is in rem, so it follows the text size. */
const FIGURE_GRID = "grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))]";

export function Dashboard({ session, active, terms, deliberation, checks, drainageOn, offerFocus, decision, onOpenStep, offerCard }: DashboardProps) {
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
  // Buildings that fall outside every ward outline are not a ward: they stay out of the ranking and are counted in a line under it.
  const outsideWards = wardRows.find((w) => w.index === -1) ?? null;
  const wardTop = useMemo(() => topWards(wardRows.filter((w) => w.index !== -1), 10), [wardRows]);

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

  // The offer, once the ward map has placed it. Priced or not, it leads the page.
  const offer = offerFocus && offerFocus.status !== "locating" ? offerFocus : null;
  const priced = isPriced(offer) ? offer : null;
  const offerPoint = offer && !offer.outside && offer.building && offer.building.lat !== null && offer.building.lon !== null ? { lat: offer.building.lat, lon: offer.building.lon, label: "This offer" } : null;
  // Where the path leads next: the offer step until an offer is priced, then on through the model.
  const nextStep: StepId = priced ? "hazard" : "offer";

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
  const layers = [
    { name: "Ground-up", means: "before insurance terms", eventKes: layer.groundUpKes, aalKes: terms.aal.groundUpKes },
    { name: "Gross", means: "after deductibles and limits", eventKes: layer.grossKes, aalKes: terms.aal.grossKes },
    { name: "Net", means: "after reinsurance", eventKes: layer.netKes, aalKes: terms.aal.netKes },
  ];

  return (
    <div className="min-w-0">
      <StepHeader kicker={stepKicker("dashboard")} title={STEP_NAMES.dashboard}>
        Should we take this business, and on what terms? Give the model a broker&apos;s offer: it reads the document, finds the building on the flood maps, and prices it against the portfolio already held. Every assumption is shown.
      </StepHeader>

      {/* The offer leads the page: the card that takes one, or the one that has been read. */}
      {offer ? (
        <OfferPanel offer={offer} priced={priced} decision={decision ?? null} lossSource={lossSource} assumptions={assumptions} onOpenStep={onOpenStep} />
      ) : (
        <div className="flex flex-wrap gap-4">
          {offerCard && <div className="min-w-0 flex-[2_1_30rem]">{offerCard}</div>}
          <DemoPath next={nextStep} hasCard={!!offerCard} onOpenStep={onOpenStep} />
        </div>
      )}

      <h3 className="mt-8 text-lg font-semibold text-ink">The model behind every price</h3>
      <p className="mt-1 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
        {priced ? "The portfolio this offer would join: " : offer ? "The portfolio an offer is priced against: " : "The portfolio every offer is priced against: "}
        what a flood could cost it, how often, and where the loss falls.
      </p>

      {/* The selector sits above everything it drives. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-8 gap-y-3 rounded-2xl border border-line bg-surface px-5 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">Flood event shown in every chart</div>
          <p className="mt-0.5 max-w-3xl wrap-anywhere text-sm leading-relaxed text-ink-2">
            Now showing a {rpWithChance(rp)} event, on the {assumptions.toLowerCase()}{drainageOn ? ", with drainage-driven flooding switched on" : ""}. A rarer event is a larger flood.
          </p>
        </div>
        <Segmented
          label="Return period of the flood event shown in every chart"
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
              : `${pct1(net100 / (result.totalTivKes || 1))} of insured value. Net: after the example insurance terms${at100?.extrapolated ? ". Held flat beyond the rarest modelled event." : ""}`
          }
          source={lossSource}
          sourceText={`${assumptions}. ${TERMS_NOTE}.`}
        />
        <Figure
          label="Average annual loss (AAL), net"
          value={kes1(terms.aal.netKes)}
          sub={`A year on average. Net: after the example insurance terms. Ground-up ${kes1(terms.aal.groundUpKes)}, gross ${kes1(terms.aal.grossKes)}`}
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
          label="What the AI changed: average annual loss, ground-up"
          value={aiChange ? (aiChange.fraction === null ? kes1(aiChange.agentsKes) : signedPct(aiChange.fraction)) : "Not run yet"}
          sub={
            aiChange
              ? `${kes1(aiChange.agentsKes)} on the agents' assumptions against ${kes1(aiChange.referenceKes)} on the reference assumptions${usingAi ? "" : ". This page is using the reference assumptions."}`
              : "Run the agents to see how their assumptions move the loss."
          }
          source="ai"
          sourceText="Assumptions chosen by the agents, loss worked out by code"
        />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-relaxed text-ink-2">
        <SourceBadge kind="assumption" />
        <span className="min-w-0 wrap-anywhere">{NET_MEANS} {TERMS_NOTE}.</span>
      </p>

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
          {/* The curve read at the event chosen at the top of the page, beside the yearly average. */}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <caption className="pb-2 text-left text-sm text-ink-2">The three lines read at the {event} event chosen at the top of the page, and their yearly average.</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="pb-2 text-left font-medium">Line</th>
                  <th scope="col" className="pb-2 pl-3 text-right font-medium">Loss in a {rpWithChance(rp)} event</th>
                  <th scope="col" className="pb-2 pl-3 text-right font-medium">Average annual loss</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {layers.map((item) => (
                  <tr key={item.name}>
                    <th scope="row" className="py-1.5 text-left font-normal text-ink">
                      <span className="font-semibold">{item.name}</span> <span className="text-ink-2">{item.means}</span>
                    </th>
                    <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right font-semibold text-ink">{kes1(item.eventKes)}</td>
                    <td className="tabular whitespace-nowrap py-1.5 pl-3 text-right text-ink-2">{kes1(item.aalKes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartFrame>

        <ChartFrame
          className="flex-[2_1_28rem]"
          title={`From ground-up loss to net loss in a ${event} event`}
          subtitle={`Read left to right: each striped bar is what one party takes off the loss, and each solid bar is what is left. The last bar is the net loss. This is a ${rpWithChance(rp)} event.`}
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
          subtitle={`Each bar is the ground-up loss to that class in a ${event} event, before insurance terms. The diamond is where the bar would end if the class lost in line with its share of insured value: a bar past its diamond loses more than its share. The share is also written under each class name.`}
          sources={lossSources}
        >
          <BarChart
            title={`Loss by housing class in a ${event} event`}
            rows={classes.map((c) => ({ label: c.label, value: c.lossKes, share: c.tivShare, note: `${pct1(c.tivShare)} of insured value, ${pct1(c.lossShare)} of the loss` }))}
            xLabel={`Ground-up loss in a ${rpWithChance(rp)} event, KES`}
            format={kes1}
            valueLabel="Ground-up loss"
            mark={{ label: "Share of insured value", scale: "ofTotal", format: pct1 }}
          />
        </ChartFrame>

        <ChartFrame
          className="flex-[2_1_34rem]"
          title={`The ten wards with the most loss in a ${event} event`}
          subtitle={`Each bar is the ground-up loss to the insured buildings in that ward in a ${event} event. The numbers beside the ward names are the numbers on the map.${offerPoint ? " The diamond on the map is the offer's building." : ""}`}
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
                <WardMap title={`Wards shaded by ground-up loss in a ${event} event`} wards={wards} rows={wardRows} top={wardTop} valueLabel="Ground-up loss" marker={offerPoint} />
              </div>
            </div>
          )}
          {outsideWards && outsideWards.lossKes > 0 && (
            <p className="mt-3 text-xs leading-relaxed text-muted">
              {fmtInt(outsideWards.buildings)} insured buildings lie inside the hazard maps but outside Nairobi County&rsquo;s ward outlines. Their {kes1(outsideWards.lossKes)} of loss in this event is in every total on this page and is left out of the ward ranking.
            </p>
          )}
        </ChartFrame>
      </div>

      {/* Row 4: what the agents changed, then the chain the figures came through. */}
      <div className="mt-4">
        <Card title="What the agents changed" aside={<SourceBadge kind="ai" />}>
          {changes === null ? (
            <div>
              <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
                The agents have not agreed a set of assumptions yet. Every figure on this page uses the reference assumptions.
              </p>
              <Button variant="secondary" className="mt-3" onClick={() => onOpenStep("agents")}>Open {stepRef("agents")}</Button>
            </div>
          ) : (
            <div>
              <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
                {changes.moved.length === 0
                  ? `The agents kept all ${changes.of} parameters at their reference values.`
                  : `The agents moved ${changes.moved.length} of ${changes.of} parameters away from the reference. The rest are unchanged.`}
                {aiChange ? ` Together they move the ground-up average annual loss ${aiChange.fraction === null ? `to ${kes1(aiChange.agentsKes)}` : `by ${signedPct(aiChange.fraction)}`}.` : ""}
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
              <Button variant="secondary" className="mt-3" onClick={() => onOpenStep("agents")}>See the agents&apos; reasons in {stepRef("agents")}</Button>
            </div>
          )}
        </Card>

      </div>

      <Card title="Model chain" className="mt-4" aside={<span className="text-sm text-ink-2">Each stage with the checks code ran on it, and the step that shows its working</span>}>
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
                <Button variant="secondary" className="w-full" aria-label={`${stage.label}, ${chainSummary(stage)}. Open ${stepRef(stage.step)}`} onClick={() => onOpenStep(stage.step)}>
                  <span className="min-w-0 wrap-anywhere">Open {stepRef(stage.step)}</span>
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {/* With an offer at the top, the card that takes another one and the full list of steps close the page. */}
      {offer && (
        <div className="mt-4 flex flex-wrap gap-4">
          {offerCard && <div className="min-w-0 flex-[2_1_30rem]">{offerCard}</div>}
          <DemoPath next={nextStep} hasCard={!!offerCard} another onOpenStep={onOpenStep} />
        </div>
      )}
    </div>
  );
}

/** The steps of the walkthrough in order, with the one to open next picked out. */
function DemoPath({ next, hasCard, another = false, onOpenStep }: { next: StepId; hasCard: boolean; another?: boolean; onOpenStep: (step: DashboardStep) => void }) {
  const nextLink: DashboardStep = next === "hazard" ? "hazard" : "offer";
  return (
    <Card title="The demo path" className="flex-[1_1_20rem]" aside={<span className="text-sm text-ink-2">The steps on the left, in order</span>}>
      <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
        {another
          ? `${next === "hazard" ? `The offer above runs through every step from ${STEP_NAMES.hazard} to ${STEP_NAMES.audit}.` : `The offer above is not priced yet: ${STEP_NAMES.offer} says what it is waiting for.`}${hasCard ? " To price a different offer, give it in the card beside this one." : ""}`
          : `Start here: ${hasCard ? "give the model an offer in the card beside this one" : "price an offer"}. Each step after that is about the offer's building, with the portfolio as its context.`}
      </p>
      <ol className="mt-3 grid gap-x-6 gap-y-1.5 text-sm grid-cols-[repeat(auto-fit,minmax(min(11rem,100%),1fr))]">
        {STEP_IDS.map((id) => (
          <li key={id} className="flex min-w-0 items-baseline gap-2" aria-current={id === "dashboard" ? "step" : undefined}>
            <span className="tabular w-5 shrink-0 text-right text-muted">{stepIndex(id)}</span>
            <span className={`min-w-0 wrap-anywhere ${id === "dashboard" ? "font-semibold text-ink" : "text-ink-2"}`}>
              {STEP_NAMES[id]}
              {id === "dashboard" && <span className="font-normal text-muted"> (you are here)</span>}
              {id === next && <span className="text-muted"> (next)</span>}
            </span>
          </li>
        ))}
      </ol>
      <Button variant="secondary" className="mt-4" onClick={() => onOpenStep(nextLink)}>
        Open {stepRef(nextLink)}
      </Button>
    </Card>
  );
}

/** A flag's severity as a word in a small box, so it never rests on colour. */
function SeverityWord({ severity }: { severity: "high" | "medium" | "low" }) {
  return (
    <span className={`inline-block w-16 shrink-0 rounded-md border px-1.5 py-0.5 text-center text-xs font-semibold uppercase tracking-wide ${severity === "high" ? "border-ink bg-ink text-surface" : severity === "medium" ? "border-ink text-ink" : "border-line text-ink-2"}`}>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

/**
 * The offer at the top of the page. Priced: its line, the four figures, how it was read, the worst
 * points to weigh, the decision and the way on. Not priced: why, in the focus's own words, and no loss figure.
 */
function OfferPanel({
  offer,
  priced,
  decision,
  lossSource,
  assumptions,
  onOpenStep,
}: {
  offer: OfferFocus;
  priced: PricedFocus | null;
  decision: DecisionRecord | null;
  lossSource: SourceKind;
  assumptions: string;
  onOpenStep: (step: DashboardStep) => void;
}) {
  const { summary, counts } = offer;
  const typed = counts.confirmed + counts.edited;
  const reading = [
    `${fmtInt(summary.fieldsVerified)} of ${plural(summary.fieldsRead, "value")} read from the document were found again in its text by code`,
    ...(typed > 0 ? [`${fmtInt(typed)} confirmed or typed by the underwriter`] : []),
    ...(counts.unverified > 0 ? [`${fmtInt(counts.unverified)} not verified`] : []),
  ].join("; ");
  const readBy = offer.document.path === "model" ? `Read by ${offer.document.model ?? "the model"}, checked by code.` : "Read by the fixed rules, with no model.";
  const top = headlineFlags(offer.flags, 3);
  const recorded = decision && decision.recordedAt && decision.choice ? { ...decision, choice: decision.choice } : null;
  const after = STEP_IDS.slice(stepIndex("hazard") + 1).map((id) => STEP_NAMES[id]);

  return (
    <section aria-label="The offer" className="min-w-0 rounded-2xl border border-line border-l-4 border-l-brand bg-surface p-5">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">The offer</div>
      <h3 className="mt-1 wrap-anywhere text-xl font-semibold leading-snug text-ink">{offer.line.text || offer.documentName}</h3>
      <p className="mt-1 wrap-anywhere text-sm leading-relaxed text-ink-2">
        From {offer.documentName}. {readBy} {reading}.
      </p>
      {offer.severalLine && <p className="mt-1 wrap-anywhere text-sm leading-relaxed text-ink-2">{offer.severalLine}</p>}

      {priced ? (
        <PricedOffer focus={priced} lossSource={lossSource} assumptions={assumptions} />
      ) : (
        <div className="mt-4">
          <Note tone="warn">
            {offer.outside ? (
              <>
                <strong className="font-semibold text-ink">{offer.outsideMessage}.</strong> {offer.coverage} No loss figure exists for this offer.
              </>
            ) : (
              <>
                <strong className="font-semibold text-ink">{offer.statusLine}</strong>
                {offer.waiting.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {offer.waiting.slice(0, 4).map((w) => (
                      <li key={w.fieldId} className="wrap-anywhere">{w.text}</li>
                    ))}
                    {offer.waiting.length > 4 && <li>And {fmtInt(offer.waiting.length - 4)} more.</li>}
                  </ul>
                )}
              </>
            )}
          </Note>
        </div>
      )}

      {priced && (
        <div className="mt-4 grid gap-x-8 gap-y-4 grid-cols-[repeat(auto-fit,minmax(min(24rem,100%),1fr))]">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">
              Points to weigh <span className="font-normal text-ink-2">({flagCountText(top.counts)})</span>
            </div>
            {top.shown.length === 0 ? (
              <p className="mt-1.5 text-sm leading-relaxed text-ink-2">The checks raised no point on this offer.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {top.shown.map((flag) => (
                  <li key={flag.id} className="flex min-w-0 items-start gap-2.5 text-sm leading-snug text-ink">
                    <SeverityWord severity={flag.severity} />
                    <span className="min-w-0 wrap-anywhere pt-0.5">{flag.title}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              {top.more > 0 ? `${plural(top.more, "more point")}, and the ` : "The "}evidence for each and the suggested conditions are in {stepRef("results")}.
            </p>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">Decision</div>
            <p className="mt-1.5 wrap-anywhere text-sm leading-relaxed text-ink-2">
              {recorded ? (
                <>
                  <span className="font-semibold text-ink">{DECISION_LABELS[recorded.choice]}</span>, recorded {fmtNoteDate(recorded.recordedAt)}
                  {recorded.conditions.length > 0 ? `, with ${plural(recorded.conditions.length, "condition")}` : ""}.
                </>
              ) : (
                <>None recorded yet. The underwriter records Accept, Accept with conditions, Refer or Decline in {stepRef("results")}.</>
              )}
            </p>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        {priced ? (
          <>
            <Button onClick={() => onOpenStep("hazard")}>Continue: {STEP_NAMES.hazard}</Button>
            <span className="min-w-0 wrap-anywhere text-sm text-ink-2">Then {after.join(", ")}.</span>
            <Button variant="ghost" className="ml-auto" onClick={() => onOpenStep("offer")}>Open the document in {stepRef("offer")}</Button>
          </>
        ) : (
          <Button onClick={() => onOpenStep("offer")}>Open {stepRef("offer")}</Button>
        )}
      </div>
    </section>
  );
}

/** The four figures an underwriter looks for first. Gross is after the policy deductible and limit. */
function PricedOffer({ focus, lossSource, assumptions }: { focus: PricedFocus; lossSource: SourceKind; assumptions: string }) {
  const { total, portfolio, building } = focus.price;
  const loss100 = total.loss100GrossKes;
  const rate = total.ratePerMilleGross;
  const madeBy = `${assumptions}, priced by code. Terms: ${focus.terms.summary.toLowerCase()}.`;
  return (
    <div className={`mt-4 ${FIGURE_GRID}`}>
      <Figure
        strong
        label={`Gross loss, ${rpWithChance(100)}`}
        value={loss100 === null ? "Not modelled" : kes1(loss100)}
        sub={
          loss100 === null
            ? "1-in-100 is more frequent than any flood the model covers."
            : building.dryAtEveryReturnPeriod
              ? "The maps show the building dry at every return period modelled."
              : `${pct1(loss100 / (total.tivKes || 1))} of the sum insured of ${kes1(total.tivKes)}${total.loss100Extrapolated ? ". Held flat beyond the rarest flood modelled." : ""}`
        }
        source={lossSource}
        sourceText={madeBy}
      />
      <Figure label="Average annual loss, gross" value={kes1(total.aalGrossKes)} sub={`A year on average. Ground-up ${kes1(total.aalGroundUpKes)}`} source={lossSource} sourceText={madeBy} />
      <Figure
        label="Pure flood rate, gross"
        value={`${fmtNum(rate, rate !== 0 && Math.abs(rate) < 0.1 ? 4 : 2)} per mille`}
        sub="Per KES 1,000 of sum insured, before expenses and loadings"
        source={lossSource}
        sourceText={madeBy}
      />
      <Figure
        label={`Change to the portfolio's ${rpLabel(100)} loss`}
        value={portfolioChangeText(portfolio.loss100ChangeKes, portfolio.loss100ChangeShare)}
        sub={`Ground-up, on ${kes1(portfolio.without.loss100Kes)} without the offer${portfolio.gross ? `. Gross: ${portfolioChangeText(portfolio.gross.change100Kes, portfolio.gross.change100Share)}` : ""}`}
        source="synthetic"
        sourceText="Against the synthetic portfolio"
      />
    </div>
  );
}
