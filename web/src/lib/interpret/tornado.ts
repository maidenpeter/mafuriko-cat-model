import { PARAM_LABELS } from "../export";
import { fmtNum } from "../format";
import type { LossMode } from "../model/drivers";
import { BOUNDS } from "../model/params";
import { HOUSING_CLASSES, SCORE_TIERS, type HousingClass, type ScoreTier } from "../model/types";
import { statedValues } from "../offer/drivers";
import { BASEMENT_LADDER, JUDGEMENT_BOUNDS, JUDGEMENT_LABELS, type OfferJudgement } from "../offer/judgement";
import { assembleAssumptions, evaluateTracked, flattenAssumptions, judgementKeyName, liveKeys, notLiveWhy, type Answer, type Assumptions, type FlatAssumptions, type Target } from "./evaluate";
import type { GroupId } from "./groups";

/**
 * The sensitivity tornado: each assumption swung on its own, to the bottom and the top of its
 * stated range, with every other assumption left as it stands. The ranges are the ones the agents
 * are allowed (BOUNDS in model/params.ts, JUDGEMENT_BOUNDS in offer/judgement.ts), never invented:
 *
 *   depth scale                   1 to 6 m
 *   each tier's return period     2 to 1000 years, kept between its neighbouring tiers so the tiers stay in order
 *   fragility, each class         0.4 to 2.5
 *   damage cap, each class        0.6 to 1
 *   buffer radius                 0 to 500 m
 *   basement ingress threshold    0 to 0.5 m
 *   basement damage ladder        every rung to the bottom of its range, then every rung to the top, kept rising
 *   drain design return period    2 to 200 years
 *   uncertainty loading           0 to 0.5
 *
 * An assumption that cannot move the answer for the target under the mode (liveKeys) is left out,
 * not shown as zero: the offer-only figures for the portfolio, every figure beyond depth under
 * Depth only, the depth scale and the tier return periods for a data set of measured depths. An
 * assumption whose range is a single value gives a zero swing.
 *
 * Title on screen: TORNADO_TITLE, "Which assumptions move the answer most".
 */

export type SwingId =
  | "depthScaleM"
  | `returnPeriods.${ScoreTier}`
  | `fragility.${HousingClass}`
  | `cap.${HousingClass}`
  | "offer.bufferRadiusM"
  | "offer.ingressThresholdM"
  | "offer.basementLadder"
  | "offer.drainDesignRp"
  | "offer.uncertaintyLoading";

/** The title of the chart, word for word. */
export const TORNADO_TITLE = "Which assumptions move the answer most";

/** The label of the ladder's row. The single figures take the labels of the ledger (PARAM_LABELS) and of the judgement figures (JUDGEMENT_LABELS). */
export const BASEMENT_LADDER_LABEL = "Basement damage ladder, every rung (share of value below ground)";

interface SwingRange {
  min: number;
  max: number;
  /** Why the range is narrower than the stated one, or how the swing moves. null when there is nothing to say. */
  note: string | null;
}

interface SwingDef {
  id: SwingId;
  label: string;
  unit: string;
  group: GroupId;
  /** The flat names the swing moves. */
  keys: string[];
  /** The stated range, with the other assumptions of the base set to hand. The target is null when none is given. */
  range: (base: FlatAssumptions, target: Target | null) => SwingRange;
  /** The swing's value in a set: one figure, or the ladder's rungs most frequent first. */
  value: (base: FlatAssumptions) => number | number[];
  /** The value at the bottom and the top of the range: one figure, or every rung of the ladder. */
  low: (range: SwingRange) => number | number[];
  high: (range: SwingRange) => number | number[];
  /** The set with the swing at a value. A single number sets every rung of the ladder. */
  apply: (base: FlatAssumptions, value: number | number[]) => FlatAssumptions;
}

const single = (id: SwingId, key: string, label: string, unit: string, group: GroupId, range: SwingDef["range"]): SwingDef => ({
  id,
  label,
  unit,
  group,
  keys: [key],
  range,
  value: (base) => base[key],
  low: (r) => r.min,
  high: (r) => r.max,
  apply: (base, value) => ({ ...base, [key]: Array.isArray(value) ? value[0] : value }),
});

const stated = (min: number, max: number): SwingRange => ({ min, max, note: null });

