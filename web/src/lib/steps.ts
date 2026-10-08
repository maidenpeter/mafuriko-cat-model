/**
 * The walkthrough's steps, in the order a demo follows: the dashboard first, then the offer and
 * the data it is priced against, then the agents, then the model from hazard to audit. Every step
 * takes its number and name from here, so moving a step means changing this list and nothing else.
 *
 * The agents come before the hazard map: once an offer is read they argue the assumptions behind
 * its loss drivers beside the model's own parameters, so every step after them shows the price they shaped.
 *
 * The hazard maps and the risk map are one step, "Hazard map": there is no separate map step.
 */
export const STEP_IDS = ["dashboard", "offer", "data", "agents", "hazard", "vulnerability", "loss", "results", "audit"] as const;

export type StepId = (typeof STEP_IDS)[number];

export const STEP_NAMES: Record<StepId, string> = {
  dashboard: "Dashboard",
  offer: "Price an offer",
  data: "Read the data",
  agents: "Agents",
  hazard: "Hazard map",
  vulnerability: "Vulnerability",
  loss: "Loss engine",
  results: "Results",
  audit: "Audit",
};

export const stepIndex = (id: StepId): number => STEP_IDS.indexOf(id);

/** A step's number in words: "Step 3". */
export const stepKicker = (id: StepId): string => `Step ${stepIndex(id)}`;

/** Where a step sits in the walkthrough, for the top bar: "Step 4 of 8". The Dashboard is step 0, so the last step's number is the count. */
export const stepPlace = (id: StepId): string => `${stepKicker(id)} of ${STEP_IDS.length - 1}`;

/**
 * The steps whose content differs between the offer and the portfolio. The control bar shows its
 * "View" switch on these and on no other: the Dashboard and Price an offer read the same either way,
 * and Results is the offer's page whenever an offer is priced, with the portfolio brought in as its context.
 */
export const STEPS_WITH_VIEW: readonly StepId[] = ["data", "agents", "hazard", "vulnerability", "loss", "audit"];
