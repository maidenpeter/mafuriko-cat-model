"use client";

/**
 * The dashboard: one call-out for the offer, then the portfolio it is priced against, on one page.
 *
 *   Call-out   the offer. The page takes no file itself: every offer is priced through the "Price an offer" step.
 *                no offer read   a slim band with one button, "Price an offer", that opens that step
 *                offer priced    its one line, four figures (flood rate, average annual loss, 1-in-100
 *                                loss, what it adds to the portfolio's 1-in-100), the 1-in-100 loss by
 *                                driver, the decision as it stands, a button to the decision and a
 *                                quiet one to price another offer
 *                not priced      the focus's own sentence (outside the hazard maps, or what pricing
 *                                waits for), no figure, and a button to the "Price an offer" step
 *   Portfolio  the section title with one line of context, and the flood event picker to its right
 *   Figures    six tiles in one even row
 *   Charts     two columns, the same in both rows: the loss curve beside one event taken through the
 *              insurance layers, then loss by housing class beside the ten wards with their map (the
 *              offer's building is marked on it)
 *   Last row   what the agents changed, beside the model chain with the checks on each stage
 *
 * The event picker drives the waterfall, the class bars, the ward bars and the map, and the count of
 * buildings reached. The figures defined at 1-in-100 stay at 1-in-100 and say so. Every offer figure
 * comes from the focus (lib/offer/focus): nothing is priced here. The settings in force are the
 * switches in the bar above every page, so this page does not repeat them.
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
 *   />
 *
 * The calculations live in lib/dashboard.ts; this file only lays them out.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { buildLedger, judgementLedger, type Deliberation } from "@/lib/agents/orchestrate";
import type { Check } from "@/lib/checks";
import {
  aalChange,
  chainStatus,
  chainSummary,
  classLossRows,
  dashboardStepId,
  driverParts,
  flagCountText,
  headlineFlags,
  hotspotCount,
  judgementChanges,
  layerSteps,
  nearestEventIndex,
  OFFER_FILE_TYPES_TEXT,
  paramChanges,
  portfolioChangeParts,
  signedPct,
  standardAt,
  topWards,
  type DashboardStep,
} from "@/lib/dashboard";
import { DECISION_LABELS, type DecisionRecord } from "@/lib/decision";
import { fmtNoteDate } from "@/lib/decisionNote";
import { PARAM_LABELS, unusedForDepth } from "@/lib/export";
import { fmtInt, fmtNum } from "@/lib/format";
import { loadGeo, type GeoLayers } from "@/lib/geo/layers";
import { assignPoints, wardAccumulation } from "@/lib/geo/spatial";
import { annualChance, kes1, LOSS_MODE_LABELS, pct1, perMille, PLACEHOLDER_RATE_LINE, rpLabel, rpWithChance, type SourceKind } from "@/lib/labels";
import { STANDARD_RETURN_PERIODS } from "@/lib/model/financial";
import type { TermsResult } from "@/lib/model/terms";
import type { DriverId } from "@/lib/offer/drivers";
import { isPriced, type OfferFocus, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES } from "@/lib/steps";
import { BarChart } from "../charts/BarChart";
import { ChartFrame, SourceBadge, type ChartSource } from "../charts/ChartFrame";
import { Figure } from "../charts/Figure";
import { OfferLossCurve, useOfferCurveRows } from "../charts/OfferCurves";
import { LineChart } from "../charts/LineChart";
import { driverSeries, StackStrip } from "../charts/StackedBars";
import { Waterfall } from "../charts/Waterfall";
import { askForUpload } from "../steps/OfferStep";
import { pointsOf } from "../steps/ResultsStep";
import { Button, Card, InsuredValueFlag, Note, PlaceholderBadge, Segmented, StatusIcon, StepHeader } from "../ui";
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
}

const TERMS_NOTE = "Example terms, not from any real policy or treaty";
/** Said once under the row of figures, so "net" is never left unexplained. */
const NET_MEANS = "Net is what is left after deductibles, policy limits, quota share and excess of loss.";

/** The name of the step a link opens, from lib/steps. */
const stepName = (step: DashboardStep) => STEP_NAMES[dashboardStepId(step)];

