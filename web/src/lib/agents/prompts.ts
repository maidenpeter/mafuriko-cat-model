import type { ModelParams } from "../model/types";
import { JUDGEMENT_BOUNDS, JUDGEMENT_KEYS, JUDGEMENT_LABELS, REFERENCE_JUDGEMENT, type OfferJudgement } from "../offer/judgement";
import type { OfferBrief } from "./offerBrief";
import type { DataProfile, OutcomeSummary } from "./profile";
import { challengeLimits } from "./responseSchema";
import { parameterNames, PARAMETER_NAMES, type Critique, type Proposal, type Role } from "./schema";

/** What each of the offer's five figures does to the price, in words. The ranges and reference values are read from judgement.ts. */
const JUDGEMENT_EFFECTS: Record<keyof OfferJudgement, string> = {
  siteRadiusM:
    "Code averages the damage ratio over every map cell within this distance of the stated point. A wider radius lets nearby mapped water count when the point itself is dry, and spreads a wet point over the drier ground around it. 0 reads the stated point alone.",
  basementLoading:
    "Raises the loss for plant kept below ground, which a flood depth at the surface does not see. It applies in full only when the document puts critical plant in a basement, and at half when it states basements with no plant in them. With no basement it has no effect.",
  drainageLoading: "Raises the loss when the document reports poor, blocked or silted drainage at the site. It has no effect when the document says nothing against the drains.",
  experienceWeight:
    "How far the document's own flood loss record pulls the price away from the model. 0 ignores the record and 1 uses it alone. It has no effect unless the document states both the losses and the number of years they cover.",
  minimumRatePerMille: "The floor under the price: no risk inside the mapped area is given a lower pure flood rate. It decides the price when the model and the loss record both give little or nothing.",
};

const OFFER_SECTION = `The offer. The last ${JUDGEMENT_KEYS.length} parameters belong to one offer: a single building a broker has asked the reinsurer to price. What code worked out about it is under "offer" in the input, and the allowed ranges and reference values of the ${JUDGEMENT_KEYS.length} are under "offerFigures". The first ${PARAMETER_NAMES.length} parameters apply to every building in the model, this one included: set them on the portfolio's evidence exactly as you would with no offer loaded, and do not bend them to suit one building.

Why the ${JUDGEMENT_KEYS.length} exist: the model reads the flood map at one point, the stated coordinates. That point can be dry in every tier while mapped water lies a short distance away, plant sits below ground and the document reports a past flood. A loss of zero is then not a price an underwriter can use. So code builds the offer's technical price from all the evidence:
- loaded loss at each return period = insured value x the damage ratio averaged over every map cell within offer.siteRadiusM of the stated point x (1 + loadings)
- loadings = offer.basementLoading when the document puts critical plant in a basement (half of it when it states basements with no plant in them) + offer.drainageLoading when the document reports poor or blocked drainage
- model average annual loss = the area under that loaded loss curve
- blended average annual loss = (1 - offer.experienceWeight) x model average annual loss + offer.experienceWeight x (stated flood losses / years of history)
- indicated average annual loss = the larger of the blended figure and offer.minimumRatePerMille x insured value / 1000

What each one is, with its allowed range and reference value:
${JUDGEMENT_KEYS.map((k) => `- offer.${k}: ${JUDGEMENT_LABELS[k]}. Allowed range ${JUDGEMENT_BOUNDS[k].min} to ${JUDGEMENT_BOUNDS[k].max}, reference value ${REFERENCE_JUDGEMENT[k]}. ${JUDGEMENT_EFFECTS[k]}`).join("\n")}

Rules for the ${JUDGEMENT_KEYS.length}:
- Each needs its own reason that points to a fact under "offer" in the input: the number of dry tiers, a distance, a share of wet cells, the basements, the drains, the loss record. Give it the basis "offer". Where the offer's facts say nothing, say so in the reason and use "judgement".
- A loading is a share added to the loss: ${REFERENCE_JUDGEMENT.basementLoading} adds ${Math.round(REFERENCE_JUDGEMENT.basementLoading * 100)}% to it.
- In the offer's facts, null means not known or not stated. It never means zero.
- You never state a loss, a rate or a price for the offer. Code works those out from your figures.`;

