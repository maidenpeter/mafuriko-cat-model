"use client";

import { motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import type { Check } from "@/lib/checks";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { annualChance, kes1, pct1, rpLabel, rpWithChance } from "@/lib/labels";
import type { InsuranceTerms, TermsResult } from "@/lib/model/terms";
import { HOUSING_LABELS } from "@/lib/model/types";
import { isPriced, type FocusTerm, type OfferFocus, type PricedFocus } from "@/lib/offer/focus";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, stepKicker, type StepId } from "@/lib/steps";
import { ChartFrame, SourceLine, type ChartSource } from "../charts/ChartFrame";
import { Waterfall, type WaterfallStep } from "../charts/Waterfall";
import { TermsPanel } from "../TermsPanel";
import { Card, CheckList, ChecksSummary, Note, Segmented, StepHeader, Tag } from "../ui";

interface Props {
  session: Session;
  active: Active;
  /** The checks on the arithmetic, the checks on the insurance terms among them. */
  checks: Check[];
  /** The insurance terms in force and what they do to every event. */
  terms: TermsResult;
  onTermsChange: (t: InsuranceTerms) => void;
  /** The priced offer while the header switch is on "Offer": the step then follows that building. */
  focus?: PricedFocus | null;
  /** The offer whatever the switch says, priced or not. */
  offerFocus?: OfferFocus | null;
  /** Opens another step of the walkthrough. */
  onOpenStep?: (id: StepId) => void;
}

type View = "offer" | "portfolio";

export function LossStep({ session, active, checks, terms, onTermsChange, focus = null, offerFocus = null, onOpenStep }: Props) {
  const [view, setView] = useState<View>("offer");
  const showOffer = focus !== null && view === "offer";

  return (
    <div>
      <StepHeader kicker={stepKicker("loss")} title={STEP_NAMES.loss}>
        {showOffer
          ? "One building, one flood at a time: the depth at the site, the damage that depth does, and what the policy terms leave the insurer to pay. Every line is arithmetic you can follow by hand; a language model produces none of it."
          : "For every building and every scenario: hazard value, to depth, to damage ratio, times insured value. The scenario loss is the sum. The insurance terms then turn that ground-up loss into the gross loss the insurer pays and the net loss it keeps. Nothing here is estimated by a model; it is arithmetic you can follow by hand."}
      </StepHeader>

      {focus ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 text-sm leading-relaxed text-ink-2">
            {view === "offer" ? (focus.severalLine ?? `Following ${focus.building.name}.`) : "The whole portfolio through the same engine, without the offer."}
          </p>
          <Segmented<View> label="What this step shows" value={view} onChange={setView} options={[{ value: "offer", label: "This offer" }, { value: "portfolio", label: "Portfolio" }]} />
        </div>
      ) : (
        offerFocus && (
          <div className="mb-4">
            <OfferNotice offerFocus={offerFocus} onOpenStep={onOpenStep} />
          </div>
        )
      )}

      {focus && view === "offer" ? (
        <OfferTrace focus={focus} active={active} terms={terms} onTermsChange={onTermsChange} onOpenStep={onOpenStep} onShowPortfolio={() => setView("portfolio")} />
      ) : (
        <PortfolioEngine session={session} active={active} checks={checks} terms={terms} onTermsChange={onTermsChange} />
      )}
    </div>
  );
}

/** Another step's name, as a link to it when the step can be opened from here. */
function StepLink({ id, onOpenStep }: { id: StepId; onOpenStep?: (id: StepId) => void }) {
  if (!onOpenStep) return <span className="font-medium text-ink">{STEP_NAMES[id]}</span>;
  return (
    <button type="button" onClick={() => onOpenStep(id)} className="font-medium text-ink underline underline-offset-2 hover:text-brand">
      {STEP_NAMES[id]}
    </button>
  );
}

