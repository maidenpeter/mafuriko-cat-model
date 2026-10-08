"use client";

/**
 * Read the data: what the model data holds, and where the offer sits in it.
 *
 * In Offer mode (`focus` set) the step opens with one card that places the offer in the portfolio:
 * its construction class against the portfolio's mix, its insured value against the range of
 * insured values, its value per m² against the range for its class, and its ward with what the
 * model already holds there. The checks on the data and "Who holds the value" follow as the
 * portfolio the offer would join. Every offer figure comes from the focus: nothing is priced here.
 *
 * With no priced offer the step shows the model data alone, as before. An offer that is outside
 * the hazard maps, or waiting for a value, says so in one note at the top.
 */

import type { ReactNode } from "react";
import { rangePlacement, type RangePlacement } from "@/lib/dashboard";
import { fmtBytes, fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { kes1 } from "@/lib/labels";
import { HOUSING_CLASSES, HOUSING_LABELS, type HousingClass } from "@/lib/model/types";
import { isPriced, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { Session } from "@/lib/session";
import { STEP_NAMES, stepKicker, type StepId } from "@/lib/steps";
import { ChartFrame, SourceBadge, SourceLine } from "../charts/ChartFrame";
import { Button, Card, CheckList, ChecksSummary, Note, Stat, StatusIcon, StepHeader, Tag } from "../ui";

export const CLASS_COLORS: Record<HousingClass, string> = {
  informal_iron_sheet: "var(--series-1)",
  semi_permanent: "var(--series-2)",
  permanent_masonry: "var(--series-3)",
  concrete_rcc: "var(--series-4)",
};

const KIND_LABEL = { exposure: "Exposure", "hazard-raster": "Hazard map", hotspots: "Hotspots", offer: "Offer", other: "Other" } as const;

interface Props extends OfferFocusProps {
  session: Session;
  /** Opens another step of the walkthrough. */
  onOpenStep?: (id: StepId) => void;
}

export function DataStep({ session, focus = null, offerFocus = null, onOpenStep }: Props) {
  const { dataset, report, reference } = session;
  const offerClass = focus?.price.building.housingClass ?? null;
  const widest = reference.scenarios[reference.scenarios.length - 1];
  const ratio = report.tivRatio;
  const discrepancy = ratio && Math.abs(ratio.median - 1) >= 0.05;

  return (
    <div>
      <StepHeader kicker={stepKicker("data")} title={STEP_NAMES.data}>
        {fmtInt(dataset.buildings.length)} buildings and {dataset.rasters.length} hazard maps were read from <strong className="font-semibold text-ink">{session.uploadName}</strong>.{" "}
        {focus ? "They are the portfolio this offer would join, and the measure it is held against." : "Nothing has been modelled yet; this step only confirms what was received."}
      </StepHeader>

      {focus && <OfferInPortfolio focus={focus} session={session} onOpenStep={onOpenStep} />}
      {!focus && offerFocus && offerFocus.status !== "locating" && (
        <div className="mb-4">
          <Note tone={isPriced(offerFocus) ? "info" : "warn"}>
            {offerFocus.outside ? (
              <>
                <strong className="font-semibold text-ink">{offerFocus.outsideMessage}.</strong> The offer in {offerFocus.documentName} cannot be placed in this portfolio. {offerFocus.coverage}
              </>
            ) : isPriced(offerFocus) ? (
              <>An offer is loaded ({offerFocus.documentName}). Switch the view to Offer in the bar at the top to see where it sits in this portfolio.</>
            ) : (
              <>
                <strong className="font-semibold text-ink">The offer in {offerFocus.documentName} is not placed in this portfolio yet.</strong> {offerFocus.statusLine}
                {onOpenStep && (
                  <Button variant="secondary" className="mt-2 block" onClick={() => onOpenStep("offer")}>Open {STEP_NAMES.offer}</Button>
                )}
              </>
            )}
          </Note>
        </div>
      )}
      {focus && <h3 className="mb-3 mt-8 text-lg font-semibold text-ink">The portfolio it would join</h3>}

      {/* One grid for the figures, the warning, the checks and the value split, so no card leaves a hole beside a taller one.
          Two columns: the figures run across the top and the checks stand beside the warning and the value split.
          With more room the figures join the left column and the checks take the whole right side.
          The widths are in rem of the chosen text size. The last row takes up the slack, so the two columns end level.
          The taller side gets the wider column: the checks while the figures are above them, the left side once the figures join it. */}
      <div className={`grid gap-4 @3xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] @6xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] ${discrepancy ? "@3xl:grid-rows-[auto_auto_1fr]" : "@3xl:grid-rows-[auto_1fr]"}`}>
        {/* In the half-width column each figure takes the width its own text needs, so the longest label stays on one line. */}
        <div className="grid gap-4 @xl:grid-cols-3 @3xl:col-span-2 @6xl:col-span-1 @6xl:grid-cols-[repeat(3,auto)]">
          <Stat label="Buildings" value={fmtInt(dataset.buildings.length)} note={<Tag kind="synthetic" />} />
          <Stat label="Total insured value" value={kes1(reference.totalTivKes)} note={<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1"><SourceBadge kind="synthetic" /> As written in the file</span>} />
          <Stat label="Hazard maps" value={dataset.rasters.length || "None"} note={<Tag kind={dataset.hazardKind === "score" ? "proxy" : "real"}>{dataset.hazardKind === "score" ? "Susceptibility score, 0 to 1" : "Flood depth, metres"}</Tag>} />
        </div>

        {discrepancy && (
          <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-2">
            <Note tone="warn">
              <strong className="font-semibold text-ink">Insured values do not match their own formula.</strong> Every row&apos;s value is {fmtNum(ratio.median, 1)}× its floor area × cost per m². The file totals {kes1(reference.totalTivKes)}; the documented formula gives {kes1(reference.totalTivKes / ratio.median)}. The model uses the values as they are in the file, so every loss figure carries this factor.
            </Note>
          </div>
        )}

        <Card title="Checks on the data" aside={<ChecksSummary checks={session.dataChecks} />} className={`@3xl:col-start-2 @3xl:row-start-2 @6xl:row-start-1 ${discrepancy ? "@3xl:row-span-2 @6xl:row-span-3" : "@6xl:row-span-2"}`}>
          <CheckList checks={session.dataChecks} />
        </Card>

        <ChartFrame
          title="Who holds the value"
          subtitle="Each housing class has two bars: its share of the buildings on top, and its share of the total insured value under it. Where the two differ, the class holds more or less money than its number of buildings suggests."
          aside={<span className="text-xs text-muted">Buildings beside money</span>}
          sources={[{ kind: "synthetic", text: "Portfolio of insured buildings and their insured values, as written in the exposure file" }]}
          className={`flex flex-col @3xl:col-start-1 ${discrepancy ? "@3xl:row-start-3" : "@3xl:row-start-2"}`}
        >
          {/* Where the card is stretched to end level with the checks, the classes share the extra height as equal rows. */}
          <div className="flex flex-1 flex-col divide-y divide-line">
            {HOUSING_CLASSES.map((c) => {
              const cls = widest.byClass[c];
              const countShare = cls.count / dataset.buildings.length;
              const valueShare = cls.tivKes / reference.totalTivKes;
              return (
                <div key={c} className="flex flex-1 flex-col justify-center py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                    <span className="inline-flex flex-wrap items-center gap-2 text-ink">
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CLASS_COLORS[c] }} />
                      <span className={c === offerClass ? "font-semibold" : undefined}>{HOUSING_LABELS[c]}</span>
                      {c === offerClass && <span className="rounded-md border border-ink px-1.5 py-0.5 text-xs font-semibold text-ink">This offer&apos;s class</span>}
                    </span>
                    <span className="tabular ml-auto text-ink-2">{fmtInt(cls.count)} buildings · {kes1(cls.tivKes)}</span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-xs text-muted">
                    <span>Buildings</span>
                    <span className="h-1.5 rounded-full bg-surface-2" title={`${HOUSING_LABELS[c]}: ${fmtInt(cls.count)} buildings, ${fmtPct(countShare, 1)} of all buildings`}><span className="block h-1.5 rounded-full" style={{ width: `${countShare * 100}%`, background: CLASS_COLORS[c] }} /></span>
                    <span className="tabular text-right">{fmtPct(countShare, 0)}</span>
                    <span>Insured value</span>
                    <span className="h-1.5 rounded-full bg-surface-2" title={`${HOUSING_LABELS[c]}: ${kes1(cls.tivKes)}, ${fmtPct(valueShare, 1)} of the total insured value`}><span className="block h-1.5 rounded-full" style={{ width: `${valueShare * 100}%`, background: CLASS_COLORS[c] }} /></span>
                    <span className="tabular text-right">{fmtPct(valueShare, valueShare < 0.01 ? 1 : 0)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </ChartFrame>
      </div>

      <Card title="Files in the upload" className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 text-left text-sm">
            <thead className="text-xs text-muted">
              <tr><th className="pb-2 font-medium">File</th><th className="pb-2 font-medium">Role</th><th className="pb-2 font-medium">Source</th><th className="pb-2 font-medium">What it holds</th><th className="pb-2 text-right font-medium">Size</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {/* An offer is not a model input, but it is used: it goes to the offer step. */}
              {report.files.map((f) => (
                <tr key={f.path} className={f.used || f.kind === "offer" ? "text-ink" : "text-muted"}>
                  <td className="py-2 pr-4 font-mono text-sm wrap-anywhere">{f.name}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{f.used || f.kind === "offer" ? KIND_LABEL[f.kind] : "Not used"}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{f.used && f.provenance !== "none" ? <Tag kind={f.provenance} /> : "-"}</td>
                  <td className="py-2 pr-4 text-ink-2">{f.note}</td>
                  <td className="tabular whitespace-nowrap py-2 text-right text-ink-2">{fmtBytes(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/** One of the four comparisons: what is compared, the offer's own value, and a sentence that places it. */
function Placed({ title, value, children }: { title: string; value: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 border-l-2 border-line pl-4">
      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</div>
      <div className="tabular mt-1 wrap-anywhere text-xl font-semibold leading-snug tracking-tight text-ink">{value}</div>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-ink-2">{children}</div>
    </div>
  );
}

/**
 * A range from the lowest to the highest value, with a tick at the middle value and a diamond where
 * the offer sits. A value outside the range is held at that end; the sentence beside the bar says
 * which side it is on, so the bar is never the only reading.
 */
function RangeBar({ placement, format, what }: { placement: RangePlacement; format: (value: number) => string; what: string }) {
  const { min, median, max, at } = placement;
  if (min === null || median === null || max === null) return null;
  const middle = max > min ? ((median - min) / (max - min)) * 100 : 50;
  return (
    <div role="img" aria-label={`${what}: lowest ${format(min)}, middle ${format(median)}, highest ${format(max)}. The offer is ${placement.position === "unknown" ? "not placed" : `${placement.position} the range`}.`}>
      <div className="relative mx-2 h-2 rounded-full border border-line bg-surface-2">
        <span aria-hidden className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-ink-2" style={{ left: `${middle}%` }} />
        {at !== null && (
          <span aria-hidden className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-surface bg-brand outline outline-1 outline-ink" style={{ left: `${at * 100}%` }} />
        )}
      </div>
      <div aria-hidden className="tabular mt-2 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-muted">
        <span>Lowest {format(min)}</span>
        <span>Middle {format(median)}</span>
        <span>Highest {format(max)}</span>
      </div>
    </div>
  );
}

/** "larger than 62% of them", from the share of values at or below the offer's. */
const largerThan = (share: number | null) => (share === null ? "" : ` It is at or above ${fmtPct(share, 0)} of them.`);

/** The card that opens the step in Offer mode: the offer measured against the portfolio already held. */
function OfferInPortfolio({ focus, session, onOpenStep }: { focus: PricedFocus; session: Session; onOpenStep?: (id: StepId) => void }) {
  const { dataset, reference } = session;
  const { building, site } = focus;
  const { portfolio, total } = focus.price;
  const cls = focus.price.building.housingClass;
  const mix = reference.scenarios[reference.scenarios.length - 1]?.byClass[cls];
  const countShare = mix && dataset.buildings.length > 0 ? mix.count / dataset.buildings.length : null;
  const valueShare = mix && reference.totalTivKes > 0 ? mix.tivKes / reference.totalTivKes : null;

  const value = rangePlacement(building.tivKes, dataset.buildings.map((b) => b.tivKes));
  const range = portfolio.classRange;
  // The class range comes from the focus; only the diamond's place along the bar is worked out here.
  const perM2: RangePlacement | null =
    range && range.minKes !== null && range.medianKes !== null && range.maxKes !== null
      ? {
          count: range.count,
          min: range.minKes,
          median: range.medianKes,
          max: range.maxKes,
          position: range.position,
          shareAtOrBelow: range.shareAtOrBelow,
          at: range.perM2Kes === null ? null : range.maxKes > range.minKes ? Math.min(1, Math.max(0, (range.perM2Kes - range.minKes) / (range.maxKes - range.minKes))) : 0.5,
        }
      : null;
  const ward = site.wardPortfolio;

  return (
    <Card title="Where this offer sits in the portfolio" aside={<span className="wrap-anywhere text-sm text-ink-2">{focus.line.insured ?? building.name}</span>}>
      {focus.severalLine && <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">{focus.severalLine}</p>}
      <div className="grid gap-x-8 gap-y-6 grid-cols-[repeat(auto-fit,minmax(min(17rem,100%),1fr))]">
        <Placed title="Construction class" value={building.housingLabel ?? HOUSING_LABELS[cls]}>
          {mix && countShare !== null && valueShare !== null ? (
            <p>
              {fmtInt(mix.count)} of the portfolio&apos;s {fmtInt(dataset.buildings.length)} buildings are of this class ({fmtPct(countShare, countShare < 0.01 ? 1 : 0)}). They hold {kes1(mix.tivKes)}, {fmtPct(valueShare, valueShare < 0.01 ? 1 : 0)} of its insured value.
            </p>
          ) : (
            <p>The portfolio has no building of this class to compare it with.</p>
          )}
          <p>The class is marked in the chart below.</p>
        </Placed>

        <Placed title="Insured value" value={kes1(building.tivKes)}>
          <p>
            {value.position === "above"
              ? `Above every building in the portfolio${portfolio.timesLargest !== null ? `: ${fmtNum(portfolio.timesLargest, 1)} times the largest now held (${kes1(portfolio.largestTivKes)})` : ""}.`
              : value.position === "below"
                ? "Below every building in the portfolio."
                : value.position === "within"
                  ? `Within the range of the portfolio's buildings.${largerThan(value.shareAtOrBelow)}`
                  : "The portfolio has no insured value to compare it with."}{" "}
            {focus.several ? `The whole offer, ${kes1(total.tivKes)}, ` : "It "}would be <span className="tabular font-semibold text-ink">{fmtPct(portfolio.tivShare, portfolio.tivShare < 0.01 ? 2 : 1)}</span> of total insured value with the offer in.
          </p>
          <RangeBar placement={value} format={kes1} what="Insured value of one building in the portfolio" />
        </Placed>

        <Placed title="Value per m²" value={range?.perM2Kes !== null && range?.perM2Kes !== undefined ? `${kes1(range.perM2Kes)} per m²` : "Not stated"}>
          {!range || range.count === 0 || !perM2 ? (
            <p>The portfolio has no cost per m² for this class to compare it with.</p>
          ) : range.position === "below" ? (
            <p className="flex gap-2">
              <span className="mt-0.5"><StatusIcon status="warn" size={16} /></span>
              <span className="min-w-0">
                <strong className="font-semibold text-ink">Possible under-insurance.</strong> Below the lowest cost per m² among the {fmtInt(range.count)} {range.label} buildings in the portfolio.
              </span>
            </p>
          ) : range.position === "above" ? (
            <p>Above the highest cost per m² among the {fmtInt(range.count)} {range.label} buildings in the portfolio.</p>
          ) : range.position === "within" ? (
            <p>Within the range of the {fmtInt(range.count)} {range.label} buildings in the portfolio.{largerThan(range.shareAtOrBelow)}</p>
          ) : (
            <p>The offer states neither a floor area nor a cost per m², so it cannot be compared with the {fmtInt(range.count)} {range.label} buildings in the portfolio.</p>
          )}
          {perM2 && <RangeBar placement={perM2} format={kes1} what={`Cost per m² of ${range?.label ?? "this class"} buildings in the portfolio`} />}
        </Placed>

        <Placed title="Ward" value={ward ? `${ward.name}${ward.subcounty ? `, ${ward.subcounty}` : ""}` : "Outside the ward outlines"}>
          {ward ? (
            <p>
              {ward.buildings > 0
                ? `The model already holds ${plural(ward.buildings, "insured building")} there, worth ${kes1(ward.tivKes)}: ${fmtPct(ward.shareOfPortfolioTiv, ward.shareOfPortfolioTiv < 0.01 ? 2 : 1)} of the portfolio's insured value.`
                : "The model holds no insured building in this ward yet."}
              {building.approximate ? " The location is approximate, so the ward is too." : ""}
            </p>
          ) : (
            <p>The building&apos;s point falls in no ward of the ward map, so there is no ward holding to compare.</p>
          )}
          {onOpenStep && (
            <p>
              <Button variant="secondary" onClick={() => onOpenStep("hazard")}>See the building on the {STEP_NAMES.hazard}</Button>
            </p>
          )}
        </Placed>
      </div>
      <SourceLine
        className="mt-5 border-t border-line pt-3"
        sources={[
          { kind: "real", text: `The offer's values, as read from the document in ${STEP_NAMES.offer}` },
          { kind: "synthetic", text: "Portfolio of insured buildings" },
        ]}
      />
    </Card>
  );
}
