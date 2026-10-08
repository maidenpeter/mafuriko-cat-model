"use client";

import { useId, useMemo, useState } from "react";
import type { Deliberation } from "@/lib/agents/orchestrate";
import { countFlags, emptyDecision, EVIDENCE_LABELS, SEVERITY_LABELS, SEVERITY_ORDER, sortFlags, toggleCondition, type DecisionRecord, type Flag, type Severity } from "@/lib/decision";
import { buildDecisionNoteHtml, decisionNoteFileName, type DecisionNoteInput } from "@/lib/decisionNote";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { DRIVER_IDS, type DriverId, type OfferDrivers } from "@/lib/offer/drivers";
import { plural } from "@/lib/offer/shared";
import { isPriced, PORTFOLIO_KEYS, settersOf, settersText, type FocusJudgement, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import { BASEMENT_LADDER, JUDGEMENT_BOUNDS, ladderRung, OUTAGE_LADDER, type OfferJudgement } from "@/lib/offer/judgement";
import { EP_HELP, isPlaceholder, LOSS_MODE_LABELS, PLACEHOLDER_RATE_LINE, SETTER_WORDS, annualChance, kes1, pct1, perMille, rpLabel, rpWithChance, selectMode, shareText } from "@/lib/labels";
import { lossAtReturnPeriod, STANDARD_RETURN_PERIODS } from "@/lib/model/financial";
import type { TermsResult } from "@/lib/model/terms";
import { HOUSING_CLASSES, HOUSING_LABELS, type ModelResult } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, stepKicker, type StepId } from "@/lib/steps";
import pkg from "../../../package.json";
import { ChartFrame, SourceBadge, SourceLine, type ChartSource } from "../charts/ChartFrame";
import { BarChart } from "../charts/BarChart";
import { LineChart, valueAt, type Point } from "../charts/LineChart";
import { driverSeries, PORTFOLIO_SERIES, StackedBars, type StackColumn } from "../charts/StackedBars";
import { DecisionPanel } from "../DecisionPanel";
import { OasisCheck } from "../OasisCheck";
import { DriverSources, offerKindOf } from "../DriverSources";
import { Button, Card, Fold, InsuredValueFlag, Note, PlaceholderBadge, Segmented, StepHeader, StepLink, Tag } from "../ui";
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
  /** The terrain-only session. Not read here: the Oasis check takes the data set and the result in force. */
  engineSession?: Session;
  /** The same assumptions on terrain flooding alone, shown when drainage is switched on. */
  terrainResult?: ModelResult | null;
  /** The insurance terms applied to the result in force: ground-up, gross and net for every event. */
  terms: TermsResult;
  /** Who set the assumptions behind the loss drivers, for the source line of the portfolio's loss by driver. */
  judgement?: FocusJudgement | null;
  /** "Saved run from <date>, model <name>" while the run shipped with the app sets the assumptions in force; null otherwise. */
  savedRunLabel?: string | null;
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

/**
 * With a priced offer loaded this is the offer's page, whatever "View" in the bar says: its price,
 * where its loss comes from, what it does to the portfolio, and the underwriter's decision.
 * Without one it shows the portfolio's results.
 */
export function ResultsStep({ offerFocus, decision, onDecision, dataSource, onOpenStep, onJudgement, ...portfolio }: Props) {
  // The walkthrough owns the record. This one only stands in if the step is ever used without it.
  const [ownDecision, setOwnDecision] = useState<DecisionRecord>(emptyDecision);
  const offer = isPriced(offerFocus) ? offerFocus : null;

  return (
    <div>
      <StepHeader kicker={stepKicker("results")} title={STEP_NAMES.results}>
        {offer
          ? "What flood cover on this offer should cost, what the offer does to the portfolio, and the decision you record."
          : "How large a flood loss to the portfolio could be, how often, and what an average year costs."}
      </StepHeader>

      {!offer && offerFocus && (
        <div className="mb-4 max-w-4xl">
          <Note tone={offerFocus.outside || offerFocus.waiting.length > 0 ? "warn" : "info"}>
            <span className="font-semibold text-ink">{offerFocus.line.insured ?? offerFocus.documentName}. </span>
            {offerFocus.outside ? `${offerFocus.outsideMessage}. This page shows the portfolio.` : `${offerFocus.statusLine} Until it is priced this page shows the portfolio.`}
            {!offerFocus.outside && onOpenStep && (
              <> <StepLink to="offer" onOpenStep={onOpenStep} /></>
            )}
          </Note>
        </div>
      )}

      {offer ? (
        <OfferResults
          focus={offer}
          decision={decision ?? ownDecision}
          onDecision={onDecision ?? setOwnDecision}
          dataSource={dataSource}
          onOpenStep={onOpenStep}
          onJudgement={onJudgement}
          savedRunLabel={portfolio.savedRunLabel}
          portfolioRun={{ dataset: portfolio.session.dataset, result: portfolio.active.result, source: portfolio.active.source }}
        />
      ) : (
        <PortfolioResults {...portfolio} onOpenStep={onOpenStep} />
      )}
    </div>
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

/** The link under a line that opens what it rests on. */
const FOLD = "cursor-pointer select-none text-xs font-medium text-ink-2 hover:text-ink";

/** The minimum flood rate: an assumption the underwriter may type over. Code keeps it inside its allowed range. */
function MinimumRateInput({ judgement, onJudgement, disabled }: { judgement: FocusJudgement; onJudgement?: (next: Partial<OfferJudgement>) => void; disabled: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const value = judgement.inForce.minimumRatePerMille;
  const { min, max } = JUDGEMENT_BOUNDS.minimumRatePerMille;
  const typed = judgement.setBy.minimumRatePerMille === "typed";
  if (!onJudgement) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-ink-2">
      <label htmlFor={id} className="font-medium text-ink">Minimum rate, per mille</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={0.05}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const next = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(next)) onJudgement({ minimumRatePerMille: next });
        }}
        onBlur={() => setDraft(null)}
        className="tabular w-24 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink disabled:opacity-60"
      />
      <span>
        allowed {fmtNum(min, 2)} to {fmtNum(max, 2)}; {SETTER_WORDS[judgement.setBy.minimumRatePerMille].sentence}
      </span>
      {typed && (
        <button type="button" onClick={() => onJudgement({ minimumRatePerMille: undefined })} className="font-medium text-ink underline underline-offset-2 hover:opacity-80">
          Back to {fmtNum(judgement.reference.minimumRatePerMille, 3)}
        </button>
      )}
    </div>
  );
}

