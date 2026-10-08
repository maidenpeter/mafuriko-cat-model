import type { LossMode } from "../model/drivers";
import { flattenParams } from "../model/params";
import { runModel } from "../model/pipeline";
import { HOUSING_CLASSES, SCORE_TIERS, type Dataset, type HousingClass, type ModelParams, type ScoreTier } from "../model/types";
import { offerDrivers, type DriverBuilding } from "../offer/drivers";
import { PORTFOLIO_KEYS, type PricedFocus } from "../offer/focus";
import { JUDGEMENT_KEYS, type OfferJudgement } from "../offer/judgement";
import type { OfferExtraction, PolicyTerms, RowPricing } from "../offer/types";

/**
 * One evaluator for "the answer" under a set of assumptions, for two targets.
 *
 *   portfolio  runModel on the loaded data set: the ground-up 1-in-100 loss (standardLosses at 100
 *              years, as the figures row and the offer's portfolio comparison read it) and the
 *              ground-up average annual loss
 *   offer      offerDrivers on one priced offer, with the inputs the focus gives it: the offer's own
 *              ground-up 1-in-100 loss (loss100.groundUpKes) and ground-up average annual loss
 *              (aal.groundUpTotalKes)
 *
 * Both are pure and synchronous. Every answer is remembered by a key made of the assumption values
 * that can reach the answer under the target and the mode (liveKeys), so the tornado and the
 * Shapley attribution never run the model twice for the same figures, and asking again for the
 * same assumptions returns the same object. The memo lives on the target's data set (portfolio)
 * or its offer inputs (offer): keep that object stable between calls, with useMemo on a screen.
 *
 * The model is a transparent formula, so nothing here fits or samples anything: every figure is a
 * run of the same engine the rest of the app uses.
 */

/** The assumptions a run is made on: the model's parameters and the figures behind the loss drivers beyond depth. */
export interface Assumptions {
  params: ModelParams;
  judgement: OfferJudgement;
}

/** The answer under one set of assumptions. loss100Kes is null when a 1-in-100 flood is more frequent than anything modelled. */
export interface Answer {
  /** Ground-up loss in a 1-in-100 flood, in KES. */
  loss100Kes: number | null;
  /** Ground-up average annual loss, in KES. */
  aalKes: number;
}

/**
 * What the offer evaluator needs: the same inputs buildOfferFocus hands offerDrivers, less the
 * assumptions, which the evaluator supplies. offerTarget fills it from a priced focus.
 */
export interface OfferInputs {
  /** The data set the offer was priced on: the session's data set as handed to buildOfferFocus. Its buildings are not read. */
  dataset: Dataset;
  /** The building the focus follows: focus.building, with the engine's ponding per scenario from its priced row. */
  building: DriverBuilding;
  /** The offer's other priced buildings, in the order of the priced rows. */
  others?: DriverBuilding[];
  /** focus.extraction: what was read from the document, with the underwriter's confirmations and edits. */
  extraction: OfferExtraction;
  /** focus.terms.policy: the deductible and the limit in force. */
  terms: PolicyTerms;
  /** The whole offer's insured value, priced or not: every row's tivKes added up, as buildOfferFocus does. */
  offerTivKes?: number;
}

/** The loaded portfolio: a screen passes { kind: "portfolio", dataset } with the view session's data set. */
export interface PortfolioTarget {
  kind: "portfolio";
  /** The data set as the view shows it: with dataset.drainage when the Flood source switch has drainage on. */
  dataset: Dataset;
}

/** One priced offer: a screen gets it from offerTarget(focus, dataset). */
export interface OfferTarget {
  kind: "offer";
  offer: OfferInputs;
}

/** What the answer is evaluated for: the loaded portfolio, or one priced offer. */
export type Target = PortfolioTarget | OfferTarget;

/**
 * Every assumption as one flat record: the model's parameter paths as the ledger names them
 * ("depthScaleM", "fragility.concrete_rcc", "returnPeriods.common") and the judgement figures as
 * the agents name them ("offer.bufferRadiusM"). The tornado's ids and the Shapley groups' keys are these names.
 */
export type FlatAssumptions = Record<string, number>;

/** The flat name of a judgement figure: "offer.bufferRadiusM". */
export const judgementKeyName = (key: keyof OfferJudgement): string => `offer.${key}`;

