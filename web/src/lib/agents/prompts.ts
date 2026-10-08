import type { LossMode } from "../model/drivers";
import { SCORE_TIERS, type ModelParams } from "../model/types";
import { AGENT_JUDGEMENT_KEYS, BASEMENT_LADDER, JUDGEMENT_BOUNDS, JUDGEMENT_LABELS, OUTAGE_LADDER, REFERENCE_JUDGEMENT, type OfferJudgement } from "../offer/judgement";
import type { OfferBrief } from "./offerBrief";
import type { DataProfile, OutcomeSummary } from "./profile";
import { challengeLimits } from "./responseSchema";
import { parameterNames, PARAMETER_NAMES, type Critique, type Proposal, type Role } from "./schema";

/** How many of the offer's figures the agents argue. */
const FIGURES = AGENT_JUDGEMENT_KEYS.length;

const named = (keys: (keyof OfferJudgement)[]) => keys.map((k) => `offer.${k}`);
const referenceOf = (keys: (keyof OfferJudgement)[]) => keys.map((k) => REFERENCE_JUDGEMENT[k]).join(", ");
/** A rung's place on its ladder, in words. The rungs run in tier order, most frequent event first. */
const rungOf = (i: number, n: number) => `rung ${i + 1} of ${n}${i === 0 ? ", the most frequent event" : i === n - 1 ? ", the rarest event" : ""}`;
const rungEffects = (ladder: (keyof OfferJudgement)[], name: string) => Object.fromEntries(ladder.map((k, i) => [k, `${name}, ${rungOf(i, ladder.length)}.`]));

/** What each figure the agents argue does to the price, in words. The labels, ranges and reference values are read from judgement.ts. */
const FIGURE_EFFECTS: Partial<Record<keyof OfferJudgement, string>> = {
  bufferRadiusM:
    "Code takes the highest map depth within this distance of the stated point, so mapped water close by counts when the point itself is dry. It stands for the building's footprint plus the error in a stated coordinate. 0 reads the point alone.",
  ingressThresholdM:
    "The depth of water at the site (the deepest of drivers 1 to 3) from which the basements are taken to flood. A lower figure floods them in more events. It has no effect when the document says there are no basements.",
  ...rungEffects(BASEMENT_LADDER, "Basement ladder"),
  belowGroundShare:
    "Used only when the document does not state the value of machinery and contents below ground. A higher share moves value out of the structure and into the basements, where the basement ladder applies.",
  ...rungEffects(OUTAGE_LADDER, "Outage ladder"),
  uncertaintyLoading: "Added on top of drivers 1 to 5 as a line of its own, for causes not modelled: seepage, blocked drains, pump failure.",
};

