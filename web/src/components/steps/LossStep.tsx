"use client";

import { motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import type { Check } from "@/lib/checks";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { annualChance, kes1, LOSS_MODE_LABELS, pct1, PORTFOLIO_DRIVERS_LINE, rpLabel, rpWithChance, selectMode, shareText } from "@/lib/labels";
import type { InsuranceTerms, TermsResult } from "@/lib/model/terms";
import { HOUSING_LABELS } from "@/lib/model/types";
import { DRIVER_IDS, driverName, type DriverId, type DriverSource } from "@/lib/offer/drivers";
import { PORTFOLIO_KEYS, settersOf, settersText, type FocusJudgement, type FocusTerm, type OfferFocus, type PricedFocus } from "@/lib/offer/focus";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, stepKicker, type StepId } from "@/lib/steps";
import { ChartFrame, SourceLine, type ChartSource } from "../charts/ChartFrame";
import { DriverSwatch, PORTFOLIO_SERIES, StackSwatch } from "../charts/StackedBars";
import { Waterfall, type WaterfallStep } from "../charts/Waterfall";
import { DriverSources, insuredValueSource, offerKindOf } from "../DriverSources";
import { TermsPanel } from "../TermsPanel";
import { Card, CheckList, ChecksSummary, Fold, Note, OfferNotice, Segmented, selectView, StepHeader, StepLink, Tag } from "../ui";

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
  /** The judgement figures in force and who set each, for the portfolio as well as the offer. */
  judgement?: FocusJudgement | null;
  /** Opens another step of the walkthrough. */
  onOpenStep?: (id: StepId) => void;
}

/** The step follows the View switch, one story at a time: the offer's building with a priced offer in Offer view, otherwise the portfolio. */
export function LossStep({ session, active, checks, terms, onTermsChange, focus = null, offerFocus = null, judgement = null, onOpenStep }: Props) {
  return focus ? (
    <OfferStory focus={focus} terms={terms} onTermsChange={onTermsChange} onOpenStep={onOpenStep} />
  ) : (
    <PortfolioEngine session={session} active={active} checks={checks} terms={terms} onTermsChange={onTermsChange} offerFocus={offerFocus} judgement={judgement} onOpenStep={onOpenStep} />
  );
}

/** The chance of a flood in any one year, as it reads inside a sentence: "1%". */
const chanceOf = (returnPeriod: number) => annualChance(returnPeriod).replace(" a year", "");

/** The flood a view opens on: the one nearest 1-in-100, or the rarest when that one causes no loss. Rows are most frequent first. */
function openingFlood<T extends { returnPeriod: number }>(rows: T[], loss: (row: T) => number): T | undefined {
  const nearest = rows.reduce<T | undefined>((best, r) => (!best || Math.abs(Math.log(r.returnPeriod / 100)) < Math.abs(Math.log(best.returnPeriod / 100)) ? r : best), undefined);
  return nearest && loss(nearest) > 0 ? nearest : rows[rows.length - 1];
}