/** One line on the offer when the step is showing the portfolio: why, and where to go. */
function OfferNotice({ offerFocus, onOpenStep }: { offerFocus: OfferFocus; onOpenStep?: (id: StepId) => void }) {
  if (offerFocus.outside) {
    return (
      <Note tone="warn">
        <span className="font-medium text-ink">{offerFocus.outsideMessage}.</span> {offerFocus.coverage} There is no loss to trace for this offer, so this step shows the portfolio.
      </Note>
    );
  }
  if (offerFocus.waiting.length > 0) {
    const n = offerFocus.waiting.length;
    return (
      <Note tone="warn">
        The offer is not priced yet: {n} {n === 1 ? "value waits" : "values wait"} to be confirmed in <StepLink id="offer" onOpenStep={onOpenStep} />. Until then this step shows the portfolio.
      </Note>
    );
  }
  if (isPriced(offerFocus)) {
    return <Note>An offer is loaded ({offerFocus.line.insured ?? offerFocus.documentName}). Switch to Offer in the header to follow that building through this step.</Note>;
  }
  return (
    <Note>
      {offerFocus.statusLine} This step shows the portfolio; the offer is in <StepLink id="offer" onOpenStep={onOpenStep} />.
    </Note>
  );
}

// ---------------------------------------------------------------------------------------------
// This offer: one building traced from the hazard map to the gross loss
// ---------------------------------------------------------------------------------------------

/** Where a figure's input came from. "document" and "typed" are the offer's own; the rest are the shared badges. */
interface Source {
  kind: "document" | "typed" | "real" | "assumption" | "ai";
  label: string;
  /** The sentence of the document the value rests on, shown on hover and beside the figure in the worked row. */
  quote?: string;
}

/** The small tag under a figure. Shape and word carry the meaning, as on the shared badges. */
function SourceTag({ source }: { source: Source }) {
  if (source.kind === "document" || source.kind === "typed") {
    return (
      <span title={source.quote || undefined} className="inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-ink-2">
        <span aria-hidden className="shrink-0">{source.kind === "document" ? "❝" : "✎"}</span>
        {source.label}
      </span>
    );
  }
  return <Tag kind={source.kind}>{source.label}</Tag>;
}

const termSource = (term: FocusTerm): Source =>
  term.source === "from the document"
    ? { kind: "document", label: term.mixed ? "Document, part typed" : "Document", quote: term.quotes.join(" ") }
    : term.source === "typed by you"
      ? { kind: "typed", label: "Typed by you" }
      : { kind: "assumption", label: "Assumption: example terms" };

/** A depth in metres. A film of water too thin for two decimals is not written as zero. */
const metres = (m: number) => (m > 0 && m < 0.005 ? "under 0.01 m" : `${fmtNum(m)} m`);

interface Stage {
  label: string;
  value: string;
  how: ReactNode;
  source: Source | null;
  quote?: string;
}

