/**
 * The walkthrough's steps, in the order a demo follows: the dashboard first, then the offer,
 * then the model from hazard to audit. Every step takes its number and name from here, so
 * moving a step means changing this list and nothing else.
 */
export const STEP_IDS = ["dashboard", "offer", "data", "hazard", "map", "agents", "vulnerability", "loss", "results", "audit"] as const;

export type StepId = (typeof STEP_IDS)[number];

export const STEP_NAMES: Record<StepId, string> = {
  dashboard: "Dashboard",
  offer: "Read the offer",
  data: "Read the data",
  hazard: "Hazard",
  map: "Risk map",
  agents: "Agents",
  vulnerability: "Vulnerability",
  loss: "Loss engine",
  results: "Results",
  audit: "Audit",
};

export const stepIndex = (id: StepId): number => STEP_IDS.indexOf(id);

/** The small line above a step's title: "Step 3". */
export const stepKicker = (id: StepId): string => `Step ${stepIndex(id)}`;