/** One step of the story: a plain title, one short sentence and the figure it arrives at. The last step is the strongest thing on the page. */
function StoryStep({ n, title, text, value, final = false, off = false, children }: { n: number; title: string; text: ReactNode; value: string; final?: boolean; off?: boolean; children?: ReactNode }) {
  return (
    <li className={`rounded-xl px-4 py-3.5 ${final ? "bg-ink text-surface" : "bg-surface-2"}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-64 wrap-anywhere">
          <div className={`flex items-baseline gap-2 text-base font-semibold ${final ? "" : "text-ink"}`}>
            <span className={`tabular text-sm font-normal ${final ? "opacity-70" : "text-muted"}`}>{n}.</span>
            {title}
          </div>
          <p className={`mt-0.5 text-sm leading-relaxed ${final ? "opacity-80" : "text-ink-2"}`}>{text}</p>
        </div>
        <span className={`tabular ml-auto font-semibold whitespace-nowrap ${final ? "text-4xl" : "text-2xl"} ${off ? "text-muted" : ""}`}>{value}</span>
      </div>
      {children}
    </li>
  );
}

const termSource = (term: FocusTerm): DriverSource =>
  term.source === "from the document"
    ? { kind: "offer", what: term.mixed ? "From the document, part typed" : "From the document", quote: term.quotes.join(" ") }
    : term.source === "typed by you"
      ? { kind: "offer", what: "Typed over the document", quote: "" }
      : { kind: "assumption", what: "Example terms: the document states none", keys: [] };

/** A depth in metres. A film of water too thin for two decimals is not written as zero. */
const metres = (m: number) => (m > 0 && m < 0.005 ? "under 0.01 m" : `${fmtNum(m)} m`);

// ---------------------------------------------------------------------------------------------
// This offer: one flood told in five steps, from the water at the building to what the insurer pays
// ---------------------------------------------------------------------------------------------

interface Stage {
  key: string;
  /** The driver this line is, when it is one of the six. */
  driver?: DriverId;
  label: string;
  value: string;
  how: ReactNode;
  sources: DriverSource[];
  /** A driver that takes no part in this price. */
  off?: boolean;
  /** "sum" for the two totals that close a part of the stack; "gross" for the last line. */
  weight?: "sum" | "gross";
}

function OfferStory({ focus, terms, onTermsChange, onOpenStep }: { focus: PricedFocus; terms: TermsResult; onTermsChange: (t: InsuranceTerms) => void; onOpenStep?: (id: StepId) => void }) {
  const d = focus.drivers;
  const all = d.mode === "all_drivers";
  const b = focus.price.building;
  const rows = d.perReturnPeriod;
  const judgement = focus.judgement;
  const offerKind = offerKindOf(focus);
  const isScore = focus.hazardKind === "score";
  const usingAi = focus.assumptionsInForce === "ai";
  // The arithmetic is written out with the building's own values when the offer is one building; with several the losses are their sum.
  const single = d.buildings === 1;

  // With Depth only the first two lines are the whole model; the other four are switched off together.
  const shown: DriverId[] = all ? [...DRIVER_IDS] : ["surrounding", "ponding"];
  const lineOf = (id: DriverId) => d.lines.find((l) => l.id === id);
  // A driver's name is the one its line carries: with Depth only the first line is the depth at the point.
  const nameOf = (id: DriverId) => lineOf(id)?.label ?? driverName(id, d.mode);
  const component = (id: "structure" | "below_ground" | "interruption") => d.components.find((c) => c.id === id);

  // The flood the story is told for.
  const [chosen, setChosen] = useState<string | null>(null);
  const row = rows.find((r) => r.id === chosen) ?? openingFlood(rows, (r) => r.groundUpTotalKes);

  if (!row) {
    return (
      <div>
        <StepHeader kicker={stepKicker("loss")} title={STEP_NAMES.loss}>No flood scenario is loaded, so there is nothing to follow.</StepHeader>
      </div>
    );
  }

  const site = focus.building;
  const insuredValue = insuredValueSource(focus);
  const deductibleSource = termSource(focus.terms.deductible);
  const limitSource = termSource(focus.terms.limit);
  const exampleTerms = focus.terms.deductible.source === "example terms" || focus.terms.limit.source === "example terms";

  const structure = component("structure");
  const below = component("below_ground");
  const interruption = component("interruption");
  const trace = b.perReturnPeriod.find((r) => r.id === row.id);
  const depths = row.depths;
  const design = rpLabel(d.drainDesign.returnPeriod);
  const event = rpLabel(row.returnPeriod);
  const kes = (v: number) => fmtKes(v, 2);

  // The value below ground loses the larger of the basement ladder's ratio and the structure's damage ratio, so the line says which gave the ratio applied.
  const { basementTakesWater, basementDamageRatio, basementAppliedRatio } = row.building;
  const ingress = `Water at the site, ${metres(depths.surfaceM)}, ${basementTakesWater ? "reaches" : "is below"} the ${metres(d.judgement.ingressThresholdM)} ingress threshold`;
  const belowValue = single && below ? `value below ground ${kes(below.valueKes)} × ` : "";
  const ladderGave = basementTakesWater && basementDamageRatio >= row.building.damageRatio;
  const otherRatio = ladderGave
    ? `the structure's damage ratio is ${shareText(row.building.damageRatio)}`
    : basementTakesWater
      ? `the basement ladder gives ${shareText(basementDamageRatio)}`
      : "below the threshold the basement ladder gives nothing";
  const basementHow = !(basementAppliedRatio > 0)
    ? `${ingress} and the structure takes no damage at that depth: no loss below ground.`
    : `${ingress}${basementTakesWater ? ", so the basement takes water" : ""}: ${belowValue}${shareText(basementAppliedRatio)}, from ${ladderGave ? "the basement ladder" : "the structure's damage ratio"} (${otherRatio}; the larger of the two is used).`;

  const driverHow: Record<DriverId, ReactNode> = {
    surrounding: all
      ? `At the point, ${metres(depths.pointM)} of water: ${kes(row.pointKes)}. Within the ${fmtInt(d.bufferRadiusM)} m buffer, ${metres(depths.bufferM)}: adds ${kes(row.bufferAddedKes)}.`
      : `${metres(depths.pointM)} of water on the map at the building's point: ${kes(row.pointKes)}.`,
    ponding: `Ponding at the site, ${metres(depths.pondingM)}: adds ${kes(row.groundUpKes.ponding)} beyond the map depth.`,
    overload: depths.overloaded
      ? `The ${event} flood is rarer than the ${design} event the drains were designed for, so the site has at least ${metres(depths.overloadM)} of water: adds ${kes(row.groundUpKes.overload)} beyond the lines above.`
      : `The ${event} flood is not rarer than the ${design} event the drains were designed for: the drains cope.`,
    basement: basementHow,
    interruption:
      row.groundUpKes.interruption > 0
        ? `${fmtNum(row.building.outageDays, 1)} outage days × a day's rent or revenue${single && interruption?.dailyKes ? ` of ${kes(interruption.dailyKes)}` : ""}.`
        : "No water reaches the site in this flood, so there is no outage.",
    uncertainty: `${shareText(d.judgement.uncertaintyLoading)} × ${kes(row.modelledKes)}, the five lines above added up. Kept apart from them: it stands for causes not modelled.`,
  };

  // The story: which reading gave the water, and what each part of the building loses, in a few words.
  const waterFrom: Record<typeof row.surfaceFrom, string> = {
    point: "Read on the flood map at the building's own point.",
    buffer: `The deepest water in the streets around it, within ${fmtInt(d.bufferRadiusM)} m.`,
    ponding: "Water ponding near drains at the site.",
    overload: "A flood this rare overloads the drains, so shallow water stands at the site.",
    dry: "No water reaches the building in this flood.",
  };
  const depthOnlyOff = `Off: ${LOSS_MODE_LABELS.depth_only} is selected`;
  const parts: { key: string; label: string; text: string; kes: number; off: boolean }[] = [
    {
      key: "structure",
      label: "The building itself",
      text: single ? `${shareText(row.building.damageRatio)} of its value${below?.on ? " above ground" : ""} is lost at that depth` : "each building's damage at its own depth, added up",
      kes: row.structureKes,
      off: false,
    },
    {
      key: "below",
      label: "What is below ground",
      text: below?.on
        ? basementTakesWater
          ? `the basement takes water: ${shareText(basementAppliedRatio)} of the plant and contents kept there`
          : basementAppliedRatio > 0
            ? `plant and contents kept there lose ${shareText(basementAppliedRatio)}, as the building does`
            : "no loss in this flood"
        : !all
          ? depthOnlyOff
          : d.basement.present === false
            ? "Off: the offer says there is no basement"
            : "Off: the offer does not say there is a basement",
      kes: row.groundUpKes.basement,
      off: !below?.on,
    },
    {
      key: "rent",
      label: "Lost rent",
      text: interruption?.on
        ? row.groundUpKes.interruption > 0
          ? `${fmtNum(row.building.outageDays, 1)} days out of use`
          : "no water at the site, so no days lost"
        : !all
          ? depthOnlyOff
          : d.interruptionCover === "excluded"
            ? "Off: the offer does not cover it"
            : "Off: the offer does not say it is covered",
      kes: row.groundUpKes.interruption,
      off: !interruption?.on,
    },
  ];
  const uncertaintyOn = lineOf("uncertainty")?.on ?? false;
  const noDamage = !(row.groundUpTotalKes > 0);
  const subject = single ? `${site.name} takes` : `the offer's ${fmtInt(d.buildings)} priced buildings take`;

  const stages: Stage[] = [
    {
      key: "water",
      label: "Water at the site",
      value: metres(depths.surfaceM),
      how: (
        <>
          {all
            ? `At the point ${metres(depths.pointM)}, within the buffer ${metres(depths.bufferM)}, drainage ponding ${metres(depths.pondingM)}, drain overload ${metres(depths.overloadM)}: the deepest is used.`
            : `At the point ${metres(depths.pointM)}, drainage ponding ${metres(depths.pondingM)}: the deeper is used.`}{" "}
          How each depth is read is in <StepLink to="hazard" onOpenStep={onOpenStep} />.
        </>
      ),
      sources: [],
    },
    {
      key: "structure",
      label: "The structure's loss at that depth",
      value: kes(row.structureKes),
      how: (
        <>
          {single && trace && structure
            ? `${metres(trace.depthM)} × fragility ${fmtNum(b.fragility)} = ${metres(trace.effectiveDepthM)} on the curve for ${HOUSING_LABELS[b.housingClass]}: damage ratio ${fmtPct(row.building.damageRatio, 1)}${row.building.capped ? ", the cap for the class," : ""} × structure value ${kes(structure.valueKes)}.`
            : "Each building's damage ratio at its deepest water × its structure value, added up."}{" "}
          Read once on the curve; the {all ? "three" : "two"} lines below share it out, so no water is counted twice. The curve is in <StepLink to="vulnerability" onOpenStep={onOpenStep} />.
        </>
      ),
      sources: structure ? [insuredValue, ...(structure.valueSource.kind === "data" ? [] : [structure.valueSource]), structure.damageSource] : [insuredValue],
    },
    ...shown.map((id): Stage => {
      const line = lineOf(id);
      const on = line?.on ?? false;
      return {
        key: id,
        driver: id,
        label: nameOf(id),
        value: on ? kes(row.groundUpKes[id]) : "Not priced",
        how: on ? driverHow[id] : (line?.text ?? ""),
        // An off driver names only what the document says about it; its on-off reason is the sentence itself.
        sources: on ? (line?.sources ?? []) : (line?.sources ?? []).filter((s) => s.kind === "offer"),
        off: !on,
      };
    }),
    {
      key: "ground-up",
      label: "Ground-up loss",
      value: kes(row.groundUpTotalKes),
      how: all ? "The six drivers added up, before any policy terms." : "The lines above added up, before any policy terms.",
      sources: [],
      weight: "sum",
    },
    { key: "deductible", label: "Deductible taken", value: kes(row.deductibleKes), how: focus.terms.deductible.text, sources: [deductibleSource] },
    { key: "limit", label: "Amount over the limit", value: kes(row.overLimitKes), how: focus.terms.limit.text, sources: [limitSource] },
    {
      key: "gross",
      label: "Gross loss",
      value: kes(row.grossKes),
      how: `${kes(row.groundUpTotalKes)} less ${kes(row.deductibleKes)} less ${kes(row.overLimitKes)}`,
      sources: [],
      weight: "gross",
    },
  ];

  const agentsSetSome = Object.values(judgement.setBy).includes("agents");
  const tableSources: ChartSource[] = [
    { kind: offerKind, text: offerKind === "ai" ? "Insured value and stated facts read from the offer document by the AI reader and checked by code" : "Insured value and stated facts read from the offer document by the fixed rules" },
    { kind: "real", text: isScore ? "Hazard maps and the JRC depth-damage curve" : "Flood depth maps and the JRC depth-damage curve" },
    { kind: usingAi ? "ai" : "assumption", text: isScore ? "Return periods, depth scale, fragility and damage cap" : "Fragility and damage cap" },
    ...(all ? [{ kind: "assumption" as const, text: `The figures behind the drivers beyond depth: each is listed with its value, range and who set it in ${STEP_NAMES.audit}` }] : []),
    ...(all && agentsSetSome ? [{ kind: "ai" as const, text: "Some of those figures were agreed by the agents" }] : []),
    ...(focus.drainageOn ? [{ kind: "assumption" as const, text: "Drainage ponding depths" }] : []),
    ...(exampleTerms ? [{ kind: "assumption" as const, text: "Example terms where the document states none" }] : []),
  ];
  const rpPicker = rows.length > 1 ? <Segmented label="Return period" value={row.id} onChange={setChosen} options={rows.map((r) => ({ value: r.id, label: rpLabel(r.returnPeriod) }))} /> : undefined;
  const g = focus.price.portfolio.gross;

  const th = "pb-2 pl-3 text-right align-bottom font-medium";
  const td = "tabular py-2.5 pl-3 text-right text-ink-2";

  return (
    <div>
      <StepHeader kicker={stepKicker("loss")} title={STEP_NAMES.loss}>
        {noDamage
          ? `In a ${rpLabel(row.returnPeriod)} flood, one with a ${chanceOf(row.returnPeriod)} chance in any year, ${subject} no damage, so the insurer pays nothing.`
          : `In a ${rpLabel(row.returnPeriod)} flood, one with a ${chanceOf(row.returnPeriod)} chance in any year, ${subject} ${kes1(row.groundUpTotalKes)} of damage and the insurer pays ${kes1(row.grossKes)}. Five steps show how.`}
      </StepHeader>

      <div className="grid gap-4">
        {b.dryAtEveryReturnPeriod ? (
          <Note>
            No water reaches the site in any flood modelled, so every loss on this page is KES 0. How close the water comes is in <StepLink to="hazard" onOpenStep={onOpenStep} />.
          </Note>
        ) : (
          b.dryAtPointEveryReturnPeriod && (
            <Note>
              The flood maps and the ponding are dry at the building&apos;s own point in every flood, so {LOSS_MODE_LABELS.depth_only} would price this offer at zero. Every loss below comes from the other loss drivers.
            </Note>
          )
        )}

        <Card title={`One flood, step by step: ${rpWithChance(row.returnPeriod)}`} aside={rpPicker}>
          {!all && (
            <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
              <strong className="font-semibold text-ink">{LOSS_MODE_LABELS.depth_only} is selected:</strong> only the water at the building&apos;s own point{focus.drainageOn ? " and ponding near drains" : ""} counts, and the streets around it are not read. {selectMode("all_drivers")} to price the parts shown as off.
            </p>
          )}
          <ol key={row.id} className="grid gap-2">
            <StoryStep n={1} title="How much water reaches the building" text={waterFrom[row.surfaceFrom]} value={metres(depths.surfaceM)} />
            <StoryStep n={2} title="What the water damages" text="Up to three things, each counted once." value={kes1(row.modelledKes)}>
              <dl className="mt-3 grid gap-1.5 border-t border-line pt-3">
                {parts.map((part) => (
                  <div key={part.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
                    <dt className="min-w-0 wrap-anywhere text-ink-2">
                      <span className="font-medium text-ink">{part.label}:</span> {part.text}
                    </dt>
                    <dd className={`tabular ml-auto font-semibold whitespace-nowrap ${part.off ? "text-muted" : "text-ink"}`}>{part.off ? "Off" : kes1(part.kes)}</dd>
                  </div>
                ))}
              </dl>
            </StoryStep>
            <StoryStep
              n={3}
              title="What the model cannot see"
              text={uncertaintyOn ? `An extra ${shareText(d.judgement.uncertaintyLoading)} for causes the model leaves out, such as seepage, blocked drains and pump failure.` : `${depthOnlyOff}.`}
              value={uncertaintyOn ? kes1(row.groundUpKes.uncertainty) : "Off"}
              off={!uncertaintyOn}
            />
            <StoryStep n={4} title="The damage in full" text="Steps 2 and 3 added up. Called the ground-up loss: the damage before any insurance terms." value={kes1(row.groundUpTotalKes)} />
            <StoryStep
              n={5}
              title="What the insurer pays"
              text={
                noDamage
                  ? "No damage in this flood, so nothing to pay."
                  : `Less the ${kes1(row.deductibleKes)} deductible, the part the policyholder keeps, ${row.overLimitKes > 0 ? `and less ${kes1(row.overLimitKes)} above the limit` : "and within the limit"}, the most the policy pays. Called the gross loss.`
              }
              value={kes1(row.grossKes)}
              final
            />
          </ol>
          {focus.several && (
            <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted">
              {focus.severalLine} {!single && (d.depthsFor ?? `The amounts add all ${fmtInt(d.buildings)} priced buildings.`)}
            </p>
          )}
          <SourceLine sources={tableSources} className="mt-4 border-t border-line pt-3" />
        </Card>

        <Card>
          <div className="space-y-2">
            <Fold summary="Show the working: each line's arithmetic and where its figures come from">
              <ol className="grid gap-2">
                {stages.map((stage, i) => (
                  <li
                    key={stage.key}
                    className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 rounded-xl px-3.5 py-2.5 ${stage.weight === "gross" ? "border border-ink bg-surface" : stage.weight === "sum" ? "border border-axis bg-surface" : "bg-surface-2"}`}
                  >
                    <div className="min-w-0 flex-1 basis-64 wrap-anywhere">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink">
                        <span className="tabular text-xs font-normal text-muted">{i + 1}.</span>
                        {stage.driver && <DriverSwatch id={stage.driver} />}
                        {stage.label}
                        {stage.off && <span className="text-xs font-normal text-muted">off</span>}
                      </div>
                      <div className="mt-0.5 text-sm leading-relaxed text-ink-2">{stage.how}</div>
                      <DriverSources sources={stage.sources} judgement={judgement} offerKind={offerKind} onOpenStep={onOpenStep} className="mt-2" />
                    </div>
                    <span className={`tabular ml-auto text-base font-semibold whitespace-nowrap ${stage.off ? "text-muted" : "text-ink"}`}>{stage.value}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted">
                {focus.several && "A deductible or limit stated in the document applies once per flood to the whole offer. "}
                The checks on this arithmetic are listed in <StepLink to="audit" onOpenStep={onOpenStep} />.
              </p>
            </Fold>

            <Fold summary="Every modelled flood, as a table" className="border-t border-line pt-2">
              <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
                One row per flood, most frequent first. The driver columns add up to the ground-up loss; the deductible and anything over the limit come off it to give the gross loss. Choose a flood to follow it in the steps above.
              </p>
              <div className="overflow-x-auto">
                <table className={`w-full text-sm ${all ? "min-w-360" : "min-w-232"}`}>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th scope="col" className="pb-2 text-left align-bottom font-medium">Return period (chance in any year)</th>
                      <th scope="col" className={th}>Depth at the point (m)</th>
                      {all && <th scope="col" className={th}>Depth within the buffer (m)</th>}
                      <th scope="col" className={th}>Water at the site (m)</th>
                      {shown.map((id) => (
                        <th key={id} scope="col" className={th}>
                          <span className="inline-flex items-center justify-end gap-1.5"><DriverSwatch id={id} />{nameOf(id)} (KES)</span>
                        </th>
                      ))}
                      <th scope="col" className={th}>Ground-up loss (KES)</th>
                      <th scope="col" className={th}>Deductible taken (KES)</th>
                      <th scope="col" className={th}>Over the limit (KES)</th>
                      <th scope="col" className={th}>Gross loss (KES)</th>
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
                            {on && <span className="ml-2 text-xs font-normal text-muted">shown above</span>}
                          </th>
                          <td className={td}>{fmtNum(r.depths.pointM)}</td>
                          {all && <td className={td}>{fmtNum(r.depths.bufferM)}</td>}
                          <td className={td}>{fmtNum(r.depths.surfaceM)}</td>
                          {shown.map((id) => <td key={id} className={td}>{lineOf(id)?.on ? kes(r.groundUpKes[id]) : "off"}</td>)}
                          <td className="tabular py-2.5 pl-3 text-right font-medium text-ink">{kes(r.groundUpTotalKes)}</td>
                          <td className={td}>{kes(r.deductibleKes)}</td>
                          <td className={td}>{kes(r.overLimitKes)}</td>
                          <td className="tabular py-2.5 pr-2 pl-3 text-right font-semibold text-ink">{kes(r.grossKes)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Fold>

            <Fold summary="The policy terms used" className="border-t border-line pt-2">
              <dl className="grid gap-3 @4xl:grid-cols-2">
                {[
                  { name: "Deductible", term: focus.terms.deductible, source: deductibleSource },
                  { name: "Limit", term: focus.terms.limit, source: limitSource },
                ].map(({ name, term, source }) => (
                  <div key={name} className="min-w-0 rounded-xl bg-surface-2 px-3.5 py-3">
                    <dt className="text-xs text-muted">{name}</dt>
                    <dd className="mt-1 wrap-anywhere text-sm text-ink">
                      {term.text}
                      <DriverSources sources={[source]} offerKind={offerKind} onOpenStep={onOpenStep} className="mt-2" />
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="my-4 max-w-3xl text-sm leading-relaxed text-ink-2">
                Both act on the damage in full.{" "}
                {exampleTerms
                  ? "Where the document states no term, the example terms in the panel below stand in, and changing them changes what the insurer pays above."
                  : "Both terms come from the offer, so the example terms in the panel below do not touch this building; they still apply to the portfolio around it."}
              </p>
              <TermsPanel terms={terms} onChange={onTermsChange} />
              <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-2">
                Reinsurance, the quota share and the excess of loss, is bought on the whole portfolio and not on one offer, so no net loss is worked out for this building.
                {g && g.without100Kes !== null && g.with100Kes !== null && (
                  <>
                    {" "}With the offer in it, the portfolio&apos;s 1-in-100 gross loss goes from {kes1(g.without100Kes)} to {kes1(g.with100Kes)}
                    {g.change100Share !== null ? ` (${pct1(g.change100Share)} more)` : ""}. {selectView("Portfolio")} for the portfolio&apos;s own net figures.
                  </>
                )}
              </p>
            </Fold>
          </div>
        </Card>

        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
          The price built on these losses is in <StepLink to="results" onOpenStep={onOpenStep} />.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Portfolio: the loss split by driver
// ---------------------------------------------------------------------------------------------

/** The portfolio's ground-up loss per return period, split into what each of drivers 1 to 3 adds. */
function PortfolioDrivers({ session, active, judgement }: Pick<Props, "session" | "active" | "judgement">) {
  const r = active.result;
  const j = r.judgement;
  const split = r.scenarios.flatMap((s) => (s.byDriver ? [{ ...s, byDriver: s.byDriver }] : []));

  if (r.mode !== "all_drivers" || !j || split.length !== r.scenarios.length) {
    return (
      <Note>
        <strong className="font-semibold text-ink">{LOSS_MODE_LABELS.depth_only} is selected.</strong> Each building&apos;s loss comes from the depth at its point{session.dataset.drainage ? " and drainage ponding" : ""} alone. {selectMode("all_drivers")} to add the water around each building and drain overload.
      </Note>
    );
  }

  const setters = settersOf(judgement, PORTFOLIO_KEYS);
  const sources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
    { kind: "real", text: "Hazard maps and the JRC depth-damage curve" },
    {
      kind: "assumption",
      text: `Buffer of ${fmtInt(j.bufferRadiusM)} m around each building; drains taken as designed for a ${rpLabel(j.drainDesignRp)} event; ${metres(j.drainOverloadDepthM)} of water when they are overloaded${setters.length > 0 ? ` (${settersText(judgement, PORTFOLIO_KEYS)})` : ""}`,
    },
    ...(setters.includes("agents") ? [{ kind: "ai" as const, text: "Buffer radius agreed by the agents" }] : []),
    ...(session.dataset.drainage ? [{ kind: "assumption" as const, text: "Drainage ponding depths" }] : []),
  ];

  return (
    <Card title="Where the damage comes from, flood by flood">
      <p className="-mt-2 mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
        One row per modelled flood, most frequent first. Each building&apos;s damage is read once, at the deepest water at it; the columns say which source of water gave it, and add up to the ground-up loss.
      </p>
      {/* With the room, the sentence on which drivers the portfolio carries sits beside the table and not under it. */}
      <div className="grid gap-x-8 gap-y-3 @6xl:grid-cols-[minmax(0,2.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-176 text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="pb-2 text-left align-bottom font-medium">Return period (chance in any year)</th>
                {PORTFOLIO_SERIES.map((p) => (
                  <th key={p.id} scope="col" className="pb-2 pl-3 text-right align-bottom font-medium">
                    <span className="inline-flex items-center justify-end gap-1.5"><StackSwatch color={p.color} fill={p.fill} />{p.column} (KES)</span>
                  </th>
                ))}
                <th scope="col" className="pb-2 pl-3 text-right align-bottom font-medium">Ground-up loss (KES)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {split.map((s) => (
                <tr key={s.id}>
                  <th scope="row" className="tabular py-2.5 pr-3 text-left font-medium whitespace-nowrap text-ink">{rpWithChance(s.returnPeriod)}</th>
                  {PORTFOLIO_SERIES.map((p) => <td key={p.id} className="tabular py-2.5 pl-3 text-right text-ink-2">{kes1(s.byDriver[p.key])}</td>)}
                  <td className="tabular py-2.5 pl-3 text-right font-semibold text-ink">{kes1(s.lossKes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">{PORTFOLIO_DRIVERS_LINE}</p>
      </div>
      <SourceLine sources={sources} className="mt-4 border-t border-line pt-3" />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Portfolio: one flood from the damage in full to what the insurer keeps, then the detail folded
// ---------------------------------------------------------------------------------------------

function PortfolioEngine({ session, active, checks, terms, onTermsChange, offerFocus, judgement, onOpenStep }: Pick<Props, "session" | "active" | "checks" | "terms" | "onTermsChange" | "offerFocus" | "judgement" | "onOpenStep">) {
  const { dataset } = session;
  const r = active.result;
  const isScore = dataset.hazardKind === "score";
  const maxLoss = Math.max(...r.scenarios.map((s) => s.lossKes), 1);

  // How the terms act, event by event. The flood chosen here is the one every part of the page follows.
  const layers = terms.scenarios;
  const anyOverLimit = layers.some((row) => row.overLimitKes > 0);
  const [event, setEvent] = useState<string | null>(null);
  const layer = layers.find((row) => row.id === event) ?? openingFlood(layers, (row) => row.groundUpKes);
  const last = r.scenarios.length - 1;
  const found = r.scenarios.findIndex((sc) => sc.id === layer?.id);
  const k = found >= 0 ? found : last;

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
  const allDrivers = r.mode === "all_drivers";
  const groundUpSources: ChartSource[] = [
    { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
    { kind: "real", text: isScore ? "Hazard maps (the hazard score read from them is a derived proxy, not a measured depth) and the JRC depth-damage curve" : "Flood depth maps and the JRC depth-damage curve" },
    { kind: "assumption", text: isScore ? "Return periods of the hazard tiers, depth scale, fragility and damage caps" : "Fragility and damage caps" },
    ...(dataset.drainage ? [{ kind: "assumption" as const, text: "Drainage ponding depths" }] : []),
    ...(allDrivers ? [{ kind: "assumption" as const, text: "With All loss drivers: the buffer around each building, the drain design return period and the depth of water when drains are overloaded" }] : []),
    ...(usingAi ? [{ kind: "ai" as const, text: "Hazard and damage assumptions agreed by the agents" }] : []),
  ];
  const termsSource: ChartSource = { kind: "assumption", text: "Insurance terms: example terms, not from any real policy or treaty" };
  const fold = "border-t border-line pt-2";

  return (
    <div>
      <StepHeader kicker={stepKicker("loss")} title={STEP_NAMES.loss}>
        {layer
          ? `In a ${rpLabel(layer.returnPeriod)} flood, one with a ${chanceOf(layer.returnPeriod)} chance in any year, the portfolio's buildings take ${kes1(layer.groundUpKes)} of damage. The insurer pays ${kes1(layer.grossKes)} of it and, after reinsurance, keeps ${kes1(layer.netKes)}.`
          : "No flood scenario is loaded, so there is no loss to show."}
      </StepHeader>
      <OfferNotice offerFocus={offerFocus} what="its building followed through this step, flood by flood" onOpenStep={onOpenStep} />

      <div className="grid gap-4">
        {layer && (
          <Card
            title={`One flood, step by step: ${rpWithChance(layer.returnPeriod)}`}
            aside={layers.length > 1 ? <Segmented label="Return period" value={layer.id} onChange={setEvent} options={layers.map((row) => ({ value: row.id, label: rpLabel(row.returnPeriod) }))} /> : undefined}
          >
            <ol key={layer.id} className="grid gap-2">
              <StoryStep
                n={1}
                title="The damage in full"
                text={`${s ? `${fmtInt(s.affected)} insured buildings are affected. ` : ""}Called the ground-up loss: the damage before any insurance terms.`}
                value={kes1(layer.groundUpKes)}
              />
              <StoryStep
                n={2}
                title="What the insurer pays"
                text={`Less ${kes1(layer.deductiblesKes)} of deductibles, the part the policyholders keep${layer.overLimitKes > 0 ? `, and ${kes1(layer.overLimitKes)} above the policy limits` : ""}. Called the gross loss.`}
                value={kes1(layer.grossKes)}
              />
              <StoryStep
                n={3}
                title="What the insurer keeps"
                text={`Reinsurance pays back ${kes1(layer.quotaShareKes)} under the quota share and ${kes1(layer.xolKes)} under the excess of loss. Called the net loss: what the insurer keeps after reinsurance.`}
                value={kes1(layer.netKes)}
                final
              />
            </ol>
            <SourceLine sources={[...groundUpSources, termsSource]} className="mt-4 border-t border-line pt-3" />
          </Card>
        )}

        <PortfolioDrivers session={session} active={active} judgement={judgement} />

        <Card>
          <div className="space-y-2">
            <Fold summary="Every modelled flood, as a table">
              <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
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

              <h4 className="mt-6 mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">Ground-up loss by scenario <Tag kind="synthetic">Synthetic portfolio</Tag></h4>
              <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
                The bar is the ground-up loss as a share of total insured value, drawn against the largest scenario.
                {allDrivers && r.judgement && ` With ${LOSS_MODE_LABELS.all_drivers} a building counts as affected once any driver puts water at it, so every building is affected in a flood rarer than the ${rpLabel(r.judgement.drainDesignRp)} event the drains are taken to be designed for.`}
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
            </Fold>

            {layer && (
              <Fold summary="The same steps as a chart" className={fold}>
                <ChartFrame
                  bare
                  title={waterfallTitle}
                  subtitle={`Read from left to right. A solid bar is a loss measured from zero; a striped bar is what a deductible or a reinsurer takes off the bar before it. A loss this size or larger has about a ${chanceOf(layer.returnPeriod)} chance in any year.`}
                  sources={[
                    { kind: "synthetic", text: "Portfolio of insured buildings and their insured values" },
                    termsSource,
                    { kind: isScore ? "assumption" : "real", text: isScore ? "Return periods attached to the hazard tiers" : "Return periods carried by the hazard maps" },
                  ]}
                >
                  <Waterfall
                    title={waterfallTitle}
                    yLabel={`Loss in a ${rpLabel(layer.returnPeriod)} event, KES`}
                    steps={steps}
                    totalLabel="Loss at this stage"
                    decreaseLabel="Taken off by a deductible or a reinsurer"
                  />
                </ChartFrame>
              </Fold>
            )}

            <Fold summary="Follow one building through the arithmetic" className={fold}>
              {ranked.length === 0 || !t ? (
                <p className="text-sm text-ink-2">No building takes a loss in this scenario.</p>
              ) : (
                <>
                  <p className="mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
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
                  <ol className="flex flex-col gap-2 @7xl:grid @7xl:auto-cols-[minmax(0,1fr)] @7xl:grid-flow-col @7xl:grid-cols-[minmax(0,1.35fr)]">
                    {[
                      { label: "The building", value: `${b.locId} · ${HOUSING_LABELS[b.housingClass]}`, how: `Insured value ${fmtKes(b.tivKes, 2)}, at ${fmtNum(b.lat, 4)}, ${fmtNum(b.lon, 4)}`, tag: "synthetic" as const },
                      { label: isScore ? "Hazard score" : "Flood depth", value: isScore ? fmtNum(t.hazard, 3) : `${fmtNum(t.hazard)} m`, how: `Read from the "${s.id}" map at the building's coordinates`, tag: (isScore ? "proxy" : "real") as "proxy" | "real" },
                      ...(isScore ? [{ label: t.drivers ? "Assumed depth at the point" : "Assumed depth", value: `${fmtNum(t.drivers ? t.drivers.pointM : t.depthM)} m`, how: !t.drivers && t.drainageM > 0 && t.drainageM >= t.depthM ? `Drainage ponding near a drain or in a settlement; the terrain gives ${fmtNum(t.hazard > 0 ? t.hazard * s.tierSlope * active.params.depthScaleM : 0)} m` : `${fmtNum(t.hazard, 3)} × tier slope ${fmtNum(s.tierSlope, 3)} × ${fmtNum(active.params.depthScaleM)} m`, tag: (usingAi ? "ai" : "assumption") as "ai" | "assumption" }] : []),
                      ...(t.drivers ? [{ label: "Deepest water at the site", value: `${fmtNum(t.drivers.surfaceM)} m`, how: `At the point ${fmtNum(t.drivers.pointM)} m, within the buffer ${fmtNum(t.drivers.bufferM)} m, drainage ponding ${fmtNum(t.drivers.pondingM)} m, drain overload ${fmtNum(t.drivers.overloadM)} m: the deepest is used`, tag: "assumption" as const }] : []),
                      { label: "Depth on the curve", value: `${fmtNum(t.effectiveDepthM)} m`, how: `${fmtNum(t.depthM)} m × fragility ${fmtNum(active.params.fragility[b.housingClass])}`, tag: (usingAi ? "ai" : "assumption") as "ai" | "assumption" },
                      { label: "Damage ratio", value: fmtPct(t.damageRatio, 1), how: t.capped ? `JRC curve gives ${fmtPct(t.curveDamage, 1)}, limited by the ${fmtPct(active.params.cap[b.housingClass], 0)} cap` : `JRC curve at ${fmtNum(t.effectiveDepthM)} m; under the ${fmtPct(active.params.cap[b.housingClass], 0)} cap`, tag: "real" as const },
                      { label: "Ground-up loss", value: fmtKes(t.lossKes, 2), how: `${fmtPct(t.damageRatio, 1)} × ${fmtKes(b.tivKes, 2)}`, tag: null },
                    ].map((row, i, all) => (
                      // The figure sits beside its explanation where both fit, and drops to its own line where they do not.
                      <li key={row.label} className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl px-3.5 py-2.5 @7xl:flex-col @7xl:flex-nowrap @7xl:items-start @7xl:justify-start @7xl:gap-y-3 @7xl:py-3.5 ${i === all.length - 1 ? "border border-ink bg-surface" : "bg-surface-2"}`}>
                        <div className="min-w-0">
                          <div className="text-xs text-muted">{row.label}</div>
                          <div className="text-sm text-ink-2">{row.how}</div>
                        </div>
                        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 text-right @7xl:mt-auto @7xl:ml-0 @7xl:justify-start @7xl:text-left">
                          {row.tag && <Tag kind={row.tag}>{row.label === "Damage ratio" ? "JRC curve" : undefined}</Tag>}
                          <span className="tabular text-base font-semibold text-ink">{row.value}</span>
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </Fold>

            <Fold summary="The insurance terms used" className={fold}>
              <TermsPanel terms={terms} onChange={onTermsChange} />
            </Fold>

            <Fold summary={<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">Checks on the arithmetic and the terms <ChecksSummary checks={checks} /></span>} className={fold}>
              {/* Full width, the list runs down two columns so the right half of the card is not left empty. */}
              <div className="@5xl:columns-2 @5xl:gap-10 @5xl:[&_li]:break-inside-avoid">
                <CheckList checks={checks} />
              </div>
            </Fold>
          </div>
        </Card>
      </div>
    </div>
  );
}
