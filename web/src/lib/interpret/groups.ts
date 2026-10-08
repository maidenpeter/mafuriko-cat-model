import { HOUSING_CLASSES, SCORE_TIERS } from "../model/types";
import { BASEMENT_LADDER, OUTAGE_LADDER } from "../offer/judgement";
import { judgementKeyName } from "./evaluate";

/**
 * The assumptions in at most eight groups, for the exact Shapley attribution of what the agents
 * changed. A group is one bar on screen, so each is something an underwriter would name in one
 * breath. The keys are the flat names of flattenAssumptions.
 *
 * Two judgement figures are in no group: the cost of capital and the minimum rate enter the premium
 * only, never the ground-up loss the attribution explains.
 */
export type GroupId = "depthScale" | "returnPeriods" | "fragility" | "caps" | "buffer" | "drainOverload" | "basement" | "interruptionUncertainty";

/** One group of assumptions: one bar of the attribution. */
export interface Group {
  id: GroupId;
  /** The name on the bar. */
  label: string;
  /** One plain sentence on what the group holds. */
  what: string;
  /** The flat names of the assumptions in the group. */
  keys: readonly string[];
}

/** The eight groups, in the order they are listed when nothing else orders them. */
export const GROUPS: readonly Group[] = [
  { id: "depthScale", label: "Depth scale", what: "The flood depth a susceptibility score of 1 stands for in the widest tier.", keys: ["depthScaleM"] },
  { id: "returnPeriods", label: "Tier return periods", what: "The return period in years given to each score tier.", keys: SCORE_TIERS.map((t) => `returnPeriods.${t}`) },
  { id: "fragility", label: "Fragility, all classes", what: "The multiplier on depth before the damage curve is read, for each housing class.", keys: HOUSING_CLASSES.map((c) => `fragility.${c}`) },
  { id: "caps", label: "Damage caps, all classes", what: "The highest damage ratio each housing class can reach.", keys: HOUSING_CLASSES.map((c) => `cap.${c}`) },
  { id: "buffer", label: "Buffer radius", what: "How far around a building the highest map depth is taken.", keys: [judgementKeyName("bufferRadiusM")] },
  { id: "drainOverload", label: "Drain overload", what: "The return period the drains are designed for, and the surface water once they are overloaded.", keys: [judgementKeyName("drainDesignRp"), judgementKeyName("drainOverloadDepthM")] },
  {
    id: "basement",
    label: "Basement",
    what: "When a basement takes water, the share of the value below ground lost at each rung, and that share of the insured value when the offer does not state it.",
    keys: [judgementKeyName("ingressThresholdM"), ...BASEMENT_LADDER.map(judgementKeyName), judgementKeyName("belowGroundShare")],
  },
  {
    id: "interruptionUncertainty",
    label: "Interruption and uncertainty",
    what: "Outage days at each rung, a year's rent when the offer does not state it, and the loading for causes not modelled.",
    keys: [...OUTAGE_LADDER.map(judgementKeyName), judgementKeyName("annualRentShare"), judgementKeyName("uncertaintyLoading")],
  },
];

/** The group's name by id. */
export const GROUP_LABELS: Record<GroupId, string> = Object.fromEntries(GROUPS.map((g) => [g.id, g.label])) as Record<GroupId, string>;

/** The group an assumption belongs to, by its flat name. null for a figure in no group. */
export function groupOf(key: string): GroupId | null {
  return GROUPS.find((g) => g.keys.includes(key))?.id ?? null;
}
