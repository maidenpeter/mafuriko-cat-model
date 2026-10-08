"use client";

/**
 * Read the data: what the model data holds, and where the offer sits in it.
 *
 * In Offer mode (`focus` set) the step is about the offer's building, in three cards:
 *   1. How the insured value is split: the parts the model prices (structure, value below ground,
 *      a year's rent) and the insured value, each with its figure and a short mark that says whether
 *      it is from the offer or assumed. The sentence or the assumption behind each figure, and the
 *      split as the offer itself states it, are folded.
 *   2. Is the building insured for enough: its value per m² on the range for its class in the
 *      portfolio, flagged in words when it is below that range.
 *   3. The portfolio this offer joins: four figures. How the offer compares with the buildings
 *      held, the portfolio by class, the checks on the data and the files are folded.
 * Every offer figure comes from the focus, the total of the stated parts among them: nothing is
 * priced or added up here.
 *
 * With no priced offer the step shows the model data alone: what was read and its checks in one
 * card, and the portfolio by class beside it. An offer that is outside the hazard maps, or waiting
 * for a value, says so in one note at the top.
 */

import type { ReactNode } from "react";
import { rangePlacement, type RangePlacement } from "@/lib/dashboard";
import { fmtBytes, fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { insuredValueFlag, kes1, LOSS_MODE_LABELS, type SourceKind } from "@/lib/labels";
import { HOUSING_CLASSES, HOUSING_LABELS, type HousingClass } from "@/lib/model/types";
import { DRIVER_LABELS, type DriverComponent, type DriverSource, type StatedValuePart } from "@/lib/offer/drivers";
import { isPriced, type FocusField, type FocusJudgement, type OfferFocusProps, type PricedFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { Session } from "@/lib/session";
import { STEP_NAMES, type StepId } from "@/lib/steps";
import { ChartFrame, SourceLine } from "../charts/ChartFrame";
import { DriverSources, offerKindOf } from "../DriverSources";
import { Button, Card, CheckList, ChecksSummary, Fold, InsuredValueFlag, Note, selectView, StatusIcon, StepHeader, Tag } from "../ui";

export const CLASS_COLORS: Record<HousingClass, string> = {
  informal_iron_sheet: "var(--series-1)",
  semi_permanent: "var(--series-2)",
  permanent_masonry: "var(--series-3)",
  concrete_rcc: "var(--series-4)",
};

const KIND_LABEL = { exposure: "Exposure", "hazard-raster": "Hazard map", hotspots: "Hotspots", offer: "Offer", other: "Other" } as const;

/** How to read the chart of the portfolio by class, wherever it is drawn. */
const CLASS_MIX_HELP = "Each class has two bars: its share of the buildings, and under it its share of the insured value. Where the two differ, the class holds more or less money than its number of buildings suggests.";

interface Props extends OfferFocusProps {
  session: Session;
  /** Opens another step of the walkthrough. */
  onOpenStep?: (id: StepId) => void;
}

export function DataStep({ session, focus = null, offerFocus = null, onOpenStep }: Props) {
  const { dataset, reference } = session;

  if (focus) {
    const { building } = focus;
    return (
      <div>
        <StepHeader title={STEP_NAMES.data}>
          <strong className="font-semibold text-ink">{focus.line.insured ?? building.name}</strong> is to be insured for{" "}
          <strong className="tabular font-semibold text-ink">{kes1(building.tivKes)}</strong>: its insured value, the most the building and what is in it are covered for.
        </StepHeader>
        <ValueSplit focus={focus} onOpenStep={onOpenStep} />
        <div className="mt-4 grid items-start gap-4 @4xl:grid-cols-2">
          <InsuredForEnough focus={focus} />
          <PortfolioJoined focus={focus} session={session} onOpenStep={onOpenStep} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <StepHeader title={STEP_NAMES.data}>
        {fmtInt(dataset.buildings.length)} buildings and {dataset.rasters.length} hazard maps were read from <strong className="font-semibold text-ink">{session.uploadName}</strong>. Nothing has been modelled yet; this step only confirms what was received.
      </StepHeader>

      {offerFocus && offerFocus.status !== "locating" && (
        <div className="mb-4">
          <Note tone={isPriced(offerFocus) ? "info" : "warn"}>
            {offerFocus.outside ? (
              <>
                <strong className="font-semibold text-ink">{offerFocus.outsideMessage}.</strong> The offer in {offerFocus.documentName} cannot be placed in this portfolio. {offerFocus.coverage}
              </>
            ) : isPriced(offerFocus) ? (
              <>An offer is loaded ({offerFocus.documentName}). {selectView("Offer")} to see where it sits in this portfolio.</>
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

      <div className="grid items-start gap-4 @4xl:grid-cols-2">
        <Card title="What was read" aside={<ChecksSummary checks={session.dataChecks} />}>
          <div className="grid gap-x-6 gap-y-4 grid-cols-[repeat(auto-fit,minmax(min(9rem,100%),1fr))]">
            <Figure label="Buildings" value={fmtInt(dataset.buildings.length)} />
            <Figure label="Total insured value" value={kes1(reference.totalTivKes)} note={<>As written in the file <InsuredValueFlag ratio={session.report.tivRatio?.median} inline /></>} />
            <Figure label="Hazard maps" value={dataset.rasters.length || "None"} note={dataset.hazardKind === "score" ? "Susceptibility score, 0 to 1" : "Flood depth, metres"} />
          </div>
          <ValueMismatch session={session} className="mt-4" />
          <div className="mt-4 space-y-1 border-t border-line pt-3">
            <Fold summary={`The ${plural(session.dataChecks.length, "check")} on the data, one by one`}>
              <CheckList checks={session.dataChecks} />
            </Fold>
            <Fold summary="The files in the upload, and what each holds">
              <FilesTable session={session} />
            </Fold>
          </div>
          <SourceLine
            className="mt-3 border-t border-line pt-3"
            sources={[
              { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
              { kind: "real", text: dataset.hazardKind === "score" ? "Hazard maps, as a derived score" : "Hazard maps" },
            ]}
          />
        </Card>

        <ChartFrame
          title="Who holds the value"
          subtitle={CLASS_MIX_HELP}
          sources={[{ kind: "synthetic", text: "Portfolio of insured buildings and their insured values, as written in the exposure file" }]}
        >
          <ClassMix session={session} offerClass={null} />
        </ChartFrame>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces both views draw
// ---------------------------------------------------------------------------------------------

/** One figure inside a card: what it is, the figure, and a few words under it. */
function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="tabular mt-0.5 wrap-anywhere text-2xl font-semibold tracking-tight text-ink">{value}</div>
      {note && <div className="mt-1 text-xs leading-relaxed text-muted">{note}</div>}
    </div>
  );
}

/** The warning when the file's insured values are a fixed multiple of their own formula. Nothing when they agree. */
function ValueMismatch({ session, className = "" }: { session: Session; className?: string }) {
  const ratio = session.report.tivRatio;
  const flag = insuredValueFlag(ratio?.median);
  if (!ratio || !flag) return null;
  const total = session.reference.totalTivKes;
  return (
    <div className={className}>
      <Note tone="warn">
        <strong className="font-semibold text-ink">{flag.full}</strong> Every row&apos;s value is {fmtNum(ratio.median, 1)}× its floor area × cost per m². The file totals {kes1(total)}; the documented formula gives {kes1(total / ratio.median)}. The model uses the values as they are in the file, so every loss figure carries this factor.
      </Note>
    </div>
  );
}

/** The portfolio by housing class: each class's share of the buildings beside its share of the insured value. */
function ClassMix({ session, offerClass }: { session: Session; offerClass: HousingClass | null }) {
  const { dataset, reference } = session;
  const widest = reference.scenarios[reference.scenarios.length - 1];
  return (
    <div className="divide-y divide-line">
      {HOUSING_CLASSES.map((c) => {
        const cls = widest.byClass[c];
        const countShare = cls.count / dataset.buildings.length;
        const valueShare = cls.tivKes / reference.totalTivKes;
        return (
          <div key={c} className="py-2.5 first:pt-0 last:pb-0">
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
  );
}

/** Every file of the upload: its role, its source and what it holds. */
function FilesTable({ session }: { session: Session }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-160 text-left text-sm">
        <thead className="text-xs text-muted">
          <tr><th scope="col" className="pb-2 font-medium">File</th><th scope="col" className="pb-2 font-medium">Role</th><th scope="col" className="pb-2 font-medium">Source</th><th scope="col" className="pb-2 font-medium">What it holds</th><th scope="col" className="pb-2 text-right font-medium">Size</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {/* An offer is not a model input, but it is used: it goes to the offer step. */}
          {session.report.files.map((f) => (
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
  );
}

/**
 * A range from the lowest to the highest value, with a tick at the middle value and a diamond where
 * the offer sits. A value outside the range is held at that end; the sentence beside the bar says
 * which side it is on, so the bar is never the only reading. `marker` names the diamond under the bar.
 */
function RangeBar({ placement, format, what, marker }: { placement: RangePlacement; format: (value: number) => string; what: string; marker: string }) {
  const { min, median, max, at } = placement;
  if (min === null || median === null || max === null) return null;
  const middle = max > min ? ((median - min) / (max - min)) * 100 : 50;
  return (
    <div role="img" aria-label={`${what}: lowest ${format(min)}, middle ${format(median)}, highest ${format(max)}. ${marker} is ${placement.position === "unknown" ? "not placed" : `${placement.position} the range`}.`}>
      <div className="relative mx-2 h-2 rounded-full border border-line bg-surface-2">
        <span aria-hidden className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-ink-2" style={{ left: `${middle}%` }} />
        {at !== null && (
          <span aria-hidden className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-surface bg-brand outline outline-ink" style={{ left: `${at * 100}%` }} />
        )}
      </div>
      <div aria-hidden className="tabular mt-2 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-muted">
        <span>Lowest {format(min)}</span>
        <span>Middle {format(median)}</span>
        <span>Highest {format(max)}</span>
      </div>
      {at !== null && (
        <div aria-hidden className="mt-1.5 flex items-center gap-2 text-xs text-ink-2">
          <span className="ml-1 inline-block h-2.5 w-2.5 shrink-0 rotate-45 bg-brand outline outline-ink" />
          <span>{marker}</span>
        </div>
      )}
    </div>
  );
}

/** "It is at or above 62% of them", from the share of values at or below the offer's. */
const largerThan = (share: number | null) => (share === null ? "" : ` It is at or above ${fmtPct(share, 0)} of them.`);

// ---------------------------------------------------------------------------------------------
// Is the building insured for enough
// ---------------------------------------------------------------------------------------------

/** The building's value per m² on the range for its class in the portfolio: the under-insurance reading. */
function InsuredForEnough({ focus }: { focus: PricedFocus }) {
  const { building } = focus;
  const range = focus.price.portfolio.classRange;
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
  const stated = range?.perM2Kes !== null && range?.perM2Kes !== undefined;
  const others = range ? `the ${fmtInt(range.count)} ${range.label} buildings in the portfolio` : "";

  return (
    <Card title="Is the building insured for enough?">
      <div className="tabular wrap-anywhere text-2xl font-semibold tracking-tight text-ink">{stated ? `${kes1(range.perM2Kes)} per m²` : "Not stated"}</div>
      <div className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">
        {!range || range.count === 0 || !perM2 ? (
          <p>The portfolio has no building of this class with a value per m², so there is nothing to measure it against.</p>
        ) : range.position === "below" ? (
          <p className="flex gap-2">
            <span className="mt-0.5"><StatusIcon status="warn" size={16} /></span>
            <span className="min-w-0">
              <strong className="font-semibold text-ink">Possibly not: it may be insured for too little.</strong> Its value per m² is below the lowest among {others}.
            </span>
          </p>
        ) : range.position === "above" ? (
          <p><strong className="font-semibold text-ink">Yes, on this measure.</strong> Its value per m² is above the highest among {others}.</p>
        ) : range.position === "within" ? (
          <p><strong className="font-semibold text-ink">Yes, on this measure.</strong> Its value per m² is within the range of {others}.</p>
        ) : (
          <p>The offer states neither a floor area nor a cost per m², so it cannot be measured against {others}.</p>
        )}
      </div>
      {perM2 && range && (
        <div className="mt-4">
          <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted">
            How to read this: the bar runs from the lowest to the highest value per m² (KES) among {range.label} buildings already held. The upright tick is the middle one{stated ? "; the diamond is this building" : ""}.
          </p>
          <RangeBar placement={perM2} format={kes1} what={`Value per m² of ${range.label} buildings in the portfolio`} marker={`This building, ${kes1(range.perM2Kes)} per m²`} />
        </div>
      )}
      <div className="mt-4 border-t border-line pt-3">
        <Fold summary="Show the working">
          <div className="max-w-3xl space-y-2 text-sm leading-relaxed text-ink-2">
            <p>Value per m² is the insured value shared over the floor area. A building insured for much less per m² than others of its kind may not be covered for what it would cost to rebuild.</p>
            {building.valuePerM2How && <p>This building: {building.valuePerM2How}</p>}
            {range && range.count > 0 && range.position !== "unknown" && range.shareAtOrBelow !== null && <p>Compared with {others}.{largerThan(range.shareAtOrBelow)}</p>}
          </div>
        </Fold>
      </div>
      <SourceLine
        className="mt-3 border-t border-line pt-3"
        sources={[
          { kind: offerKindOf(focus), text: "The building's value and floor area, as read from the offer" },
          { kind: "synthetic", text: "Portfolio of insured buildings" },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The portfolio this offer joins
// ---------------------------------------------------------------------------------------------

/** The portfolio in four figures. How the offer compares with it, its classes, its checks and its files are folded. */
function PortfolioJoined({ focus, session, onOpenStep }: { focus: PricedFocus; session: Session; onOpenStep?: (id: StepId) => void }) {
  const { dataset, reference } = session;
  const { building, site } = focus;
  const { portfolio, total } = focus.price;
  const cls = focus.price.building.housingClass;
  const mix = reference.scenarios[reference.scenarios.length - 1]?.byClass[cls];
  const value = rangePlacement(building.tivKes, dataset.buildings.map((b) => b.tivKes));
  const ward = site.wardPortfolio;
  const share = fmtPct(portfolio.tivShare, portfolio.tivShare < 0.01 ? 2 : 1);

  return (
    <Card title="The portfolio this offer joins" aside={<ChecksSummary checks={session.dataChecks} />}>
      <div className="grid gap-x-6 gap-y-4 grid-cols-[repeat(auto-fit,minmax(min(9rem,100%),1fr))]">
        <Figure label="Buildings held" value={fmtInt(dataset.buildings.length)} />
        <Figure label="Their insured value" value={kes1(reference.totalTivKes)} note={<InsuredValueFlag ratio={session.report.tivRatio?.median} inline />} />
        <Figure label="Of this offer's class" value={mix ? fmtInt(mix.count) : "None"} note={`${building.housingLabel ?? HOUSING_LABELS[cls]}${mix ? `, holding ${kes1(mix.tivKes)}` : ""}`} />
        <Figure label="This offer's share" value={share} note={`Of all insured value once ${focus.several ? "the whole offer" : "it"} is added`} />
      </div>
      <div className="mt-4 space-y-1 border-t border-line pt-3">
        <Fold summary="How the offer compares with the buildings held">
          <div className="max-w-3xl space-y-3 text-sm leading-relaxed text-ink-2">
            <p>
              <strong className="font-semibold text-ink">Insured value, {kes1(building.tivKes)}.</strong>{" "}
              {value.position === "above"
                ? `Above every building in the portfolio${portfolio.timesLargest !== null ? `: ${fmtNum(portfolio.timesLargest, 1)} times the largest now held (${kes1(portfolio.largestTivKes)})` : ""}.`
                : value.position === "below"
                  ? "Below every building in the portfolio."
                  : value.position === "within"
                    ? `Within the range of the portfolio's buildings.${largerThan(value.shareAtOrBelow)}`
                    : "The portfolio has no insured value to compare it with."}
              {focus.several ? ` The whole offer is ${kes1(total.tivKes)}.` : ""}
            </p>
            <RangeBar placement={value} format={kes1} what="Insured value of one building in the portfolio" marker={`This building, ${kes1(building.tivKes)}`} />
            <p>
              <strong className="font-semibold text-ink">Ward: {ward ? `${ward.name}${ward.subcounty ? `, ${ward.subcounty}` : ""}` : "outside the ward outlines"}.</strong>{" "}
              {ward
                ? `${
                    ward.buildings > 0
                      ? `The portfolio already holds ${plural(ward.buildings, "insured building")} there, worth ${kes1(ward.tivKes)}: ${fmtPct(ward.shareOfPortfolioTiv, ward.shareOfPortfolioTiv < 0.01 ? 2 : 1)} of its insured value.`
                      : "The portfolio holds no insured building in this ward yet."
                  }${building.approximate ? " The location is approximate, so the ward is too." : ""}`
                : "The building's point falls in no ward of the ward map, so there is no ward holding to compare."}
            </p>
            {onOpenStep && <Button variant="secondary" onClick={() => onOpenStep("hazard")}>See the building on the {STEP_NAMES.hazard}</Button>}
          </div>
        </Fold>
        <Fold summary="The portfolio by class of building">
          <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted">How to read this: {CLASS_MIX_HELP}</p>
          <ClassMix session={session} offerClass={cls} />
        </Fold>
        <Fold summary={`The ${plural(session.dataChecks.length, "check")} on the data, one by one`}>
          <ValueMismatch session={session} className="mb-2" />
          <CheckList checks={session.dataChecks} />
        </Fold>
        <Fold summary="The files in the upload, and what each holds">
          <p className="mb-2 text-sm leading-relaxed text-ink-2">
            Read from <strong className="font-semibold text-ink">{session.uploadName}</strong>, with {plural(dataset.rasters.length, "hazard map")} ({dataset.hazardKind === "score" ? "susceptibility score, 0 to 1" : "flood depth, metres"}).
          </p>
          <FilesTable session={session} />
        </Fold>
      </div>
      <SourceLine className="mt-3 border-t border-line pt-3" sources={[{ kind: "synthetic", text: "Portfolio of insured buildings and their insured values, as written in the exposure file" }]} />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The value split
// ---------------------------------------------------------------------------------------------

const fullKes = (value: number) => `KES ${fmtInt(value)}`;

/** A value that was read from the document but failed its check: it is the underwriter's to settle, not the broker's. */
function NotChecked({ what = "Read from the document but not checked yet, so not used." }: { what?: string }) {
  return (
    <span className="flex gap-2">
      <span className="mt-0.5"><StatusIcon status="warn" size={14} /></span>
      <span className="min-w-0">{what} Confirm it or type over it in {STEP_NAMES.offer}.</span>
    </span>
  );
}

/**
 * Where one figure the model prices comes from, drawn as on every other step: the offer's sentence,
 * or the assumption and who set it. A line that is switched off names what switched it off: that is
 * a reason, not an assumed figure, so it carries no badge. `unverified` is the offer's own value for
 * the same figure when it was read but failed its check: the assumption stands in until the
 * underwriter settles it, and the cell says so.
 */
function SourceCell({ source, judgement, kind, unverified, onOpenStep }: { source: DriverSource; judgement: FocusJudgement; kind: SourceKind; unverified?: FocusField; onOpenStep?: (id: StepId) => void }) {
  const reasonOnly = source.kind === "data" || (source.kind === "assumption" && source.keys.length === 0);
  return (
    <div className="min-w-0">
      <DriverSources sources={[source]} judgement={judgement} offerKind={kind} quiet={reasonOnly ? "all" : "none"} onOpenStep={onOpenStep} />
      {unverified?.status === "unverified" && (
        <div className="mt-1">
          <NotChecked what={`The document's own figure${unverified.value ? ` (${unverified.value})` : ""} was read but not checked yet, so this stands in for it.`} />
        </div>
      )}
    </div>
  );
}

const usable = (field: FocusField | undefined): field is FocusField => !!field && (field.status === "verified" || field.status === "confirmed" || field.status === "edited") && field.raw !== null;

/**
 * Where a value the offer states comes from: its sentence, the underwriter's typing, or the gap it leaves.
 * `asked` is true when the broker questions in Price an offer hold a question for it.
 */
function StatedCell({ field, kind, asked, onOpenStep }: { field: FocusField | undefined; kind: SourceKind; asked: boolean; onOpenStep?: (id: StepId) => void }) {
  const stated = usable(field) ? field : null;
  if (stated) {
    const typed = stated.status === "edited";
    return <DriverSources sources={[{ kind: "offer", what: typed ? `Typed in ${STEP_NAMES.offer}` : "Stated in the offer", quote: typed ? "" : stated.quote.trim() }]} offerKind={kind} onOpenStep={onOpenStep} />;
  }
  if (field?.status === "unverified") return <NotChecked />;
  return <span>The document does not state it.{asked ? ` It is a question for the broker, listed in ${STEP_NAMES.offer}.` : ""}</span>;
}

/** The field of the offer each stated part of the insured value is read from. */
const PART_FIELD: Record<StatedValuePart["id"], string> = { building: "terms:valueBuildingKes", machinery: "terms:valueMachineryKes", contents: "terms:valueContentsKes" };

/** The few words beside a figure in the split: whether the offer gives it, it is assumed, or it takes no part in the price. */
function markOf(source: DriverSource, on: boolean): string {
  if (!on) return "Not priced";
  if (source.kind === "offer") return source.quote ? "From the offer" : "Typed by you";
  return source.kind === "assumption" ? "Assumed" : "All of the insured value";
}

/** One row of the split: the part and what it means, its figure, its mark, and what is folded behind it. */
interface SplitRow {
  id: string;
  part: string;
  /** What the part is, in a few everyday words. */
  means: string;
  figure: string;
  /** The figure in whole shillings, for the folded detail. null when there is none. */
  full: string | null;
  mark: string;
  source: ReactNode;
  usedFor: string;
  total?: boolean;
}

/**
 * The insured value in parts: what the model prices (structure, value below ground, a year's rent)
 * and the insured value they sit under, each with a short mark. The source of each figure and the
 * split as the offer states it (building, plant and machinery, contents) are folded. Every figure
 * is the focus's own, the total of the stated parts and its gap to the insured value included.
 */
function ValueSplit({ focus, onOpenStep }: { focus: PricedFocus; onOpenStep?: (id: StepId) => void }) {
  const { drivers, building, judgement } = focus;
  const split = drivers.valueSplit;
  const kind = offerKindOf(focus);
  const field = (id: string) => focus.fields.find((x) => x.id === id);
  const asked = (id: string) => focus.questions.some((q) => q.id === id);
  const part = (id: DriverComponent["id"]) => drivers.components.find((c) => c.id === id);
  const structure = part("structure");
  const below = part("below_ground");
  const rent = part("interruption");
  const rentStated = field("terms:annualRentKes");
  const tiv = field(`row:${building.index}:tivKes`);
  const allDrivers = focus.mode === "all_drivers";
  const insured = focus.price.total.tivKes;
  const gap = split.gapKes ?? 0;
  const assumed = [structure, below, rent].some((c) => c && c.on && c.valueSource.kind === "assumption");

  const rows: SplitRow[] = [];
  if (structure) {
    rows.push({
      id: "structure",
      part: "Structure",
      means: "The building itself, above ground",
      figure: kes1(structure.valueKes),
      full: fullKes(structure.valueKes),
      mark: markOf(structure.valueSource, true),
      source: <SourceCell source={structure.valueSource} judgement={judgement} kind={kind} onOpenStep={onOpenStep} />,
      usedFor: `${allDrivers ? `${DRIVER_LABELS.surrounding}, ${DRIVER_LABELS.ponding} and ${DRIVER_LABELS.overload}` : "Depth at the point and drainage ponding"}, on the damage curve`,
    });
  }
  if (below) {
    rows.push({
      id: "below",
      part: "Below ground",
      means: "Machinery and contents in the basement",
      figure: below.on ? kes1(below.valueKes) : "None",
      full: below.on ? fullKes(below.valueKes) : null,
      mark: markOf(below.valueSource, below.on),
      source: <SourceCell source={below.valueSource} judgement={judgement} kind={kind} unverified={allDrivers ? field("terms:valueBelowGroundKes") : undefined} onOpenStep={onOpenStep} />,
      usedFor: DRIVER_LABELS.basement,
    });
  }
  if (rent) {
    const statedRent = usable(rentStated) ? rentStated : null;
    rows.push({
      id: "rent",
      part: "Rent or revenue for one year",
      means: "What is lost while the building cannot be used. Not part of the insured value",
      figure: rent.on ? kes1(rent.valueKes) : statedRent ? (typeof statedRent.raw === "number" ? kes1(statedRent.raw) : statedRent.value) : "Not stated",
      full: rent.on ? fullKes(rent.valueKes) : statedRent ? statedRent.value : null,
      mark: markOf(rent.valueSource, rent.on),
      source: rent.on ? (
        <SourceCell source={rent.valueSource} judgement={judgement} kind={kind} unverified={rentStated} onOpenStep={onOpenStep} />
      ) : (
        <>
          <StatedCell field={rentStated} kind={kind} asked={asked("annualRentKes")} onOpenStep={onOpenStep} />
          <p className="mt-1">{rent.valueSource.what}</p>
        </>
      ),
      usedFor: DRIVER_LABELS.interruption,
    });
  }
  rows.push({
    id: "insured",
    part: "Insured value",
    means: "Structure and below ground together, so nothing is counted twice",
    figure: kes1(building.tivKes),
    full: building.tivKes !== null ? fullKes(building.tivKes) : null,
    mark: building.tivFrom === "area_times_cost" ? "From the offer" : tiv?.status === "edited" ? "Typed by you" : "From the offer",
    source: building.tivFrom === "area_times_cost" ? <span>Worked out as floor area × cost per m², both read in {STEP_NAMES.offer}</span> : <StatedCell field={tiv} kind={kind} asked={asked("tivKes")} onOpenStep={onOpenStep} />,
    usedFor: "The measure every loss and rate is set against",
    total: true,
  });

  const HEAD = "pb-2 pr-4 font-medium";
  const CELL = "py-2.5 pr-4 align-top";

  // How the stated parts read against the insured value. Shown on the card when they disagree, otherwise with the stated split.
  const disagrees = split.complete && !split.agrees;
  const reading = split.complete ? (
    split.agrees ? (
      <>
        <span className="mt-0.5"><StatusIcon status="pass" size={16} /></span>
        <span className="min-w-0">The three stated parts add up to {fullKes(split.statedKes)}, the {focus.several ? "offer's whole " : ""}insured value.</span>
      </>
    ) : (
      <>
        <span className="mt-0.5"><StatusIcon status="warn" size={16} /></span>
        <span className="min-w-0">
          <strong className="font-semibold text-ink">The parts the offer states do not add up to the insured value.</strong> They come to {fullKes(split.statedKes)}, {kes1(Math.abs(gap))} {gap > 0 ? "more" : "less"} than the {focus.several ? "offer's whole " : ""}insured value of {fullKes(insured)}. Worth asking the broker which figure is right.
        </span>
      </>
    )
  ) : split.statedCount > 0 ? (
    <span className="min-w-0">Only {split.statedCount} of the three parts {split.statedCount === 1 ? "is" : "are"} stated, so they cannot be added up to the insured value.</span>
  ) : (
    <span className="min-w-0">The offer states no split of the insured value, so there is nothing to add up.{asked("valueSplit") ? " The split is one of the questions for the broker." : ""}</span>
  );

  return (
    <Card title="How the insured value is split">
      <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
        {allDrivers
          ? "A flood does not harm every part of a building the same way, so the model prices each part on its own."
          : `${LOSS_MODE_LABELS.depth_only} is selected under "Losses from" in the bar above, so the whole insured value is priced as structure: nothing is priced below ground or for lost rent.`}
        {focus.severalLine ? ` ${focus.severalLine}` : ""}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full max-w-3xl text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className={HEAD}>Part</th>
              <th scope="col" className={`${HEAD} text-right`}>Figure</th>
              <th scope="col" className="pb-2 font-medium">Where from</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line text-ink-2">
            {rows.map((r) => (
              <tr key={r.id} className={r.total ? "font-semibold text-ink" : undefined}>
                <th scope="row" className={`${CELL} ${r.total ? "" : "font-medium"} text-ink`}>
                  {r.part}
                  <span className="block text-xs font-normal leading-relaxed text-muted">{r.means}</span>
                </th>
                <td className={`${CELL} tabular whitespace-nowrap text-right text-ink`}>{r.figure}</td>
                <td className="py-2.5 align-top font-normal text-ink-2">{r.mark}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {disagrees && <p className="mt-3 flex max-w-3xl gap-2 text-sm leading-relaxed text-ink-2">{reading}</p>}

      <div className="mt-4 space-y-1 border-t border-line pt-3">
        <Fold summary="Where each figure comes from">
          <ul className="max-w-5xl divide-y divide-line text-sm leading-relaxed text-ink-2">
            {rows.map((r) => (
              <li key={r.id} className="py-2.5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <span className="font-medium text-ink">{r.part}</span>
                  {r.full && <span className="tabular text-ink">{r.full}</span>}
                </div>
                <div className="mt-1 text-xs leading-relaxed text-muted">{r.source}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted">Used for: {r.usedFor}</div>
              </li>
            ))}
          </ul>
        </Fold>
        <Fold summary="The split as the offer states it">
          <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
            The offer&apos;s own split is for context: it changes no loss.{focus.several ? " An amount the offer states once for several buildings is shared between them by insured value." : ""}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-120 max-w-5xl text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className={HEAD}>Part</th>
                  <th scope="col" className={`${HEAD} text-right`}>Figure (KES)</th>
                  <th scope="col" className="pb-2 font-medium">Source of the figure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-ink-2">
                {split.parts.map((x) => (
                  <tr key={x.id}>
                    <th scope="row" className={`${CELL} font-medium text-ink`}>{x.label}</th>
                    <td className={`${CELL} tabular whitespace-nowrap text-right text-ink`}>{x.kes !== null ? fullKes(x.kes) : "Not stated"}</td>
                    <td className="py-2.5 align-top text-xs leading-relaxed text-muted"><StatedCell field={field(PART_FIELD[x.id])} kind={kind} asked={asked("valueSplit")} onOpenStep={onOpenStep} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!disagrees && <p className="mt-3 flex max-w-3xl gap-2 text-sm leading-relaxed text-ink-2">{reading}</p>}
        </Fold>
      </div>
      <SourceLine
        className="mt-3 border-t border-line pt-3"
        sources={[
          { kind, text: "Figures the offer states, each checked against its sentence" },
          ...(assumed ? [{ kind: "assumption" as const, text: "Rows marked Assumed: a share of the insured value, used where the offer states no figure" }] : []),
        ]}
      />
    </Card>
  );
}
