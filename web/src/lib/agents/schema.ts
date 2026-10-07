import { z } from "zod";
import { flattenParams, REFERENCE_PARAMS } from "../model/params";
import { HOUSING_CLASSES, SCORE_TIERS, type HousingClass, type ModelParams, type ScoreTier } from "../model/types";

export const ROLES = ["optimist", "cautious", "critic", "chair"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  optimist: "Optimist",
  cautious: "Cautious",
  critic: "Critic",
  chair: "Chair",
};

/** Every parameter by its flat name, e.g. "fragility.concrete_rcc". Agents reply with one entry per name. */
export const PARAMETER_NAMES = flattenParams(REFERENCE_PARAMS).map((p) => p.path);

export const BASES = ["jrc_reference", "data_profile", "brief", "judgement"] as const;
export type Basis = (typeof BASES)[number];

export const BASIS_LABELS: Record<Basis, string> = {
  jrc_reference: "JRC reference",
  data_profile: "Data profile",
  brief: "Hackathon brief",
  judgement: "Judgement",
};

const reasoned = z.object({
  value: z.number(),
  reason: z.string().min(1),
  basis: z.enum(BASES).catch("judgement"),
});

const decided = reasoned.extend({
  leans: z.enum(["optimist", "cautious", "between", "outside"]).catch("between"),
});

const perClass = <T extends z.ZodTypeAny>(item: T) =>
  z.object(Object.fromEntries(HOUSING_CLASSES.map((c) => [c, item])) as Record<HousingClass, T>);
const perTier = <T extends z.ZodTypeAny>(item: T) =>
  z.object(Object.fromEntries(SCORE_TIERS.map((t) => [t, item])) as Record<ScoreTier, T>);

const parameterSet = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    depthScaleM: item,
    fragility: perClass(item),
    cap: perClass(item),
    returnPeriods: perTier(item),
  });

export const proposalSchema = parameterSet(reasoned).extend({ stance: z.string().min(1) });
export type Proposal = z.infer<typeof proposalSchema>;

export const critiqueSchema = z.object({
  summary: z.string().min(1),
  challenges: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        detail: z.string().min(1),
        severity: z.enum(["high", "medium", "low"]).catch("medium"),
        affects: z.array(z.string()).catch([]),
        recommendation: z.string().min(1),
      }),
    )
    .min(1)
    .max(8),
});
export type Critique = z.infer<typeof critiqueSchema>;

export const decisionSchema = z.object({
  summary: z.string().min(1),
  decision: parameterSet(decided),
  responses: z.array(
    z.object({
      challengeId: z.string().min(1),
      verdict: z.enum(["accepted", "partly", "rejected"]).catch("partly"),
      response: z.string().min(1),
    }),
  ),
});
export type Decision = z.infer<typeof decisionSchema>;

export const SCHEMAS = {
  optimist: proposalSchema,
  cautious: proposalSchema,
  critic: critiqueSchema,
  chair: decisionSchema,
} as const;

export type AgentOutput = { optimist: Proposal; cautious: Proposal; critic: Critique; chair: Decision };

type ParameterSet = { depthScaleM: { value: number }; fragility: Record<HousingClass, { value: number }>; cap: Record<HousingClass, { value: number }>; returnPeriods: Record<ScoreTier, { value: number }> };

/** Strip the reasons and keep the numbers the engine needs. */
export function toParams(set: ParameterSet): ModelParams {
  const values = <K extends string>(keys: readonly K[], from: Record<K, { value: number }>) =>
    Object.fromEntries(keys.map((k) => [k, from[k].value])) as Record<K, number>;
  return {
    depthScaleM: set.depthScaleM.value,
    fragility: values(HOUSING_CLASSES, set.fragility),
    cap: values(HOUSING_CLASSES, set.cap),
    returnPeriods: values(SCORE_TIERS, set.returnPeriods),
  };
}

/** Look up one reasoned value by its flat path, e.g. "fragility.concrete_rcc". */
export function reasonAt<T extends { value: number; reason: string }>(set: unknown, path: string): T | undefined {
  let node: unknown = set;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  return node as T | undefined;
}

/** A flat list of named entries turned into the nested parameter set. Unknown names are dropped; a repeated name keeps its last entry. */
export function nestParameters(entries: unknown): Record<string, unknown> {
  const out: Record<string, Record<string, unknown> | unknown> = {};
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, ...rest } = entry as { name?: unknown };
    if (typeof name !== "string" || !PARAMETER_NAMES.includes(name)) continue;
    const [group, key] = name.split(".");
    if (key === undefined) out[group] = rest;
    else out[group] = { ...(out[group] as Record<string, unknown> | undefined), [key]: rest };
  }
  return out;
}

/** Replies arrive flat (see responseSchema.ts); the rest of the app works with the nested form. */
export function nestReply(role: Role, reply: unknown): unknown {
  if (role === "critic" || typeof reply !== "object" || reply === null || !("parameters" in reply)) return reply;
  const { parameters, ...rest } = reply as { parameters: unknown };
  const nested = nestParameters(parameters);
  return role === "chair" ? { ...rest, decision: nested } : { ...rest, ...nested };
}
