import { fmtKes, fmtNum } from "../format";
import { policyLoss } from "../model/terms";
import type { DescribeTerms, GrossLoss, GrossLosses, PolicyTerms, PolicyTermsOf } from "./types";
import { usableValue } from "./verify";

/**
 * The deductible and the limit of one offer, and the formula that applies them:
 *
 *   gross loss = the lesser of the limit and (ground-up loss less the deductible)
 *
 * What the document states is used. What it does not state comes from the example terms of the
 * Insurance terms panel, through policyLoss, the same function the portfolio uses. Each of the
 * two terms records which it was, so the screen can say so.
 */

/** A stated amount that can be used: a number of zero or more. Anything else counts as not stated. */
const amount = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v >= 0 ? v : null);

const share = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const sum = (values: readonly number[]) => values.reduce((t, v) => t + v, 0);

export const policyTerms: PolicyTermsOf = (terms, defaults) => {
  const pct = amount(usableValue(terms.floodDeductiblePct));
  const minKes = amount(usableValue(terms.floodDeductibleMinKes));
  const limitKes = amount(usableValue(terms.floodLimitKes));
  return {
    deductible:
      pct !== null || minKes !== null
        ? { source: "document", pct, minKes, basis: usableValue(terms.floodDeductibleBasis) ?? "percent_of_loss" }
        : { source: "example", share: share(defaults.deductibleShare), minKes: amount(defaults.deductibleMinKes) ?? 0 },
    limit: limitKes !== null ? { source: "document", kes: limitKes } : { source: "example", share: share(defaults.limitShare) },
  };
};

/** One building in one flood, taken through the terms: what each party keeps. The three add up to the ground-up loss. */
export interface TermsSplit {
  /** The part of the loss the policyholder keeps under the deductible. */
  deductibleKes: number;
  /** The part of the loss above the limit. */
  overLimitKes: number;
  /** What the insurer pays: ground-up less the deductible, capped at the limit. */
  grossKes: number;
}

/**
 * One flood, every building of the offer, by the formulas on PolicyTerms: the deductible taken,
 * the amount over the limit and the gross loss of each building, in the order given.
 * grossLosses is this function's gross column, so the two can never disagree.
 */
export const termsSplit = (groundUpKes: readonly number[], tivKes: readonly number[], terms: PolicyTerms): TermsSplit[] => {
  const loss = groundUpKes.map((v) => (v > 0 ? v : 0));
  const tiv = loss.map((_, i) => (tivKes[i] > 0 ? tivKes[i] : 0));
  const total = sum(loss);
  // No loss, no deductible: a KES minimum is only ever taken out of a loss that happened.
  if (!(total > 0)) return loss.map(() => ({ deductibleKes: 0, overLimitKes: 0, grossKes: 0 }));

  const { deductible, limit } = terms;
  // The panel's terms for both: exactly what the portfolio does, building by building.
  if (deductible.source === "example" && limit.source === "example") {
    return loss.map((v, i) => policyLoss(v, tiv[i], { deductibleShare: deductible.share, deductibleMinKes: deductible.minKes, limitShare: limit.share }));
  }

  let after: number[];
  if (deductible.source === "document") {
    // Once per flood, on the whole offer, and shared in proportion to each building's loss.
    const base = deductible.basis === "percent_of_sum_insured" ? sum(tiv) : total;
    const taken = Math.min(total, Math.max(deductible.pct !== null ? (deductible.pct / 100) * base : 0, deductible.minKes ?? 0));
    after = loss.map((v) => v - taken * (v / total));
  } else {
    // A limit of the whole insured value never bites after a deductible, so this reads off the deductible alone.
    after = loss.map((v, i) => v - policyLoss(v, tiv[i], { deductibleShare: deductible.share, deductibleMinKes: deductible.minKes, limitShare: 1 }).deductibleKes);
  }
  after = after.map((v) => Math.max(0, v));

  let gross: number[];
  if (limit.source === "document") {
    const left = sum(after);
    gross = left > limit.kes ? after.map((v) => limit.kes * (v / left)) : after;
  } else {
    gross = after.map((v, i) => Math.min(v, limit.share * tiv[i]));
  }
  return loss.map((v, i) => ({ deductibleKes: v - after[i], overLimitKes: after[i] - gross[i], grossKes: gross[i] }));
};

export const grossLosses: GrossLosses = (groundUpKes, tivKes, terms) => termsSplit(groundUpKes, tivKes, terms).map((x) => x.grossKes);

export const grossLoss: GrossLoss = (groundUpKes, terms, tivKes) => grossLosses([groundUpKes], [tivKes], terms)[0];

export const describeTerms: DescribeTerms = ({ deductible, limit }) => {
  let d: string;
  if (deductible.source === "example") {
    d = `${fmtNum(deductible.share * 100)}% of the building's insured value, and never less than ${fmtKes(deductible.minKes)}`;
  } else if (deductible.pct !== null) {
    const of = deductible.basis === "percent_of_sum_insured" ? "the insured value, as the text says" : "each loss";
    d = `${fmtNum(deductible.pct)}% of ${of}, ${deductible.minKes !== null ? `with a minimum of ${fmtKes(deductible.minKes)}` : "with no KES minimum stated"}`;
  } else {
    d = `a flat ${fmtKes(deductible.minKes ?? 0)} for each flood, as no percentage is stated`;
  }
  const l = limit.source === "example" ? `${fmtNum(limit.share * 100)}% of the building's insured value` : `${fmtKes(limit.kes)} for one flood`;
  return { deductible: `${d}.`, limit: `${l}.` };
};