function OfferTrace({ focus, active, terms, onTermsChange, onOpenStep, onShowPortfolio }: { focus: PricedFocus; active: Active; terms: TermsResult; onTermsChange: (t: InsuranceTerms) => void; onOpenStep?: (id: StepId) => void; onShowPortfolio: () => void }) {
  const b = focus.price.building;
  const site = focus.building;
  const rows = b.perReturnPeriod;
  const isScore = focus.hazardKind === "score";
  const usingAi = focus.assumptionsInForce === "ai";
  const className = HOUSING_LABELS[b.housingClass];

  // The return period worked step by step. It opens on the one nearest 1-in-100, the flood the headline figure is read at.
  const nearest100 = rows.reduce((best, r, i) => (Math.abs(Math.log(r.returnPeriod / 100)) < Math.abs(Math.log(rows[best].returnPeriod / 100)) ? i : best), 0);
  const [chosen, setChosen] = useState<string | null>(null);
  const row = rows.find((r) => r.id === chosen) ?? rows[nearest100];

  // An assumption the agents chose carries the AI badge; the reference value carries the assumption badge.
  const assumed = (what: string): Source => (usingAi ? { kind: "ai", label: `AI: ${what}` } : { kind: "assumption", label: `Assumption: ${what}` });
  const hazardMap: Source = { kind: "real", label: "Hazard map" };
  const curveSource: Source = { kind: "real", label: "JRC curve" };
  const pondingSource: Source = { kind: "assumption", label: "Assumption: drainage ponding" };

  // The insured value: stated, or floor area × cost per m², each read from the document or typed over it.
  const valueFields = (site.tivFrom === "area_times_cost" ? ["floorAreaM2", "costPerM2Kes"] : ["tivKes"]).flatMap((key) => focus.fields.filter((f) => f.id === `row:${site.index}:${key}`));
  const valueTyped = valueFields.length > 0 && valueFields.every((f) => f.origin === "edited");
  const valueQuote = [...new Set(valueFields.filter((f) => f.origin !== "edited").map((f) => f.quote.trim()).filter(Boolean))].join(" ");
  const valueSource: Source = valueTyped ? { kind: "typed", label: "Typed by you" } : { kind: "document", label: "Document", quote: valueQuote };
  const deductibleSource = termSource(focus.terms.deductible);
  const limitSource = termSource(focus.terms.limit);
  const exampleTerms = focus.terms.deductible.source === "example terms" || focus.terms.limit.source === "example terms";

  if (!row) return <Note>No flood scenario is loaded, so there is nothing to trace.</Note>;

  const slope = active.result.scenarios.find((s) => s.id === row.id)?.tierSlope;
  const depthScale = active.params.depthScaleM;
  // The terrain depth written as its own sum, only when that sum gives the engine's figure.
  const scoreSum = isScore && row.hazard > 0 && slope !== undefined && Math.abs(row.hazard * slope * depthScale - row.terrainM) < 0.005;
  const terrainHow = scoreSum
    ? `Terrain: score ${fmtNum(row.hazard, 3)} × tier slope ${fmtNum(slope, 3)} × depth scale ${fmtNum(depthScale)} m = ${metres(row.terrainM)}.`
    : `Terrain${isScore ? "" : " map"}: ${metres(row.terrainM)}.`;
  const pondingHow = focus.drainageOn ? ` Drainage ponding: ${metres(row.drainageM)}. The deeper of the two is used.` : " Drainage ponding is switched off.";

  const stages: Stage[] = [
    {
      label: "Insured value",
      value: fmtKes(b.tivKes, 2),
      how:
        site.tivFrom === "area_times_cost" && site.floorAreaM2 !== null && site.costPerM2Kes !== null
          ? `Floor area ${fmtInt(site.floorAreaM2)} m² × ${fmtKes(site.costPerM2Kes)} per m²`
          : valueTyped
            ? "The figure typed over the document's"
            : "As the document states it",
      source: valueSource,
      quote: valueSource.quote,
    },
    {
      label: isScore ? "Hazard score on the map" : "Flood depth on the map",
      value: isScore ? fmtNum(row.hazard, 3) : metres(row.hazard),
      how: `Read from the "${row.label}" map at the building's point`,
      source: hazardMap,
    },
    {
      label: "Depth at the building",
      value: metres(row.depthM),
      how: terrainHow + pondingHow,
      source: row.depthFrom === "drainage" ? pondingSource : isScore ? assumed("depth scale") : hazardMap,
    },
    {
      label: "Depth on the curve",
      value: metres(row.effectiveDepthM),
      how: `${metres(row.depthM)} × fragility ${fmtNum(b.fragility)} for ${className}`,
      source: assumed("fragility"),
    },
    {
      label: "Damage ratio",
      value: fmtPct(row.damageRatio, 1),
      how: row.capped ? `The JRC curve gives ${fmtPct(row.curveDamage, 1)}; the ${fmtPct(b.cap, 0)} cap for this class limits it` : `JRC curve at ${metres(row.effectiveDepthM)}; under the ${fmtPct(b.cap, 0)} cap for this class`,
      source: row.capped ? assumed("damage cap") : curveSource,
    },
    {
      label: "Ground-up loss",
      value: fmtKes(row.groundUpKes, 2),
      how: `${fmtPct(row.damageRatio, 1)} × ${fmtKes(b.tivKes, 2)}`,
      source: null,
    },
    {
      label: "Deductible taken",
      value: fmtKes(row.deductibleKes, 2),
      how: focus.terms.deductible.text,
      source: deductibleSource,
      quote: deductibleSource.quote,
    },
    {
      label: "Amount over the limit",
      value: fmtKes(row.overLimitKes, 2),
      how: focus.terms.limit.text,
      source: limitSource,
      quote: limitSource.quote,
    },
    {
      label: "Gross loss",
      value: fmtKes(row.grossKes, 2),
      how: `${fmtKes(row.groundUpKes, 2)} less ${fmtKes(row.deductibleKes, 2)} less ${fmtKes(row.overLimitKes, 2)}`,
      source: null,
    },
  ];

  // Average annual loss, gross, band by band: the same sum the figure above it comes from.
  const curve = b.curve;
  const bands = curve.map((p, i) => {
    const next = curve[i + 1];
    const chance = next ? 1 / p.returnPeriod - 1 / next.returnPeriod : 1 / p.returnPeriod;
    const lossKes = next ? (p.grossKes + next.grossKes) / 2 : p.grossKes;
    return { id: p.id, label: next ? `${rpLabel(p.returnPeriod)} to ${rpLabel(next.returnPeriod)}` : `${rpLabel(p.returnPeriod)} and rarer`, chance, lossKes, partKes: chance * lossKes };
  });

  const steps: WaterfallStep[] = [
    { label: "Ground-up", value: row.groundUpKes, kind: "total" },
    { label: "Minus deductible", value: row.deductibleKes, kind: "decrease" },
    ...(row.overLimitKes > 0 ? [{ label: "Minus over limit", value: row.overLimitKes, kind: "decrease" as const }] : []),
    { label: "Gross", value: row.grossKes, kind: "total" },
  ];
  const waterfallTitle = `From ground-up loss to gross loss at this building in a ${rpLabel(row.returnPeriod)} flood`;
  const chartSources: ChartSource[] = [
    { kind: focus.document.path === "model" ? "ai" : "real", text: focus.document.path === "model" ? "Insured value read from the offer document by the AI reader and checked by code" : "Insured value read from the offer document" },
    { kind: "real", text: isScore ? "Hazard maps and the JRC depth-damage curve" : "Flood depth maps and the JRC depth-damage curve" },
    { kind: usingAi ? "ai" : "assumption", text: isScore ? "Return periods, depth scale, fragility and damage cap" : "Fragility and damage cap" },
    ...(focus.drainageOn ? [{ kind: "assumption" as const, text: "Drainage ponding depths" }] : []),
    ...(exampleTerms ? [{ kind: "assumption" as const, text: "Example terms where the document states none" }] : []),
  ];
  const rpPicker = rows.length > 1 ? <Segmented label="Return period" value={row.id} onChange={setChosen} options={rows.map((r) => ({ value: r.id, label: rpLabel(r.returnPeriod) }))} /> : undefined;
  const g = focus.price.portfolio.gross;

  const th = "pb-2 pl-3 text-right align-bottom font-medium";
  const td = "tabular py-2.5 pl-3 text-right text-ink-2";
  const head = (label: string, source: Source | null) => (
    <th scope="col" className={th}>
      <div>{label}</div>
      <div className="mt-1 flex min-h-6 justify-end">{source && <SourceTag source={source} />}</div>
    </th>
  );

  return (
    <div className="grid gap-4">
      {b.dryAtEveryReturnPeriod && (
        <Note>
          The building is dry at every return period modelled, so every loss on this page is KES 0. How close the water comes is in <StepLink id="hazard" onOpenStep={onOpenStep} />.
        </Note>
      )}

      <Card title={`One flood, worked step by step: ${rpWithChance(row.returnPeriod)}`} aside={rpPicker}>
        <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
          Read in order: each stage takes the figure before it and shows the sum that gives the next. The tag beside a figure says where its input came from. Depths are in metres and amounts in KES.
        </p>
        {/* A list down the card; three stages to a row on a medium step, five on a wide one, with the gross loss taking the last two places. */}
        <motion.ol key={row.id} className="grid gap-2 @3xl:grid-cols-3 @7xl:grid-cols-5" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08 } } }}>
          {stages.map((stage, i, all) => {
            const last = i === all.length - 1;
            return (
              <motion.li key={stage.label} variants={{ hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0 } }} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl px-3.5 py-2.5 @3xl:flex-col @3xl:flex-nowrap @3xl:items-start @3xl:justify-start @3xl:gap-y-3 @3xl:py-3.5 ${last ? "bg-ink text-surface @7xl:col-span-2" : "bg-surface-2"}`}>
                <div className="min-w-0 wrap-anywhere">
                  <div className={`text-xs ${last ? "opacity-70" : "text-muted"}`}>{i + 1}. {stage.label}</div>
                  <div className={`text-sm ${last ? "opacity-80" : "text-ink-2"}`}>{stage.how}</div>
                  {stage.quote && <q className="mt-1 block text-xs leading-relaxed text-muted">{stage.quote}</q>}
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 text-right @3xl:mt-auto @3xl:ml-0 @3xl:justify-start @3xl:text-left">
                  {stage.source && <SourceTag source={stage.source} />}
                  <span className="tabular text-base font-semibold">{stage.value}</span>
                </div>
              </motion.li>
            );
          })}
        </motion.ol>
        {focus.several && <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted">A deductible or limit stated in the document applies once per flood to the whole offer; this building carries its share of it.</p>}

        <h4 className="mt-6 mb-1 text-sm font-semibold text-ink">Every return period</h4>
        <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">One row per flood, most frequent first. Choose a return period to work it through above. Hover over a Document tag to read the sentence it rests on.</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-300 text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="pb-2 text-left align-bottom font-medium">
                  <div>Return period (chance in any year)</div>
                  <div className="mt-1 flex min-h-6">
                    <SourceTag source={isScore ? assumed("return period") : hazardMap} />
                  </div>
                </th>
                {head(isScore ? "Hazard score (0 to 1)" : "Map depth (m)", hazardMap)}
                {head("Terrain depth (m)", isScore ? assumed("depth scale") : hazardMap)}
                {focus.drainageOn && head("Ponding (m)", pondingSource)}
                {focus.drainageOn && head("Depth used (m)", null)}
                {head("Depth on the curve (m)", assumed("fragility"))}
                {head("Damage ratio (%)", curveSource)}
                {head("Ground-up loss (KES)", valueSource)}
                {head("Deductible taken (KES)", deductibleSource)}
                {head("Over the limit (KES)", limitSource)}
                {head("Gross loss (KES)", null)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const on = r.id === row.id;
                return (
                  <tr key={r.id} className={on ? "bg-surface-2" : undefined}>
                    <th scope="row" className="py-2.5 pr-3 pl-2 text-left font-medium whitespace-nowrap text-ink">
                      <button type="button" aria-pressed={on} onClick={() => setChosen(r.id)} className="tabular underline-offset-2 hover:underline">
                        {rpWithChance(r.returnPeriod)}
                      </button>
                      {on && <span className="ml-2 text-xs font-normal text-muted">worked above</span>}
                    </th>
                    <td className={td}>{isScore ? fmtNum(r.hazard, 3) : fmtNum(r.hazard)}</td>
                    <td className={td}>{fmtNum(r.terrainM)}</td>
                    {focus.drainageOn && <td className={td}>{fmtNum(r.drainageM)}</td>}
                    {focus.drainageOn && <td className={td}>{fmtNum(r.depthM)}</td>}
                    <td className={td}>{fmtNum(r.effectiveDepthM)}</td>
                    <td className={td}>
                      {fmtPct(r.damageRatio, 1)}
                      {r.capped && <span className="ml-1 text-xs text-muted">at the cap</span>}
                    </td>
                    <td className={td}>{fmtKes(r.groundUpKes, 2)}</td>
                    <td className={td}>{fmtKes(r.deductibleKes, 2)}</td>
                    <td className={td}>{fmtKes(r.overLimitKes, 2)}</td>
                    <td className="tabular py-2.5 pr-2 pl-3 text-right font-semibold text-ink">{fmtKes(r.grossKes, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 @6xl:grid-cols-2">
        <Card title="Average annual loss and pure rate">
          <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
            The losses in the table above, weighted by how often each flood comes. The pure rate is before expense, profit and uncertainty loadings.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-136 text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="pb-2 text-left font-medium">Figure</th>
                  <th scope="col" className="pb-2 pl-3 text-left font-medium">Formula</th>
                  <th scope="col" className="pb-2 pl-3 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[
                  { label: "Average annual loss, ground-up", formula: "Area under the ground-up losses against their annual chance", value: fmtKes(b.aalGroundUpKes, 2) },
                  { label: "Average annual loss, gross", formula: "The same area under the gross losses", value: fmtKes(b.aalGrossKes, 2) },
                  { label: "Pure rate, ground-up", formula: `${fmtKes(b.aalGroundUpKes, 2)} ÷ ${fmtKes(b.tivKes, 2)} × 1,000`, value: `${fmtNum(b.ratePerMilleGroundUp, 3)} per mille` },
                  { label: "Pure rate, gross", formula: `${fmtKes(b.aalGrossKes, 2)} ÷ ${fmtKes(b.tivKes, 2)} × 1,000`, value: `${fmtNum(b.ratePerMilleGross, 3)} per mille` },
                ].map((f) => (
                  <tr key={f.label}>
                    <th scope="row" className="py-2.5 pr-3 text-left font-medium text-ink">{f.label}</th>
                    <td className="py-2.5 pl-3 text-ink-2">{f.formula}</td>
                    <td className="tabular py-2.5 pl-3 text-right font-semibold whitespace-nowrap text-ink">{f.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer select-none text-sm font-medium text-ink-2 hover:text-ink">The gross average annual loss, band by band</summary>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">
              Between two neighbouring return periods, the gap between their annual chances × the average of their two gross losses. The rarest flood counts at its own chance and loss. Floods more frequent than the first are taken to cause no loss. The parts add up to the figure above.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-128 text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th scope="col" className="pb-2 text-left font-medium">Band of floods</th>
                    <th scope="col" className="pb-2 pl-3 text-right font-medium">Chance in any year (%)</th>
                    <th scope="col" className="pb-2 pl-3 text-right font-medium">Gross loss in the band (KES)</th>
                    <th scope="col" className="pb-2 pl-3 text-right font-medium">Chance × loss (KES)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {bands.map((band) => (
                    <tr key={band.id}>
                      <th scope="row" className="tabular py-2 pr-3 text-left font-medium whitespace-nowrap text-ink">{band.label}</th>
                      <td className={td}>{fmtPct(band.chance, 2)}</td>
                      <td className={td}>{fmtKes(band.lossKes, 2)}</td>
                      <td className={td}>{fmtKes(band.partKes, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {focus.several && (
            <p className="mt-3 text-xs leading-relaxed text-muted">
              These are this building&apos;s own figures. The key figures at the top of the page add all {fmtInt(focus.price.pricedCount)} priced buildings: gross average annual loss {kes1(focus.price.total.aalGrossKes)}.
            </p>
          )}
        </Card>

        <ChartFrame
          title={waterfallTitle}
          subtitle={`Read from left to right. A solid bar is a loss measured from zero; a striped bar is what the deductible or the limit takes off the bar before it. A flood this size or larger has about a ${annualChance(row.returnPeriod).replace(" a year", "")} chance in any year.`}
          sources={chartSources}
          aside={rpPicker}
        >
          {row.groundUpKes > 0 ? (
            <Waterfall title={waterfallTitle} yLabel={`Loss in a ${rpLabel(row.returnPeriod)} flood, KES`} steps={steps} totalLabel="Loss at this stage" decreaseLabel="Taken off by the deductible or the limit" />
          ) : (
            <p className="rounded-xl bg-surface-2 px-3.5 py-6 text-sm leading-relaxed text-ink-2">
              No water reaches the building in a {rpLabel(row.returnPeriod)} flood, so the ground-up and gross losses are both KES 0 and there is nothing to draw.
              {b.firstWetReturnPeriod !== null && ` The first flood that reaches it is the ${rpLabel(b.firstWetReturnPeriod)}.`}
            </p>
          )}
        </ChartFrame>
      </div>

      <Card title="The terms used, and where reinsurance comes in">
        <dl className="grid gap-3 @4xl:grid-cols-2">
          {[
            { name: "Deductible", term: focus.terms.deductible, source: deductibleSource },
            { name: "Limit", term: focus.terms.limit, source: limitSource },
          ].map(({ name, term, source }) => (
            <div key={name} className="min-w-0 rounded-xl bg-surface-2 px-3.5 py-3">
              <dt className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                {name}
                <SourceTag source={source} />
              </dt>
              <dd className="mt-1 wrap-anywhere text-sm text-ink">
                {term.text}
                {term.quotes.map((quote) => (
                  <q key={quote} className="mt-1 block text-xs leading-relaxed text-muted">{quote}</q>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-2">
          {exampleTerms
            ? "Where the document states no term, the example terms in the panel below stand in, and changing them changes the gross loss above."
            : "Both terms come from the offer, so the example terms in the panel below do not touch this building; they still apply to the portfolio around it."}
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-sm font-medium text-ink-2 hover:text-ink">Insurance terms panel: the example policy terms and the reinsurance</summary>
          <TermsPanel terms={terms} onChange={onTermsChange} className="mt-3" />
        </details>

        <p className="mt-4 max-w-3xl border-t border-line pt-4 text-sm leading-relaxed text-ink-2">
          Reinsurance, the quota share and the excess of loss, is bought on the whole portfolio and not on one offer, so no net loss is worked out for this building.{" "}
          {g && g.without100Kes !== null && g.with100Kes !== null ? (
            <>
              With the offer in it, the portfolio&apos;s 1-in-100 gross loss goes from {kes1(g.without100Kes)} to {kes1(g.with100Kes)}
              {g.change100Share !== null ? ` (${pct1(g.change100Share)} more)` : ""}. What it does to the net loss is not worked out here; the portfolio&apos;s own net figures are in the{" "}
              <button type="button" onClick={onShowPortfolio} className="font-medium text-ink underline underline-offset-2 hover:text-brand">Portfolio view</button> of this step, and what the change means for the decision is in <StepLink id="results" onOpenStep={onOpenStep} />.
            </>
          ) : (
            <>
              What the offer adds to the portfolio is in <StepLink id="results" onOpenStep={onOpenStep} />.
            </>
          )}{" "}
          The checks on this arithmetic are listed in <StepLink id="audit" onOpenStep={onOpenStep} />.
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Portfolio: every building through the engine, then the insurance terms
// ---------------------------------------------------------------------------------------------

function PortfolioEngine({ session, active, checks, terms, onTermsChange }: Pick<Props, "session" | "active" | "checks" | "terms" | "onTermsChange">) {
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
    <>
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
    </>
  );
}