/** "no change" to "No change": a phrase from lib/dashboard standing as a figure of its own. */
const asFigure = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The band the offer's call-out is drawn in, whatever it holds: the rule down its side marks it as the lead of the page. */
const CALLOUT = "min-w-0 rounded-2xl border border-line border-l-4 border-l-brand bg-surface p-5";
const KICKER = "text-xs font-semibold uppercase tracking-[0.14em] text-muted";
const SECTION_TITLE = "text-lg font-semibold text-ink";

/**
 * The page's two columns, the same in every row so the gutters line up. The wider one holds the chart
 * that needs the room: the waterfall's bars, the ward bars beside their map, the table of what the
 * agents changed. Below 72rem of room the cards stack. The widths are in rem, so they follow the text size.
 */
const TWO_COLUMNS = "grid gap-4 @6xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]";
/** A chart card as tall as its neighbour: the chart takes the spare height, so the source line stays on the card's bottom edge. */
const CHART_CARD = "flex flex-col";
const CHART_BODY = "min-w-0 grow";
/**
 * Where the figures of a row stand side by side in narrow tiles, each label keeps the room of two
 * lines, so every figure sits on one line across the row whether its label wraps or not.
 */
const SIX_ACROSS = "@7xl:[&>div:first-child]:min-h-10";
const FOUR_ACROSS = "@6xl:[&>div:first-child]:min-h-10";

