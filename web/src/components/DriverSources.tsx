"use client";

import { fmtKes } from "@/lib/format";
import { isPlaceholder, type SourceKind } from "@/lib/labels";
import type { DriverSource } from "@/lib/offer/drivers";
import { settersOf, settersText, type FocusJudgement, type OfferFocus, type PricedFocus } from "@/lib/offer/focus";
import type { StepId } from "@/lib/steps";
import { SourceBadge } from "./charts/ChartFrame";
import { PlaceholderBadge, StepLink, Tag } from "./ui";

/** The badge of a figure read from the offer: AI when the model read the document and code checked it, Real data when the fixed rules did. */
export const offerKindOf = (focus: Pick<OfferFocus, "document">): SourceKind => (focus.document.path === "model" ? "ai" : "real");

/**
 * What a figure rests on, one line per source, drawn the same on every step:
 *   the offer       the badge of how the document was read, the sentence, and the way to its place in the document
 *   an assumption   always the Assumption badge, the AI badge as well when the agents set part of it, and who set it;
 *                   the cost of capital and the minimum rate carry the placeholder badge in its place
 *   the data        the Real data badge
 * A figure the underwriter typed over the document is marked "Typed" in place of a badge.
 */
export function DriverSources({
  sources,
  judgement = null,
  offerKind = "real",
  quiet = "none",
  onOpenStep,
  className = "",
}: {
  sources: DriverSource[];
  /** Who set each judgement figure. Left out, an assumption names no setter. */
  judgement?: Pick<FocusJudgement, "setBy"> | null;
  /** offerKindOf(focus). */
  offerKind?: SourceKind;
  /** "all" for a line that takes no part in the price: its sources only say why, with no badge. "data" for a total, whose data lines only say what it adds up. */
  quiet?: "none" | "data" | "all";
  onOpenStep?: (id: StepId) => void;
  className?: string;
}) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label="Sources" className={`grid gap-1.5 text-xs leading-relaxed text-muted ${className}`}>
      {sources.map((source, i) => {
        if (quiet === "all" || (quiet === "data" && source.kind === "data")) return <li key={i} className="wrap-anywhere">{source.what}</li>;
        const setters = source.kind === "assumption" ? settersOf(judgement, source.keys) : [];
        return (
          <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {source.kind === "offer" ? (
              source.quote ? <SourceBadge kind={offerKind} /> : <Tag kind="none">Typed</Tag>
            ) : source.kind === "assumption" && source.keys.some(isPlaceholder) ? (
              <PlaceholderBadge />
            ) : (
              <SourceBadge kind={source.kind === "data" ? "real" : "assumption"} />
            )}
            {setters.includes("agents") && <SourceBadge kind="ai" />}
            <span className="min-w-0 wrap-anywhere">
              {source.what}
              {source.kind === "assumption" && setters.length > 0 && ` (${settersText(judgement, source.keys)})`}
              {source.kind === "offer" && source.quote && (
                <>
                  : <q className="text-ink-2">{source.quote}</q>
                  {onOpenStep && <> (in <StepLink to="offer" onOpenStep={onOpenStep} />)</>}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The followed building's insured value as a source: stated, or floor area × cost per m², each
 * read from the document (with its sentence) or typed over it.
 */
export function insuredValueSource(focus: PricedFocus): DriverSource {
  const site = focus.building;
  const fields = (site.tivFrom === "area_times_cost" ? ["floorAreaM2", "costPerM2Kes"] : ["tivKes"]).flatMap((key) => focus.fields.filter((f) => f.id === `row:${site.index}:${key}`));
  const typed = fields.length > 0 && fields.every((f) => f.origin === "edited");
  const quote = [...new Set(fields.filter((f) => f.origin !== "edited").map((f) => f.quote.trim()).filter(Boolean))].join(" ");
  const what = site.tivKes === null ? "Insured value" : `Insured value of ${fmtKes(site.tivKes, 2)}${site.tivFrom === "area_times_cost" ? ", floor area × cost per m²" : ""}`;
  return { kind: "offer", what, quote: typed ? "" : quote };
}
