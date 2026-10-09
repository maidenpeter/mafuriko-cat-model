"use client";

/**
 * The offer's own curves, read off the same pricing the rest of the page shows:
 *
 *   OfferLossCurve    how large a loss, how often: the ground-up loss with all loss drivers, the gross
 *                     loss after the offer's deductible and limit, and the ground-up loss on Depth only
 *   OfferDamageCurve  the share of the insured value lost at each return period, all loss drivers
 *                     beside Depth only
 *
 * Both are worked out here from the offer as priced: the same building, document, terms, parameters
 * and judgement figures, run once with all loss drivers and once on depth alone. Nothing is typed
 * in and nothing is assumed beyond what the offer's price already rests on.
 */

import { useMemo } from "react";
import { offerTarget } from "@/lib/interpret";
import { annualChance, kes1, rpLabel, rpWithChance, shareText } from "@/lib/labels";
import type { Dataset, ModelParams } from "@/lib/model/types";
import { offerDrivers } from "@/lib/offer/drivers";
import type { PricedFocus } from "@/lib/offer/focus";
import { ChartFrame, type ChartSource } from "./ChartFrame";
import { LineChart, type Point } from "./LineChart";

/** One modelled flood of the offer under both readings. */
export interface OfferCurveRow {
  returnPeriod: number;
  /** Ground-up loss with all loss drivers, in KES. */
  groundUpKes: number;
  /** Gross loss with all loss drivers: after the offer's deductible and limit. */
  grossKes: number;
  /** Ground-up loss on depth alone, in KES. */
  depthOnlyKes: number;
}

/**
 * The offer's losses at each modelled return period, with all loss drivers and on depth alone,
 * under the parameters and the judgement figures in force. Empty when the offer cannot be priced.
 */
export function offerCurveRows(focus: PricedFocus, dataset: Dataset, params: ModelParams): OfferCurveRow[] {
  const { offer } = offerTarget(focus, dataset);
  const run = (mode: "all_drivers" | "depth_only") =>
    offerDrivers({ dataset: offer.dataset, params, building: offer.building, others: offer.others, extraction: offer.extraction, terms: offer.terms, judgement: focus.drivers.judgement, mode, offerTivKes: offer.offerTivKes });
  const all = run("all_drivers");
  const depth = run("depth_only");
  if (!all || !depth) return [];
  return all.perReturnPeriod
    .map((r) => ({ returnPeriod: r.returnPeriod, groundUpKes: r.groundUpTotalKes, grossKes: r.grossKes, depthOnlyKes: depth.perReturnPeriod.find((d) => d.id === r.id)?.groundUpTotalKes ?? 0 }))
    .sort((a, b) => a.returnPeriod - b.returnPeriod);
}

/** The rows, kept while the offer, the data set and the parameters stay the same. */
export function useOfferCurveRows(focus: PricedFocus | null, dataset: Dataset, params: ModelParams): OfferCurveRow[] {
  return useMemo(() => {
    if (!focus) return [];
    try {
      return offerCurveRows(focus, dataset, params);
    } catch {
      return [];
    }
  }, [focus, dataset, params]);
}

interface Props {
  focus: PricedFocus;
  rows: OfferCurveRow[];
  /** Where the figures come from: the maps, the offer, the assumptions in force. */
  sources: ChartSource[];
  /** A smaller chart with a shorter title, for the Dashboard. */
  compact?: boolean;
  className?: string;
}

const READ_LOSS = "Read across from a return period to the loss: a 1-in-100 loss has about a 1% chance of being exceeded in any year.";
const X_LABEL = "Return period, with the chance of it being exceeded in any one year";

const points = (rows: OfferCurveRow[], y: (row: OfferCurveRow) => number): Point[] => rows.map((row) => ({ x: row.returnPeriod, y: y(row) }));

/** How large a loss, how often, for the offer. */
export function OfferLossCurve({ focus, rows, sources, compact = false, className = "" }: Props) {
  const name = focus.building.name;
  if (rows.length === 0) return null;
  const xs = rows.map((r) => r.returnPeriod);
  return (
    <ChartFrame
      className={className}
      title={compact ? `Loss curve for this offer: how large a loss, how often` : `Loss curve for ${name}: how large a loss, how often`}
      subtitle={`${READ_LOSS} The solid lines count every loss driver, before and after the offer's deductible and limit; the dashed line is the loss from the depth of water at the building alone.`}
      sources={sources}
    >
      <LineChart
        ariaLabel={`Loss curve for ${name}: the ground-up loss with all loss drivers, the gross loss after the offer's deductible and limit, and the ground-up loss on depth only, at each return period from ${rpLabel(xs[0])} to ${rpLabel(xs[xs.length - 1])}`}
        xScale="log"
        xTicks={xs}
        xFormat={rpLabel}
        xSubFormat={annualChance}
        tooltipTitle={rpWithChance}
        yFormat={kes1}
        xLabel={X_LABEL}
        yLabel="Loss from one flood (KES)"
        hoverXs={xs}
        height={compact ? 280 : 340}
        endLabels
        series={[
          { id: "ground-up", label: "Ground-up, all loss drivers", short: "Ground-up, all drivers", endLabel: "Ground-up", color: "var(--brand)", points: points(rows, (r) => r.groundUpKes), marker: "square", strong: true },
          { id: "gross", label: "Gross, after the offer's deductible and limit", short: "Gross", endLabel: "Gross", color: "var(--series-2)", points: points(rows, (r) => r.grossKes), marker: "triangle" },
          { id: "depth-only", label: "Ground-up, Depth only", short: "Ground-up, Depth only", endLabel: "Depth only", color: "var(--ink-2)", points: points(rows, (r) => r.depthOnlyKes), marker: "circle", dash: "9 6" },
        ]}
      />
    </ChartFrame>
  );
}

/** The share of the insured value lost at each return period, all loss drivers beside Depth only. */
export function OfferDamageCurve({ focus, rows, sources, className = "" }: Props) {
  const name = focus.building.name;
  const tiv = focus.drivers.tivKes;
  if (rows.length === 0 || !(tiv > 0)) return null;
  const xs = rows.map((r) => r.returnPeriod);
  return (
    <ChartFrame
      className={className}
      title="Share of value lost at each return period"
      subtitle={`Read across from a return period to the share of ${name}'s insured value lost in that flood, before the deductible and the limit. The solid line counts every loss driver; the dashed line is the depth of water at the building alone.`}
      sources={sources}
    >
      <LineChart
        ariaLabel={`Share of the insured value of ${name} lost at each return period from ${rpLabel(xs[0])} to ${rpLabel(xs[xs.length - 1])}: with all loss drivers, and on depth only`}
        xScale="log"
        xTicks={xs}
        xFormat={rpLabel}
        xSubFormat={annualChance}
        tooltipTitle={rpWithChance}
        yFormat={shareText}
        xLabel={X_LABEL}
        yLabel="Share of the insured value lost (%)"
        hoverXs={xs}
        height={340}
        yMax={1}
        endLabels
        series={[
          { id: "all", label: "All loss drivers", endLabel: "All drivers", color: "var(--brand)", points: points(rows, (r) => r.groundUpKes / tiv), marker: "square", strong: true },
          { id: "depth-only", label: "Depth only", endLabel: "Depth only", color: "var(--ink-2)", points: points(rows, (r) => r.depthOnlyKes / tiv), marker: "circle", dash: "9 6" },
        ]}
      />
    </ChartFrame>
  );
}