/** A tier's range: the stated one, kept strictly between the neighbouring tiers (one year apart at the least, as enforceBounds keeps them). */
function tierRange(tier: ScoreTier, base: FlatAssumptions): SwingRange {
  const at = SCORE_TIERS.indexOf(tier);
  const own = base[`returnPeriods.${tier}`];
  const before = at > 0 ? SCORE_TIERS[at - 1] : null;
  const after = at < SCORE_TIERS.length - 1 ? SCORE_TIERS[at + 1] : null;
  const prev = before ? base[`returnPeriods.${before}`] : null;
  const next = after ? base[`returnPeriods.${after}`] : null;
  let min = BOUNDS.returnPeriod.min;
  let max = BOUNDS.returnPeriod.max;
  const clauses: string[] = [];
  if (prev !== null && prev + 1 > min) {
    min = prev + 1;
    clauses.push(`rarer than the ${before} tier (${fmtNum(prev, 3)} years)`);
  }
  if (next !== null && next - 1 < max) {
    max = next - 1;
    clauses.push(`more frequent than the ${after} tier (${fmtNum(next, 3)} years)`);
  }
  // Tiers out of order in the base set leave no room to swing: the figure stays where it is.
  if (min > max) return { min: own, max: own, note: "No room to swing: the neighbouring tiers leave no return period between them." };
  return { min, max, note: clauses.length ? `Kept ${clauses.join(" and ")}, so the tiers stay in order.` : null };
}

const judgementRange = (key: keyof OfferJudgement) => stated(JUDGEMENT_BOUNDS[key].min, JUDGEMENT_BOUNDS[key].max);

const LADDER_KEYS = BASEMENT_LADDER.map(judgementKeyName);

/** The ladder swung as one assumption. */
const ladderSwing: SwingDef = {
  id: "offer.basementLadder",
  label: BASEMENT_LADDER_LABEL,
  unit: "share of value below ground",
  group: "basement",
  keys: LADDER_KEYS,
  range: () => ({
    min: Math.min(...BASEMENT_LADDER.map((k) => JUDGEMENT_BOUNDS[k].min)),
    max: Math.max(...BASEMENT_LADDER.map((k) => JUDGEMENT_BOUNDS[k].max)),
    note: "All five rungs move together: every rung to the bottom of its range, then every rung to the top, so the ladder keeps rising.",
  }),
  value: (base) => LADDER_KEYS.map((k) => base[k]),
  // Rising from the most frequent rung: each rung at least the one before it.
  low: () => BASEMENT_LADDER.map((k) => JUDGEMENT_BOUNDS[k].min).map((v, i, all) => Math.max(v, ...all.slice(0, i))),
  // Rising towards the rarest rung: each rung at most the one after it.
  high: () => BASEMENT_LADDER.map((k) => JUDGEMENT_BOUNDS[k].max).map((v, i, all) => Math.min(v, ...all.slice(i + 1))),
  apply: (base, value) => {
    const out = { ...base };
    LADDER_KEYS.forEach((k, i) => {
      out[k] = Array.isArray(value) ? (value[i] ?? value[value.length - 1]) : value;
    });
    return out;
  },
};

const SWINGS: readonly SwingDef[] = [
  single("depthScaleM", "depthScaleM", PARAM_LABELS.depthScaleM, "m", "depthScale", () => stated(BOUNDS.depthScaleM.min, BOUNDS.depthScaleM.max)),
  ...SCORE_TIERS.map((t) => single(`returnPeriods.${t}`, `returnPeriods.${t}`, PARAM_LABELS[`returnPeriods.${t}`], "years", "returnPeriods", (base) => tierRange(t, base))),
  ...HOUSING_CLASSES.map((c) => single(`fragility.${c}`, `fragility.${c}`, PARAM_LABELS[`fragility.${c}`], "times depth", "fragility", () => stated(BOUNDS.fragility.min, BOUNDS.fragility.max))),
  ...HOUSING_CLASSES.map((c) => single(`cap.${c}`, `cap.${c}`, PARAM_LABELS[`cap.${c}`], "share of value", "caps", () => stated(BOUNDS.cap.min, BOUNDS.cap.max))),
  single("offer.bufferRadiusM", judgementKeyName("bufferRadiusM"), JUDGEMENT_LABELS.bufferRadiusM, "m", "buffer", () => judgementRange("bufferRadiusM")),
  single("offer.ingressThresholdM", judgementKeyName("ingressThresholdM"), JUDGEMENT_LABELS.ingressThresholdM, "m", "basement", () => judgementRange("ingressThresholdM")),
  ladderSwing,
  single("offer.drainDesignRp", judgementKeyName("drainDesignRp"), JUDGEMENT_LABELS.drainDesignRp, "years", "drainOverload", (_, target) => {
    const range = judgementRange("drainDesignRp");
    // An offer that states its drain design return period is priced on that, so this assumption cannot move its answer.
    if (target?.kind === "offer" && statedValues(target.offer.extraction).drainDesignRp) range.note = "The offer states its drain design return period, so this assumption is not in force for it.";
    return range;
  }),
  single("offer.uncertaintyLoading", judgementKeyName("uncertaintyLoading"), JUDGEMENT_LABELS.uncertaintyLoading, "share of the loss", "interruptionUncertainty", () => judgementRange("uncertaintyLoading")),
];