export function Dashboard({ session, active, terms, deliberation, checks, drainageOn, offerFocus, decision, onOpenStep }: DashboardProps) {
  const { dataset, reference } = session;
  const result = active.result;
  const usingAi = active.source === "ai";
  // With an offer priced, its own loss curve sits beside the portfolio's.
  const pricedOffer = isPriced(offerFocus) ? offerFocus : null;
  const offerCurve = useOfferCurveRows(pricedOffer, dataset, active.params);
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
  // The assumptions beyond depth the agents argued for an offer. None are listed when they ran with no offer loaded.
  const beyondDepth = useMemo(() => judgementChanges(judgementLedger(deliberation)), [deliberation]);

  const scenario = k >= 0 ? result.scenarios[k] : undefined;
  const layer = k >= 0 ? terms.scenarios[k] : undefined;
  if (!scenario || !layer) return <Note tone="warn">The model has no events to show yet.</Note>;

  const rp = scenario.returnPeriod;
  const event = rpLabel(rp);
  const assumptions = usingAi ? "Agreed assumptions" : "Reference assumptions";
  const lossSource: SourceKind = usingAi ? "ai" : "assumption";
  const allDrivers = result.mode === "all_drivers";

  // The offer leads the page from the moment it is read, priced or not.
  const offer = offerFocus ?? null;
  const priced = isPriced(offer) ? offer : null;
  const offerPoint = offer && !offer.outside && offer.building && offer.building.lat !== null && offer.building.lon !== null ? { lat: offer.building.lat, lon: offer.building.lon, label: "This offer" } : null;

  // The figures.
  const at100 = standardAt(terms.standard, 100);
  const net100 = at100?.netKes ?? null;
  const hotspots = hotspotCount(session.hits);
  const agentsAal = usingAi ? result.aalKes : deliberation?.final?.result.aalKes ?? null;
  const aiChange = aalChange(reference.aalKes, agentsAal);
  const netSource = `${assumptions}, example terms`;

  // The loss curve.
  const points = (pick: (row: TermsResult["scenarios"][number]) => number) => terms.scenarios.map((row) => ({ x: row.returnPeriod, y: pick(row) }));
  const eventRps = terms.scenarios.map((row) => row.returnPeriod);
  const firstRp = Math.min(...eventRps);
  const lastRp = Math.max(...eventRps);
  const standardTicks = STANDARD_RETURN_PERIODS.filter((x) => x >= firstRp && x <= lastRp);
  const xTicks = standardTicks.length >= 2 ? standardTicks : eventRps;
  const hoverXs = [...new Set([...eventRps, ...xTicks])].sort((a, b) => a - b);

  // Where the loss falls.
  const classes = classLossRows(scenario);

  const lossSources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings" },
    { kind: "real", text: "Hazard maps supplied with the model data" },
    { kind: "assumption", text: isScore ? "Return periods and flood depths" : "Damage curves" },
    ...(usingAi ? [{ kind: "ai" as const, text: "Damage and depth assumptions agreed by the agents" }] : []),
  ];
  const termsSource: ChartSource = { kind: "assumption", text: TERMS_NOTE };

  return (
    <div className="min-w-0">
      <StepHeader title={STEP_NAMES.dashboard}>
        Flood risk on the portfolio held, and each offer priced against it.
      </StepHeader>

      {/* The call-out: the first thing on the page, and the one way in to price an offer. */}
      <OfferCallout offer={offer} priced={priced} decision={decision ?? null} lossSource={lossSource} assumptions={assumptions} onOpenStep={onOpenStep} />

      {/* The portfolio: its title, one line, and the event picker beside them and above everything it drives. */}
      <div className="mt-8 mb-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h3 className={SECTION_TITLE}>The portfolio</h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">
            {priced ? "This offer would join it: " : "Every offer is priced against it: "}
            what a flood could cost, how often, and where the loss falls.
          </p>
        </div>
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span aria-hidden className="pl-3 text-xs font-medium text-ink-2">Flood event in the charts</span>
          <Segmented
            label="Return period of the flood event shown in the charts"
            value={scenario.id}
            onChange={setPicked}
            options={result.scenarios.map((s) => ({
              value: s.id,
              // The annual chance sits under the return period, so the picker stays narrow enough to stand beside the title.
              label: (
                <>
                  <span className="block whitespace-nowrap leading-tight">{rpLabel(s.returnPeriod)}</span>
                  <span className="block whitespace-nowrap text-xs leading-tight text-muted">{annualChance(s.returnPeriod)}</span>
                </>
              ),
            }))}
          />
        </div>
      </div>

      {/* Six figures in one even row: three across where six do not fit, then two, then one. */}
      <div className="grid gap-4 @md:grid-cols-2 @3xl:grid-cols-3 @7xl:grid-cols-6">
        <Figure className={SIX_ACROSS} label="Total insured value" value={kes1(result.totalTivKes)} sub={<>As written in the exposure file<InsuredValueFlag ratio={session.report.tivRatio?.median} className="mt-1.5" /></>} source="synthetic" sourceText="Synthetic portfolio" />
        <Figure
          className={SIX_ACROSS}
          label="Buildings insured"
          value={fmtInt(result.buildingCount)}
          sub={`${fmtInt(scenario.affected)} ${allDrivers ? "with water at the site" : "flooded"} in a ${event} event`}
          source="synthetic"
          sourceText="Synthetic portfolio"
        />
        <Figure
          className={SIX_ACROSS}
          label={`Net loss, ${rpWithChance(100)}`}
          value={kes1(net100)}
          sub={net100 === null ? "More frequent than any event modelled" : `${pct1(net100 / (result.totalTivKes || 1))} of insured value${at100?.extrapolated ? ", held flat beyond the rarest event" : ""}`}
          source={lossSource}
          sourceText={netSource}
        />
        <Figure
          className={SIX_ACROSS}
          label="Average annual loss, net"
          value={kes1(terms.aal.netKes)}
          sub={`Gross ${kes1(terms.aal.grossKes)}, ground-up ${kes1(terms.aal.groundUpKes)}`}
          source={lossSource}
          sourceText={netSource}
        />
        <Figure
          className={SIX_ACROSS}
          label="Known flood areas matched"
          value={hotspots.total > 0 ? `${fmtInt(hotspots.matched)} of ${fmtInt(hotspots.total)}` : "n/a"}
          sub={hotspots.total === 0 ? "The data lists no known flood areas" : drainageOn ? "Terrain and drainage flooding" : isScore ? "Terrain hazard maps only" : "On the flood depth maps"}
          source="real"
          sourceText="Named flood areas against the hazard maps"
        />
        <Figure
          className={SIX_ACROSS}
          label="Agents' effect on average annual loss"
          value={aiChange ? (aiChange.agentsKes === aiChange.referenceKes ? "No change" : aiChange.fraction === null ? kes1(aiChange.agentsKes) : signedPct(aiChange.fraction)) : "Not run yet"}
          sub={
            aiChange
              ? aiChange.agentsKes === aiChange.referenceKes
                ? `The set the agents agreed gives the same ground-up loss as the reference: ${kes1(aiChange.agentsKes)}`
                : `Ground-up: ${kes1(aiChange.agentsKes)} against ${kes1(aiChange.referenceKes)} on the reference`
              : "The agents have not agreed a set yet"
          }
          source="ai"
          sourceText="Assumptions by the agents, loss by code"
        />
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted">
        <SourceBadge kind="assumption" />
        <span className="min-w-0 wrap-anywhere">{NET_MEANS} {TERMS_NOTE}.</span>
      </p>

      {pricedOffer && offerCurve.length > 0 && (
        <OfferLossCurve
          compact
          className={`mt-4 ${CHART_CARD}`}
          focus={pricedOffer}
          rows={offerCurve}
          sources={[
            { kind: "real", text: "Hazard maps supplied with the model data" },
            { kind: "real", text: "The offer's insured value, deductible and limit, as read from the document" },
            { kind: usingAi ? "ai" : "assumption", text: usingAi ? "Assumptions agreed by the agents; every loss computed by code" : "Reference assumptions behind the depths, the damage and the loss drivers" },
          ]}
        />
      )}

      {/* How large a loss, how often, and who bears it. */}
      <div className={`mt-4 ${TWO_COLUMNS}`}>
        <ChartFrame
          className={CHART_CARD}
          title="Loss curve: how large a loss, how often"
          subtitle="Read across from a return period to the loss. Ground-up is before insurance terms, gross is after deductibles and limits, net is after reinsurance."
          sources={[...lossSources, termsSource]}
        >
          <div className={CHART_BODY}>
            <LineChart
              ariaLabel="Loss curve: ground-up, gross and net loss at each return period"
              xScale="log"
              xTicks={xTicks}
              xFormat={rpLabel}
              xSubFormat={annualChance}
              tooltipTitle={rpWithChance}
              yFormat={kes1}
              xLabel="Return period, with the chance of it being exceeded in any one year"
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
          </div>
        </ChartFrame>

        <ChartFrame
          className={CHART_CARD}
          title={`From ground-up loss to net loss in a ${event} event`}
          subtitle="Read left to right: a striped bar is what one party takes off the loss, a solid bar is what is left. The last bar is the net loss."
          sources={[...lossSources, termsSource]}
        >
          <div className={CHART_BODY}>
            <Waterfall
              title={`From ground-up loss to net loss in a ${event} event`}
              yLabel={`Loss in a ${rpWithChance(rp)} event, KES`}
              steps={layerSteps(layer)}
              totalLabel="Loss left"
              decreaseLabel="Taken off"
              height={320}
            />
          </div>
        </ChartFrame>
      </div>

      {/* Where the loss falls. Both charts show ground-up loss: reinsurance works on the portfolio total, so net loss has no split by class or ward. */}
      <div className={`mt-4 ${TWO_COLUMNS}`}>
        <ChartFrame
          className={CHART_CARD}
          title={`Loss by housing class in a ${event} event`}
          subtitle="Each bar is the ground-up loss to that class. A bar that runs past its diamond loses more than its share of insured value."
          sources={lossSources}
        >
          <div className={CHART_BODY}>
            <BarChart
              title={`Loss by housing class in a ${event} event`}
              rows={classes.map((c) => ({ label: c.label, value: c.lossKes, share: c.tivShare, note: `Value ${pct1(c.tivShare)}, loss ${pct1(c.lossShare)}` }))}
              xLabel={`Ground-up loss in a ${rpWithChance(rp)} event, KES`}
              format={kes1}
              valueLabel="Ground-up loss"
              mark={{ label: "Share of insured value", scale: "ofTotal", format: pct1 }}
            />
          </div>
        </ChartFrame>

        <ChartFrame
          className={CHART_CARD}
          title={`The ten wards with the most loss in a ${event} event`}
          subtitle={`Each bar is the ground-up loss to the insured buildings in that ward. The numbers beside the ward names are the numbers on the map${offerPoint ? ", where the diamond is the offer's building" : ""}.`}
          sources={[...lossSources, { kind: "real", text: "Ward boundaries: Omare and Omare 2017, CC BY 4.0" }]}
        >
          <div className={CHART_BODY}>
            {geo === null ? (
              <p className="text-sm text-ink-2">Loading the ward outlines.</p>
            ) : !wards ? (
              <p className="text-sm text-ink-2">The ward outlines are not available, so the loss cannot be split by ward.</p>
            ) : wardTop.length === 0 ? (
              <p className="text-sm text-ink-2">No ward has a loss in a {event} event.</p>
            ) : (
              <div className="grid items-start gap-x-6 gap-y-5 grid-cols-[repeat(auto-fit,minmax(min(18rem,100%),1fr))]">
                <div className="min-w-0">
                  <BarChart
                    title={`The ten wards with the most loss in a ${event} event`}
                    rows={wardTop.map((w) => ({ label: `${w.rank}. ${w.name}`, value: w.lossKes }))}
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
                {fmtInt(outsideWards.buildings)} insured buildings lie outside the ward outlines. Their {kes1(outsideWards.lossKes)} of loss in this event is in every total on this page and left out of the ranking.
              </p>
            )}
          </div>
        </ChartFrame>
      </div>

      {/* The quiet last row: what the agents changed, and the chain the figures came through. */}
      <h3 className={`mt-8 mb-4 ${SECTION_TITLE}`}>Assumptions and checks</h3>
      <div className={TWO_COLUMNS}>
        <Card title="What the agents changed" aside={<SourceBadge kind="ai" />}>
          {changes === null ? (
            <p className="text-sm leading-relaxed text-ink-2">The agents have not agreed a set of assumptions yet.</p>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-ink-2">
                {changes.moved.length === 0 ? `All ${changes.of} model parameters kept at the reference.` : `${changes.moved.length} of ${changes.of} model parameters moved from the reference.`}
                {beyondDepth.of === 0
                  ? " No offer was loaded when they ran, so the assumptions beyond depth are the reference values."
                  : beyondDepth.moved.length === 0
                    ? ` All ${beyondDepth.of} assumptions beyond depth kept at the reference.`
                    : ` ${beyondDepth.moved.length} of ${beyondDepth.of} assumptions beyond depth moved for the offer.`}
                {beyondDepth.of > 0 && offerFocus?.judgement.agents === "another_offer" ? " They argued a different offer from the one now loaded, so those are not in force." : ""}
                {beyondDepth.moved.length > 0 && !allDrivers ? ` With ${LOSS_MODE_LABELS.depth_only} selected, they enter no loss.` : ""}
              </p>
              {(changes.moved.length > 0 || beyondDepth.moved.length > 0) && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[24rem] text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th scope="col" className="pb-2 text-left font-medium">Parameter</th>
                        <th scope="col" className="pb-2 pl-3 text-right font-medium">Reference</th>
                        <th scope="col" className="pb-2 pl-3 text-right font-medium">Agreed</th>
                        <th scope="col" className="pb-2 pl-3 text-right font-medium">Change</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {changes.moved.length > 0 && beyondDepth.moved.length > 0 && (
                        <tr>
                          <th scope="colgroup" colSpan={4} className="pt-1 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-muted">Model parameters</th>
                        </tr>
                      )}
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
                      {beyondDepth.moved.length > 0 && (
                        <tr>
                          <th scope="colgroup" colSpan={4} className="pt-3 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-muted">Assumptions beyond depth, argued for the offer</th>
                        </tr>
                      )}
                      {beyondDepth.moved.map((c) => (
                        <tr key={c.key}>
                          <th scope="row" className="py-1.5 text-left font-normal text-ink">
                            {c.label}
                            {c.adjusted && <span className="block text-xs text-muted">Corrected by code to stay inside its allowed range</span>}
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
            </>
          )}
          <Button variant="secondary" className="mt-4" onClick={() => onOpenStep("agents")}>Open {stepName("agents")}</Button>
        </Card>

        <Card title="Model chain" aside={<span className="text-xs text-muted">Checks run by code on each stage</span>}>
          <ol className="divide-y divide-line">
            {stages.map((stage, i) => (
              <li key={stage.step} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0">
                <span className="shrink-0"><StatusIcon status={stage.status === "none" ? "idle" : stage.status} /></span>
                <span className="flex min-w-0 flex-1 basis-48 flex-wrap items-baseline gap-x-4 gap-y-0.5 text-sm">
                  <span className="w-40 shrink-0 wrap-anywhere font-semibold text-ink">{i + 1}. {stage.label}</span>
                  <span className="min-w-0 wrap-anywhere text-ink-2">{chainSummary(stage)}</span>
                </span>
                <Button variant="secondary" aria-label={`${stage.label}, ${chainSummary(stage)}. Open ${stepName(stage.step)}`} onClick={() => onOpenStep(stage.step)}>
                  <span className="min-w-0 wrap-anywhere">Open {stepName(stage.step)}</span>
                </Button>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}

/**
 * The call-out at the top of the page, in one of three states. No offer read: what pricing an offer
 * does and the one button that opens the upload. Read but not priced: why, in the focus's own
 * sentence, and no figure. Priced: the offer's figures and the way to its decision.
 */
function OfferCallout({
  offer,
  priced,
  decision,
  lossSource,
  assumptions,
  onOpenStep,
}: {
  offer: OfferFocus | null;
  priced: PricedFocus | null;
  decision: DecisionRecord | null;
  lossSource: SourceKind;
  assumptions: string;
  onOpenStep: (step: DashboardStep) => void;
}) {
  if (!offer) {
    return (
      <section aria-label="Price an offer" className={`${CALLOUT} flex flex-wrap items-center justify-between gap-x-8 gap-y-4`}>
        <div className="min-w-0 flex-1 basis-80">
          <h3 className={SECTION_TITLE}>Price an offer</h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">
            A broker&apos;s placement memo is read, every value is checked against the document, and the flood risk is priced against this portfolio.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">Accepted: {OFFER_FILE_TYPES_TEXT} files.</p>
        </div>
        <Button className="whitespace-nowrap" onClick={() => onOpenStep("offer")}>Price an offer</Button>
      </section>
    );
  }

  // The offer's line is its name, then its place, value, cover and period: the name is the heading and the rest sits under it.
  const [title, ...titleRest] = (offer.line.text || offer.documentName).split(" · ");
  const titleDetail = titleRest.join(" · ");

  if (!priced) {
    // Outside the hazard maps the sentence is the focus's fixed one. No figure is shown: a loss of zero would be wrong.
    const sentence = offer.outside && offer.outsideMessage ? `${offer.outsideMessage}.` : offer.statusLine;
    return (
      <section aria-label="The offer" className={`${CALLOUT} flex flex-wrap items-center justify-between gap-x-8 gap-y-4`}>
        <div className="min-w-0 flex-1 basis-80">
          <div className={KICKER}>The offer</div>
          <h3 className={`mt-1 wrap-anywhere leading-snug ${SECTION_TITLE}`}>{title}</h3>
          {titleDetail && <p className="mt-1 wrap-anywhere text-sm leading-relaxed text-ink-2">{titleDetail}</p>}
          <p className="mt-2 flex items-start gap-2 text-sm leading-relaxed text-ink">
            <span className="mt-0.5 shrink-0"><StatusIcon status={offer.status === "locating" ? "running" : "warn"} size={16} /></span>
            <span className="min-w-0 wrap-anywhere font-medium">{sentence}</span>
          </p>
        </div>
        <Button className="whitespace-nowrap" onClick={() => onOpenStep("offer")}>Open {stepName("offer")}</Button>
      </section>
    );
  }

  return (
    <section aria-label="The offer" className={CALLOUT}>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <div className={KICKER}>The offer</div>
          <h3 className={`mt-1 wrap-anywhere leading-snug ${SECTION_TITLE}`}>{title}</h3>
          {titleDetail && <p className="mt-1 wrap-anywhere text-sm leading-relaxed text-ink-2">{titleDetail}</p>}
          {priced.severalLine && <p className="mt-1 wrap-anywhere text-sm leading-relaxed text-ink-2">{priced.severalLine}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button className="whitespace-nowrap" onClick={() => onOpenStep("results")}>Open the decision</Button>
          <Button
            variant="ghost"
            className="whitespace-nowrap"
            onClick={() => {
              // The step folds its upload away once an offer is read: this asks it to open on the upload.
              askForUpload();
              onOpenStep("offer");
            }}
          >
            Price another offer
          </Button>
        </div>
      </div>
      <PricedOffer focus={priced} decision={decision} lossSource={lossSource} assumptions={assumptions} />
    </section>
  );
}

/** One line of the offer's standing: what it is, then what is so. */
function Standing({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{term}</dt>
      <dd className="mt-0.5 wrap-anywhere text-sm leading-relaxed text-ink">{children}</dd>
    </div>
  );
}

/**
 * What an underwriter looks for first: the flood rate, the average annual loss, the 1-in-100 loss and
 * what it adds to the portfolio's, then where that 1-in-100 loss comes from and how the offer stands.
 * All for the setting of the "Losses from" switch in force. The points to weigh and the decision are
 * counted here and set out on the Results step.
 */
function PricedOffer({ focus, decision, lossSource, assumptions }: { focus: PricedFocus; decision: DecisionRecord | null; lossSource: SourceKind; assumptions: string }) {
  const { total, portfolio, building } = focus.price;
  const { drivers, summary, counts } = focus;
  const { premium } = drivers;
  const all = focus.mode === "all_drivers";
  const modeLabel = LOSS_MODE_LABELS[focus.mode];
  const loss100 = total.loss100GrossKes;
  // What the offer adds to the portfolio's 1-in-100: gross where it could be worked out, the basis the capital load is worked from.
  const change = portfolio.gross
    ? { basis: "gross", kes: portfolio.gross.change100Kes, share: portfolio.gross.change100Share }
    : { basis: "ground-up", kes: portfolio.loss100ChangeKes, share: portfolio.loss100ChangeShare };
  const added = portfolioChangeParts(change.kes, change.share);
  const madeBy = `${assumptions}, priced by code`;

  // The modelled flood nearest 1-in-100, split by driver.
  const k = nearestEventIndex(drivers.perReturnPeriod.map((r) => r.returnPeriod), 100);
  const row = k >= 0 ? drivers.perReturnPeriod[k] : null;
  // Only the drivers that take part, each under the name its line carries: a driver that is off is not listed as KES 0.
  const series = driverSeries(drivers.lines);
  const names = Object.fromEntries(drivers.lines.map((line) => [line.id, line.label])) as Record<DriverId, string>;
  const strip = row ? driverParts(row.groundUpKes, series.map((band) => band.id), names) : null;
  const agentsSetSome = all && Object.values(focus.judgement.setBy).includes("agents");

  // How the offer stands: the decision, the points to weigh as a count, and how the document was read.
  const recorded = decision && decision.recordedAt && decision.choice ? { ...decision, choice: decision.choice } : null;
  const points = headlineFlags(pointsOf(focus), 0).counts;
  const setByHand = counts.confirmed + counts.edited;
  const reading = [
    `${fmtInt(summary.fieldsVerified)} of ${plural(summary.fieldsRead, "value")} verified by code`,
    ...(setByHand > 0 ? [`${fmtInt(setByHand)} set by the underwriter`] : []),
    ...(counts.unverified > 0 ? [`${fmtInt(counts.unverified)} not verified`] : []),
  ].join(", ");

  return (
    <>
      {/* Four figures in one even row: two by two where four do not fit, then one column. */}
      <div className="mt-4 grid gap-4 @md:grid-cols-2 @6xl:grid-cols-4">
        {all ? (
          <Figure
            className={FOUR_ACROSS}
            label={premium.setBy === "minimum rate" ? "Flood rate, the minimum rate" : "Flood rate"}
            value={perMille(premium.floodRatePerMille)}
            sub={
              <>
                {`Flood premium ${kes1(premium.floodPremiumKes)} a year${premium.stated ? `. The offer's all-risks rate: ${perMille(premium.stated.ratePerMille)}` : ""}.`}
                <span className="mt-1.5 block">{PLACEHOLDER_RATE_LINE}</span>
                <span className="mt-1.5 block"><PlaceholderBadge /></span>
              </>
            }
            source="assumption"
            sourceText="Modelled loss by code, loadings assumed"
          />
        ) : (
          <Figure className={FOUR_ACROSS} label="Pure flood rate, gross" value={perMille(total.ratePerMilleGross)} sub="Before expenses and loadings" source={lossSource} sourceText={madeBy} />
        )}
        <Figure className={FOUR_ACROSS} label="Average annual loss, gross" value={kes1(total.aalGrossKes)} sub={`Ground-up ${kes1(total.aalGroundUpKes)}`} source={lossSource} sourceText={madeBy} />
        <Figure
          className={FOUR_ACROSS}
          label={`Gross loss, ${rpWithChance(100)}`}
          value={loss100 === null ? "Not modelled" : kes1(loss100)}
          sub={
            loss100 === null
              ? "More frequent than any flood modelled"
              : building.dryAtEveryReturnPeriod
                ? "No water reaches the building at any return period"
                : `${pct1(loss100 / (total.tivKes || 1))} of the sum insured${total.loss100Extrapolated ? ", held flat beyond the rarest flood" : ""}`
          }
          source={lossSource}
          sourceText={madeBy}
        />
        <Figure
          className={FOUR_ACROSS}
          label={`Added to the portfolio, ${rpWithChance(100)}`}
          value={asFigure(added.amount)}
          sub={added.share ? `${added.share} on its ${change.basis} loss` : `On its ${change.basis} loss`}
          source={lossSource}
          sourceText={madeBy}
        />
      </div>

      <div className="mt-4 grid gap-x-8 gap-y-4 @5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {row && strip && (
          <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-4">
            <h4 className="text-sm font-semibold text-ink">Loss by driver in a {rpWithChance(row.returnPeriod)} flood</h4>
            <p className="mt-0.5 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
              The strip is the ground-up loss of {kes1(row.groundUpTotalKes)}, split by driver. Gross, after the deductible and the limit, is {kes1(row.grossKes)}.
              {row.returnPeriod !== 100 ? " This is the modelled flood nearest 1-in-100." : ""}
            </p>
            {strip.totalKes > 0 ? (
              <StackStrip title={`Ground-up loss by driver in a ${rpLabel(row.returnPeriod)} flood`} parts={strip.parts} series={series} />
            ) : (
              <p className="text-sm leading-relaxed text-ink-2">No driver gives a loss in this flood with {modeLabel}.</p>
            )}
            <ul aria-label="Sources" className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-3 text-xs leading-relaxed text-muted">
              <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <SourceBadge kind="real" />
                <span className="min-w-0 wrap-anywhere">{focus.hazardKind === "score" ? "Hazard maps; depth is an assumed scale on their score" : "Flood depth maps"}</span>
              </li>
              {all && (
                <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <SourceBadge kind="assumption" />
                  {agentsSetSome && <SourceBadge kind="ai" />}
                  <span className="min-w-0 wrap-anywhere">The assumptions behind the drivers beyond depth{agentsSetSome ? ", some agreed by the agents" : ""}</span>
                </li>
              )}
              <li className="min-w-0 wrap-anywhere">Deductible and limit: {focus.terms.summary.toLowerCase()}</li>
            </ul>
          </div>
        )}
        <dl className="grid min-w-0 content-start gap-y-3">
          <Standing term="Decision">
            {recorded ? (
              <>
                <span className="font-semibold">{DECISION_LABELS[recorded.choice]}</span>, recorded {fmtNoteDate(recorded.recordedAt)}
                {recorded.conditions.length > 0 ? `, with ${plural(recorded.conditions.length, "condition")}` : ""}
              </>
            ) : (
              "None recorded yet"
            )}
          </Standing>
          <Standing term="Points to weigh">{asFigure(flagCountText(points))}</Standing>
          <Standing term="Document">
            {focus.documentName}, read by {focus.document.path === "model" ? "the model" : "the fixed rules"}: {reading}
          </Standing>
        </dl>
      </div>
    </>
  );
}