const OFFER_SECTION = `The offer. The last ${FIGURES} parameters belong to one offer: a single building a broker has asked the reinsurer to price. What code worked out about it is under "offer" in the input, and the allowed ranges and reference values of the ${FIGURES} are under "offerFigures". The first ${PARAMETER_NAMES.length} parameters apply to every building in the model, this one included: set them on the portfolio's evidence exactly as you would with no offer loaded, and do not bend them to suit one building.

Why the ${FIGURES} exist: read at one point, a dry building prices at zero even when the ground around it floods in heavy rain, its drains are overloaded and its plant sits in a basement. So code works out the offer's loss at each return period as the sum of six loss drivers, then takes off the deductible and applies the limit:
1. Surrounding flooding: the highest map depth within offer.bufferRadiusM of the building, not only at the point.
2. Drainage ponding: as the drainage layer gives it.
3. Drain overload: when the event is rarer than the drains were designed for (the design return period the document states, otherwise an assumed one set on screen, ${REFERENCE_JUDGEMENT.drainDesignRp} years unless the underwriter changed it), the site is wet to a shallow assumed depth (${REFERENCE_JUDGEMENT.drainOverloadDepthM} m unless changed) even where the maps are dry.
4. Basement ingress: when water at the site (drivers 1 to 3) reaches offer.ingressThresholdM and the building has basements: value below ground x the basement damage ratio for that event (the basement ladder).
5. Business interruption: only when the document says it is covered: outage days for that event (the outage ladder) x the daily rent or revenue.
6. Uncertainty loading: offer.uncertaintyLoading on top of drivers 1 to 5, for causes not modelled. Always shown apart.
Drivers 1 to 3 all put water at the same building, so the structure's loss is read once on the damage curve, at the deepest of the three. The value below ground is the document's own figure when it states one, otherwise offer.belowGroundShare x the insured value. The structure's value is the insured value less the value below ground, so nothing is counted twice.

How to read the offer's facts: "depthsByTier" gives, for each tier, the map depth at the point (pointM), the highest map depth within the buffer (bufferM, read with the radius under "bufferRadiusM"), drainage ponding (pondingM) and whether the drains are overloaded in that event. The rest says what sits below ground, how it is protected, what the drains were designed for and what is covered.

What each one is, with its allowed range and reference value:
${AGENT_JUDGEMENT_KEYS.map((k) => `- offer.${k}: ${JUDGEMENT_LABELS[k]}. Allowed range ${JUDGEMENT_BOUNDS[k].min} to ${JUDGEMENT_BOUNDS[k].max}, reference value ${REFERENCE_JUDGEMENT[k]}. ${FIGURE_EFFECTS[k] ?? ""}`).join("\n")}

The two ladders. Each holds one figure per tier, in the order ${SCORE_TIERS.map((t) => `"${t}"`).join(", ")}: "${SCORE_TIERS[0]}" is the most frequent event and "${SCORE_TIERS[SCORE_TIERS.length - 1]}" the rarest. A ladder never falls as events get rarer: code raises any rung that is lower than the one before it, and reports the correction.
- The basement ladder (${named(BASEMENT_LADDER).join(", ")}; reference ${referenceOf(BASEMENT_LADDER)}): the share of the value below ground lost when the basements take water. Steeper rungs need evidence that a little water does a lot of damage: plant or switchgear listed on the lowest level, no flood barriers or non-return valves, a sump pump with no power backup or none stated, deep basements, a past flood in a basement. Flatter rungs need protection the document states: barriers and valves present, a pump with a backup, little of value below ground.
- The outage ladder (${named(OUTAGE_LADDER).join(", ")}; reference ${referenceOf(OUTAGE_LADDER)}): the days of rent or revenue lost when the site floods. Steeper rungs need evidence that the building cannot be used until plant is replaced: power, lifts or pumps below ground, deep basements to pump out. Flatter rungs need evidence that it can reopen quickly: plant above ground, a pump with a backup, an occupancy that does not depend on the basements.
Argue each ladder as a ladder: decide from the offer's facts whether it should be steeper or flatter than the reference, then give every rung a value that fits that view. A rung's reason is one short sentence on why it sits where it does against the rung before it.

Rules for the ${FIGURES}:
- Each needs its own reason that points to a fact under "offer" in the input: a depth at the point or within the buffer, an overloaded drain, the basements, what is listed below ground, the pump, the barriers, the cover. Give it the basis "offer". Where the offer's facts say nothing, say so in the reason and use "judgement".
- Keep every reason to one or two short sentences. The reply holds ${PARAMETER_NAMES.length + FIGURES} entries, and long reasons can cut it off before it is complete.
- A share is a fraction of 1: ${REFERENCE_JUDGEMENT.uncertaintyLoading} is ${Math.round(REFERENCE_JUDGEMENT.uncertaintyLoading * 100)}%.
- In the offer's facts, null means not known or not stated. It never means zero, and it is never evidence of protection: what the document leaves out is a question for the broker, not a guess.
- A figure with no effect on this offer still needs a value: the outage ladder when business interruption is not stated as covered, offer.belowGroundShare when the document states the value below ground, the basement figures when the document says there are no basements. Give the reference value and say in the reason that it has no effect here.
- You never state a loss, a rate or a price for the offer. Code works those out from your figures.`;