/** The assumptions the tornado swings, in the order they are listed above. */
export const SWING_IDS: readonly SwingId[] = SWINGS.map((s) => s.id);

const swingDef = (id: SwingId): SwingDef => {
  const def = SWINGS.find((s) => s.id === id);
  if (!def) throw new Error(`No such assumption to swing: ${id}`);
  return def;
};

/** One figure, or the ladder's rungs, as text: "4", "0.08", "0.15 / 0.25 / 0.4 / 0.55 / 0.7". The unit is on the row. */
export const swingText = (value: number | number[]): string => (Array.isArray(value) ? value.map((v) => fmtNum(v, 3)).join(" / ") : fmtNum(value, 3));

/**
 * The stated range of one assumption, given the base set (a tier is kept between its neighbours).
 * The target is read only for the drain design return period of an offer that states its own.
 */
export function swingRange(id: SwingId, base: Assumptions, target: Target | null = null): SwingRange {
  return swingDef(id).range(flattenAssumptions(base), target);
}

/**
 * The base set with one assumption at a value: a number for a single figure, and for the ladder
 * the five rungs most frequent first, or one number for every rung. Nothing is clamped here.
 */
export function swingAssumptions(id: SwingId, base: Assumptions, value: number | number[]): Assumptions {
  return assembleAssumptions(swingDef(id).apply(flattenAssumptions(base), value), base);
}

/** What a screen passes with the target and the base set. */
export interface TornadoOptions {
  /** The mode the header switch shows. The assumptions beyond depth are swung only under "all_drivers". */
  mode: LossMode;
  /** Which figure's swing orders the rows: the 1-in-100 loss when left out, the average annual loss where that is not modelled. */
  sortBy?: "loss100" | "aal";
}

/** One assumption as the tornado will swing it: its values at the bottom and the top of its range, before any run. */
export interface SwingPlan {
  id: SwingId;
  label: string;
  unit: string;
  group: GroupId;
  /** The flat names moved. */
  keys: string[];
  note: string | null;
  baseValue: number | number[];
  lowValue: number | number[];
  highValue: number | number[];
  rangeMin: number;
  rangeMax: number;
  /** The whole set at each end, ready to run. */
  low: Assumptions;
  high: Assumptions;
}

/** What tornadoPlan returns: the swings to run, and what was left out. */
export interface TornadoPlan {
  swung: SwingPlan[];
  /** The assumptions left out, each with the reason. */
  leftOut: { id: SwingId; label: string; why: string }[];
}

/** Which assumptions the tornado swings for a target under a mode, and how far, with the ones left out and why. No run of the model. */
export function tornadoPlan(target: Target, base: Assumptions, options: TornadoOptions): TornadoPlan {
  const live = new Set(liveKeys(target, options.mode));
  const flat = flattenAssumptions(base);
  const swung: SwingPlan[] = [];
  const leftOut: TornadoPlan["leftOut"] = [];
  for (const def of SWINGS) {
    if (!def.keys.some((k) => live.has(k))) {
      const isParam = !def.keys[0].startsWith("offer.");
      leftOut.push({ id: def.id, label: def.label, why: isParam ? "Not in force on this data set: it carries its own depths or return periods." : notLiveWhy(target, options.mode) });
      continue;
    }
    const range = def.range(flat, target);
    const lowValue = def.low(range);
    const highValue = def.high(range);
    swung.push({
      id: def.id,
      label: def.label,
      unit: def.unit,
      group: def.group,
      keys: def.keys,
      note: range.note,
      baseValue: def.value(flat),
      lowValue,
      highValue,
      rangeMin: range.min,
      rangeMax: range.max,
      low: assembleAssumptions(def.apply(flat, lowValue), base),
      high: assembleAssumptions(def.apply(flat, highValue), base),
    });
  }
  return { swung, leftOut };
}

