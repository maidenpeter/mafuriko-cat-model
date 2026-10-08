"use client";

import { useMemo, useState } from "react";
import type { Deliberation } from "@/lib/agents/orchestrate";
import { countFlags, emptyDecision, EVIDENCE_LABELS, SEVERITY_LABELS, SEVERITY_ORDER, sortFlags, toggleCondition, type DecisionRecord, type Severity } from "@/lib/decision";
import { buildDecisionNoteHtml, decisionNoteFileName, type DecisionNoteInput } from "@/lib/decisionNote";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { isPriced, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import { EP_HELP, annualChance, kes1, pct1, rpLabel, rpWithChance } from "@/lib/labels";
import { lossAtReturnPeriod, STANDARD_RETURN_PERIODS } from "@/lib/model/financial";
import type { TermsResult } from "@/lib/model/terms";
import { HOUSING_CLASSES, HOUSING_LABELS, type ModelResult } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, stepKicker, type StepId } from "@/lib/steps";
import pkg from "../../../package.json";
import { ChartFrame, SourceBadge, SourceLine, type ChartSource } from "../charts/ChartFrame";
import { Figure } from "../charts/Figure";
import { LineChart, valueAt, type Point } from "../charts/LineChart";
import { DecisionPanel } from "../DecisionPanel";
import { OasisCheck } from "../OasisCheck";
import { Button, Card, Note, Segmented, StepHeader, Tag } from "../ui";
import { CLASS_COLORS } from "./DataStep";

const curve = (r: ModelResult): Point[] => r.scenarios.map((s) => ({ x: s.returnPeriod, y: s.lossKes }));
const signed = (fraction: number) => `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(0)}%`;
const RP_TICKS = [2, 5, ...STANDARD_RETURN_PERIODS, 500, 1000];
const ticksBetween = (xs: number[]) => RP_TICKS.filter((x) => x >= Math.min(...xs) && x <= Math.max(...xs));
const snapPoints = (xs: number[], ticks: number[]) => [...new Set([...xs, ...ticks])].sort((a, b) => a - b);

interface PortfolioProps {
  session: Session;
  active: Active;
  deliberation: Deliberation | null;
  /** The terrain-only session, which the Oasis check was run against. */
  engineSession?: Session;
  /** The same assumptions on terrain flooding alone, shown when drainage is switched on. */
  terrainResult?: ModelResult | null;
  /** The insurance terms applied to the result in force: ground-up, gross and net for every event. */
  terms: TermsResult;
}

interface Props extends PortfolioProps, OfferFocusProps {
  /** The underwriter's decision on the offer, kept by the walkthrough so it survives leaving the step. */
  decision?: DecisionRecord;
  onDecision?: (next: DecisionRecord) => void;
  /** Where the model data came from, for the foot of the decision note. */
  dataSource?: string;
  /** Opens another step of the walkthrough. */
  onOpenStep?: (id: StepId) => void;
}

type View = "offer" | "portfolio";

/**
 * With a priced offer in Offer mode this is the underwriter's decision page, and the portfolio's
 * results are the second view of the same step. Without one it shows the portfolio's results.
 */
export function ResultsStep({ focus, offerFocus, decision, onDecision, dataSource, onOpenStep, ...portfolio }: Props) {
  const [view, setView] = useState<View>("offer");
  // The walkthrough owns the record. This one only stands in if the step is ever used without it.
  const [ownDecision, setOwnDecision] = useState<DecisionRecord>(emptyDecision);
  const onOffer = Boolean(focus) && view === "offer";

  return (
    <div>
      <StepHeader kicker={stepKicker("results")} title={STEP_NAMES.results}>
        {onOffer
          ? "Whether to take this business, and on what terms: the figures, the points to weigh, and the decision you record."
          : "What an underwriter needs: how large the loss could be at each level of rarity, what an average year costs, and where the loss comes from."}
      </StepHeader>

      {focus && (
        <div className="mb-4">
          <Segmented<View> label="View" value={view} onChange={setView} options={[{ value: "offer", label: "This offer" }, { value: "portfolio", label: "Portfolio" }]} />
        </div>
      )}
      {!focus && offerFocus && (
        <div className="mb-4">
          <Note tone={offerFocus.outside || offerFocus.waiting.length > 0 ? "warn" : "info"}>
            <span className="font-semibold text-ink">{offerFocus.line.insured ?? offerFocus.documentName}. </span>
            {offerFocus.outside
              ? `${offerFocus.outsideMessage}. There is no decision page for it; the portfolio's results are below.`
              : isPriced(offerFocus)
                ? "This offer is priced. Switch to Offer in the header for its decision page."
                : `${offerFocus.statusLine} Its decision page opens once it is priced; the portfolio's results are below.`}
            {!offerFocus.outside && !isPriced(offerFocus) && onOpenStep && (
              <> <StepLink id="offer" onOpenStep={onOpenStep} /></>
            )}
          </Note>
        </div>
      )}

      {focus && onOffer ? (
        <OfferDecision
          focus={focus}
          decision={decision ?? ownDecision}
          onDecision={onDecision ?? setOwnDecision}
          dataSource={dataSource}
          onOpenStep={onOpenStep}
        />
      ) : (
        <PortfolioResults {...portfolio} />
      )}
    </div>
  );
}