const shared = (hasOffer: boolean) => {
  const names = parameterNames(hasOffer);
  return `You are one member of a small panel setting the assumptions for a flood catastrophe model used by a reinsurer in Kenya.

How the work is divided:
- You choose and justify assumptions. You never calculate or state a loss figure; code does all arithmetic.
- Every value must sit inside the allowed range given in the input.
- Every value needs its own reason: one or two plain sentences that point to something specific in the input (a number from the data profile, the JRC reference curve, or the hackathon brief). Do not give the same sentence for several parameters.
- "basis" must be one of: "jrc_reference", "data_profile", "brief", "judgement"${hasOffer ? ', "offer"' : ""}. Use "judgement" when you have no evidence, and say so in the reason.${hasOffer ? ` Use "offer" only for the ${FIGURES} offer parameters.` : ""}
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
  optimist: `For the offer, argue the least severe reading of this building that a careful underwriter could still defend. Leniency needs evidence from the offer's facts: the point and the buffer both dry or shallow in every tier, mapped water far away, drains designed for a rare event, no basements or little of value in them, flood barriers and non-return valves present, a sump pump with a power backup, a long loss record with little in it. Where the facts are silent or point the other way, stay near the reference value and say why. A dry point alone is not evidence that the site cannot flood.`,
  cautious: `For the offer, argue the most severe reading of this building that is still credible. Severity needs evidence from the offer's facts: water within the buffer where the point is dry, drains overloaded in frequent events, a drain design the document does not state, equipment listed below ground, deep basements, no barriers or valves, a pump with no backup, past flood losses in the document, a location that is only approximate. Where those facts do not support severity, stay near the reference value and say why.`,
  critic: `An offer is loaded, so challenge it as well, and the reference assumptions behind its loss drivers. At least three of your challenges must be about the offer, and each must rest on its facts in the input. Consider:
- the single dry cell against the buffer: whether one dry cell at the stated point can be trusted when the buffer holds water, what a small error in the coordinates would change, and whether the buffer radius fits a building of this size;
- plant below ground: what is listed in the basements, how it is protected (barriers, non-return valves, the sump pump and its power backup), and whether the reference basement ladder and share of value below ground fit it;
- the drain design: whether the document states a design return period at all, and what an assumed one hides;
- the damage curve: the model's curve is a residential one (see the JRC curve's source in the data profile), so say whether a commercial building, by its occupancy, its class and its insured value, is fairly read on it;
- what the document leaves unstated: each null in the offer's facts that bears on the price is a question for the broker, and must not be filled with a guess;
- the stated loss history: whether it is long enough and complete enough to say anything against the modelled loss.
For a challenge about the offer, put "offer" or the offer parameter names it bears on in "affects".`,
  chair: `An offer is loaded, so you settle all ${parameterNames(true).length} parameters and answer every challenge, those about the offer like any other. In each proposal the ${FIGURES} offer figures are under "offerJudgement", and the values code applied after enforcing the ranges and the ladders are under "appliedOfferJudgement". Decide each of the ${FIGURES} on the offer's facts and name the side you leaned towards. Settle each ladder as a whole: say in its first rung's reason whether it is steeper or flatter than the reference and why, and never let a rung fall below the one before it. End your summary with one sentence on how the offer's site was read.`,
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
  /** The offer's figures this side argued, after code kept them in range and the ladders rising. Only there when the agents ran with an offer loaded. */
  appliedOfferJudgement?: Partial<OfferJudgement>;
}

export interface ChairContext {
  optimist: ChairSide | null;
  cautious: ChairSide | null;
  critique: Critique | null;
}

/** What every agent is told when the portfolio's losses count more than the depth at each building's point. */
const ALL_DRIVERS_BASIS =
  "The portfolio's losses in this run count three loss drivers at every building, not only the depth at its point: surrounding flooding (the highest map depth within a buffer around the building), drainage ponding, and drain overload (a shallow depth once the event is rarer than the drains were designed for, so the return periods of the tiers decide which events overload them). The portfolio has no basement data, so basement ingress and business interruption are not counted for it. Each side's outcome shown to the Chair is on this basis.";

export interface AgentRequest {
  profile: DataProfile;
  chair?: ChairContext;
  /** The offer being priced, as plain facts. Left out or null, the agents set the model's parameters alone. */
  offer?: OfferBrief | null;
  /** The basis the portfolio's losses are worked out on. Left out, or "depth_only", nothing is said: depth at each building's point, as before. */
  lossBasis?: LossMode;
}

export function buildPrompt(role: Role, request: AgentRequest): { system: string; user: string } {
  const hasOffer = request.offer != null;
  const input: Record<string, unknown> = { dataProfile: request.profile };
  // A fixed sentence chosen by code: nothing typed elsewhere travels in this field.
  if (request.lossBasis === "all_drivers") input.lossBasis = ALL_DRIVERS_BASIS;
  if (hasOffer) {
    input.offer = request.offer;
    // By the names the agents reply with, so a range is found under the name it belongs to.
    input.offerFigures = Object.fromEntries(AGENT_JUDGEMENT_KEYS.map((k) => [`offer.${k}`, { min: JUDGEMENT_BOUNDS[k].min, max: JUDGEMENT_BOUNDS[k].max, reference: REFERENCE_JUDGEMENT[k] }]));
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
