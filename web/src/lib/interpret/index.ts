/**
 * Interpretability of the answer. The model is a transparent formula, so nothing here fits a
 * surrogate: every figure is a run of the same engine the rest of the app uses.
 *
 *   evaluate(target, assumptions, mode)                  the ground-up 1-in-100 loss and average annual loss, memoised
 *   tornado(target, base, { mode })                      each assumption swung across its stated range, largest swing first
 *   shapley(target, reference, agreed, { mode })         exact Shapley values of what the agents changed, by group
 *   shapleyAsync(..., { mode, signal, onProgress })      the same for screens, yielding between runs
 *
 * A target is the portfolio ({ kind: "portfolio", dataset }) or a priced offer (offerTarget(focus, dataset)).
 * Assumptions are { params, judgement }: the model's parameters and the figures behind the loss
 * drivers beyond depth. The titles on screen are TORNADO_TITLE and SHAPLEY_TITLE.
 */
export {
  answerKey,
  assembleAssumptions,
  evaluate,
  flattenAssumptions,
  judgementKeyName,
  liveKeys,
  notLiveWhy,
  offerTarget,
  rememberedAnswers,
  type Answer,
  type Assumptions,
  type FlatAssumptions,
  type OfferInputs,
  type OfferTarget,
  type PortfolioTarget,
  type Target,
} from "./evaluate";
export { GROUP_LABELS, GROUPS, groupOf, type Group, type GroupId } from "./groups";
export { shapley, shapleyAsync, SHAPLEY_TITLE, shapleyMethodLine, type ShapleyAsyncOptions, type ShapleyDropped, type ShapleyGroup, type ShapleyOptions, type ShapleyResult } from "./shapley";
export {
  BASEMENT_LADDER_LABEL,
  SWING_IDS,
  swingAssumptions,
  swingRange,
  swingText,
  tornado,
  TORNADO_TITLE,
  tornadoMethodLine,
  tornadoPlan,
  type SwingId,
  type SwingPlan,
  type TornadoOptions,
  type TornadoPlan,
  type TornadoRow,
  type TornadoSide,
} from "./tornado";
