import type { ModelResult, StandardLoss } from "./types";

export interface CurvePoint {
  returnPeriod: number;
  lossKes: number;
}

export const STANDARD_RETURN_PERIODS = [10, 25, 50, 100, 250];

/**
 * Loss at a return period, read off the curve by interpolating loss against
 * log(return period). Points must be sorted from most frequent to rarest.
 * More frequent than the first point: not modelled. Rarer than the last: held flat.
 */
export function lossAtReturnPeriod(points: CurvePoint[], rp: number): Omit<StandardLoss, "returnPeriod"> {
  if (points.length === 0) return { lossKes: null, extrapolated: false };
  const first = points[0];
  const last = points[points.length - 1];
  if (rp < first.returnPeriod) return { lossKes: null, extrapolated: false };
  if (rp > last.returnPeriod) return { lossKes: last.lossKes, extrapolated: true };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (rp <= b.returnPeriod) {
      const t = (Math.log(rp) - Math.log(a.returnPeriod)) / (Math.log(b.returnPeriod) - Math.log(a.returnPeriod));
      return { lossKes: a.lossKes + t * (b.lossKes - a.lossKes), extrapolated: false };
    }
  }
  return { lossKes: first.lossKes, extrapolated: false };
}

/**
 * Average annual loss: area under loss against annual exceedance probability.
 * Assumptions: no loss from events more frequent than the first point, and the
 * loss stays at the last point's level for anything rarer.
 */
export function averageAnnualLoss(points: CurvePoint[]): number {
  if (points.length === 0) return 0;
  let aal = 0;
  for (let i = 1; i < points.length; i++) {
    const pA = 1 / points[i - 1].returnPeriod;
    const pB = 1 / points[i].returnPeriod;
    aal += (pA - pB) * 0.5 * (points[i - 1].lossKes + points[i].lossKes);
  }
  const last = points[points.length - 1];
  aal += (1 / last.returnPeriod) * last.lossKes;
  return aal;
}

/**
 * Average annual loss as Oasis builds it from a period table: each scenario counts only for the
 * band of annual probability between its own return period and the next rarer one. This is the
 * step (lower) reading of the same curve the trapezoid above interpolates.
 */
export function bandedAal(result: Pick<ModelResult, "scenarios">): number {
  const s = result.scenarios;
  return s.reduce((t, x, i) => t + (1 / x.returnPeriod - (i + 1 < s.length ? 1 / s[i + 1].returnPeriod : 0)) * x.lossKes, 0);
}
