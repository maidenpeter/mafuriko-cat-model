/**
 * Logic for the underwriter's decision page. Pure: no React, no storage, no network.
 *
 * How to use it:
 *   const flags = flagsFromChecks(checks, extraFlags);          // points for the underwriter, worst first
 *   const conditions = suggestedConditions(flags, facts);       // suggestions drawn from the flags and facts
 *   const [record, setRecord] = useState(emptyDecision());      // what the underwriter records
 *   const problems = validateDecision(record, conditions.map((c) => c.id));
 *   if (problems.length === 0) setRecord(stampDecision(record)); // sets recordedAt
 *
 * Show DECISION_STANCE near the four choices. The tool never fills in `choice` itself.
 */

export type Severity = "high" | "medium" | "low";

export type FlagEvidence = {
  /** "quote" is words from the offer document, "figure" is a number from the model. */
  kind: "quote" | "figure";
  text: string;
};

export type Flag = {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: FlagEvidence;
};

/** A check as the page already has it. Evidence is optional: without it the detail stands as a model figure. */
export type CheckInput = {
  id: string;
  status: "pass" | "warn" | "fail";
  title: string;
  detail: string;
  evidence?: FlagEvidence;
};

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low"];

/** Always show the word next to any colour or shape. */
export const SEVERITY_LABELS: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const EVIDENCE_LABELS: Record<FlagEvidence["kind"], string> = {
  quote: "Document quote",
  figure: "Model figure",
};

/** Worst first, then by title, then by id so the order never changes between renders. */
export function sortFlags(flags: Flag[]): Flag[] {
  return [...flags].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.title.localeCompare(b.title, "en") ||
      a.id.localeCompare(b.id, "en"),
  );
}

/**
 * Failed checks become high flags and warnings medium ones; passes are not flags.
 * Extra flags are merged in. Where an extra flag has the same id as a check, the extra flag wins.
 */
export function flagsFromChecks(checks: CheckInput[], extra: Flag[] = []): Flag[] {
  const byId = new Map<string, Flag>();
  for (const check of checks) {
    if (check.status === "pass") continue;
    byId.set(check.id, {
      id: check.id,
      severity: check.status === "fail" ? "high" : "medium",
      title: check.title,
      detail: check.detail,
      evidence: check.evidence ?? { kind: "figure", text: check.detail },
    });
  }
  for (const flag of extra) byId.set(flag.id, flag);
  return sortFlags([...byId.values()]);
}

/** How many flags there are at each severity, for a one-line count. */
export function countFlags(flags: Flag[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const flag of flags) counts[flag.severity] += 1;
  return counts;
}

/** What is known about the offer. Use null where a value is unknown. An unknown number of basements supports the survey suggestion; pass 0 when the document says there are none. */
export type OfferFacts = {
  /** Number of basement levels, or null when the document does not say. */
  basements: number | null;
  criticalPlantInBasement: boolean;
  pastFloodLoss: boolean;
  /** True when the site is dry at every modelled return period. */
  dryInEveryTier: boolean;
  /** Distance in metres to the nearest cell that floods, or null when unknown. */
  nearestWetCellM: number | null;
  /** True when the location was placed from an address or area name instead of surveyed coordinates. */
  approximateLocation: boolean;
  /** How many values could not be matched to a quote in the document. */
  unverifiedValues: number;
  underInsured: boolean;
  commercialOnResidentialCurve: boolean;
  drainagePoor: boolean;
  grossLoss100Kes: number | null;
  tivKes: number | null;
  /**
   * The facts behind the loss drivers beyond flood depth. Each may be left out (the fact is then
   * not looked at); null means the document does not say. buildOfferFocus fills them from the
   * document's usable values once the offer is priced.
   */
  /** How many items of equipment the document places below ground. */
  equipmentBelowGround?: number;
  /** True when the document states the return period the site's drains were designed for; false when the price uses an assumed one. */
  drainDesignStated?: boolean;
  /** Whether the basement sump pumps have backup power. */
  sumpPumpBackup?: "yes" | "no" | null;
  floodBarriers?: "present" | "absent" | null;
  nonReturnValves?: "present" | "absent" | null;
  /** Whether business interruption is covered for flood. */
  interruptionCover?: "covered" | "excluded" | null;
};

