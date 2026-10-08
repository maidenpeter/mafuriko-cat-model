/**
 * The assumptions behind the loss drivers that act beyond flood depth at a building's point.
 *
 * Read at one point, a dry building prices at zero even when the ground around it floods in
 * heavy rain, its drains are overloaded and its plant sits in a basement. So the loss at each
 * return period is the sum of these drivers, then the deductible and the limit:
 *
 *   1. Surrounding flooding  the highest map depth within bufferRadiusM of the building
 *                            (its footprint plus the error in a stated coordinate), not only at the point
 *   2. Drainage ponding      as the drainage layer gives it
 *   3. Drain overload        when the event is rarer than the drains were designed for (the offer's
 *                            stated design return period, otherwise drainDesignRp) the site is wet
 *                            to drainOverloadDepthM even where the maps are dry
 *   4. Basement ingress      when water at the site (drivers 1 to 3) reaches ingressThresholdM and the
 *                            building has basements: value below ground x the basement damage ratio
 *                            for that event (a ladder, one figure per rung, rising with rarity). The
 *                            value below ground never loses a smaller share than the damage curve
 *                            gives the structure at the same water, so taking it off the curve can
 *                            never make a building cheaper than "Depth only" prices it
 *   5. Business interruption when the offer says it is covered: outage days for that event
 *                            x the daily rent or revenue
 *   6. Uncertainty loading   uncertaintyLoading on top of drivers 1 to 5, for causes not modelled
 *                            (seepage, blocked drains, pump failure). Always shown apart.
 *
 * Drivers 1 to 3 all put water at the same building, so the structure's loss is read once, at the
 * deepest of the three, and each driver is credited with the loss it adds beyond the ones before it:
 * the depth at the point first, then what the surroundings add, then ponding, then drain overload.
 * The parts add up to the loss at the deepest water, and with "Depth only" selected the result is
 * exactly the point reading the model gave before these drivers existed.
 *
 * Every figure here is an assumption, not a measurement. Each has a reference value and an allowed
 * range. The agents may argue the ones in AGENT_JUDGEMENT_KEYS; the rest are set on screen. Code
 * keeps all of them in range, and the two ladders rising with rarity.
 */
export interface OfferJudgement {
  /** Metres around the building within which the highest map depth is taken. */
  bufferRadiusM: number;
  /** Surface water at the site, in metres, at which a basement starts to take water. */
  ingressThresholdM: number;
  /** Share of the value below ground lost when a basement takes water, per rung, most frequent first. */
  basementDamageExtreme: number;
  basementDamageSevere: number;
  basementDamageModerate: number;
  basementDamageOccasional: number;
  basementDamageCommon: number;
  /** Share of the insured value that sits below ground, used when the offer does not state it. */
  belowGroundShare: number;
  /** Days of lost rent or revenue when the site floods, per rung, most frequent first. */
  outageDaysExtreme: number;
  outageDaysSevere: number;
  outageDaysModerate: number;
  outageDaysOccasional: number;
  outageDaysCommon: number;
  /** Share added on top of the modelled loss for causes not modelled: 0.1 is +10%. */
  uncertaintyLoading: number;
  /** Return period, in years, the site's drains are taken to be designed for when the offer does not say. */
  drainDesignRp: number;
  /** Surface water, in metres, when the drains are overloaded. */
  drainOverloadDepthM: number;
  /** A year's rent or revenue as a share of the insured value, used when the offer does not state it. */
  annualRentShare: number;
  /** Cost of the capital the offer ties up: a share of what it adds to the portfolio's 1-in-100 gross loss, per year. */
  costOfCapital: number;
  /** The lowest flood rate any risk inside the mapped area is given, per mille of insured value. */
  minimumRatePerMille: number;
}

