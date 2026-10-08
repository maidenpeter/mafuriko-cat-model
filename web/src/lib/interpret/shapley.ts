import type { LossMode } from "../model/drivers";
import { assembleAssumptions, evaluateTracked, flattenAssumptions, liveKeys, notLiveWhy, type Answer, type Assumptions, type Target } from "./evaluate";
import { GROUPS, type GroupId } from "./groups";

/**
 * Exact Shapley attribution of what the agents changed. The assumptions are taken in groups
 * (groups.ts, at most eight). A group is "on" when its figures hold the agreed values and "off"
 * when they hold the reference values. The model is run for every one of the 2^n combinations
 * of the n live groups, and each group's value is its average marginal contribution over every
 * ordering of the groups, with the standard weights |S|! (n - |S| - 1)! / n!. Nothing is sampled.
 * The values add up to the whole change, reference to agreed, to floating point.
 *
 * A group whose figures are the same in both sets, or whose figures cannot reach the answer for
 * the target under the mode (liveKeys), is dropped before any run, and the result says why: a
 * portfolio comparison with five live groups costs 32 runs, not 256.
 *
 * Label on screen: SHAPLEY_TITLE. The sync shapley is for tests and the written note; screens use
 * shapleyAsync, which yields to the event loop between runs, reports progress and can be cancelled.
 */

/** The label of the chart, word for word. */
export const SHAPLEY_TITLE = "How much of the AI's change each assumption accounts for (exact Shapley values)";

/** One bar of the attribution: a group and its exact share of the change. */
export interface ShapleyGroup {
  id: GroupId;
  label: string;
  /** The group's exact Shapley value for the change in ground-up average annual loss, in KES. */
  aalKes: number;
  /** The same for the ground-up 1-in-100 loss. null when a 1-in-100 flood is not modelled under some combination. */
  loss100Kes: number | null;
  /** The flat names in the group whose values differ between the two sets. */
  keysChanged: string[];
}

/** A group left out before any run, with the reason in one sentence. */
export interface ShapleyDropped {
  id: GroupId;
  label: string;
  why: string;
}

/** What shapley and shapleyAsync return: the bars, the totals they add up to, and what it cost. */
export interface ShapleyResult {
  /** One bar per live group, largest absolute value first. */
  groups: ShapleyGroup[];
  /** The groups left out before any run, each with the reason. */
  dropped: ShapleyDropped[];
  /** The answer with every group at its reference value, and at its agreed value. */
  reference: Answer;
  agreed: Answer;
  /** The whole change, agreed less reference. */
  totalAalKes: number;
  totalLoss100Kes: number | null;
  /** The groups' values added up: equal to the totals to floating point. Shown beside them so the reader can see they match. */
  sumAalKes: number;
  sumLoss100Kes: number | null;
  /** How many combinations were evaluated: 2 to the power of the live groups, 1 when none is live. */
  evaluations: number;
  /** How many of those ran the model, rather than coming from the memo. */
  runs: number;
}

/** What a screen passes with the target and the two sets. */
export interface ShapleyOptions {
  /** The mode the header switch shows. Under "depth_only" the groups beyond depth are dropped. */
  mode: LossMode;
  /** Which figure's values order the bars: the 1-in-100 loss when left out, the average annual loss where that is not modelled. */
  sortBy?: "loss100" | "aal";
}

/** The same, with the three things a screen needs to keep the page responsive. */
export interface ShapleyAsyncOptions extends ShapleyOptions {
  /** Abort it to stop: the promise then rejects with an error named "AbortError". */
  signal?: AbortSignal;
  /** Called after each evaluation with how many are done out of the total. */
  onProgress?: (done: number, total: number) => void;
  /** How long to keep running before yielding to the event loop, in milliseconds. 16 when left out; 0 yields after every evaluation. */
  budgetMs?: number;
}

interface LiveGroup {
  id: GroupId;
  label: string;
  keys: readonly string[];
  changed: string[];
}

interface Prepared {
  live: LiveGroup[];
  dropped: ShapleyDropped[];
  /** 2 to the power of the live groups. */
  subsets: number;
  /** The assumptions with the groups in the mask at their agreed values and the rest at the reference. */
  assumptionsFor: (mask: number) => Assumptions;
}

function prepare(target: Target, reference: Assumptions, agreed: Assumptions, options: ShapleyOptions): Prepared {
  const liveSet = new Set(liveKeys(target, options.mode));
  const ref = flattenAssumptions(reference);
  const agr = flattenAssumptions(agreed);
  const live: LiveGroup[] = [];
  const dropped: ShapleyDropped[] = [];
  for (const g of GROUPS) {
    const reaching = g.keys.filter((k) => liveSet.has(k));
    if (reaching.length === 0) {
      dropped.push({ id: g.id, label: g.label, why: notLiveWhy(target, options.mode) });
      continue;
    }
    const changed = reaching.filter((k) => ref[k] !== agr[k]);
    if (changed.length === 0) {
      dropped.push({ id: g.id, label: g.label, why: "The two sets hold the same value for every figure in this group." });
      continue;
    }
    live.push({ id: g.id, label: g.label, keys: g.keys, changed });
  }
  const assumptionsFor = (mask: number): Assumptions => {
    const flat = { ...ref };
    live.forEach((g, i) => {
      if (mask & (1 << i)) for (const k of g.changed) flat[k] = agr[k];
    });
    return assembleAssumptions(flat, reference);
  };
  return { live, dropped, subsets: 1 << live.length, assumptionsFor };
}

const FACTORIAL = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];