/** A step's name as a link that opens it. */
function StepLink({ id, onOpenStep }: { id: StepId; onOpenStep?: (id: StepId) => void }) {
  if (!onOpenStep) return <span className="font-medium text-ink">{STEP_NAMES[id]}</span>;
  return (
    <button type="button" onClick={() => onOpenStep(id)} className="font-medium text-ink underline underline-offset-2 hover:opacity-80">
      {STEP_NAMES[id]}
    </button>
  );
}

const SEVERITY_COLOR: Record<Severity, string> = { high: "var(--critical)", medium: "var(--warning)", low: "var(--muted)" };

/** Severity as a shape and its word: a triangle for high, a diamond for medium, a ring for low. */
function SeverityMark({ severity }: { severity: Severity }) {
  const color = SEVERITY_COLOR[severity];
  return (
    <span className="inline-flex w-20 shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink">
      <svg viewBox="0 0 16 16" aria-hidden className="shrink-0" style={{ width: "1rem", height: "1rem" }}>
        {severity === "high" && <path d="M8 1.5l7 12.5H1z" fill={color} />}
        {severity === "medium" && <path d="M8 1.5l6.5 6.5L8 14.5 1.5 8z" fill={color} />}
        {severity === "low" && <circle cx="8" cy="8" r="5.5" fill="none" stroke={color} strokeWidth="2" />}
      </svg>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

const ratePerMille = (rate: number) => `${fmtNum(rate, rate !== 0 && Math.abs(rate) < 0.1 ? 4 : 2)} per mille`;
const signedKes = (v: number) => (Math.abs(v) < 0.5 ? "no change" : `${v < 0 ? "-" : "+"}${kes1(Math.abs(v))}`);
const signedShare = (f: number) => `${f < 0 ? "-" : "+"}${fmtPct(Math.abs(f), Math.abs(f) < 0.001 ? 3 : 1)}`;

/** The decision page for one priced offer. Every figure is read from the focus; nothing is priced here. */
function OfferDecision({
  focus,
  decision,
  onDecision,
  dataSource,
  onOpenStep,
}: {
  focus: PricedFocus;
  decision: DecisionRecord;
  onDecision: (next: DecisionRecord) => void;
  dataSource?: string;
  onOpenStep?: (id: StepId) => void;
}) {
  const { line, terms, conditions } = focus;
  const { total, portfolio, building } = focus.price;
  const [printBlocked, setPrintBlocked] = useState(false);

  const usingAi = focus.assumptionsInForce === "ai";
  const basis = usingAi ? "ai" : "assumption";
  const basisText = usingAi ? "Assumptions agreed by the agents" : "Reference assumptions";
  const exampleTerms = terms.deductible.source === "example terms" || terms.limit.source === "example terms";
  const flags = sortFlags(focus.flags);
  const counts = countFlags(flags);
  const flagTitle = new Map(flags.map((f) => [f.id, f.title]));
  const subject = focus.several ? "this offer" : "this building";

  // The portfolio comparison after policy terms where it could be worked out, otherwise before them.
  const change = portfolio.gross
    ? { basis: "gross", kes: portfolio.gross.change100Kes, share: portfolio.gross.change100Share, without: portfolio.gross.without100Kes, withOffer: portfolio.gross.with100Kes }
    : { basis: "ground-up", kes: portfolio.loss100ChangeKes, share: portfolio.loss100ChangeShare, without: portfolio.without.loss100Kes, withOffer: portfolio.with.loss100Kes };

  const groundUp: Point[] = total.curve.map((p) => ({ x: p.returnPeriod, y: p.groundUpKes }));
  const gross: Point[] = total.curve.map((p) => ({ x: p.returnPeriod, y: p.grossKes }));
  const xs = total.curve.map((p) => p.returnPeriod);
  const ticks = ticksBetween(xs);
  const noLoss = total.curve.every((p) => !(p.groundUpKes > 0));
  const anyHeldFlat = total.standard.some((l) => l.extrapolated);

  const sources: ChartSource[] = [
    { kind: "real", text: focus.hazardKind === "score" ? "Hazard maps; depth is an assumed scale on their score" : "Flood depth maps" },
    { kind: basis, text: usingAi ? "Hazard and damage assumptions agreed by the agents" : "Reference hazard and damage assumptions" },
    focus.document.path === "model"
      ? { kind: "ai", text: "Sum insured and terms read from the offer document, each checked against its text by code" }
      : { kind: "real", text: "Sum insured and terms read from the offer document by fixed rules" },
    ...(exampleTerms ? [{ kind: "assumption" as const, text: "Example terms where the document states none" }] : []),
  ];

  const note = (): DecisionNoteInput => ({
    offer: {
      insured: line.insured ?? focus.documentName,
      location: line.location ?? "location not stated",
      sumInsuredKes: line.sumInsuredKes,
      coverSought: [line.cover, line.period].filter(Boolean).join(", ") || "not stated",
    },
    figures: {
      grossLoss100Kes: total.loss100GrossKes,
      averageAnnualLossKes: total.aalGrossKes,
      pureRatePerMille: total.ratePerMilleGross,
      portfolioChange100Kes: change.kes,
      portfolioChange100Fraction: change.share,
    },
    lossByReturnPeriod: total.standard.filter((l) => l.groundUpKes !== null).map((l) => ({ returnPeriodYears: l.returnPeriod, groundUpKes: l.groundUpKes, grossKes: l.grossKes })),
    flags,
    conditions: conditions.map((c) => ({ id: c.id, text: c.text })),
    // A draft is not a decision: until it is recorded the note says so, and keeps the note text and the ticks.
    decision: decision.recordedAt ? decision : { ...decision, choice: null },
    terms: {
      source: exampleTerms ? "example" : "document",
      lines: [
        { label: `Deductible (${terms.deductible.source})`, value: terms.deductible.text },
        { label: `Limit (${terms.limit.source})`, value: terms.limit.text },
        ...(line.cover ? [{ label: "Flood cover asked for", value: line.cover }] : []),
        ...(line.period ? [{ label: "Policy period", value: line.period }] : []),
      ],
    },
    footer: {
      modelVersion: pkg.version,
      dataSource: `${dataSource ?? focus.datasetName}${focus.drainageOn ? ", drainage ponding on" : ", terrain flooding only"}`,
      assumptions: usingAi ? "agents" : "reference",
    },
  });

  const download = () => {
    const input = note();
    const url = URL.createObjectURL(new Blob([buildDecisionNoteHtml(input)], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = decisionNoteFileName(input.offer.insured, new Date());
    a.click();
    URL.revokeObjectURL(url);
  };

  const print = () => {
    const win = window.open("", "_blank");
    setPrintBlocked(!win);
    if (!win) return;
    win.document.open();
    win.document.write(buildDecisionNoteHtml(note()));
    win.document.close();
    win.focus();
    win.print();
  };

  return (
    <div>
      <Card>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-x-8 gap-y-3">
          {[
            { label: "Insured", value: line.insured ?? "Not stated" },
            { label: "Location", value: line.location ?? "Not stated" },
            { label: "Sum insured", value: line.sumInsuredKes !== null ? fmtKes(line.sumInsuredKes) : "Not stated" },
            { label: "Cover sought", value: [line.cover, line.period].filter(Boolean).join(", ") || "Not stated" },
          ].map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-xs text-muted">{item.label}</dt>
              <dd className="tabular wrap-anywhere text-base font-semibold text-ink">{item.value}</dd>
            </div>
          ))}
        </dl>
        {focus.severalLine && <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-2">{focus.severalLine}</p>}
      </Card>

      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))] gap-4">
        <Figure
          strong
          label={`Gross loss in a ${rpWithChance(100)} flood`}
          value={total.loss100GrossKes !== null ? kes1(total.loss100GrossKes) : "not modelled"}
          sub={
            total.loss100GrossKes === null
              ? "A 1-in-100 flood is more frequent than anything modelled under these assumptions."
              : `${pct1(total.tivKes > 0 ? total.loss100GrossKes / total.tivKes : 0)} of the sum insured${total.loss100Extrapolated ? ", held flat beyond the rarest flood modelled" : ""}. Ground-up ${kes1(total.loss100GroundUpKes)}.`
          }
          source={basis}
          sourceText={`${basisText}. Terms: ${terms.summary.toLowerCase()}`}
        />
        <Figure
          label="Average annual loss, gross"
          value={kes1(total.aalGrossKes)}
          sub={`Ground-up ${kes1(total.aalGroundUpKes)}.`}
          source={basis}
          sourceText={basisText}
        />
        <Figure
          label="Pure flood rate, gross"
          value={ratePerMille(total.ratePerMilleGross)}
          sub="Before expense, profit and uncertainty loadings."
          source={basis}
          sourceText={basisText}
        />
        <Figure
          label={`Change to the portfolio's 1-in-100 loss, ${change.basis}`}
          value={change.kes === null ? "not modelled" : `${signedKes(change.kes)}${change.share !== null && Math.abs(change.kes) >= 0.5 ? ` (${signedShare(change.share)})` : ""}`}
          sub={
            change.kes === null
              ? "A 1-in-100 loss cannot be read for the portfolio under these assumptions."
              : `From ${kes1(change.without)} to ${kes1(change.withOffer)} with the offer added.${portfolio.gross && portfolio.loss100ChangeKes !== null ? ` Ground-up: ${signedKes(portfolio.loss100ChangeKes)}.` : ""}`
          }
          source="synthetic"
          sourceText={portfolio.gross ? "Synthetic portfolio on example terms" : "Synthetic portfolio"}
        />
      </div>

      <ChartFrame
        className="mt-4"
        title={`Loss by return period for ${subject}: ground-up and gross`}
        subtitle="Each point is the loss from one flood of that rarity. The gap between the two lines is what the deductible and the limit take off. Further right is rarer."
        help={noLoss ? undefined : EP_HELP}
        sources={sources}
        aside={<Tag kind={basis}>{usingAi ? "Agreed assumptions in force" : "Reference assumptions in force"}</Tag>}
      >
        <div className="grid gap-x-8 gap-y-4 @6xl:grid-cols-[minmax(0,1fr)_minmax(26rem,0.7fr)]">
          <div className="min-w-0">
            {noLoss ? (
              <Note>
                <span className="font-semibold text-ink">No loss at any modelled return period, so there is no curve to draw.</span>{" "}
                {building.dryAtEveryReturnPeriod
                  ? `The depth used at ${subject === "this offer" ? "the building followed" : "the building"} is zero in every flood modelled${building.nearestWetM !== null && building.nearestWetM > 0 ? `, with mapped flood water ${fmtInt(building.nearestWetM)} m away` : ""}.`
                  : "The damage curve gives no loss at the depths read."}{" "}
                The depths are in <StepLink id="hazard" onOpenStep={onOpenStep} />. A figure of KES 0 is the model&rsquo;s answer at this exact point, not proof that the site cannot flood: weigh the points below.
              </Note>
            ) : (
              <LineChart
                height={300}
                endLabels
                xScale="log"
                xTicks={ticks}
                xFormat={rpLabel}
                xSubFormat={annualChance}
                tooltipTitle={(x) => `${rpWithChance(x)} flood`}
                yFormat={kes1}
                yLabel="Loss from one event (KES)"
                xLabel="Return period (years), with the chance of a loss this large or larger in any year. Further right is rarer."
                ariaLabel={`Ground-up and gross loss to ${subject} in KES against return period in years`}
                hoverXs={snapPoints(xs, ticks)}
                series={[
                  { id: "ground-up", label: "Ground-up loss", endLabel: "Ground-up", color: "var(--series-3)", points: groundUp, dash: "2 6", marker: "triangle" },
                  { id: "gross", label: "Gross loss, after the deductible and limit", endLabel: "Gross", color: "var(--series-2)", points: gross, marker: "square" },
                ]}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="overflow-x-auto">
              <table className="w-full min-w-96 text-sm">
                <caption className="pb-2 text-left text-sm font-medium text-ink">Loss at each standard return period, KES</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="pb-2 text-left font-medium">Return period (chance a year)</th>
                    <th className="pb-2 pl-3 text-right font-medium">Ground-up</th>
                    <th className="pb-2 pl-3 text-right font-medium">Gross</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {total.standard.map((l) => {
                    const cell = (v: number | null) => (v === null ? "not modelled" : `${kes1(v)}${l.extrapolated ? " †" : ""}`);
                    return (
                      <tr key={l.returnPeriod}>
                        <td className="tabular py-2 text-ink">{rpWithChance(l.returnPeriod)}</td>
                        <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{cell(l.groundUpKes)}</td>
                        <td className="tabular whitespace-nowrap py-2 pl-3 text-right font-semibold text-ink">{cell(l.grossKes)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="py-2 text-ink">Average annual loss</td>
                    <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{kes1(total.aalGroundUpKes)}</td>
                    <td className="tabular whitespace-nowrap py-2 pl-3 text-right font-semibold text-ink">{kes1(total.aalGrossKes)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
              {total.standard.some((l) => l.groundUpKes === null) ? "“Not modelled” means the event is more frequent than the most frequent flood modelled. " : ""}
              {anyHeldFlat ? "† held flat beyond the rarest flood modelled. " : ""}
              The depth, damage ratio, deductible and limit behind each figure are in <StepLink id="loss" onOpenStep={onOpenStep} />.
            </p>
          </div>
        </div>
      </ChartFrame>

      {/* On a wide screen the points to weigh sit beside what the underwriter does about them. */}
      <div className="mt-4 grid items-start gap-4 @6xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Card
          title="Points for the underwriter"
          aside={
            <span className="text-xs text-muted">
              {flags.length === 0 ? "None raised" : SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${SEVERITY_LABELS[s].toLowerCase()}`).join(" · ")}, most severe first
            </span>
          }
        >
          {flags.length === 0 ? (
            <p className="text-sm leading-relaxed text-ink-2">The checks and the document raise no point on this offer.</p>
          ) : (
            <ul className="-mt-2 divide-y divide-line">
              {flags.map((flag) => (
                <li key={flag.id} className="flex flex-wrap gap-x-3 gap-y-1 py-3 @xl:flex-nowrap">
                  <span className="mt-0.5"><SeverityMark severity={flag.severity} /></span>
                  <div className="min-w-0 basis-full wrap-anywhere @xl:basis-auto">
                    <div className="text-sm font-semibold text-ink">{flag.title}</div>
                    {flag.detail && flag.detail !== flag.evidence.text && <p className="mt-0.5 max-w-3xl text-sm leading-relaxed text-ink-2">{flag.detail}</p>}
                    <p className="mt-1.5 max-w-3xl border-l-2 border-axis pl-3 text-sm leading-relaxed text-ink-2">
                      <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{EVIDENCE_LABELS[flag.evidence.kind]}</span>
                      {flag.evidence.kind === "quote" ? <q className="italic">{flag.evidence.text}</q> : flag.evidence.text}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-muted">
            Every check behind these points, passed or not, is listed in <StepLink id="audit" onOpenStep={onOpenStep} />.
          </p>
        </Card>

        <div className="grid min-w-0 gap-4">
          <Card title="Suggested conditions" aside={<span className="text-xs text-muted">Suggestions, not requirements</span>}>
            {conditions.length === 0 ? (
              <p className="text-sm leading-relaxed text-ink-2">The points on this offer suggest no condition.</p>
            ) : (
              <>
                <p className="-mt-2 mb-2 max-w-3xl text-sm leading-relaxed text-ink-2">Tick the ones to apply. Ticked suggestions are printed on the decision note as selected.</p>
                <ul className="divide-y divide-line">
                  {conditions.map((c) => {
                    const answers = c.because.map((id) => flagTitle.get(id)).filter((t): t is string => Boolean(t));
                    // The points are named below, so the sentence that only counts them is left out.
                    const reason = answers.length > 0 ? c.why.replace(/\s*(A flag|\d+ flags) on this page point to it\.$/, "") : c.why;
                    return (
                      <li key={c.id} className="py-3">
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            checked={decision.conditions.includes(c.id)}
                            onChange={() => onDecision(toggleCondition(decision, c.id))}
                            className="mt-0.5 size-4 shrink-0 accent-accent"
                          />
                          <span className="min-w-0 wrap-anywhere text-sm font-medium leading-relaxed text-ink">{c.text}</span>
                        </label>
                        <div className="ml-7 mt-1 text-sm leading-relaxed text-ink-2">
                          {reason && <p>{reason}</p>}
                          {answers.length > 0 && (
                            <p><span className="text-xs font-semibold uppercase tracking-wide text-muted">Answers </span>{answers.join("; ")}.</p>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Card>

          <DecisionPanel decision={decision} onDecision={onDecision} conditionIds={conditions.map((c) => c.id)}>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={download}>Download decision note</Button>
              <Button variant="secondary" onClick={print}>Print or save as PDF</Button>
            </div>
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
              One page with everything above: the offer, the figures, the points, the conditions, the terms used and the decision.
              {decision.recordedAt ? "" : " Until a decision is recorded, the note says that none is."}
            </p>
            {printBlocked && (
              <p role="alert" className="mt-2 text-sm leading-relaxed text-ink">
                The browser blocked the new window. Allow pop-ups for this page, or download the note and print the file.
              </p>
            )}
          </DecisionPanel>
        </div>
      </div>
    </div>
  );
}

/** The portfolio's results: the step as it stands without an offer, and the second view with one. */
function PortfolioResults({ session, active, deliberation, engineSession, terrainResult, terms }: PortfolioProps) {
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

  // Where the ground-up loss of one scenario comes from. The hazard maps are real data; a hazard score read from them is a proxy.
  const lossSources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
    { kind: "real", text: isScore ? "Hazard maps; the hazard score read from them is a derived proxy" : "Flood depth maps" },
    { kind: basis, text: usingAi ? "Hazard and damage assumptions agreed by the agents" : "Reference hazard and damage assumptions" },
  ];

  return (
    <div>
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
                      <th className="pb-2 text-left font-medium">Return period (chance a year)</th>
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
                          <td className="tabular py-2 text-ink">{rpWithChance(l.returnPeriod)}</td>
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
            <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">Each figure reads from the reference assumptions, without AI, to the assumptions the agents agreed. All are ground-up, before insurance terms.</p>
            <div className={`grid grow gap-x-8 gap-y-4 ${!summary ? "" : paired ? "@7xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" : "@7xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"}`}>
              <div className="grid content-between gap-4 grid-cols-[repeat(auto-fit,minmax(min(15.5rem,100%),1fr))]">
                <div><div className="text-sm text-ink-2">Ground-up loss in the rarest scenario, {rpWithChance(rarest.returnPeriod)}</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{kes1(refRarest.lossKes)} → {kes1(rarest.lossKes)}</div><div className="text-xs text-muted">{signed(rarest.lossKes / refRarest.lossKes - 1)} against reference{rarest.returnPeriod !== refRarest.returnPeriod ? `; return period ${rpLabel(refRarest.returnPeriod)} → ${rpLabel(rarest.returnPeriod)}` : ""}</div></div>
                <div><div className="text-sm text-ink-2">Average annual loss, ground-up</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{kes1(reference.aalKes)} → {kes1(r.aalKes)}</div><div className="text-xs text-muted">{signed(r.aalKes / reference.aalKes - 1)} against reference</div></div>
                {deliberation?.optimist && deliberation.cautious && (
                  <div><div className="text-sm text-ink-2">Range of average annual loss, ground-up</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{kes1(Math.min(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes))} to {kes1(Math.max(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes))}</div><div className="text-xs text-muted">Optimist to Cautious</div></div>
                )}
              </div>
              {summary && <p className="max-w-3xl text-sm leading-relaxed text-ink-2">{summary}</p>}
            </div>
            <SourceLine
              className="mt-4 border-t border-line pt-3"
              sources={[
                { kind: "ai", text: summary ? "Agreed assumptions, the two proposals and the Chair's summary" : "Agreed assumptions and the two proposals" },
                { kind: "assumption", text: "Reference assumptions and return periods" },
                { kind: "synthetic", text: "Portfolio of insured buildings" },
              ]}
            />
          </Card>
        ) : (
          <Note>These results use the reference assumptions only. Run the agents in the {STEP_NAMES.agents} step to see how their agreed assumptions change the curve.</Note>
        )}

        {drainageCard && terrainResult && (
          <Card title="What drainage-driven flooding adds to the ground-up loss" className="flex flex-col" aside={<Tag kind="assumption">Drainage ponding assumed</Tag>}>
            {/* With the whole row to itself, the explanation sits beside the table and not in one long line under it. */}
            <div className={`grid gap-x-8 gap-y-3 @6xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] ${paired ? "@7xl:grid-cols-1" : ""}`}>
              <div className="min-w-0 overflow-x-auto">
                <table className="w-full min-w-130 text-sm">
                  <caption className="pb-2 text-left text-xs text-muted">Ground-up loss from one event in KES, with terrain flooding alone and with drainage ponding added.</caption>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th className="pb-2 text-left font-medium">Event (chance a year)</th>
                      <th className="pb-2 text-right font-medium">Buildings flooded</th>
                      <th className="pb-2 text-right font-medium">Terrain only (KES)</th>
                      <th className="pb-2 text-right font-medium">Terrain + drainage (KES)</th>
                      <th className="pb-2 text-right font-medium">Added (%)</th>
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
            <SourceLine
              className="mt-auto border-t border-line pt-3"
              sources={[
                { kind: "real", text: "OpenStreetMap drains and settlements, and the hazard maps" },
                { kind: "assumption", text: "Drainage ponding depths and return periods" },
                { kind: "synthetic", text: "Portfolio of insured buildings" },
                ...(usingAi ? [{ kind: "ai" as const, text: "Hazard and damage assumptions agreed by the agents" }] : []),
              ]}
            />
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
          <p className="-mt-2 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">Each row is one construction class, named beside its colour. Each bar is the loss to that class in a {rpLabel(s.returnPeriod)} flood, drawn against the class with the largest loss.</p>
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
          <SourceLine className="mt-3 border-t border-line pt-3" sources={lossSources} />
        </Card>

        <Card title={`Largest single losses, ${rpWithChance(s.returnPeriod)} flood`} aside={<span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted">Top {top.length} are {fmtPct(top10Share, 0)} of this scenario <SourceBadge kind="synthetic" /></span>}>
          <p className="-mt-2 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
            Each row is one building, largest ground-up loss first. {isScore ? "The hazard score is read from the hazard map at the building; it is a derived proxy, not a measured depth." : "The depth is read from the flood map at the building."} Gross is the loss after that building&rsquo;s deductible and limit.
          </p>
          {top.length === 0 ? (
            <p className="text-sm text-ink-2">No losses in this scenario.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr><th className="pb-2 text-left font-medium">Building</th><th className="pb-2 pl-3 text-left font-medium">Class</th><th className="pb-2 pl-3 text-right font-medium">{isScore ? <span className="inline-flex flex-wrap items-center justify-end gap-1.5">Hazard score (0 to 1) <Tag kind="proxy" /></span> : "Depth (m)"}</th><th className="pb-2 pl-3 text-right font-medium">Damage (% of value)</th><th className="pb-2 pl-3 text-right font-medium">Ground-up (KES)</th><th className="pb-2 pl-3 text-right font-medium">Gross (KES)</th></tr>
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
          <SourceLine className="mt-3 border-t border-line pt-3" sources={[...lossSources, { kind: "assumption", text: "Gross uses the example policy terms" }]} />
        </Card>
      </div>

      <OasisCheck session={engineSession ?? session} />
    </div>
  );
}