/** Every assumption of a set as a flat record. */
export function flattenAssumptions(a: Assumptions): FlatAssumptions {
  const out: FlatAssumptions = {};
  for (const { path, value } of flattenParams(a.params)) out[path] = value;
  for (const key of JUDGEMENT_KEYS) out[judgementKeyName(key)] = a.judgement[key];
  return out;
}

/** The nested assumptions back from a flat record. A name the record lacks keeps the fallback's value. */
export function assembleAssumptions(flat: FlatAssumptions, fallback: Assumptions): Assumptions {
  const read = (name: string, otherwise: number) => (typeof flat[name] === "number" ? flat[name] : otherwise);
  const fragility = {} as Record<HousingClass, number>;
  const cap = {} as Record<HousingClass, number>;
  for (const c of HOUSING_CLASSES) {
    fragility[c] = read(`fragility.${c}`, fallback.params.fragility[c]);
    cap[c] = read(`cap.${c}`, fallback.params.cap[c]);
  }
  const returnPeriods = {} as Record<ScoreTier, number>;
  for (const t of SCORE_TIERS) returnPeriods[t] = read(`returnPeriods.${t}`, fallback.params.returnPeriods[t]);
  const judgement = { ...fallback.judgement };
  for (const key of JUDGEMENT_KEYS) judgement[key] = read(judgementKeyName(key), fallback.judgement[key]);
  return { params: { depthScaleM: read("depthScaleM", fallback.params.depthScaleM), fragility, cap, returnPeriods }, judgement };
}

/** The judgement figures that only enter the premium: the ground-up loss figures never read them. */
const PREMIUM_ONLY_KEYS: ReadonlySet<keyof OfferJudgement> = new Set(["costOfCapital", "minimumRatePerMille"]);

/**
 * The flat names of the assumptions that can move the answer for a target under a mode. Anything
 * else is left out of the tornado and the Shapley groups, and out of the memo key:
 *
 *   the depth scale        only for a susceptibility score data set
 *   a tier's return period only when the data set has a scenario of that tier without a return period of its own
 *   fragility and caps     always
 *   judgement figures      none under "depth_only"; for the portfolio the three in PORTFOLIO_KEYS
 *                          (buffer, drain design return period, drain overload depth); for an offer
 *                          every figure but the two that only enter the premium
 */
export function liveKeys(target: Target, mode: LossMode): string[] {
  const dataset = target.kind === "portfolio" ? target.dataset : target.offer.dataset;
  const out: string[] = [];
  if (dataset.hazardKind === "score") out.push("depthScaleM");
  for (const c of HOUSING_CLASSES) out.push(`fragility.${c}`);
  for (const c of HOUSING_CLASSES) out.push(`cap.${c}`);
  for (const t of SCORE_TIERS) if (dataset.scenarios.some((s) => s.id === t && s.fixedReturnPeriod === undefined)) out.push(`returnPeriods.${t}`);
  if (mode === "all_drivers") {
    const keys = target.kind === "portfolio" ? PORTFOLIO_KEYS : JUDGEMENT_KEYS.filter((k) => !PREMIUM_ONLY_KEYS.has(k));
    for (const key of keys) out.push(judgementKeyName(key));
  }
  return out;
}

/** Why a judgement figure is not live, in one sentence, for the rows and groups left out. */
export function notLiveWhy(target: Target, mode: LossMode): string {
  if (mode === "depth_only") return "Not in force under Depth only: the loss drivers beyond depth are switched off.";
  return target.kind === "portfolio" ? "The portfolio does not read this figure: its buildings carry the buffer and drain overload only." : "This figure does not reach the offer's ground-up loss.";
}

interface Memo {
  live: Partial<Record<LossMode, string[]>>;
  answers: Map<string, Answer>;
}

// Answers remembered per target object. Past this many the oldest are dropped.
const ANSWERS_KEPT = 4096;
const memos = new WeakMap<object, Memo>();

const memoOf = (target: Target): Memo => {
  const holder: object = target.kind === "portfolio" ? target.dataset : target.offer;
  let memo = memos.get(holder);
  if (!memo) memos.set(holder, (memo = { live: {}, answers: new Map() }));
  return memo;
};

/** The memo key of a set of assumptions for a target and a mode: the mode and the live values, in order. */
export function answerKey(target: Target, assumptions: Assumptions, mode: LossMode): string {
  const memo = memoOf(target);
  const live = memo.live[mode] ?? (memo.live[mode] = liveKeys(target, mode));
  const flat = flattenAssumptions(assumptions);
  return `${mode}|${live.map((k) => flat[k]).join(",")}`;
}

