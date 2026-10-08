import { z } from "zod";
import { flattenParams, REFERENCE_PARAMS } from "../model/params";
import { HOUSING_CLASSES, SCORE_TIERS, type HousingClass, type ModelParams, type ScoreTier } from "../model/types";
import { AGENT_JUDGEMENT_KEYS, JUDGEMENT_PARAMETER_NAMES, type OfferJudgement } from "../offer/judgement";

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

/**
 * The names an agent replies with. Without an offer these are the model's own parameters.
 * With an offer loaded, the figures behind the offer's loss drivers that the agents may argue
 * follow them ("offer.bufferRadiusM" and so on, see AGENT_JUDGEMENT_KEYS), so one reply settles both.
 */
export const parameterNames = (hasOffer: boolean): string[] => (hasOffer ? [...PARAMETER_NAMES, ...JUDGEMENT_PARAMETER_NAMES] : PARAMETER_NAMES);

export const BASES = ["jrc_reference", "data_profile", "brief", "judgement"] as const;
/** With an offer loaded, a value can also rest on the facts of the offer. */
export const OFFER_BASES = [...BASES, "offer"] as const;
export type Basis = (typeof OFFER_BASES)[number];

/** What a value may rest on, for this request. */
export const basesFor = (hasOffer: boolean): readonly Basis[] => (hasOffer ? OFFER_BASES : BASES);

export const BASIS_LABELS: Record<Basis, string> = {
  jrc_reference: "JRC reference",
  data_profile: "Data profile",
  brief: "Hackathon brief",
  judgement: "Judgement",
  offer: "The offer's facts",
};

const reasoned = z.object({
  value: z.number(),
  reason: z.string().min(1),
  basis: z.enum(BASES).catch("judgement"),
});

const LEANS = ["optimist", "cautious", "between", "outside"] as const;

const decided = reasoned.extend({
  leans: z.enum(LEANS).catch("between"),
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

// The offer's judgement figures are argued like the parameters: a value, a reason and what it rests on.
const offerReasoned = reasoned.extend({ basis: z.enum(OFFER_BASES).catch("judgement") });
const offerDecided = offerReasoned.extend({ leans: z.enum(LEANS).catch("between") });

/**
 * One entry for each figure the agents argue, by key. The check demands every one of them. The type
 * says "may be absent" because the same shape is read back from saved runs, and a run saved under an
 * earlier set of figures holds other keys: those are ignored, and a figure it lacks takes the reference.
 */
const judgementSet = <T extends z.ZodTypeAny>(item: T) =>
  z.object(Object.fromEntries(AGENT_JUDGEMENT_KEYS.map((k) => [k, item]))) as unknown as z.ZodType<Partial<Record<keyof OfferJudgement, z.infer<T>>>>;

export const proposalSchema = parameterSet(reasoned).extend({ stance: z.string().min(1) });
/** A proposal made with an offer loaded: the model's parameters, and the offer's figures set aside under offerJudgement. */
export const offerProposalSchema = proposalSchema.extend({ offerJudgement: judgementSet(offerReasoned) });
/** The offer's figures as a proposing agent argued them, by key ("bufferRadiusM", not "offer.bufferRadiusM"). */
export type JudgementProposal = z.infer<typeof offerProposalSchema>["offerJudgement"];
/** offerJudgement is there only when the agent ran with an offer loaded. */
export type Proposal = z.infer<typeof proposalSchema> & { offerJudgement?: JudgementProposal };

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
/** The Chair's decision made with an offer loaded. */
export const offerDecisionSchema = decisionSchema.extend({ offerJudgement: judgementSet(offerDecided) });
/** The offer's figures as the Chair settled them, each with the side it leaned towards. */
export type JudgementDecision = z.infer<typeof offerDecisionSchema>["offerJudgement"];
/** offerJudgement is there only when the Chair ran with an offer loaded. */
export type Decision = z.infer<typeof decisionSchema> & { offerJudgement?: JudgementDecision };

export const SCHEMAS = {
  optimist: proposalSchema,
  cautious: proposalSchema,
  critic: critiqueSchema,
  chair: decisionSchema,
} as const;

const OFFER_SCHEMAS = {
  optimist: offerProposalSchema,
  cautious: offerProposalSchema,
  critic: critiqueSchema,
  chair: offerDecisionSchema,
} as const;

/** The check a reply must pass. With an offer loaded, every one of the offer's figures must be there too. */
export const schemaFor = (role: Role, hasOffer: boolean): z.ZodTypeAny => (hasOffer ? OFFER_SCHEMAS : SCHEMAS)[role];

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

/**
 * Strip the reasons from the offer's figures and keep the numbers, for the figures the agents argue
 * and nothing else. A figure the set does not hold is left out. Code then keeps them in range and
 * the ladders rising (enforceJudgement).
 */
export function toJudgement(set: Partial<Record<string, { value?: unknown } | null>> | null | undefined): Partial<OfferJudgement> {
  const out: Partial<OfferJudgement> = {};
  for (const key of AGENT_JUDGEMENT_KEYS) {
    const value = set?.[key]?.value;
    if (typeof value === "number") out[key] = value;
  }
  return out;
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

/** The offer's figures picked out of the same flat list, by key: "offer.bufferRadiusM" becomes bufferRadiusM. A repeated name keeps its last entry. */
export function nestJudgement(entries: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, ...rest } = entry as { name?: unknown };
    if (typeof name !== "string" || !JUDGEMENT_PARAMETER_NAMES.includes(name)) continue;
    out[name.slice(name.indexOf(".") + 1)] = rest;
  }
  return out;
}

/**
 * Replies arrive flat (see responseSchema.ts); the rest of the app works with the nested form.
 * With an offer loaded, the offer's figures are set aside under offerJudgement, beside the
 * model's parameters, so everything that reads the parameters is unchanged.
 */
export function nestReply(role: Role, reply: unknown, hasOffer = false): unknown {
  if (role === "critic" || typeof reply !== "object" || reply === null || !("parameters" in reply)) return reply;
  const { parameters, ...rest } = reply as { parameters: unknown };
  const nested = nestParameters(parameters);
  const offer = hasOffer ? { offerJudgement: nestJudgement(parameters) } : {};
  return role === "chair" ? { ...rest, decision: nested, ...offer } : { ...rest, ...nested, ...offer };
}

/** Where a reply fell short, named the way the agent names things so the retry can point at it: "offer.bufferRadiusM", not the nested path. */
export const issueName = (path: readonly PropertyKey[]): string => path.map(String).join(".").replace(/^offerJudgement\./, "offer.");
