import { HOUSING_CLASSES, SCORE_TIERS, type HousingClass, type ModelParams, type ScoreTier } from "./types";

/** Reference assumptions: what the model uses when no agent has spoken. */
export const REFERENCE_PARAMS: ModelParams = {
  depthScaleM: 4.0,
  fragility: {
    informal_iron_sheet: 1.5,
    semi_permanent: 1.2,
    permanent_masonry: 1.0,
    concrete_rcc: 0.7,
  },
  cap: {
    informal_iron_sheet: 0.95,
    semi_permanent: 0.9,
    permanent_masonry: 0.85,
    concrete_rcc: 0.8,
  },
  returnPeriods: { extreme: 10, severe: 25, moderate: 50, occasional: 100, common: 250 },
};

export const BOUNDS = {
  depthScaleM: { min: 1.0, max: 6.0 },
  fragility: { min: 0.4, max: 2.5 },
  cap: { min: 0.6, max: 1.0 },
  returnPeriod: { min: 2, max: 1000 },
} as const;

export interface Adjustment {
  path: string;
  from: number;
  to: number;
  reason: string;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Force a proposed parameter set inside the allowed ranges and report every
 * change made, so nothing is corrected silently.
 */
export function enforceBounds(input: ModelParams): { params: ModelParams; adjustments: Adjustment[] } {
  const adjustments: Adjustment[] = [];
  const fix = (path: string, v: number, min: number, max: number, fallback: number) => {
    const start = Number.isFinite(v) ? v : fallback;
    const out = clamp(start, min, max);
    if (out !== v) {
      adjustments.push({
        path,
        from: v,
        to: out,
        reason: Number.isFinite(v) ? `outside allowed range ${min} to ${max}` : "not a number, reference value used",
      });
    }
    return out;
  };

  const fragility = {} as Record<HousingClass, number>;
  const cap = {} as Record<HousingClass, number>;
  for (const c of HOUSING_CLASSES) {
    fragility[c] = fix(`fragility.${c}`, input.fragility?.[c], BOUNDS.fragility.min, BOUNDS.fragility.max, REFERENCE_PARAMS.fragility[c]);
    cap[c] = fix(`cap.${c}`, input.cap?.[c], BOUNDS.cap.min, BOUNDS.cap.max, REFERENCE_PARAMS.cap[c]);
  }

  // Return periods must rise strictly from the narrowest footprint to the widest.
  const returnPeriods = {} as Record<ScoreTier, number>;
  let previous = 0;
  for (const t of SCORE_TIERS) {
    let rp = fix(`returnPeriods.${t}`, input.returnPeriods?.[t], BOUNDS.returnPeriod.min, BOUNDS.returnPeriod.max, REFERENCE_PARAMS.returnPeriods[t]);
    if (rp <= previous) {
      const raised = previous + 1;
      adjustments.push({ path: `returnPeriods.${t}`, from: rp, to: raised, reason: "must be rarer than the tier before it" });
      rp = raised;
    }
    returnPeriods[t] = rp;
    previous = rp;
  }

  return {
    params: {
      depthScaleM: fix("depthScaleM", input.depthScaleM, BOUNDS.depthScaleM.min, BOUNDS.depthScaleM.max, REFERENCE_PARAMS.depthScaleM),
      fragility,
      cap,
      returnPeriods,
    },
    adjustments,
  };
}

/** Flat list of every parameter, used by the ledger and by comparisons. */
export function flattenParams(p: ModelParams): { path: string; value: number }[] {
  return [
    { path: "depthScaleM", value: p.depthScaleM },
    ...HOUSING_CLASSES.map((c) => ({ path: `fragility.${c}`, value: p.fragility[c] })),
    ...HOUSING_CLASSES.map((c) => ({ path: `cap.${c}`, value: p.cap[c] })),
    ...SCORE_TIERS.map((t) => ({ path: `returnPeriods.${t}`, value: p.returnPeriods[t] })),
  ];
}