export const EMPTY_FACTS: OfferFacts = {
  basements: null,
  criticalPlantInBasement: false,
  pastFloodLoss: false,
  dryInEveryTier: false,
  nearestWetCellM: null,
  approximateLocation: false,
  unverifiedValues: 0,
  underInsured: false,
  commercialOnResidentialCurve: false,
  drainagePoor: false,
  grossLoss100Kes: null,
  tivKes: null,
};

export type SuggestedCondition = {
  id: string;
  /** The suggestion, worded for the underwriter to consider. */
  text: string;
  /** Plain reasons this suggestion appears. Never empty. */
  why: string;
  /** Ids of the flags that support it. May be empty when only a fact supports it. */
  because: string[];
};

/** A 1-in-100 gross loss at or above this share of the sum insured supports a flood sub-limit. */
export const SUBLIMIT_LOSS_SHARE = 0.1;
/** A 1-in-100 gross loss at or above this share of the sum insured supports a higher flood deductible. */
export const DEDUCTIBLE_LOSS_SHARE = 0.03;
/** A dry site this close (metres) to a cell that floods supports a survey before binding. */
export const NEAR_WET_CELL_M = 250;

const pct = (fraction: number) => `${(fraction * 100).toFixed(1).replace(/\.0$/, "")}%`;

/** The flags with one of these ids, in the order the page has them. Ids only: no flag's words are read. */
const flagged = (flags: Flag[], ids: readonly string[]): string[] => flags.filter((flag) => ids.includes(flag.id)).map((flag) => flag.id);

/** Flags whose id or title mentions one of the words. Matching is on whole words, ignoring case. */
function flagsAbout(flags: Flag[], words: RegExp): string[] {
  return flags.filter((flag) => words.test(`${flag.id.replace(/[_-]+/g, " ")} ${flag.title}`)).map((flag) => flag.id);
}

/**
 * Suggestions drawn from the flags and the facts. Each one appears only when a fact or a flag supports it,
 * and says why. They are suggestions: the underwriter ticks the ones to apply.
 *
 * The suggestions on the loss drivers beyond depth (the drain design, pump backup, barriers and
 * valves, business interruption) and the one on drainage upkeep rest on the facts alone: a fact
 * that is left out is not looked at, and no flag's wording stands in for it. Where the fact holds,
 * the flags named beside it (by id) are listed as its support.
 */