export const REFERENCE_JUDGEMENT: OfferJudgement = {
  bufferRadiusM: 250,
  ingressThresholdM: 0.1,
  basementDamageExtreme: 0.15,
  basementDamageSevere: 0.25,
  basementDamageModerate: 0.4,
  basementDamageOccasional: 0.55,
  basementDamageCommon: 0.7,
  belowGroundShare: 0.08,
  outageDaysExtreme: 2,
  outageDaysSevere: 5,
  outageDaysModerate: 10,
  outageDaysOccasional: 20,
  outageDaysCommon: 40,
  uncertaintyLoading: 0.1,
  drainDesignRp: 25,
  drainOverloadDepthM: 0.1,
  annualRentShare: 0.08,
  costOfCapital: 0.08,
  minimumRatePerMille: 0.1,
};

export const JUDGEMENT_KEYS = Object.keys(REFERENCE_JUDGEMENT) as (keyof OfferJudgement)[];

const ladderBound = (max: number) => ({ min: 0, max });
export const JUDGEMENT_BOUNDS: Record<keyof OfferJudgement, { min: number; max: number }> = {
  bufferRadiusM: { min: 0, max: 500 },
  ingressThresholdM: { min: 0, max: 0.5 },
  basementDamageExtreme: ladderBound(1),
  basementDamageSevere: ladderBound(1),
  basementDamageModerate: ladderBound(1),
  basementDamageOccasional: ladderBound(1),
  basementDamageCommon: ladderBound(1),
  belowGroundShare: { min: 0, max: 0.5 },
  outageDaysExtreme: ladderBound(365),
  outageDaysSevere: ladderBound(365),
  outageDaysModerate: ladderBound(365),
  outageDaysOccasional: ladderBound(365),
  outageDaysCommon: ladderBound(365),
  uncertaintyLoading: { min: 0, max: 0.5 },
  drainDesignRp: { min: 2, max: 200 },
  drainOverloadDepthM: { min: 0, max: 0.5 },
  annualRentShare: { min: 0, max: 0.3 },
  costOfCapital: { min: 0, max: 0.3 },
  minimumRatePerMille: { min: 0, max: 2 },
};

/** The two ladders, each rung by rung from the most frequent event to the rarest. A ladder never falls as events get rarer. */
export const BASEMENT_LADDER: (keyof OfferJudgement)[] = ["basementDamageExtreme", "basementDamageSevere", "basementDamageModerate", "basementDamageOccasional", "basementDamageCommon"];
export const OUTAGE_LADDER: (keyof OfferJudgement)[] = ["outageDaysExtreme", "outageDaysSevere", "outageDaysModerate", "outageDaysOccasional", "outageDaysCommon"];

/** The figures the agents may argue when an offer is loaded. The rest are set on screen only. */
export const AGENT_JUDGEMENT_KEYS: (keyof OfferJudgement)[] = ["bufferRadiusM", "ingressThresholdM", ...BASEMENT_LADDER, "belowGroundShare", ...OUTAGE_LADDER, "uncertaintyLoading"];

/** The names the agents use for theirs, beside the model's own parameter names. */
export const JUDGEMENT_PARAMETER_NAMES = AGENT_JUDGEMENT_KEYS.map((k) => `offer.${k}`);

/**
 * A rung of a ladder by its place and its flood: "rung 1 of 5, most frequent flood", "rung 3 of 5",
 * "rung 5 of 5, rarest flood". The one name for a rung on every screen and in every record. With
 * `returnPeriods` (one per rung, most frequent first) the flood is named by its return period
 * instead: "rung 3 of 5, 1-in-50 flood". null for a figure that is not on a ladder.
 */