const popcount = (mask: number): number => {
  let n = 0;
  for (let m = mask; m > 0; m >>= 1) n += m & 1;
  return n;
};

/** The exact Shapley values from the answer of every combination, in mask order. */
function finish(prepared: Prepared, values: Answer[], runs: number, sortBy: "loss100" | "aal"): ShapleyResult {
  const { live, dropped, subsets } = prepared;
  const n = live.length;
  const reference = values[0];
  const agreed = values[subsets - 1];
  const anyNotModelled = values.some((v) => v.loss100Kes === null);
  // The weight of a marginal contribution made after s groups are already on.
  const weight = (s: number) => (FACTORIAL[s] * FACTORIAL[n - s - 1]) / FACTORIAL[n];
  const groups = live.map((g, i): ShapleyGroup => {
    const bit = 1 << i;
    let aal = 0;
    let loss100 = 0;
    for (let mask = 0; mask < subsets; mask++) {
      if (mask & bit) continue;
      const w = weight(popcount(mask));
      const without = values[mask];
      const withGroup = values[mask | bit];
      aal += w * (withGroup.aalKes - without.aalKes);
      if (!anyNotModelled) loss100 += w * ((withGroup.loss100Kes as number) - (without.loss100Kes as number));
    }
    return { id: g.id, label: g.label, aalKes: aal, loss100Kes: anyNotModelled ? null : loss100, keysChanged: g.changed };
  });
  const sumAalKes = groups.reduce((t, g) => t + g.aalKes, 0);
  const sumLoss100Kes = anyNotModelled ? null : groups.reduce((t, g) => t + (g.loss100Kes as number), 0);
  const size = (g: ShapleyGroup, by: "loss100" | "aal") => Math.abs(by === "loss100" ? (g.loss100Kes ?? g.aalKes) : g.aalKes);
  const other = sortBy === "loss100" ? "aal" : "loss100";
  groups.sort((a, b) => size(b, sortBy) - size(a, sortBy) || size(b, other) - size(a, other) || live.findIndex((g) => g.id === a.id) - live.findIndex((g) => g.id === b.id));
  return {
    groups,
    dropped,
    reference,
    agreed,
    totalAalKes: agreed.aalKes - reference.aalKes,
    totalLoss100Kes: anyNotModelled ? null : (agreed.loss100Kes as number) - (reference.loss100Kes as number),
    sumAalKes,
    sumLoss100Kes,
    evaluations: subsets,
    runs,
  };
}

/**
 * The exact Shapley attribution, synchronously: for tests and the written note. `reference` is the
 * set without the agents (REFERENCE_PARAMS with the judgement figures in force without them) and
 * `agreed` the set the agents settled (the final parameters with their agreed judgement figures).
 * Every combination of the live groups is run, 2 to the power of their number, memoised.
 */
export function shapley(target: Target, reference: Assumptions, agreed: Assumptions, options: ShapleyOptions): ShapleyResult {
  const prepared = prepare(target, reference, agreed, options);
  const values: Answer[] = [];
  let runs = 0;
  for (let mask = 0; mask < prepared.subsets; mask++) {
    const { answer, ran } = evaluateTracked(target, prepared.assumptionsFor(mask), options.mode);
    if (ran) runs += 1;
    values.push(answer);
  }
  return finish(prepared, values, runs, options.sortBy ?? "loss100");
}

/** Hands the rest of the work back to the event loop: scheduler.yield where the browser has it, otherwise a zero timeout. */
const yieldToEventLoop = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler && typeof scheduler.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
};

const abortError = (): Error => {
  const error = new Error("The attribution was cancelled before it finished.");
  error.name = "AbortError";
  return error;
};

/**
 * The same attribution for screens: the same values as shapley, with the event loop given its
 * turn between evaluations (after each budgetMs of work), progress reported after each one, and
 * the whole thing stopped by an AbortSignal, so 256 runs never freeze a page.
 */
export async function shapleyAsync(target: Target, reference: Assumptions, agreed: Assumptions, options: ShapleyAsyncOptions): Promise<ShapleyResult> {
  const { signal, onProgress } = options;
  const budget = options.budgetMs ?? 16;
  const prepared = prepare(target, reference, agreed, options);
  const values: Answer[] = [];
  let runs = 0;
  let since = performance.now();
  for (let mask = 0; mask < prepared.subsets; mask++) {
    if (signal?.aborted) throw abortError();
    const { answer, ran } = evaluateTracked(target, prepared.assumptionsFor(mask), options.mode);
    if (ran) runs += 1;
    values.push(answer);
    onProgress?.(mask + 1, prepared.subsets);
    if (mask + 1 < prepared.subsets && performance.now() - since >= budget) {
      await yieldToEventLoop();
      since = performance.now();
    }
  }
  if (signal?.aborted) throw abortError();
  return finish(prepared, values, runs, options.sortBy ?? "loss100");
}

/** One sentence on how the attribution was made, for the written note and the Audit step. */
export function shapleyMethodLine(result: ShapleyResult): string {
  const n = result.groups.length;
  const named = result.groups.map((g) => g.label.toLowerCase()).join(", ");
  if (n === 0) return "The agents left every assumption that reaches this answer at its reference value, so there is no change to attribute.";
  return `The assumptions that changed were taken in ${n} ${n === 1 ? "group" : "groups"} (${named}). The model was run for every one of the ${result.evaluations} combinations of reference and agreed values, and each group's share is its average marginal contribution over every ordering of the groups: exact Shapley values, not sampled. The shares add up to the whole change.`;
}