export function suggestedConditions(flags: Flag[], facts: OfferFacts): SuggestedCondition[] {
  const out: SuggestedCondition[] = [];
  const add = (id: string, text: string, reasons: (string | false | null)[], because: string[]) => {
    const said = reasons.filter((reason): reason is string => typeof reason === "string");
    if (said.length === 0 && because.length === 0) return;
    const flagged = because.length > 0 ? [`${because.length === 1 ? "A flag" : `${because.length} flags`} on this page point to it.`] : [];
    out.push({ id, text, why: [...said, ...flagged].join(" "), because });
  };

  const lossShare =
    facts.grossLoss100Kes !== null && facts.tivKes !== null && facts.tivKes > 0 && facts.grossLoss100Kes > 0
      ? facts.grossLoss100Kes / facts.tivKes
      : null;
  const nearWet =
    facts.dryInEveryTier && facts.nearestWetCellM !== null && facts.nearestWetCellM <= NEAR_WET_CELL_M;

  add(
    "relocate_plant",
    "Consider asking for critical plant to be moved out of the basement, or protected where it stands (raised plinths, flood barriers, sump pumps).",
    [
      facts.criticalPlantInBasement && "The offer places critical plant in a basement, where flood water collects first.",
      (facts.equipmentBelowGround ?? 0) > 0 &&
        (facts.equipmentBelowGround === 1
          ? "The offer lists 1 item of equipment below ground."
          : `The offer lists ${facts.equipmentBelowGround} items of equipment below ground.`),
    ],
    flagsAbout(flags, /\b(basements?|plant)\b/i),
  );

  // A building the document says has no basement is asked for nothing that protects one.
  const mayHaveBasement = facts.basements !== 0;
  // The flags that support a suggestion, by id, counted only when the fact behind the suggestion holds.
  const support = (holds: boolean, ...ids: string[]) => (holds ? flagged(flags, ids) : []);

  const designAssumed = facts.drainDesignStated === false;
  add(
    "drain_design",
    "Consider asking for the return period the site's storm drains were designed for, with the drawings or a drainage survey that shows it.",
    [designAssumed && "The offer does not state what storm the drains were designed for, so the Drain overload loss rests on an assumed design."],
    support(designAssumed, "drain-overload"),
  );

  const noBackup = mayHaveBasement && facts.sumpPumpBackup === "no";
  const backupNotSaid = mayHaveBasement && facts.sumpPumpBackup === null;
  add(
    "pump_backup",
    "Consider requiring backup power for the basement sump pumps, tested on a schedule.",
    [
      noBackup && "The offer says the sump pumps have no backup power, and the mains often fail in the storm that floods a basement.",
      backupNotSaid && "The offer does not say whether the sump pumps have backup power.",
    ],
    support(noBackup || backupNotSaid, "basement-ingress"),
  );

  const noBarriers = mayHaveBasement && facts.floodBarriers === "absent";
  const barriersNotSaid = mayHaveBasement && facts.floodBarriers === null;
  const noValves = mayHaveBasement && facts.nonReturnValves === "absent";
  const valvesNotSaid = mayHaveBasement && facts.nonReturnValves === null;
  add(
    "ingress_protection",
    "Consider requiring flood barriers at the basement ramps and openings, and non-return valves on the drains that serve the basement.",
    [
      noBarriers && "The offer says there are no flood barriers.",
      barriersNotSaid && "The offer does not say whether flood barriers are fitted.",
      noValves && "The offer says there are no non-return valves.",
      valvesNotSaid && "The offer does not say whether non-return valves are fitted.",
    ],
    support(noBarriers || barriersNotSaid || noValves || valvesNotSaid, "basement-ingress"),
  );

  const coverNotSaid = facts.interruptionCover === null;
  add(
    "confirm_interruption",
    "Consider confirming in writing whether business interruption or loss of rent is insured for flood, and leaving it out of the cover until its sum insured is declared.",
    [coverNotSaid && "The offer does not say whether business interruption is covered, so no loss of rent or revenue is in the price."],
    support(coverNotSaid, "interruption-not-stated"),
  );

  add(
    "flood_sublimit",
    "Consider a flood sub-limit below the full sum insured.",
    [
      lossShare !== null &&
        lossShare >= SUBLIMIT_LOSS_SHARE &&
        `The 1-in-100 gross loss is ${pct(lossShare)} of the sum insured.`,
      facts.pastFloodLoss && "The offer reports a past flood loss.",
    ],
    flagsAbout(flags, /\b(sub ?limits?|accumulation|concentration)\b/i),
  );

  add(
    "higher_deductible",
    "Consider a higher flood deductible than the one offered.",
    [
      facts.pastFloodLoss && "A past flood loss suggests smaller floods will recur.",
      lossShare !== null &&
        lossShare >= DEDUCTIBLE_LOSS_SHARE &&
        `The 1-in-100 gross loss is ${pct(lossShare)} of the sum insured.`,
    ],
    flagsAbout(flags, /\b(deductibles?|excess|past (flood )?loss(es)?|loss history)\b/i),
  );

  add(
    "survey_before_binding",
    "Consider a survey to confirm the coordinates and floor levels before binding.",
    [
      facts.approximateLocation && "The location is approximate, so the flood depth at the site is uncertain.",
      nearWet &&
        `The site is dry at every return period but only ${Math.round(facts.nearestWetCellM ?? 0)} m from ground that floods, so a small error in position changes the answer.`,
      facts.basements === null && "The document does not say whether there are basements.",
    ],
    flagsAbout(flags, /\b(coordinates?|location|geocod\w*|floor levels?|survey)\b/i),
  );

  add(
    "drainage_evidence",
    "Consider asking for evidence that site drainage is maintained (cleaning records, photographs, a maintenance contract).",
    // Only on a report of poor drainage. An open question about the drains, assumed ponding or an
    // overloaded drain design is not a report on how the drains are kept.
    [facts.drainagePoor && "Drainage at or around the site is reported as poor."],
    support(facts.drainagePoor, "drainage-condition"),
  );

  add(
    "revaluation",
    "Consider asking for a revaluation of the sums insured, or applying an average clause.",
    [facts.underInsured && "The declared values look low for the property described, so under-insurance is possible."],
    flagsAbout(flags, /\b(under[ -]?insur\w*|valuation|revaluation)\b/i),
  );

  add(
    "confirm_unverified",
    "Consider asking the broker to confirm every value that could not be found in the document.",
    [
      facts.unverifiedValues > 0 &&
        (facts.unverifiedValues === 1
          ? "1 value could not be matched to a quote in the document."
          : `${facts.unverifiedValues} values could not be matched to a quote in the document.`),
    ],
    flagsAbout(flags, /\b(unverified|not verified|not found|no quote)\b/i),
  );

  add(
    "confirm_occupancy",
    "Consider asking for contents and stock details, and treating the modelled loss as indicative until they arrive.",
    [
      facts.commercialOnResidentialCurve &&
        "A commercial risk is priced here on a residential damage curve, which can understate loss to stock and equipment.",
    ],
    flagsAbout(flags, /\b(damage curve|vulnerability|occupancy)\b/i),
  );

  return out;
}