export function ladderRung(key: keyof OfferJudgement, returnPeriods?: readonly number[]): { ladder: "basement" | "outage"; rung: number; of: number; text: string } | null {
  const basement = BASEMENT_LADDER.indexOf(key);
  const at = basement >= 0 ? basement : OUTAGE_LADDER.indexOf(key);
  if (at < 0) return null;
  const of = BASEMENT_LADDER.length;
  const matched = returnPeriods && returnPeriods.length === of && Number.isFinite(returnPeriods[at]) && returnPeriods[at] > 0;
  const flood = matched ? `, 1-in-${Number(returnPeriods[at].toFixed(2))} flood` : at === 0 ? ", most frequent flood" : at === of - 1 ? ", rarest flood" : "";
  return { ladder: basement >= 0 ? "basement" : "outage", rung: at + 1, of, text: `rung ${at + 1} of ${of}${flood}` };
}

const ladderLabels = (keys: (keyof OfferJudgement)[], text: (rung: string) => string) => Object.fromEntries(keys.map((k) => [k, text(ladderRung(k)!.text)]));

export const JUDGEMENT_LABELS = {
  bufferRadiusM: "Buffer around the building where the highest map depth is taken (m)",
  ingressThresholdM: "Surface water at which a basement takes water (m)",
  ...ladderLabels(BASEMENT_LADDER, (rung) => `Basement damage ratio, ${rung} (share of value below ground)`),
  belowGroundShare: "Share of insured value below ground when the offer does not state it",
  ...ladderLabels(OUTAGE_LADDER, (rung) => `Outage, ${rung} (days)`),
  uncertaintyLoading: "Uncertainty loading for causes not modelled (share of the loss)",
  drainDesignRp: "Drain design return period when the offer does not state it (years)",
  drainOverloadDepthM: "Surface water when the drains are overloaded (m)",
  annualRentShare: "A year's rent or revenue when the offer does not state it (share of insured value)",
  costOfCapital: "Cost of capital on what the offer adds to the portfolio's 1-in-100 gross loss (share per year)",
  minimumRatePerMille: "Minimum flood rate inside the mapped area (per mille)",
} as Record<keyof OfferJudgement, string>;

export interface JudgementAdjustment {
  key: keyof OfferJudgement;
  from: number;
  to: number;
  reason: string;
}

/**
 * Keeps every figure inside its allowed range and each ladder rising with rarity, and reports
 * what was moved. A missing value takes the reference; a value that is not a number does too, and is reported.
 */
export function enforceJudgement(input: Partial<Record<keyof OfferJudgement, unknown>>): { judgement: OfferJudgement; adjustments: JudgementAdjustment[] } {
  const adjustments: JudgementAdjustment[] = [];
  const judgement = { ...REFERENCE_JUDGEMENT };
  for (const key of JUDGEMENT_KEYS) {
    const raw = input[key];
    const { min, max } = JUDGEMENT_BOUNDS[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      if (raw !== undefined) adjustments.push({ key, from: Number.NaN, to: REFERENCE_JUDGEMENT[key], reason: "not a number, reference value used" });
      continue;
    }
    const value = Math.min(max, Math.max(min, raw));
    if (value !== raw) adjustments.push({ key, from: raw, to: value, reason: `outside allowed range ${min} to ${max}` });
    judgement[key] = value;
  }
  for (const ladder of [BASEMENT_LADDER, OUTAGE_LADDER]) {
    for (let i = 1; i < ladder.length; i++) {
      const before = judgement[ladder[i - 1]];
      if (judgement[ladder[i]] < before) {
        adjustments.push({ key: ladder[i], from: judgement[ladder[i]], to: before, reason: "lower than the more frequent rung, raised to match it" });
        judgement[ladder[i]] = before;
      }
    }
  }
  return { judgement, adjustments };
}

/** A ladder's figure for scenario k of n, most frequent first. With other than five scenarios the nearest rung by position is used. */
export function ladderValue(judgement: OfferJudgement, ladder: (keyof OfferJudgement)[], k: number, n: number): number {
  const rung = n <= 1 ? ladder.length - 1 : Math.round((k / (n - 1)) * (ladder.length - 1));
  return judgement[ladder[Math.min(ladder.length - 1, Math.max(0, rung))]];
}