const shared = (hasOffer: boolean) => {
  const names = parameterNames(hasOffer);
  return `You are one member of a small panel setting the assumptions for a flood catastrophe model used by a reinsurer in Kenya.

How the work is divided:
- You choose and justify assumptions. You never calculate or state a loss figure; code does all arithmetic.
- Every value must sit inside the allowed range given in the input.
- Every value needs its own reason: one or two plain sentences that point to something specific in the input (a number from the data profile, the JRC reference curve, or the hackathon brief). Do not give the same sentence for several parameters.
- "basis" must be one of: "jrc_reference", "data_profile", "brief", "judgement"${hasOffer ? ', "offer"' : ""}. Use "judgement" when you have no evidence, and say so in the reason.${hasOffer ? ` Use "offer" only for the ${JUDGEMENT_KEYS.length} offer parameters.` : ""}
- Be honest about what is unknown. The portfolio is synthetic. For score datasets the hazard is a proxy, not measured flooding.
- Reply with one JSON object in exactly the shape requested. No markdown, no text outside the JSON.

The ${names.length} parameters, by name:
${names.map((n) => `- ${n}`).join("\n")}

What they mean:
- depthScaleM: assumed flood depth in metres at the highest-scoring spot in the widest tier (the rarest event). Narrower tiers are scaled down by their tier slope, given in the data profile, so depth grows as the event gets rarer. Higher means deeper water everywhere.
- fragility.<class>: multiplies depth before the JRC curve is read. Above 1 means the class is damaged as if the water were deeper.
- cap.<class>: the highest share of a building's value that can be lost.
- returnPeriods.<tier>: years assigned to each tier. They must rise strictly from "extreme" (narrowest footprint, most frequent) to "common" (widest footprint, rarest). Shorter return periods mean the same losses happen more often.${hasOffer ? `\n\n${OFFER_SECTION}` : ""}`;
};

const parameterList = (hasOffer: boolean, extra = "") =>
  `"parameters": [ exactly ${parameterNames(hasOffer).length} entries, one for each parameter name above, in that order: { "name": string, "reason": string, "basis": string,${extra} "value": number } ]`;

/** What each role is asked to do about the offer, added to its brief only when one is loaded. */
const OFFER_BRIEF: Record<Role, string> = {
  optimist: `For the offer, argue the least severe reading of this site that a careful underwriter could still defend. Leniency needs evidence from the offer's facts: the stated point dry in every tier, mapped water far away or covering little of the surroundings, no plant below ground, drains in good order, a long loss record with little in it. Where those facts point the other way, stay near the reference value and say why. A dry point alone is not evidence that the site cannot flood.`,
  cautious: `For the offer, argue the most severe reading of this site that is still credible. Severity needs evidence from the offer's facts: mapped water close to a dry point, a large share of the surroundings wet, critical plant in a basement, drains reported as poor, past flood losses in the document. Where those facts do not support severity, stay near the reference value and say why.`,
  critic: `An offer is loaded, so challenge it as well. At least two of your challenges must be about the offer, and each must rest on its facts in the input. Consider:
- the single cell: whether one dry cell at the stated point can be trusted when mapped water is near, and what a small error in the coordinates would change;
- plant below ground: basements and critical plant that a flood depth at the surface does not see;
- the stated loss history: whether it is long enough and complete enough to carry weight, and what it says against a dry reading of the site;
- the damage curve: the model's curve is a residential one (see the JRC curve's source in the data profile), so say whether this building, by its occupancy, its class and its insured value, is fairly read on it.
For a challenge about the offer, put "offer" or the offer parameter names it bears on in "affects".`,
  chair: `An offer is loaded, so you settle all ${parameterNames(true).length} parameters. In each proposal the ${JUDGEMENT_KEYS.length} offer figures are under "offerJudgement", and the values code applied after enforcing the ranges are under "appliedOfferJudgement". Decide each of the ${JUDGEMENT_KEYS.length} on the offer's facts, name the side you leaned towards, and answer the Critic's challenges about the offer like any other. End your summary with one sentence on how the offer's site was read.`,
};