export type DecisionChoice = "accept" | "accept_with_conditions" | "refer" | "decline";

/** The order the four choices appear on screen. */
export const DECISION_CHOICES: DecisionChoice[] = ["accept", "accept_with_conditions", "refer", "decline"];

export const DECISION_LABELS: Record<DecisionChoice, string> = {
  accept: "Accept",
  accept_with_conditions: "Accept with conditions",
  refer: "Refer",
  decline: "Decline",
};

export type DecisionRecord = {
  choice: DecisionChoice | null;
  note: string;
  /** Ids of the suggested conditions the underwriter ticked. */
  conditions: string[];
  /** ISO time the decision was recorded, or null while it is a draft. */
  recordedAt: string | null;
};

/** Show this next to the four choices. */
export const DECISION_STANCE =
  "This tool does not accept or decline. It sets out the figures and the points to weigh; the underwriter decides and records the decision.";

export const emptyDecision = (): DecisionRecord => ({ choice: null, note: "", conditions: [], recordedAt: null });

/** Tick or untick one condition. Returns a new record; the draft loses its recorded time. */
export function toggleCondition(record: DecisionRecord, id: string): DecisionRecord {
  const conditions = record.conditions.includes(id)
    ? record.conditions.filter((c) => c !== id)
    : [...record.conditions, id];
  return { ...record, conditions, recordedAt: null };
}

/**
 * Plain messages for what is missing; an empty list means the decision can be recorded.
 * Pass the ids of the conditions on screen so that ticks for conditions no longer suggested do not count.
 */
export function validateDecision(record: DecisionRecord, availableConditionIds?: string[]): string[] {
  const messages: string[] = [];
  if (record.choice === null) {
    messages.push("Choose Accept, Accept with conditions, Refer or Decline.");
    return messages;
  }
  const ticked = availableConditionIds
    ? record.conditions.filter((id) => availableConditionIds.includes(id))
    : record.conditions;
  if (record.choice === "accept_with_conditions" && ticked.length === 0) {
    messages.push("Tick at least one condition to accept with conditions.");
  }
  if ((record.choice === "refer" || record.choice === "decline") && record.note.trim() === "") {
    messages.push(`Add a note saying why you ${record.choice === "refer" ? "refer" : "decline"} this offer.`);
  }
  return messages;
}

/** The record with its note trimmed and the time it was recorded. Call only when validateDecision returns nothing. */
export function stampDecision(record: DecisionRecord, now: Date = new Date()): DecisionRecord {
  return { ...record, note: record.note.trim(), recordedAt: now.toISOString() };
}
