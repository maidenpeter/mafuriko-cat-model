/**
 * The judgement calls behind an offer's technical price.
 *
 * Reading the flood map at one stated point can give a loss of zero for a building that
 * plainly can flood: mapped water a few metres away, plant in the basement, a past flood in
 * the broker's own document. So the price is built from all the evidence, by code:
 *
 *   1. the model at the stated point                          (may be zero; kept as evidence)
 *   2. the model around the site: the damage ratio averaged over every map cell within
 *      siteRadiusM of the point, so nearby mapped water counts in proportion to how much
 *      of the surroundings it covers (a radius of 0 is the point reading)
 *   3. story loadings on that loss: basementLoading when the document puts critical plant
 *      in a basement (half of it when it states basements with no plant in them), and
 *      drainageLoading when it reports poor or blocked drainage
 *   4. the document's own flood loss history: stated flood losses divided by the years of
 *      history, blended in with experienceWeight when the document states both
 *   5. minimumRatePerMille: no risk inside the mapped area is priced at zero
 *
 *   loaded loss at each return period = insured value x site-averaged damage ratio x (1 + loadings)
 *   model AAL        = area under that curve, as for the portfolio
 *   blended AAL      = (1 - w) x model AAL + w x experience AAL      (w = 0 with no history stated)
 *   indicated AAL    = the larger of the blended AAL and minimum rate x insured value
 *   indicated rate   = indicated AAL / insured value x 1000, per mille
 *
 * The five figures below are assumptions, not measurements. Each has a reference value and an
 * allowed range; the agents may argue them when an offer is loaded, and code keeps them in range.
 */
export interface OfferJudgement {
  /** Metres around the stated point over which the flood maps are read. */
  siteRadiusM: number;
  /** Share added to the flood loss when critical plant is kept in a basement: 0.25 is +25%. */
  basementLoading: number;
  /** Share added when the document reports poor, blocked or silted drainage at the site. */
  drainageLoading: number;
  /** Weight given to the document's own flood loss history, 0 to 1. */
  experienceWeight: number;
  /** The lowest pure flood rate any risk inside the mapped area is given, per mille of insured value. */
  minimumRatePerMille: number;
}

export const REFERENCE_JUDGEMENT: OfferJudgement = {
  siteRadiusM: 100,
  basementLoading: 0.25,
  drainageLoading: 0.1,
  experienceWeight: 0.3,
  minimumRatePerMille: 0.1,
};

export const JUDGEMENT_BOUNDS: Record<keyof OfferJudgement, { min: number; max: number }> = {
  siteRadiusM: { min: 0, max: 500 },
  basementLoading: { min: 0, max: 1 },
  drainageLoading: { min: 0, max: 0.5 },
  experienceWeight: { min: 0, max: 1 },
  minimumRatePerMille: { min: 0, max: 2 },
};

export const JUDGEMENT_KEYS = Object.keys(REFERENCE_JUDGEMENT) as (keyof OfferJudgement)[];

/** The names the agents use for these five, beside the model's own parameter names. */
export const JUDGEMENT_PARAMETER_NAMES = JUDGEMENT_KEYS.map((k) => `offer.${k}`);

export const JUDGEMENT_LABELS: Record<keyof OfferJudgement, string> = {
  siteRadiusM: "Radius around the stated point where the flood maps are read (m)",
  basementLoading: "Loading for critical plant in a basement (share of the loss)",
  drainageLoading: "Loading for drainage reported as poor (share of the loss)",
  experienceWeight: "Weight on the document's own flood loss history (0 to 1)",
  minimumRatePerMille: "Minimum pure flood rate inside the mapped area (per mille)",
};

export interface JudgementAdjustment {
  key: keyof OfferJudgement;
  from: number;
  to: number;
  reason: string;
}

/** Keeps every figure inside its allowed range and reports what was moved. A missing or non-numeric value falls back to the reference. */
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
  return { judgement, adjustments };
}