function answerOf(target: Target, assumptions: Assumptions, mode: LossMode): Answer {
  if (target.kind === "portfolio") {
    const result = runModel(target.dataset, assumptions.params, { mode, judgement: assumptions.judgement });
    const at100 = result.standardLosses.find((s) => s.returnPeriod === 100);
    return { loss100Kes: at100?.lossKes ?? null, aalKes: result.aalKes };
  }
  const { offer } = target;
  const drivers = offerDrivers({
    dataset: offer.dataset,
    params: assumptions.params,
    building: offer.building,
    others: offer.others,
    extraction: offer.extraction,
    terms: offer.terms,
    judgement: assumptions.judgement,
    mode,
    offerTivKes: offer.offerTivKes,
  });
  if (!drivers) throw new Error("The offer cannot be priced on these maps: a building lies outside a hazard map, or its insured value is not above zero.");
  return { loss100Kes: drivers.loss100.groundUpKes, aalKes: drivers.aal.groundUpTotalKes };
}

/**
 * The answer, and whether the model had to run for it (false when it came from the memo). The
 * tornado and the Shapley attribution count their runs with this.
 */
export function evaluateTracked(target: Target, assumptions: Assumptions, mode: LossMode): { answer: Answer; ran: boolean } {
  const memo = memoOf(target);
  const key = answerKey(target, assumptions, mode);
  const known = memo.answers.get(key);
  if (known) return { answer: known, ran: false };
  const answer = answerOf(target, assumptions, mode);
  if (memo.answers.size >= ANSWERS_KEPT) memo.answers.delete(memo.answers.keys().next().value as string);
  memo.answers.set(key, answer);
  return { answer, ran: true };
}

/**
 * The answer under a set of assumptions: the ground-up 1-in-100 loss and average annual loss of
 * the portfolio, or of the offer. Memoised: the same target, assumptions and mode give the same
 * object without running the model again. A screen passes the mode the header switch shows.
 * Throws for an offer that cannot be priced (a building outside the maps, or no insured value):
 * a screen calls this with a priced focus only.
 */
export function evaluate(target: Target, assumptions: Assumptions, mode: LossMode): Answer {
  return evaluateTracked(target, assumptions, mode).answer;
}

/** How many answers are remembered for a target, over both modes. */
export function rememberedAnswers(target: Target): number {
  return memoOf(target).answers.size;
}

/**
 * The offer target of a priced focus, with the inputs buildOfferFocus gave offerDrivers:
 *
 *   dataset      the session's data set handed to buildOfferFocus (session.dataset). Drainage ponding
 *                at the offer's buildings is taken from their priced rows, so the data set's own
 *                drainage field changes nothing here
 *   building     the followed building (focus.building.locId) from focus.pricing.rows, with its
 *                ponding per scenario; others are the remaining priced rows
 *   extraction   focus.extraction
 *   terms        focus.terms.policy
 *   offerTivKes  every row's insured value added up (focus.rows), priced or not
 *
 * Make it once per focus (useMemo on the focus and the data set): the memo of answers lives on it.
 */
export function offerTarget(focus: PricedFocus, dataset: Dataset): OfferTarget {
  const pricing = focus.pricing;
  if (!pricing) throw new Error("The focus carries no pricing, so there is no offer to evaluate.");
  const priced = pricing.rows.filter((r): r is Extract<RowPricing, { status: "priced" }> => r.status === "priced");
  const followed = priced.find((r) => r.locId === focus.building.locId) ?? priced[0];
  if (!followed) throw new Error("The focus has no priced building to evaluate.");
  const asBuilding = (r: Extract<RowPricing, { status: "priced" }>): DriverBuilding => ({
    lon: r.location.kind === "none" ? Number.NaN : r.location.lon,
    lat: r.location.kind === "none" ? Number.NaN : r.location.lat,
    housingClass: r.housingClass,
    tivKes: r.tivKes,
    name: focus.rows.find((x) => x.locId === r.locId)?.name,
    pondingM: Object.fromEntries(r.scenarios.map((s) => [s.id, s.drainageM])),
  });
  const insuredKes = focus.rows.reduce((t, r) => t + (r.tivKes ?? 0), 0);
  return {
    kind: "offer",
    offer: {
      dataset,
      building: asBuilding(followed),
      others: priced.filter((r) => r !== followed).map(asBuilding),
      extraction: focus.extraction,
      terms: focus.terms.policy,
      offerTivKes: insuredKes > 0 ? insuredKes : undefined,
    },
  };
}
