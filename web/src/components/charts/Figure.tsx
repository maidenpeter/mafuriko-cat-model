"use client";

/**
 * One headline figure for a dashboard row: what it is, the number, an optional line under
 * it, and the badge that says where the number comes from.
 *
 * How to use it:
 *   <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
 *     <Figure strong label="Net loss, 1-in-100 (1% a year)" value={kes1(net)} sub="After deductibles and reinsurance" source="synthetic" />
 *     <Figure label="Average annual loss" value={kes1(aal)} source="synthetic" sourceText="Synthetic portfolio" />
 *   </div>
 *
 * Give `value` already formatted (kes1, pct1, rpWithChance from lib/labels). Use `strong` for the
 * one figure in the row that matters most: it is larger and carries a brand rule down its side.
 */

import type { ReactNode } from "react";
import type { SourceKind } from "@/lib/labels";
import { SourceBadge } from "./ChartFrame";

interface Props {
  /** What the figure is, in plain words, with its units or return period where they apply. */
  label: string;
  /** The figure, already formatted, for example "KES 4.2bn". */
  value: string;
  /** One short line of context under the figure. */
  sub?: ReactNode;
  /** Where the figure comes from. Every figure on the dashboard carries its badge. */
  source: SourceKind;
  /** A few words beside the badge, for example "Synthetic portfolio". */
  sourceText?: ReactNode;
  /** The one figure that matters most in its row. */
  strong?: boolean;
  className?: string;
}

export function Figure({ label, value, sub, source, sourceText, strong = false, className = "" }: Props) {
  return (
    <div
      role="group"
      aria-label={`${label}: ${value}`}
      // The strong figure is told apart by its size and its rule, not by colour alone.
      className={`flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-5 ${strong ? "border-l-4 border-l-brand" : ""} ${className}`}
    >
      <div className={`wrap-anywhere text-ink-2 ${strong ? "text-base font-medium" : "text-sm"}`}>{label}</div>
      <div className={`tabular mt-1 wrap-anywhere font-semibold leading-tight tracking-tight text-ink ${strong ? "text-4xl" : "text-2xl"}`}>{value}</div>
      {sub && <div className="mt-1.5 wrap-anywhere text-sm leading-relaxed text-ink-2">{sub}</div>}
      {/* mt-auto keeps the badges of a row on one line when the figures above them differ in height. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-3 text-xs leading-relaxed text-muted">
        <SourceBadge kind={source} />
        {sourceText && <span className="min-w-0 wrap-anywhere">{sourceText}</span>}
      </div>
    </div>
  );
}
