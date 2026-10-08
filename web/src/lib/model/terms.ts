import { averageAnnualLoss, lossAtReturnPeriod, STANDARD_RETURN_PERIODS, type CurvePoint } from "./financial";
import type { Dataset, ModelResult } from "./types";

/**
 * Insurance terms, applied by code after the damage model has produced ground-up losses.
 *
 *   ground-up  the loss to the building before any insurance terms
 *   gross      what the insurer pays: ground-up less the policy deductible, capped at the policy limit
 *   net        what the insurer keeps after reinsurance: gross less the quota share and the
 *              excess of loss recoveries
 *
 * The defaults are example terms, not taken from any real policy or treaty.
 */
export interface InsuranceTerms {
  /** Policy deductible as a share of the building's insured value: 0.02 is 2%. */
  deductibleShare: number;
  /** The deductible is never less than this amount. */
  deductibleMinKes: number;
  /** Policy limit as a share of the building's insured value: 1 is 100%. */
  limitShare: number;
  /** Quota share: the share of every gross loss passed to reinsurers. 0.25 is 25% ceded. */
  quotaShareCeded: number;
  /** Catastrophe excess of loss on the retained share, per event. null means the default below. */
  xolAttachmentKes: number | null;
  /** The most the excess of loss pays in one event. null means the default below. */
  xolLimitKes: number | null;
}

export const DEFAULT_TERMS: InsuranceTerms = {
  deductibleShare: 0.02,
  deductibleMinKes: 50_000,
  limitShare: 1,
  quotaShareCeded: 0.25,
  xolAttachmentKes: null,
  xolLimitKes: null,
};

/** By default the excess of loss starts at the retained 1-in-10 loss and runs out at the retained 1-in-250 loss. */
export const XOL_DEFAULT_ATTACHMENT_RP = 10;
export const XOL_DEFAULT_EXHAUSTION_RP = 250;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Keeps edited terms inside what makes sense: shares between 0 and 1, amounts not below zero. */
export function sanitiseTerms(t: InsuranceTerms): InsuranceTerms {
  const amount = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.max(0, v));
  return {
    deductibleShare: clamp(t.deductibleShare, 0, 1),
    deductibleMinKes: Math.max(0, Number.isFinite(t.deductibleMinKes) ? t.deductibleMinKes : 0),
    limitShare: clamp(t.limitShare, 0, 1),
    quotaShareCeded: clamp(t.quotaShareCeded, 0, 1),
    xolAttachmentKes: amount(t.xolAttachmentKes),
    xolLimitKes: amount(t.xolLimitKes),
  };
}

export interface PolicyLoss {
  /** The part of the loss the policyholder keeps under the deductible. */
  deductibleKes: number;
  /** The part of the loss above the policy limit. */
  overLimitKes: number;
  grossKes: number;
}

/**
 * One building, one event: ground-up loss less the deductible, capped at the limit.
 * The deductible is the larger of the share of insured value and the KES minimum, and never
 * more than the loss itself. No loss means no deductible and nothing paid.
 */
export function policyLoss(groundUpKes: number, tivKes: number, terms: Pick<InsuranceTerms, "deductibleShare" | "deductibleMinKes" | "limitShare">): PolicyLoss {
  if (!(groundUpKes > 0)) return { deductibleKes: 0, overLimitKes: 0, grossKes: 0 };
  const deductibleKes = Math.min(groundUpKes, Math.max(terms.deductibleShare * tivKes, terms.deductibleMinKes));
  const afterDeductible = groundUpKes - deductibleKes;
  const grossKes = Math.min(afterDeductible, terms.limitShare * tivKes);
  return { deductibleKes, overLimitKes: afterDeductible - grossKes, grossKes };
}

/** One event through every layer, portfolio totals. Each line is the one above less what the next party takes. */
export interface LayerRow {
  id: string;
  returnPeriod: number;
  groundUpKes: number;
  /** Kept by policyholders under their deductibles, summed over buildings. */
  deductiblesKes: number;
  /** Above policy limits, summed over buildings. */
  overLimitKes: number;
  grossKes: number;
  /** Recovered from the quota share reinsurers. */
  quotaShareKes: number;
  /** Gross less the quota share: the insurer's share before the excess of loss. */
  retainedKes: number;
  /** Recovered from the excess of loss. */
  xolKes: number;
  netKes: number;
}

