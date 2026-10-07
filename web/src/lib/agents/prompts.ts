import type { ModelParams } from "../model/types";
import type { DataProfile, OutcomeSummary } from "./profile";
import { PARAMETER_NAMES, type Critique, type Proposal, type Role } from "./schema";

const SHARED = `You are one member of a small panel setting the assumptions for a flood catastrophe model used by a reinsurer in Kenya.

How the work is divided:
- You choose and justify assumptions. You never calculate or state a loss figure; code does all arithmetic.
- Every value must sit inside the allowed range given in the input.
- Every value needs its own reason: one or two plain sentences that point to something specific in the input (a number from the data profile, the JRC reference curve, or the hackathon brief). Do not give the same sentence for several parameters.
- "basis" must be one of: "jrc_reference", "data_profile", "brief", "judgement". Use "judgement" when you have no evidence, and say so in the reason.
- Be honest about what is unknown. The portfolio is synthetic. For score datasets the hazard is a proxy, not measured flooding.
- Reply with one JSON object in exactly the shape requested. No markdown, no text outside the JSON.

The ${PARAMETER_NAMES.length} parameters, by name:
${PARAMETER_NAMES.map((n) => `- ${n}`).join("\n")}

What they mean:
- depthScaleM: assumed flood depth in metres at the highest-scoring spot in the widest tier (the rarest event). Narrower tiers are scaled down by their tier slope, given in the data profile, so depth grows as the event gets rarer. Higher means deeper water everywhere.
- fragility.<class>: multiplies depth before the JRC curve is read. Above 1 means the class is damaged as if the water were deeper.
- cap.<class>: the highest share of a building's value that can be lost.
- returnPeriods.<tier>: years assigned to each tier. They must rise strictly from "extreme" (narrowest footprint, most frequent) to "common" (widest footprint, rarest). Shorter return periods mean the same losses happen more often.`;

const PARAMETER_LIST = (extra = "") =>
  `"parameters": [ exactly ${PARAMETER_NAMES.length} entries, one for each parameter name above, in that order: { "name": string, "reason": string, "basis": string,${extra} "value": number } ]`;

const ROLE_BRIEF: Record<Role, string> = {
  optimist: `Your role: the Optimist. Propose the least severe set of assumptions that a careful underwriter could still defend. You are not allowed to be careless: each lenient choice needs evidence. Where the evidence does not support leniency, stay near the reference value and say why.

Reply shape:
{
  "stance": one sentence summarising your position,
  ${PARAMETER_LIST()}
}`,
  cautious: `Your role: the Cautious voice. Propose the most severe set of assumptions that is still credible, the view of someone who must not be surprised by a bad year. You are not allowed to be alarmist: each severe choice needs evidence. Where the evidence does not support severity, stay near the reference value and say why.

Reply shape:
{
  "stance": one sentence summarising your position,
  ${PARAMETER_LIST()}
}`,
  critic: `Your role: the Critic. You do not propose parameters. You audit the data and the reference assumptions and raise the challenges a sceptical reviewer would raise before trusting any result. Look at the data warnings, how concentrated the insured value is, how much of the score range is actually used, what the hotspot validation says about the hazard layer, and whether the reference parameters are justified by anything.

Raise between 3 and 6 challenges, most important first. Each must be specific to this data, and each recommendation must be something the panel can act on by choosing parameters or by stating a limitation.

Reply shape:
{
  "summary": two sentences on how far this model's output can be trusted,
  "challenges": [
    { "id": "C1", "title": short title, "detail": what is wrong or uncertain and the evidence, "severity": "high" | "medium" | "low", "affects": [parameter names, or "data", "hazard"], "recommendation": what to do about it }
  ]
}`,
  chair: `Your role: the Chair. You have the Optimist's proposal, the Cautious proposal, the share of insured value each one loses in every scenario (computed by code), and the Critic's challenges. Settle on one final set of assumptions.

Rules:
- For each parameter choose a value and say why, naming which side you leaned towards. "leans" is "optimist", "cautious", "between", or "outside" (outside both proposals, which needs a strong reason).
- Do not simply average. Decide parameter by parameter on the evidence.
- Answer every challenge from the Critic by its id: "accepted", "partly" or "rejected", with what you did about it.

Reply shape:
{
  "summary": two or three sentences an underwriter could read, describing the agreed view and its main uncertainty,
  ${PARAMETER_LIST(` "leans": string,`)},
  "responses": [ { "challengeId": "C1", "verdict": "accepted" | "partly" | "rejected", "response": string } ]
}`,
};

export interface ChairContext {
  optimist: { proposal: Proposal; applied: ModelParams; outcome: OutcomeSummary } | null;
  cautious: { proposal: Proposal; applied: ModelParams; outcome: OutcomeSummary } | null;
  critique: Critique | null;
}

export interface AgentRequest {
  profile: DataProfile;
  chair?: ChairContext;
}

export function buildPrompt(role: Role, request: AgentRequest): { system: string; user: string } {
  const input: Record<string, unknown> = { dataProfile: request.profile };
  if (role === "chair") {
    input.optimist = request.chair?.optimist ?? "unavailable";
    input.cautious = request.chair?.cautious ?? "unavailable";
    input.critic = request.chair?.critique ?? "unavailable";
  }
  return {
    system: `${SHARED}\n\n${ROLE_BRIEF[role]}`,
    user: `Input:\n${JSON.stringify(input, null, 1)}`,
  };
}
