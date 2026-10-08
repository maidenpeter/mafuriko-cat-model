"use client";

/**
 * The offer document as text, with the quote behind each extracted value marked in place.
 *
 * How to use it:
 *   const [activeId, setActiveId] = useState<string | null>(null);
 *   <DocumentQuotes
 *     text={documentText}
 *     quotes={[{ id: "limit", quote: "KES 500,000,000", label: "Limit", status: "verified" }]}
 *     activeId={activeId}
 *     onSelect={setActiveId}
 *   />
 *
 * The parent drives it: set activeId (for example when a field in the table is clicked) and the
 * panel scrolls that quote into view and moves keyboard focus to it. Clicking a mark, or pressing
 * Enter or Space on it, calls onSelect with the quote's id. Only the panel scrolls, never the page.
 * Rows with an empty quote are left out of the count; rows whose quote is not in the text are
 * named in the line above the panel. Each status has its own underline style and a word in the
 * key below the panel, so status never rests on colour alone.
 */

import { memo, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { findQuoteSpans, paragraphs, type PlacedSegment } from "@/lib/quoteSpans";

export type QuoteStatus = "verified" | "unverified" | "rules" | "confirmed" | "edited";

export type DocumentQuote = { id: string; quote: string; label: string; status: QuoteStatus };

export type DocumentQuotesProps = {
  text: string;
  quotes: DocumentQuote[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
};

/** The word, background and underline for each status. The underline shape differs, not just the colour. */
const STATUS: Record<QuoteStatus, { word: string; wash: string; line: string }> = {
  verified: { word: "Verified", wash: "bg-accent-wash", line: "decoration-solid decoration-accent" },
  confirmed: { word: "Confirmed", wash: "bg-accent-wash", line: "decoration-double decoration-accent" },
  edited: { word: "Edited", wash: "bg-surface-2", line: "decoration-wavy decoration-ink-2" },
  rules: { word: "Set by rules", wash: "bg-surface-2", line: "decoration-dotted decoration-ink-2" },
  unverified: { word: "Unverified", wash: "bg-brand-wash", line: "decoration-dashed decoration-brand" },
};

const STATUS_ORDER: QuoteStatus[] = ["verified", "confirmed", "edited", "rules", "unverified"];

const MARK = "cursor-pointer rounded-sm underline decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** What a block needs to know about the quotes; the same object for every block until the quotes change. */
type Lookup = {
  byId: Map<string, DocumentQuote>;
  /** 1, 2, 3 in reading order. */
  numberOf: Map<string, number>;
  /** Where in the text each quote begins and ends. */
  startOf: Map<string, number>;
  endOf: Map<string, number>;
};

type BlockProps = {
  pieces: PlacedSegment[];
  lookup: Lookup;
  /** The active id when it is inside this block, otherwise null, so other blocks are not redrawn. */
  activeId: string | null;
  onSelect?: (id: string) => void;
};

const Block = memo(function Block({ pieces, lookup, activeId, onSelect }: BlockProps) {
  return (
    <div className="whitespace-pre-wrap break-words">
      {pieces.map((piece) => {
        if (piece.ids.length === 0) return piece.text;
        const active = activeId !== null && piece.ids.includes(activeId);
        const leadId = active ? (activeId as string) : piece.ids[0];
        const lead = lookup.byId.get(leadId);
        if (!lead) return piece.text;
        const starters = piece.ids.filter((id) => lookup.startOf.get(id) === piece.start);
        const names = piece.ids.map((id) => {
          const q = lookup.byId.get(id);
          return q ? `${lookup.numberOf.get(id)}. ${q.label} (${STATUS[q.status].word})` : "";
        });
        /** A click picks this quote. Where two quotes share the words, a second click moves to the next one. */
        const pick = () => {
          const at = activeId === null ? -1 : piece.ids.indexOf(activeId);
          onSelect?.(piece.ids[(at + 1) % piece.ids.length]);
        };
        const onKey = (e: KeyboardEvent<HTMLElement>) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          pick();
        };
        const look = active
          ? `bg-accent text-surface decoration-current outline-2 outline-offset-1 outline-ink ${STATUS[lead.status].line.split(" ")[0]}`
          : `text-ink ${STATUS[lead.status].wash} ${STATUS[lead.status].line}`;
        return (
          <mark
            key={piece.start}
            role="button"
            tabIndex={starters.length > 0 ? 0 : -1}
            aria-current={active ? "true" : undefined}
            data-at={starters.length > 0 ? piece.start : undefined}
            title={names.join("\n")}
            onClick={pick}
            onKeyDown={onKey}
            className={`${MARK} ${look}`}
          >
            {piece.text}
            {starters.length > 0 && (
              <sup className="ml-0.5 inline-block select-none align-super text-xs font-semibold leading-none">
                {starters.map((id) => lookup.numberOf.get(id)).join(", ")}
              </sup>
            )}
            <span className="sr-only"> ({names.join("; ")})</span>
          </mark>
        );
      })}
    </div>
  );
});

export function DocumentQuotes({ text, quotes, activeId = null, onSelect, className = "" }: DocumentQuotesProps) {
  const panel = useRef<HTMLDivElement>(null);
  const shownId = useRef<string | null>(null);
  const firstRun = useRef(true);

  const { blocks, lookup, asked, missing, statuses } = useMemo(() => {
    const withQuote = quotes.filter((q) => q.quote.trim() !== "");
    const { spans, notFound } = findQuoteSpans(text, withQuote);
    const byId = new Map(withQuote.map((q) => [q.id, q] as const));
    const numberOf = new Map<string, number>();
    const startOf = new Map<string, number>();
    const endOf = new Map<string, number>();
    for (const s of spans) {
      if (numberOf.has(s.id)) continue;
      numberOf.set(s.id, numberOf.size + 1);
      startOf.set(s.id, s.start);
      endOf.set(s.id, s.end);
    }
    const present = new Set<QuoteStatus>();
    for (const id of numberOf.keys()) {
      const q = byId.get(id);
      if (q) present.add(q.status);
    }
    return {
      blocks: paragraphs(text, spans),
      lookup: { byId, numberOf, startOf, endOf },
      asked: withQuote.length,
      missing: notFound.map((id) => byId.get(id)?.label ?? id),
      statuses: STATUS_ORDER.filter((s) => present.has(s)),
    };
  }, [text, quotes]);

  /** Bring the active quote into view inside the panel and put the keyboard on it. */
  useEffect(() => {
    const first = firstRun.current;
    firstRun.current = false;
    if (activeId === shownId.current) return;
    if (activeId === null) {
      shownId.current = null;
      return;
    }
    const box = panel.current;
    const at = lookup.startOf.get(activeId);
    if (!box || at === undefined) return;
    const mark = box.querySelector<HTMLElement>(`mark[data-at="${at}"]`);
    if (!mark) return;
    shownId.current = activeId;
    const boxRect = box.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const fullyVisible = markRect.top >= boxRect.top && markRect.bottom <= boxRect.bottom;
    if (!fullyVisible) {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const top = box.scrollTop + (markRect.top - boxRect.top) - Math.max(0, (box.clientHeight - markRect.height) / 2);
      box.scrollTo({ top: Math.max(0, top), behavior: still ? "auto" : "smooth" });
    }
    // On first load only scroll: taking the keyboard before the reader has done anything would be a surprise.
    if (!first) mark.focus({ preventScroll: true });
  }, [activeId, lookup]);

  const found = lookup.numberOf.size;
  const activeStart = activeId === null ? undefined : lookup.startOf.get(activeId);
  const activeEnd = activeId === null ? undefined : lookup.endOf.get(activeId);

  return (
    <div className={`min-w-0 ${className}`}>
      <p className="mb-2 text-sm leading-relaxed text-ink-2" aria-live="polite">
        {asked === 0
          ? "No quotes to show in the document yet."
          : `${found} of ${asked} ${asked === 1 ? "quote" : "quotes"} found in the document.`}
        {missing.length > 0 && <span className="text-ink"> Not found in the document: {missing.join(", ")}.</span>}
      </p>
      <div
        ref={panel}
        role="region"
        aria-label="Document text"
        tabIndex={0}
        className="max-h-[24rem] overflow-y-auto rounded-2xl border border-line bg-surface p-4 text-sm leading-relaxed text-ink-2 focus-visible:outline-2 focus-visible:outline-accent lg:max-h-[36rem]"
      >
        {text.trim() === "" ? (
          <p className="text-muted">No document text to show.</p>
        ) : (
          blocks.map((block, i) => {
            const next = blocks[i + 1]?.start ?? Infinity;
            // A quote can run over a block break, so a block is active when it overlaps the quote at all.
            const holdsActive = activeStart !== undefined && activeEnd !== undefined && block.start < activeEnd && next > activeStart;
            return <Block key={block.start} pieces={block.pieces} lookup={lookup} activeId={holdsActive ? activeId : null} onSelect={onSelect} />;
          })
        )}
      </div>
      {statuses.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Key to the marks">
          {statuses.map((s) => (
            <li key={s} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`rounded-sm px-1 text-ink underline decoration-2 underline-offset-4 ${STATUS[s].wash} ${STATUS[s].line}`}>
                Abc
              </span>
              {STATUS[s].word}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