/** The premium build-up, read top to bottom, beside the offer's own premium and its loss history. Every figure is the focus's. */
function PremiumBuildUp({ focus, onJudgement, onOpenStep }: { focus: PricedFocus; onJudgement?: (next: Partial<OfferJudgement>) => void; onOpenStep?: (id: StepId) => void }) {
  const d = focus.drivers;
  const p = d.premium;
  const { depthOnly } = focus.price;
  const judgement = focus.judgement;
  const all = d.mode === "all_drivers";
  const offerKind = offerKindOf(focus);
  const isDriver = (id: string): id is DriverId => (DRIVER_IDS as readonly string[]).includes(id);
  const driverLine = (id: string) => d.lines.find((l) => l.id === id);
  const lineOn = (id: string) => (isDriver(id) ? (driverLine(id)?.on ?? false) : all || id === "technical" || id === "flood_premium");
  const totals = ["technical", "flood_premium"];
  const agentsSetSome = Object.values(judgement.setBy).includes("agents");
  // Only the lines that take part are tabled; the rest are named in one line under the table.
  const lines = p.lines.filter((line) => lineOn(line.id));
  const off = p.lines.filter((line) => !lineOn(line.id)).map((line) => line.label);

  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface p-5">
      <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
        {all
          ? `Read down, from the modelled loss to the flood rate. The flood premium is the larger of the technical premium and the minimum. With ${LOSS_MODE_LABELS.depth_only}, counting just the water depth at the building, the 1-in-100 gross loss is ${depthOnly.loss100GrossKes === null ? "not modelled" : kes1(depthOnly.loss100GrossKes)} and the average annual loss ${kes1(depthOnly.aalGrossKes)} gross.`
          : `With ${LOSS_MODE_LABELS.depth_only} there is no loading, no capital load and no floor: the premium is the modelled loss alone.`}
      </p>
      <div className="grid gap-x-8 gap-y-5 @4xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-112 text-sm">
              <caption className="pb-2 text-left text-sm leading-relaxed text-ink-2">
                <span className="font-medium text-ink">Flood premium for one year, in KES and per mille of the sum insured of {kes1(d.tivKes)}.</span> {p.caption}
              </caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="pb-2 text-left font-medium">Line</th>
                  <th scope="col" className="pb-2 pl-3 text-right font-medium">KES a year</th>
                  <th scope="col" className="pb-2 pl-3 text-right font-medium">Per mille</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const total = totals.includes(line.id);
                  const strong = line.id === "flood_premium";
                  return (
                    <tr key={line.id} className={`align-top ${strong ? "border-t-2 border-ink" : "border-t border-line"}`}>
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        <span className={`text-ink ${total ? "font-semibold" : "font-medium"}`}>{driverLine(line.id)?.label ?? line.label}</span>
                        {all && (line.id === "capital_load" || line.id === "minimum") && (
                          <span className="mt-1 block">
                            <PlaceholderBadge />
                          </span>
                        )}
                        {/* A driver in force carries no sentence of its own: the caption says once what every one of them is. */}
                        {line.text && <span className="mt-0.5 block max-w-md text-xs leading-relaxed text-ink-2">{line.text}</span>}
                        {line.id === "minimum" && <MinimumRateInput judgement={judgement} onJudgement={onJudgement} disabled={!all} />}
                        <details className="mt-1">
                          <summary className={FOLD}>What it rests on</summary>
                          <DriverSources sources={line.sources} quiet={total ? "data" : "none"} judgement={judgement} offerKind={offerKind} onOpenStep={onOpenStep} className="mt-1.5" />
                        </details>
                      </th>
                      <td className={`tabular whitespace-nowrap py-2 pl-3 text-right text-ink ${total ? "font-semibold" : ""}`}>{kes1(line.kes)}</td>
                      <td className={`tabular whitespace-nowrap py-2 pl-3 text-right ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>{perMille(line.ratePerMille).replace(" per mille", "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink">
            <span className="font-semibold">Flood rate: {perMille(p.floodRatePerMille)}</span> of the sum insured, set by {p.setBy === "modelled" ? "the modelled figures" : "the minimum rate"}.            {off.length > 0 && (
              <span className="text-ink-2">
                {" "}Not in this price: {off.join(", ")}. Why each is off is in <StepLink to="loss" onOpenStep={onOpenStep} />.
              </span>
            )}
          </p>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-4">
            <div className="text-sm font-semibold text-ink">Beside the offer&rsquo;s own premium</div>
            {p.stated ? (
              <>
                <dl className="mt-2 space-y-1.5 text-sm">
                  {[
                    { label: "Premium the offer states, all risks", value: `${kes1(p.stated.premiumKes)} a year` },
                    { label: "All-risks rate", value: perMille(p.stated.ratePerMille) },
                    { label: "Flood rate modelled here", value: perMille(p.floodRatePerMille) },
                    ...(p.stated.ratePerMille > 0 ? [{ label: "Flood rate as a share of the all-risks rate", value: shareText(p.stated.floodShareOfAllRisks) }] : []),
                  ].map((item) => (
                    <div key={item.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <dt className="min-w-0 text-ink-2">{item.label}</dt>
                      <dd className="tabular whitespace-nowrap font-semibold text-ink">{item.value}</dd>
                    </div>
                  ))}
                </dl>
                {p.stated.note && <p className="mt-2 text-sm leading-relaxed text-ink-2">{p.stated.note}</p>}
                <DriverSources sources={[{ kind: "offer", what: "The premium the offer states", quote: p.stated.quote }]} offerKind={offerKind} onOpenStep={onOpenStep} className="mt-2" />
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-ink-2">
                The offer states no premium, so there is no all-risks rate to set beside the flood rate. It is one of the questions for the broker below.
              </p>
            )}
          </div>

          <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-4">
            <div className="text-sm font-semibold text-ink">Sense check: the document&rsquo;s own flood losses</div>
            {p.history.usable && p.history.lossPerYearKes !== null && p.history.years !== null ? (
              <>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">
                  <span className="tabular font-semibold text-ink">{kes1(p.history.lossPerYearKes)} a year</span>: {plural(p.history.losses.length, "stated loss", "stated losses")} of {kes1(p.history.totalKes)} over {fmtNum(p.history.years, 1)} years, beside a modelled average annual loss of{" "}
                  <span className="tabular font-semibold text-ink">{kes1(p.history.modelledAalKes)}</span> gross. Shown for comparison only: it is not blended into the price.
                </p>
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted">
                  <SourceBadge kind={offerKind} />
                  <span className="min-w-0 wrap-anywhere">
                    {p.history.yearsQuote ? (
                      <>
                        The period: <q className="text-ink-2">{p.history.yearsQuote}</q>{" "}
                      </>
                    ) : null}
                    Each loss and its sentence are in <StepLink to="offer" onOpenStep={onOpenStep} />.
                  </span>
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{p.history.why} So there is no loss per year from the document to set beside the modelled figure.</p>
            )}
          </div>
        </div>
      </div>
      <SourceLine
        className="mt-4 border-t border-line pt-3"
        sources={[
          { kind: "real", text: focus.hazardKind === "score" ? "Hazard maps; depth is an assumed scale on their score" : "Flood depth maps" },
          ...(all
            ? [
                {
                  kind: "assumption" as const,
                  text: (
                    <>
                      The assumptions behind the drivers, the capital load and the minimum rate; each with its range and who set it is in <StepLink to="audit" onOpenStep={onOpenStep} />
                    </>
                  ),
                },
              ]
            : []),
          ...(all && agentsSetSome ? [{ kind: "ai" as const, text: "Assumptions the agents agreed for this offer; the premium itself is worked out by code" }] : []),
          { kind: "synthetic", text: "Portfolio the capital load is measured against" },
        ]}
      />
    </div>
  );
}

/** The assumptions in force behind the drivers and the premium, as the decision note lists them: a short name, the value, and who set it. */
function noteAssumptions(judgement: FocusJudgement): NonNullable<DecisionNoteInput["assumptions"]> {
  const v = judgement.inForce;
  const who = judgement.setBy;
  type Item = NonNullable<DecisionNoteInput["assumptions"]>[number];
  const one = (key: keyof OfferJudgement, label: string, value: string): Item => ({ label, value, setBy: who[key], ...(isPlaceholder(key) ? { placeholder: true } : {}) });
  // A ladder is one line when one party set every rung; otherwise each rung, by the name every screen gives it, says who set it.
  const ladder = (keys: (keyof OfferJudgement)[], label: string, text: (value: number) => string, unit: string): Item[] =>
    settersOf(judgement, keys).length === 1
      ? [{ label: `${label}, rung 1 to rung ${keys.length}, most frequent flood to rarest`, value: `${keys.map((key) => text(v[key])).join(" / ")}${unit}`, setBy: who[keys[0]] }]
      : keys.map((key) => ({ label: `${label}, ${ladderRung(key)?.text ?? ""}`, value: `${text(v[key])}${unit}`, setBy: who[key] }));
  return [
    one("bufferRadiusM", "Buffer around the building", `${fmtNum(v.bufferRadiusM, 0)} m`),
    one("drainDesignRp", "Drains designed for", rpLabel(v.drainDesignRp)),
    one("drainOverloadDepthM", "Water when the drains are overloaded", `${fmtNum(v.drainOverloadDepthM, 2)} m`),
    one("ingressThresholdM", "Surface water at which a basement takes water", `${fmtNum(v.ingressThresholdM, 2)} m`),
    one("belowGroundShare", "Value below ground", `${shareText(v.belowGroundShare)} of the insured value`),
    ...ladder(BASEMENT_LADDER, "Basement damage ratio", (x) => fmtNum(x * 100, 1), "%"),
    one("annualRentShare", "A year's rent or revenue", `${shareText(v.annualRentShare)} of the insured value`),
    ...ladder(OUTAGE_LADDER, "Outage", (x) => fmtNum(x, 1), " days"),
    one("uncertaintyLoading", "Uncertainty loading", shareText(v.uncertaintyLoading)),
    one("costOfCapital", "Cost of capital", `${shareText(v.costOfCapital)} a year`),
    one("minimumRatePerMille", "Minimum flood rate", `${fmtNum(v.minimumRatePerMille, 3)} per mille`),
  ];
}

/** The loss by driver and the premium build-up as the decision note prints them. Drivers that take no part are named, not tabled. */
function noteDrivers(d: OfferDrivers): Pick<DecisionNoteInput, "drivers" | "premium"> {
  const on = d.lines.filter((l) => l.on);
  const off = d.lines.filter((l) => !l.on).map((l) => l.label);
  const p = d.premium;
  const all = d.mode === "all_drivers";
  const history =
    p.history.usable && p.history.lossPerYearKes !== null && p.history.years !== null
      ? `Sense check, not in the price: the document's own flood losses come to ${kes1(p.history.lossPerYearKes)} a year over ${fmtNum(p.history.years, 1)} years, beside a modelled average annual loss of ${kes1(p.history.modelledAalKes)} gross.`
      : undefined;
  return {
    drivers: {
      basis: LOSS_MODE_LABELS[d.mode],
      columns: on.map((l) => ({ id: l.id, label: l.label })),
      off,
      rows: d.perReturnPeriod.map((r) => ({ returnPeriodYears: r.returnPeriod, byDriverKes: r.groundUpKes, groundUpKes: r.groundUpTotalKes, grossKes: r.grossKes })),
    },
    premium: {
      lines: p.lines
        // A driver's line is printed when the driver is on. With Depth only the premium is the modelled loss, so the lines after the drivers are left out.
        .filter((line) => {
          const driver = d.lines.find((l) => l.id === line.id);
          return driver ? driver.on : all || line.id === "flood_premium";
        })
        .map((line) => ({
          label: d.lines.find((l) => l.id === line.id)?.label ?? line.label,
          kes: line.kes,
          ratePerMille: line.ratePerMille,
          total: line.id === "technical" || line.id === "flood_premium",
          ...(all && (line.id === "capital_load" || line.id === "minimum") ? { placeholder: true } : {}),
          note:
            line.id === "capital_load" && p.capital.addedLoss100Kes !== null
              ? `${shareText(p.capital.costOfCapital)} of ${kes1(Math.max(0, p.capital.addedLoss100Kes))} added to the portfolio's 1-in-100 ${p.capital.basis} loss`
              : line.id === "minimum"
                ? "the floor"
                : line.id === "flood_premium" || line.id === "technical" || line.id === "capital_load"
                  ? undefined
                  : "average annual loss, gross",
        })),
      floodPremiumKes: p.floodPremiumKes,
      floodRatePerMille: p.floodRatePerMille,
      setBy: p.setBy,
      stated: p.stated ? { premiumKes: p.stated.premiumKes, ratePerMille: p.stated.ratePerMille } : null,
      history,
    },
  };
}

/**
 * The portfolio comparison after policy terms where it could be worked out, otherwise before them.
 * Gross is also what the capital load is worked from, so the note's two figures for it agree.
 */
function portfolioChange(portfolio: PricedFocus["price"]["portfolio"]) {
  return portfolio.gross
    ? { basis: "gross", kes: portfolio.gross.change100Kes, share: portfolio.gross.change100Share, without: portfolio.gross.without100Kes, withOffer: portfolio.gross.with100Kes }
    : { basis: "ground-up", kes: portfolio.loss100ChangeKes, share: portfolio.loss100ChangeShare, without: portfolio.without.loss100Kes, withOffer: portfolio.with.loss100Kes };
}

/**
 * Everything the printed decision note says about a priced offer, read from the focus: the figures
 * for the mode in force, the loss by driver, the premium build-up, the assumptions in force with
 * who set each, the questions for the broker, the points, the conditions, the terms and the decision.
 */
export function offerDecisionNote(focus: PricedFocus, decision: DecisionRecord, dataSource?: string): DecisionNoteInput {
  const { line, terms, conditions, drivers, questions } = focus;
  const { total, portfolio } = focus.price;
  const all = focus.mode === "all_drivers";
  const usingAi = focus.assumptionsInForce === "ai";
  const exampleTerms = terms.deductible.source === "example terms" || terms.limit.source === "example terms";
  const change = portfolioChange(portfolio);
  const premium = drivers.premium;
  const flags = sortFlags(focus.flags);
  return {
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
    floodRatePerMille: all ? premium.floodRatePerMille : null,
    portfolioChange100Kes: change.kes,
    portfolioChange100Fraction: change.share,
  },
  lossByReturnPeriod: total.standard.filter((l) => l.groundUpKes !== null).map((l) => ({ returnPeriodYears: l.returnPeriod, groundUpKes: l.groundUpKes, grossKes: l.grossKes })),
  ...noteDrivers(drivers),
  assumptions: all ? noteAssumptions(focus.judgement) : undefined,
  questions: questions.map((q) => q.question),
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
};
}

/** The points to weigh on an offer. The questions for the broker are a list of their own and are never among them. */
export const pointsOf = (offer: Pick<PricedFocus, "flags">): Flag[] => offer.flags;

/** One point: its severity and title, with the detail and the evidence behind a fold. */
function Point({ flag }: { flag: Flag }) {
  return (
    <li className="py-2.5">
      <details>
        <summary className="cursor-pointer select-none">
          <span className="inline-flex max-w-[calc(100%-1.5rem)] flex-wrap items-start gap-x-3 gap-y-1 align-top">
            <SeverityMark severity={flag.severity} />
            <span className="min-w-0 flex-1 basis-56 wrap-anywhere text-sm font-semibold text-ink">{flag.title}</span>
          </span>
        </summary>
        <div className="mt-1.5 min-w-0 wrap-anywhere">
          {flag.detail && flag.detail !== flag.evidence.text && <p className="max-w-3xl text-sm leading-relaxed text-ink-2">{flag.detail}</p>}
          <p className="mt-1.5 max-w-3xl border-l-2 border-axis pl-3 text-sm leading-relaxed text-ink-2">
            <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{EVIDENCE_LABELS[flag.evidence.kind]}</span>
            {flag.evidence.kind === "quote" ? <q className="italic">{flag.evidence.text}</q> : flag.evidence.text}
          </p>
        </div>
      </details>
    </li>
  );
}

/**
 * The page for one priced offer: the price, the loss by driver, what the offer does to the
 * portfolio, the points to weigh and the decision. Every figure is read from the focus; nothing is priced here.
 */
function OfferResults({
  focus,
  decision,
  onDecision,
  dataSource,
  onOpenStep,
  onJudgement,
  savedRunLabel,
  portfolioRun,
}: {
  focus: PricedFocus;
  decision: DecisionRecord;
  onDecision: (next: DecisionRecord) => void;
  dataSource?: string;
  onOpenStep?: (id: StepId) => void;
  onJudgement?: (next: Partial<OfferJudgement>) => void;
  savedRunLabel?: string | null;
  /** The portfolio's run under the header's settings, for the Oasis check: it follows the same settings as the portfolio view. */
  portfolioRun?: { dataset: Session["dataset"]; result: ModelResult; source: Active["source"] };
}) {
  const { terms, conditions, drivers, questions } = focus;
  const { total, building, portfolio } = focus.price;
  const premium = drivers.premium;
  const change = portfolioChange(portfolio);
  const name = focus.line.insured ?? focus.building.name;
  const [printBlocked, setPrintBlocked] = useState(false);

  const all = focus.mode === "all_drivers";
  const modeLabel = LOSS_MODE_LABELS[focus.mode];
  const usingAi = focus.assumptionsInForce === "ai";
  const basis = usingAi ? "ai" : "assumption";
  const exampleTerms = terms.deductible.source === "example terms" || terms.limit.source === "example terms";
  const flags = sortFlags(pointsOf(focus));
  const counts = countFlags(flags);
  const weighty = flags.filter((flag) => flag.severity !== "low");
  const low = flags.filter((flag) => flag.severity === "low");
  const flagTitle = new Map(flags.map((f) => [f.id, f.title]));
  const subject = focus.several ? "this offer" : "this building";

  const rows = drivers.perReturnPeriod;
  const noLoss = rows.every((r) => !(r.groundUpTotalKes > 0));
  const anyHeldFlat = total.standard.some((l) => l.extrapolated);
  const series = driverSeries(drivers.lines);
  const agentsSetSome = all && Object.values(focus.judgement.setBy).includes("agents");
  const gross100 = (v: number | null) => (v === null ? "not modelled" : kes1(v));
  // The same names the header's figures row gives the rate.
  const rateLabel = !all ? "Pure flood rate" : premium.setBy === "minimum rate" ? "Flood rate, the minimum rate" : "Flood rate";

  const sources: ChartSource[] = [
    { kind: "real", text: focus.hazardKind === "score" ? "Hazard maps; depth is an assumed scale on their score" : "Flood depth maps" },
    { kind: basis, text: usingAi ? `Hazard and damage assumptions agreed by the agents${savedRunLabel ? ` (${savedRunLabel})` : ""}` : "Reference hazard and damage assumptions" },
    ...(all
      ? [
          {
            kind: "assumption" as const,
            text: (
              <>
                The assumptions behind the drivers beyond depth; each with its value and who set it is in <StepLink to="agents" onOpenStep={onOpenStep} />
              </>
            ),
          },
        ]
      : []),
    ...(agentsSetSome && !usingAi ? [{ kind: "ai" as const, text: "Beyond-depth assumptions the agents agreed for this offer" }] : []),
    focus.document.path === "model"
      ? { kind: "ai", text: "Sum insured and terms read from the offer document, each checked against its text by code" }
      : { kind: "real", text: "Sum insured and terms read from the offer document by fixed rules" },
    ...(exampleTerms ? [{ kind: "assumption" as const, text: "Example terms where the document states none" }] : []),
  ];

  const note = () => offerDecisionNote(focus, decision, dataSource);

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
      {/* The answer: the price, and the two loss figures behind it. */}
      <Card title={`The price of flood cover for ${subject}`}>
        <div className="grid gap-x-8 gap-y-5 @4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="min-w-0 border-l-4 border-brand pl-4">
            <dl className="flex flex-wrap items-end gap-x-10 gap-y-3">
              <div>
                <dt className="text-sm font-medium text-ink-2">{rateLabel}</dt>
                <dd className="tabular text-4xl font-semibold leading-tight tracking-tight text-ink">{perMille(premium.floodRatePerMille)}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-ink-2">{all ? "Flood premium a year" : "Modelled flood loss a year"}</dt>
                <dd className="tabular text-4xl font-semibold leading-tight tracking-tight text-ink">{kes1(premium.floodPremiumKes)}</dd>
              </div>
            </dl>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink">
              {all
                ? `Flood cover on ${name} is priced at ${kes1(premium.floodPremiumKes)} a year, on a sum insured of ${kes1(drivers.tivKes)}. ${
                    premium.setBy === "minimum rate"
                      ? "The modelled loss is small, so the minimum rate sets the price."
                      : "That pays for the flood loss of an average year, a margin for what the model cannot know, and the cost of the capital held against a rare flood."
                  }`
                : `Counting only the water depth at the building, flood on ${name} costs ${kes1(premium.floodPremiumKes)} in an average year, on a sum insured of ${kes1(drivers.tivKes)}. No margin and no minimum are added. ${selectMode("all_drivers")} for the full price.`}
            </p>
            {all && (
              <p className="mt-2 flex max-w-2xl flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-relaxed text-ink-2">
                <PlaceholderBadge />
                <span className="min-w-0">{PLACEHOLDER_RATE_LINE}</span>
              </p>
            )}
            <p className="mt-1 text-sm leading-relaxed text-ink-2">Per mille means KES for every KES 1,000 of the sum insured.</p>
          </div>
          <dl className="grid min-w-0 content-start gap-4">
            <div>
              <dt className="text-sm font-medium text-ink-2">Gross loss in a 1-in-100 flood</dt>
              <dd className="tabular text-2xl font-semibold tracking-tight text-ink">{gross100(total.loss100GrossKes)}</dd>
              <dd className="text-sm leading-relaxed text-ink-2">
                What the insurer pays, after the deductible and the limit, in a flood with a 1% chance in any year{total.loss100Extrapolated ? "; held flat beyond the rarest flood modelled" : ""}.
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-ink-2">Average annual loss, gross</dt>
              <dd className="tabular text-2xl font-semibold tracking-tight text-ink">{kes1(total.aalGrossKes)}</dd>
              <dd className="text-sm leading-relaxed text-ink-2">What flood costs the insurer in an average year, small and large floods together.</dd>
            </div>
          </dl>
        </div>
        <SourceLine className="mt-4 border-t border-line pt-3" sources={sources} />
      </Card>

      <Fold summary="How the flood rate is built up" className="mt-2">
        <PremiumBuildUp focus={focus} onJudgement={onJudgement} onOpenStep={onOpenStep} />
      </Fold>

      {/* Where the loss comes from, beside what the offer does to the portfolio. */}
      <div className="mt-4 grid items-start gap-4 @5xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <ChartFrame
          title={`Loss by driver for ${subject}, at each return period`}
          subtitle={`One bar for each modelled flood, rarer to the right. Each band is the damage one driver adds, before any insurance terms (ground-up). The line with a diamond marks the gross loss: what the insurer pays, after the deductible and the limit.${all ? "" : ` With ${LOSS_MODE_LABELS.depth_only} the other drivers are off.`}`}
          sources={sources.slice(0, all ? 3 : 2)}
        >
          {noLoss ? (
            <Note>
              <span className="font-semibold text-ink">No loss at any modelled return period with {modeLabel}, so there are no bars to draw.</span>{" "}
              {building.dryAtEveryReturnPeriod
                ? `No water reaches ${subject === "this offer" ? "the building followed" : "the building"} in any flood modelled${building.nearestWetM !== null && building.nearestWetM > 0 ? `, with mapped flood water ${fmtInt(building.nearestWetM)} m away` : ""}.`
                : "The damage curve gives no loss at the depths read."}{" "}
              The depths are in <StepLink to="hazard" onOpenStep={onOpenStep} />. A figure of KES 0 is the model&rsquo;s answer{all ? "" : " at this exact point"}, not proof that the site cannot flood: weigh the points below.
            </Note>
          ) : (
            <StackedBars
              height={250}
              title={`Ground-up loss to ${subject} by driver at each return period, with the gross loss marked`}
              yLabel="Loss from one event, ground-up (KES)"
              xLabel="Return period, with the chance of a flood this large or larger in any year. Further right is rarer."
              series={series}
              totalLabel="Ground-up loss"
              markerLabel="Gross loss, after the deductible and limit"
              columns={rows.map((r) => ({
                key: r.id,
                label: rpLabel(r.returnPeriod),
                sub: annualChance(r.returnPeriod),
                title: `${rpWithChance(r.returnPeriod)} flood`,
                parts: r.groundUpKes,
                total: r.groundUpTotalKes,
                marker: r.grossKes,
                extra: [
                  ...(all && r.groundUpKes.surrounding > 0
                    ? [
                        { label: "Surrounding flooding, at the point", value: kes1(r.pointKes) },
                        { label: "Surrounding flooding, added within the buffer", value: kes1(r.bufferAddedKes) },
                      ]
                    : []),
                  { label: "Kept under the deductible", value: kes1(r.deductibleKes) },
                  ...(r.overLimitKes > 0 ? [{ label: "Above the limit", value: kes1(r.overLimitKes) }] : []),
                ],
              }))}
            />
          )}
          <Fold summary="The same figures as a table" className="mt-2">
            <div className="overflow-x-auto">
              <table className="w-full min-w-96 max-w-3xl text-sm">
                <caption className="pb-2 text-left text-sm font-medium text-ink">Loss at each standard return period, KES ({modeLabel})</caption>
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="pb-2 text-left font-medium">Return period (chance a year)</th>
                    <th scope="col" className="pb-2 pl-3 text-right font-medium">Ground-up</th>
                    <th scope="col" className="pb-2 pl-3 text-right font-medium">Gross</th>
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
                </tbody>
              </table>
            </div>
            {(total.standard.some((l) => l.groundUpKes === null) || anyHeldFlat) && (
              <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
                {total.standard.some((l) => l.groundUpKes === null) ? "“Not modelled” means the event is more frequent than the most frequent flood modelled. " : ""}
                {anyHeldFlat ? "† held flat beyond the rarest flood modelled." : ""}
              </p>
            )}
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
              Every modelled flood line by line, each driver with its source, is in <StepLink to="loss" onOpenStep={onOpenStep} />; the depths are in <StepLink to="hazard" onOpenStep={onOpenStep} />.
            </p>
          </Fold>
        </ChartFrame>

        <Card title="What this offer does to the portfolio">
          <p className="-mt-2 max-w-3xl text-sm leading-relaxed text-ink">
            {change.without !== null && change.withOffer !== null && change.kes !== null ? (
              <>
                In a 1-in-100 flood, one with a 1% chance in any year, the portfolio&rsquo;s {change.basis} loss goes from {kes1(change.without)} to {kes1(change.withOffer)} with this offer:{" "}
                <strong className="font-semibold">
                  {kes1(change.kes)} more{change.share !== null ? `, or ${pct1(change.share)}` : ""}
                </strong>
                .
              </>
            ) : (
              "The portfolio's 1-in-100 loss is not modelled: a flood with a 1% chance in any year is more frequent than the most frequent flood modelled."
            )}{" "}
            <span className="text-ink-2">{change.basis === "gross" ? "Gross is what the insurer pays, after deductibles and limits." : "Ground-up is the damage before any insurance terms."}</span>
          </p>
          {change.without !== null && change.withOffer !== null && (
            <div className="mt-3">
              <BarChart
                title={`The portfolio's 1-in-100 ${change.basis} loss without and with this offer`}
                rows={[
                  { label: "Portfolio today", value: change.without, note: plural(portfolio.without.buildings, "building") },
                  { label: "With this offer", value: change.withOffer, color: "var(--brand)" },
                ]}
                xLabel={`Loss in a 1-in-100 (1% a year) flood, ${change.basis}, KES`}
                format={kes1}
                valueLabel={`1-in-100 ${change.basis} loss`}
              />
            </div>
          )}
          <Fold summary="Show the working" className="mt-2">
            <dl className="space-y-1.5 text-sm">
              {[
                { label: "Offer's share of the portfolio's insured value, the offer included", value: shareText(portfolio.tivShare) },
                { label: "Added to the portfolio's average annual loss, ground-up", value: `${kes1(portfolio.aalChangeKes)}${portfolio.aalChangeShare !== null ? ` (${pct1(portfolio.aalChangeShare)})` : ""}` },
                ...(portfolio.gross ? [{ label: "Portfolio's average annual loss, gross, without and with the offer", value: `${kes1(portfolio.gross.aalWithoutKes)} to ${kes1(portfolio.gross.aalWithKes)}` }] : []),
                ...(portfolio.loss100ChangeKes !== null ? [{ label: "Added to the portfolio's 1-in-100 loss, ground-up", value: kes1(portfolio.loss100ChangeKes) }] : []),
              ].map((item) => (
                <div key={item.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <dt className="min-w-0 text-ink-2">{item.label}</dt>
                  <dd className="tabular whitespace-nowrap font-semibold text-ink">{item.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-muted">The portfolio&rsquo;s buildings are on the example terms, the offer on its own. The capital load in the flood rate is worked from the gross change.</p>
          </Fold>
          <SourceLine
            className="mt-3 border-t border-line pt-3"
            sources={[
              { kind: "synthetic", text: "Portfolio of insured buildings" },
              { kind: "assumption", text: "Example terms on the portfolio's buildings, and the hazard and damage assumptions" },
            ]}
          />
        </Card>
      </div>

      {/* The portfolio under the header's settings, checked by Oasis where a run was made for them. */}
      {portfolioRun && (
        <Fold summary="Independent check: the portfolio run through Oasis LMF" className="mt-2">
          <OasisCheck dataset={portfolioRun.dataset} result={portfolioRun.result} source={portfolioRun.source} />
        </Fold>
      )}

      <Card
        title="Before you decide"
        className="mt-4"
        aside={
          <span className="text-xs text-muted">
            {flags.length === 0 ? "No points raised" : `${SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${SEVERITY_LABELS[s].toLowerCase()}`).join(" · ")}, most severe first`}
          </span>
        }
      >
        <div className="grid gap-x-8 gap-y-5 @4xl:grid-cols-2">
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-ink">Points to weigh</h4>
            {flags.length === 0 ? (
              <p className="mt-1 text-sm leading-relaxed text-ink-2">The checks and the document raise no point on this offer.</p>
            ) : (
              <>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">Open a point for its detail and the evidence behind it.</p>
                {weighty.length > 0 && (
                  <ul className="divide-y divide-line">
                    {weighty.map((flag) => <Point key={flag.id} flag={flag} />)}
                  </ul>
                )}
                {low.length > 0 && (
                  <details className={weighty.length > 0 ? "border-t border-line pt-2.5" : "mt-2"} open={weighty.length === 0}>
                    <summary className="cursor-pointer select-none text-sm font-medium text-ink-2 hover:text-ink">{plural(low.length, "low point")}</summary>
                    <ul className="mt-1 divide-y divide-line pl-4">
                      {low.map((flag) => <Point key={flag.id} flag={flag} />)}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>

          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-ink">Suggested conditions</h4>
            {conditions.length === 0 ? (
              <p className="mt-1 text-sm leading-relaxed text-ink-2">The points on this offer suggest no condition.</p>
            ) : (
              <>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">Suggestions, not requirements. Tick the ones to apply: they are printed on the decision note.</p>
                <ul className="divide-y divide-line">
                  {conditions.map((c) => {
                    const answers = c.because.map((id) => flagTitle.get(id)).filter((t): t is string => Boolean(t));
                    // The points are named below, so the sentence that only counts them is left out.
                    const reason = c.why.replace(/\s*(A flag|\d+ flags) on this page point to it\.$/, "");
                    return (
                      <li key={c.id} className="py-2.5">
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            checked={decision.conditions.includes(c.id)}
                            onChange={() => onDecision(toggleCondition(decision, c.id))}
                            className="mt-0.5 size-4 shrink-0 accent-accent"
                          />
                          <span className="min-w-0 wrap-anywhere text-sm font-medium leading-relaxed text-ink">{c.text}</span>
                        </label>
                        {(reason || answers.length > 0) && (
                          <details className="ml-7 mt-0.5">
                            <summary className={FOLD}>Why</summary>
                            <div className="mt-1 text-sm leading-relaxed text-ink-2">
                              {reason && <p>{reason}</p>}
                              {answers.length > 0 && (
                                <p><span className="text-xs font-semibold uppercase tracking-wide text-muted">Answers </span>{answers.join("; ")}.</p>
                              )}
                            </div>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm leading-relaxed text-ink-2">
            {questions.length === 0 ? (
              "Nothing to ask the broker: the document states every value the price needs."
            ) : (
              <>
                <span className="font-semibold text-ink">Still to ask the broker: {plural(questions.length, "question")}.</span> Until each is answered the price uses a marked assumption. Answer them in <StepLink to="offer" onOpenStep={onOpenStep} />.
              </>
            )}
          </p>
          {questions.length > 0 && (
            <Fold summary="The questions, the one that could move the price most first">
              <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-ink marker:text-muted">
                {questions.map((q) => (
                  <li key={q.id} className="wrap-anywhere">{q.question}</li>
                ))}
              </ol>
            </Fold>
          )}
        </div>
      </Card>

      <DecisionPanel decision={decision} onDecision={onDecision} conditionIds={conditions.map((c) => c.id)} className="mt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={download}>Download decision note</Button>
            <Button variant="secondary" onClick={print}>Print or save as PDF</Button>
          </div>
          <p className="min-w-0 max-w-3xl text-xs leading-relaxed text-muted">
            One page with everything on this step, the assumptions in force with who set each, and the terms used.
            {decision.recordedAt ? "" : " Until a decision is recorded, the note says that none is."}
          </p>
        </div>
        {printBlocked && (
          <p role="alert" className="mt-2 text-sm leading-relaxed text-ink">
            The browser blocked the new window. Allow pop-ups for this page, or download the note and print the file.
          </p>
        )}
      </DecisionPanel>
    </div>
  );
}

/** The portfolio's results: the step as it stands without an offer, and the second view with one. */
function PortfolioResults({ session, active, deliberation, terrainResult, terms, judgement, savedRunLabel, onOpenStep }: PortfolioProps & { onOpenStep?: (id: StepId) => void }) {
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
  const all = r.mode === "all_drivers";
  const basisText = `${LOSS_MODE_LABELS[r.mode]}. ${usingAi ? `Assumptions agreed by the agents${savedRunLabel ? ` (${savedRunLabel})` : ""}` : "Reference assumptions"}`;
  // The portfolio's loss by driver, when the engine ran with all loss drivers: one bar per scenario.
  const driverColumns: StackColumn[] = all
    ? r.scenarios.flatMap((sc, i) =>
        sc.byDriver
          ? [
              {
                key: sc.id,
                label: rpLabel(sc.returnPeriod),
                sub: annualChance(sc.returnPeriod),
                title: `${rpWithChance(sc.returnPeriod)} flood`,
                parts: { point: sc.byDriver.pointKes, surrounding: sc.byDriver.surroundingKes, ponding: sc.byDriver.pondingKes, overload: sc.byDriver.overloadKes },
                marker: terms.scenarios[i]?.grossKes ?? null,
                extra: [{ label: "Buildings with water at the site", value: `${fmtInt(sc.affected)} of ${fmtInt(r.buildingCount)}` }],
              },
            ]
          : [],
      )
    : [];
  const siteSetters = settersOf(judgement, PORTFOLIO_KEYS);

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
      <p className="mb-4 max-w-4xl text-base leading-relaxed text-ink">
        In a {rpWithChance(headline.rp)} flood the damage to the portfolio&rsquo;s buildings is <strong className="font-semibold">{kes1(headline.groundUpKes)}</strong> before any insurance terms (ground-up). The insurer pays{" "}
        <strong className="font-semibold">{kes1(headline.grossKes)}</strong> after deductibles and limits (gross), and keeps <strong className="font-semibold">{kes1(headline.netKes)}</strong> after reinsurance (net).
        {headline.extrapolated ? " These are held flat beyond the rarest flood modelled." : ""}
        {all ? "" : ` Only the depth at each building and drainage ponding are counted. ${selectMode("all_drivers")} to add surrounding flooding and drain overload.`}
      </p>

      <ChartFrame
        title="Loss curve: how large a loss, how often, before and after insurance terms"
        subtitle="Each point is the loss from one flood of that rarity. Further right is rarer. The three lines are the same flood before any terms, after deductibles and limits, and after reinsurance."
        help={EP_HELP}
        sources={curveSources}
      >
        <LineChart
          height={300}
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
        <Fold summary="The same figures as a table" className="mt-2">
          <div className="overflow-x-auto">
            <table className="w-full min-w-120 max-w-4xl text-sm">
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
        </Fold>
      </ChartFrame>

      <Card title="Key figures" className="mt-4">
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-x-6 gap-y-4">
          {[
            { label: `Net loss in a ${rpLabel(headline.rp)} flood`, value: kes1(headline.netKes), sub: `What the insurer keeps after reinsurance: ${pct1(headline.netKes / r.totalTivKes)} of insured value.`, strong: true },
            { label: `Gross loss in a ${rpLabel(headline.rp)} flood`, value: kes1(headline.grossKes), sub: "What the insurer pays, after deductibles and limits." },
            { label: "Average annual loss, gross", value: kes1(terms.aal.grossKes), sub: `What flood costs the insurer in an average year: ${perYear(terms.aal.grossKes)}.` },
            { label: "Average annual loss, net", value: kes1(terms.aal.netKes), sub: `The same after reinsurance: ${perYear(terms.aal.netKes)}.` },
          ].map((x) => (
            <div key={x.label} className={`min-w-0 ${x.strong ? "border-l-4 border-brand pl-3" : ""}`}>
              <dt className="text-sm text-ink-2">{x.label}</dt>
              <dd className="tabular mt-0.5 text-2xl font-semibold tracking-tight text-ink">{x.value}</dd>
              <dd className="mt-1 text-sm leading-relaxed text-ink-2">{x.sub}</dd>
            </div>
          ))}
        </dl>
        <Fold summary="More figures" className="mt-3">
          <dl className="max-w-3xl space-y-1.5 text-sm">
            {[
              { label: "Average annual loss, ground-up", value: `${kes1(terms.aal.groundUpKes)} (${perYear(terms.aal.groundUpKes)})` },
              { label: "Total insured value", value: `${kes1(r.totalTivKes)}, ${fmtInt(r.buildingCount)} buildings` },
              {
                label: `Insured value in flooded cells in the rarest scenario, ${rpLabel(rarest.returnPeriod)}`,
                value: `${fmtPct(rarest.tivExposedKes / r.totalTivKes, 0)}: ${kes1(rarest.tivExposedKes)}, ${fmtInt(rarest.affected)} of ${fmtInt(r.buildingCount)} buildings`,
              },
            ].map((item) => (
              <div key={item.label} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <dt className="min-w-0 text-ink-2">{item.label}</dt>
                <dd className="tabular font-semibold text-ink">{item.value}</dd>
              </div>
            ))}
          </dl>
          <InsuredValueFlag ratio={session.report.tivRatio?.median} className="mt-2 max-w-3xl" />
          {all && <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">With {LOSS_MODE_LABELS.all_drivers} a building counts as affected once any driver puts water at it, drain overload included.</p>}
        </Fold>
        <SourceLine
          className="mt-3 border-t border-line pt-3"
          sources={[
            { kind: basis, text: basisText },
            { kind: "assumption", text: "Example policy and reinsurance terms" },
            { kind: "synthetic", text: "Synthetic portfolio, values as written in the exposure file" },
          ]}
        />
      </Card>

      {all && driverColumns.length > 0 ? (
        <ChartFrame
          className="mt-4"
          title="Portfolio loss by driver, at each return period"
          subtitle="One bar for each modelled flood. Each band is the damage one driver adds across the portfolio, before any insurance terms. The line with a diamond marks the gross loss, after deductibles and limits."
          sources={[
            { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
            { kind: "real", text: isScore ? "Hazard maps; the hazard score read from them is a derived proxy" : "Flood depth maps" },
            {
              kind: "assumption",
              text: r.judgement
                ? `Buffer of ${fmtNum(r.judgement.bufferRadiusM, 0)} m around each building, drains designed for a ${rpLabel(r.judgement.drainDesignRp)} event, ${fmtNum(r.judgement.drainOverloadDepthM, 2)} m of water when they are overloaded${siteSetters.length > 0 ? ` (${settersText(judgement, PORTFOLIO_KEYS)})` : ""}; example policy terms behind the gross loss`
                : "Buffer radius, drain design return period, the depth of water when drains are overloaded, and example policy terms",
            },
            ...(siteSetters.includes("agents") || usingAi ? [{ kind: "ai" as const, text: usingAi ? "Hazard and damage assumptions agreed by the agents" : "Buffer radius agreed by the agents" }] : []),
          ]}
        >
          <StackedBars
            height={260}
            title="Ground-up loss to the portfolio by driver at each return period, with the gross loss marked"
            yLabel="Loss from one event, ground-up (KES)"
            xLabel="Return period, with the chance of a flood this large or larger in any year. Further right is rarer."
            series={PORTFOLIO_SERIES}
            totalLabel="Ground-up loss"
            markerLabel="Gross loss, after deductibles and limits"
            columns={driverColumns}
          />
          <Fold summary="How to read the bands" className="mt-2">
            <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
              The bands are stacked from the bottom up in the order of the legend: the depth at each building&rsquo;s point, what the deeper water within the buffer adds, what drainage ponding adds, then what drain overload adds. The first two together are Surrounding flooding. The same figures as a table are in <StepLink to="loss" onOpenStep={onOpenStep} />.
            </p>
          </Fold>
        </ChartFrame>
      ) : all ? null : (
        <div className="mt-4">
          <Note>
            <span className="font-semibold text-ink">{LOSS_MODE_LABELS.depth_only} is selected, so the portfolio&rsquo;s loss is not split by driver.</span> {selectMode("all_drivers")} to see what surrounding flooding, drainage ponding and drain overload each add at every return period.
          </Note>
        </div>
      )}

      {/* The rest of the working, each part closed until it is asked for. */}
      <div className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface px-5 py-2">
        {usingAi && (
          <Fold summary="With and without the agents: what their assumptions change" className="py-1.5">
            <ChartFrame
              bare
              title="Compare with reference assumptions: ground-up loss with and without the agents"
              subtitle="The solid line uses the assumptions the agents agreed. The dashed line uses the reference assumptions, without AI. The shaded band runs from the Optimist's proposal to the Cautious one. All figures are ground-up, before insurance terms."
              sources={[
                { kind: "ai", text: summary ? "Agreed assumptions, the two proposals and the Chair's summary" : "Agreed assumptions and the two proposals" },
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
              {aiCard && (
                <div className="mt-4 border-t border-line pt-4">
                  <h4 className="text-sm font-semibold text-ink">What the AI changed</h4>
                  <p className="mt-1 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">Each figure reads from the reference assumptions, without AI, to the assumptions the agents agreed. All are ground-up, before insurance terms.</p>
                  <div className={`grid gap-x-8 gap-y-4 ${summary ? "@6xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : ""}`}>
                    <div className="grid content-start gap-4 grid-cols-[repeat(auto-fit,minmax(min(15.5rem,100%),1fr))]">
                      <div><div className="text-sm text-ink-2">Ground-up loss in the rarest scenario, {rpWithChance(rarest.returnPeriod)}</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{kes1(refRarest.lossKes)} → {kes1(rarest.lossKes)}</div><div className="text-xs text-muted">{signed(rarest.lossKes / refRarest.lossKes - 1)} against reference{rarest.returnPeriod !== refRarest.returnPeriod ? `; return period ${rpLabel(refRarest.returnPeriod)} → ${rpLabel(rarest.returnPeriod)}` : ""}</div></div>
                      <div><div className="text-sm text-ink-2">Average annual loss, ground-up</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{kes1(reference.aalKes)} → {kes1(r.aalKes)}</div><div className="text-xs text-muted">{signed(r.aalKes / reference.aalKes - 1)} against reference</div></div>
                      {deliberation?.optimist && deliberation.cautious && (
                        <div><div className="text-sm text-ink-2">Range of average annual loss, ground-up</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{kes1(Math.min(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes))} to {kes1(Math.max(deliberation.optimist.result.aalKes, deliberation.cautious.result.aalKes))}</div><div className="text-xs text-muted">Optimist to Cautious</div></div>
                      )}
                    </div>
                    {summary && <p className="max-w-3xl text-sm leading-relaxed text-ink-2">{summary}</p>}
                  </div>
                </div>
              )}
            </ChartFrame>
          </Fold>
        )}

        {drainageCard && terrainResult && (
          <Fold summary="What drainage-driven flooding adds to the ground-up loss" className="py-1.5">
            <div className="grid gap-x-8 gap-y-3 @6xl:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)]">
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
              className="mt-3 border-t border-line pt-3"
              sources={[
                { kind: "real", text: "OpenStreetMap drains and settlements, and the hazard maps" },
                { kind: "assumption", text: "Drainage ponding depths and return periods" },
                { kind: "synthetic", text: "Portfolio of insured buildings" },
                ...(usingAi ? [{ kind: "ai" as const, text: "Hazard and damage assumptions agreed by the agents" }] : []),
              ]}
            />
          </Fold>
        )}

        <Fold summary="Where the loss comes from: by construction class, and the largest single losses" className="py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm leading-relaxed text-ink-2">Pick a flood scenario to see which buildings carry its loss. Amounts are in KES.</p>
            <Segmented label="Scenario" value={String(k)} onChange={(v) => setScenario(Number(v))} options={r.scenarios.map((sc, i) => ({ value: String(i), label: rpLabel(sc.returnPeriod) }))} />
          </div>

          <div className="mt-3 grid gap-x-8 gap-y-5 @5xl:grid-cols-2">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-ink">Ground-up loss by construction class, {rpWithChance(s.returnPeriod)} flood</h4>
              <p className="mt-1 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">Each bar is the loss to that class, drawn against the class with the largest loss. Loss follows insured value, so a few large concrete buildings dominate.</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
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
            </div>

            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-ink">Largest single losses, {rpWithChance(s.returnPeriod)} flood</h4>
              <p className="mt-1 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
                One building a row, largest ground-up loss first; the top {top.length} are {fmtPct(top10Share, 0)} of this scenario. {isScore ? "The hazard score is read from the hazard map at the building; it is a derived proxy, not a measured depth." : "The depth is read from the flood map at the building."} Gross is the loss after that building&rsquo;s deductible and limit.
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
            </div>
          </div>
          <SourceLine className="mt-3 border-t border-line pt-3" sources={[...lossSources, { kind: "assumption", text: "Gross uses the example policy terms" }]} />
        </Fold>

        <Fold summary="Independent check: the same model run through Oasis LMF" className="py-1.5">
          <OasisCheck dataset={dataset} result={r} source={active.source} />
        </Fold>
      </div>
    </div>
  );
}