/** The answer at one end of a swing, and how far it is from the base. */
export interface TornadoSide {
  loss100Kes: number | null;
  aalKes: number;
  /** null when either side is not modelled. */
  loss100ChangeKes: number | null;
  aalChangeKes: number;
}

/** One bar of the tornado: an assumption, its values at each end, and the answer there. */
export interface TornadoRow {
  id: SwingId;
  /** The assumption in plain words, as the ledger and the judgement tables name it. */
  label: string;
  /** "m", "years", "times depth", "share of value", "share of the loss", "share of value below ground". */
  unit: string;
  group: GroupId;
  /** One figure, or the ladder's five rungs most frequent first. */
  baseValue: number | number[];
  lowValue: number | number[];
  highValue: number | number[];
  /** The same as text, ready for a bar's label: "4", "0 / 0 / 0 / 0 / 0". */
  baseText: string;
  lowText: string;
  highText: string;
  /** The stated range the swing stayed inside. For the ladder, the range of a rung. */
  rangeMin: number;
  rangeMax: number;
  /** The answer with the assumption at the bottom of its range, and at the top. */
  low: TornadoSide;
  high: TornadoSide;
  /** How far the answer moves: from the lowest of base, low and high to the highest. The bar's length. null where the 1-in-100 loss is not modelled. */
  swing: { loss100Kes: number | null; aalKes: number };
  /** Why the range is narrower than the stated one, or how the swing moves. null when there is nothing to say. */
  note: string | null;
}

const change = (side: Answer, base: Answer) => ({
  loss100Kes: side.loss100Kes,
  aalKes: side.aalKes,
  loss100ChangeKes: side.loss100Kes !== null && base.loss100Kes !== null ? side.loss100Kes - base.loss100Kes : null,
  aalChangeKes: side.aalKes - base.aalKes,
});

const extent = (values: (number | null)[]): number | null => {
  if (values.some((v) => v === null)) return null;
  const nums = values as number[];
  return Math.max(...nums) - Math.min(...nums);
};

/** The figure a row is ordered by: the chosen one, or the other where the chosen one is not modelled. */
const orderOf = (swing: TornadoRow["swing"], sortBy: "loss100" | "aal"): number => (sortBy === "loss100" ? (swing.loss100Kes ?? swing.aalKes) : swing.aalKes);

/**
 * The tornado for a target under the base assumptions (the set in force on screen), one row per
 * assumption swung, largest swing first. Two runs of the model per row, memoised: the base is one
 * more, shared with everything else. The screen passes the mode the header switch shows.
 */
export function tornado(target: Target, base: Assumptions, options: TornadoOptions): TornadoRow[] {
  const { mode } = options;
  const sortBy = options.sortBy ?? "loss100";
  const baseAnswer = evaluateTracked(target, base, mode).answer;
  const rows = tornadoPlan(target, base, options).swung.map((plan): TornadoRow => {
    const low = change(evaluateTracked(target, plan.low, mode).answer, baseAnswer);
    const high = change(evaluateTracked(target, plan.high, mode).answer, baseAnswer);
    return {
      id: plan.id,
      label: plan.label,
      unit: plan.unit,
      group: plan.group,
      baseValue: plan.baseValue,
      lowValue: plan.lowValue,
      highValue: plan.highValue,
      baseText: swingText(plan.baseValue),
      lowText: swingText(plan.lowValue),
      highText: swingText(plan.highValue),
      rangeMin: plan.rangeMin,
      rangeMax: plan.rangeMax,
      low,
      high,
      swing: { loss100Kes: extent([baseAnswer.loss100Kes, low.loss100Kes, high.loss100Kes]), aalKes: extent([baseAnswer.aalKes, low.aalKes, high.aalKes]) as number },
      note: plan.note,
    };
  });
  const other = sortBy === "loss100" ? "aal" : "loss100";
  return rows.sort((a, b) => orderOf(b.swing, sortBy) - orderOf(a.swing, sortBy) || orderOf(b.swing, other) - orderOf(a.swing, other) || SWING_IDS.indexOf(a.id) - SWING_IDS.indexOf(b.id));
}

/** One sentence on how the tornado was made, for the written note and the Audit step. */
export function tornadoMethodLine(rows: readonly TornadoRow[]): string {
  const n = rows.length;
  return `Each of the ${n} assumptions was swung on its own to the bottom and the top of its allowed range, with every other assumption left as it stands: ${2 * n} runs of the model beside the one in force. The bars show how far the ground-up 1-in-100 loss and average annual loss moved, largest first, with the low and high values used.`;
}