const roleBrief = (role: Role, hasOffer: boolean): string => {
  const offer = hasOffer ? `\n\n${OFFER_BRIEF[role]}` : "";
  const challenges = challengeLimits(hasOffer);
  switch (role) {
    case "optimist":
      return `Your role: the Optimist. Propose the least severe set of assumptions that a careful underwriter could still defend. You are not allowed to be careless: each lenient choice needs evidence. Where the evidence does not support leniency, stay near the reference value and say why.${offer}

Reply shape:
{
  "stance": one sentence summarising your position,
  ${parameterList(hasOffer)}
}`;
    case "cautious":
      return `Your role: the Cautious voice. Propose the most severe set of assumptions that is still credible, the view of someone who must not be surprised by a bad year. You are not allowed to be alarmist: each severe choice needs evidence. Where the evidence does not support severity, stay near the reference value and say why.${offer}

Reply shape:
{
  "stance": one sentence summarising your position,
  ${parameterList(hasOffer)}
}`;
    case "critic":
      return `Your role: the Critic. You do not propose parameters. You audit the data and the reference assumptions and raise the challenges a sceptical reviewer would raise before trusting any result. Look at the data warnings, how concentrated the insured value is, how much of the score range is actually used, what the hotspot validation says about the hazard layer, and whether the reference parameters are justified by anything.

Raise between ${challenges.minItems} and ${challenges.maxItems} challenges, most important first. Each must be specific to this data, and each recommendation must be something the panel can act on by choosing parameters or by stating a limitation.${offer}

Reply shape:
{
  "summary": two sentences on how far this model's output can be trusted,
  "challenges": [
    { "id": "C1", "title": short title, "detail": what is wrong or uncertain and the evidence, "severity": "high" | "medium" | "low", "affects": [parameter names, or "data", "hazard"${hasOffer ? ', "offer"' : ""}], "recommendation": what to do about it }
  ]
}`;
    case "chair":
      return `Your role: the Chair. You have the Optimist's proposal, the Cautious proposal, the share of insured value each one loses in every scenario (computed by code), and the Critic's challenges. Settle on one final set of assumptions.${offer}

Rules:
- For each parameter choose a value and say why, naming which side you leaned towards. "leans" is "optimist", "cautious", "between", or "outside" (outside both proposals, which needs a strong reason).
- Do not simply average. Decide parameter by parameter on the evidence.
- Answer every challenge from the Critic by its id: "accepted", "partly" or "rejected", with what you did about it.

Reply shape:
{
  "summary": two or three sentences an underwriter could read, describing the agreed view and its main uncertainty,
  ${parameterList(hasOffer, ` "leans": string,`)},
  "responses": [ { "challengeId": "C1", "verdict": "accepted" | "partly" | "rejected", "response": string } ]
}`;
  }
};

/** One side as the Chair sees it: what was proposed, what code applied, and what it produced. */
export interface ChairSide {
  proposal: Proposal;
  applied: ModelParams;
  outcome: OutcomeSummary;
  /** The offer's five figures after code kept them in range. Only there when the agents ran with an offer loaded. */
  appliedOfferJudgement?: OfferJudgement;
}

export interface ChairContext {
  optimist: ChairSide | null;
  cautious: ChairSide | null;
  critique: Critique | null;
}

export interface AgentRequest {
  profile: DataProfile;
  chair?: ChairContext;
  /** The offer being priced, as plain facts. Left out or null, the agents set the model's parameters alone. */
  offer?: OfferBrief | null;
}

export function buildPrompt(role: Role, request: AgentRequest): { system: string; user: string } {
  const hasOffer = request.offer != null;
  const input: Record<string, unknown> = { dataProfile: request.profile };
  if (hasOffer) {
    input.offer = request.offer;
    // By the names the agents reply with, so a range is found under the name it belongs to.
    input.offerFigures = Object.fromEntries(JUDGEMENT_KEYS.map((k) => [`offer.${k}`, { min: JUDGEMENT_BOUNDS[k].min, max: JUDGEMENT_BOUNDS[k].max, reference: REFERENCE_JUDGEMENT[k] }]));
  }
  if (role === "chair") {
    input.optimist = request.chair?.optimist ?? "unavailable";
    input.cautious = request.chair?.cautious ?? "unavailable";
    input.critic = request.chair?.critique ?? "unavailable";
  }
  return {
    system: `${shared(hasOffer)}\n\n${roleBrief(role, hasOffer)}`,
    user: `Input:\n${JSON.stringify(input, null, 1)}`,
  };
}