export interface TermsLossAt {
  returnPeriod: number;
  /** null when the return period is more frequent than anything modelled. */
  groundUpKes: number | null;
  grossKes: number | null;
  netKes: number | null;
  /** True when held flat beyond the rarest modelled scenario. */
  extrapolated: boolean;
}

export interface TermsResult {
  terms: InsuranceTerms;
  /** The excess of loss actually applied, and whether each figure is the default or was typed in. */
  xol: { attachmentKes: number; limitKes: number; attachmentIsDefault: boolean; limitIsDefault: boolean };
  /** In the order of ModelResult.scenarios, most frequent first. */
  scenarios: LayerRow[];
  /** Gross loss per building and scenario: [building][scenario], in the model result's order. */
  buildingGrossKes: number[][];
  /** The three curves read at the standard return periods. */
  standard: TermsLossAt[];
  aal: { groundUpKes: number; grossKes: number; netKes: number };
}

/** Recovery from an excess of loss layer for one event. */
export const xolRecovery = (retainedKes: number, attachmentKes: number, limitKes: number) => Math.min(limitKes, Math.max(0, retainedKes - attachmentKes));

/**
 * Applies the terms to a model result.
 *
 * Policy terms work building by building. Reinsurance works on the portfolio total of each event:
 * the quota share takes its share of the gross loss, then the excess of loss pays the part of the
 * retained loss above its attachment, up to its limit.
 */
export function applyTerms(dataset: Pick<Dataset, "buildings">, result: ModelResult, input: InsuranceTerms): TermsResult {
  const terms = sanitiseTerms(input);
  const buildingGrossKes: number[][] = result.buildings.map(() => []);

  const beforeXol = result.scenarios.map((s, k) => {
    let deductiblesKes = 0;
    let overLimitKes = 0;
    let grossKes = 0;
    result.buildings.forEach((b, i) => {
      const p = policyLoss(b.perScenario[k].lossKes, dataset.buildings[i].tivKes, terms);
      buildingGrossKes[i][k] = p.grossKes;
      deductiblesKes += p.deductibleKes;
      overLimitKes += p.overLimitKes;
      grossKes += p.grossKes;
    });
    const quotaShareKes = terms.quotaShareCeded * grossKes;
    return { id: s.id, returnPeriod: s.returnPeriod, groundUpKes: s.lossKes, deductiblesKes, overLimitKes, grossKes, quotaShareKes, retainedKes: grossKes - quotaShareKes };
  });

  // Default layer: read off the retained curve. A return period more frequent than anything
  // modelled falls back to the most frequent modelled event, so the layer never starts at zero by accident.
  const retainedCurve: CurvePoint[] = beforeXol.map((r) => ({ returnPeriod: r.returnPeriod, lossKes: r.retainedKes }));
  const retainedAt = (rp: number) => lossAtReturnPeriod(retainedCurve, rp).lossKes ?? retainedCurve[0]?.lossKes ?? 0;
  const attachmentKes = terms.xolAttachmentKes ?? retainedAt(XOL_DEFAULT_ATTACHMENT_RP);
  const limitKes = terms.xolLimitKes ?? Math.max(0, retainedAt(XOL_DEFAULT_EXHAUSTION_RP) - attachmentKes);

  const scenarios: LayerRow[] = beforeXol.map((r) => {
    const xolKes = xolRecovery(r.retainedKes, attachmentKes, limitKes);
    return { ...r, xolKes, netKes: r.retainedKes - xolKes };
  });

  const curve = (pick: (r: LayerRow) => number): CurvePoint[] => scenarios.map((r) => ({ returnPeriod: r.returnPeriod, lossKes: pick(r) }));
  const groundUp = curve((r) => r.groundUpKes);
  const gross = curve((r) => r.grossKes);
  const net = curve((r) => r.netKes);

  return {
    terms,
    xol: { attachmentKes, limitKes, attachmentIsDefault: terms.xolAttachmentKes === null, limitIsDefault: terms.xolLimitKes === null },
    scenarios,
    buildingGrossKes,
    standard: STANDARD_RETURN_PERIODS.map((returnPeriod) => {
      const g = lossAtReturnPeriod(groundUp, returnPeriod);
      return { returnPeriod, groundUpKes: g.lossKes, grossKes: lossAtReturnPeriod(gross, returnPeriod).lossKes, netKes: lossAtReturnPeriod(net, returnPeriod).lossKes, extrapolated: g.extrapolated };
    }),
    aal: { groundUpKes: averageAnnualLoss(groundUp), grossKes: averageAnnualLoss(gross), netKes: averageAnnualLoss(net) },
  };
}
