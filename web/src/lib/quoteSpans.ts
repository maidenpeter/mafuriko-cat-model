/**
 * Finds where quotes sit in a document, so the document can be shown with each quote marked.
 *
 * How to use it:
 *   const { spans, notFound } = findQuoteSpans(text, [{ id: "limit", quote: "KES 500,000,000" }]);
 *   const pieces = segments(text, spans);          // the whole text, cut into marked and plain pieces
 *   const blocks = paragraphs(text, spans);        // the same pieces, grouped into paragraphs to draw
 *
 * Matching forgives layout, not wording: any run of spaces, tabs, line breaks and non-breaking
 * spaces counts as one space, and curly and straight quotation marks and apostrophes are equal.
 * Letter case, digits and punctuation must match. Every position returned is a position in the
 * ORIGINAL text, so text.slice(span.start, span.end) is the quote as the document wrote it.
 *
 * A quote that appears more than once is placed at its first appearance. Two ids that ask for
 * the same quote text get the same place, and the piece that covers it carries both ids.
 * Pure code: no model, no network, no DOM.
 */

export type QuoteInput = { id: string; quote: string };

/** One quote's place in the original text: start is included, end is not. */
export type QuoteSpan = { id: string; start: number; end: number };

/** A run of the text and the ids of every quote that covers it. Plain text has no ids. */
export type Segment = { text: string; ids: string[] };

/** A segment that also knows where it starts in the original text. */
export type PlacedSegment = Segment & { start: number };

/** A block of lines to draw as one element. Joined in order, the blocks give back the whole text. */
export type Paragraph = { start: number; pieces: PlacedSegment[] };

const SINGLE_QUOTES = "\u2018\u2019\u201A\u201B\u2032`\u00B4";
const DOUBLE_QUOTES = "\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB";
const SPACE = /\s/;

type Normalised = { norm: string; starts: number[]; ends: number[] };

/** The text with layout differences removed, and for each character left, the stretch of the original it stands for. */
function normalise(text: string): Normalised {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (SPACE.test(ch)) {
      let j = i + 1;
      while (j < text.length && SPACE.test(text[j])) j++;
      out.push(" ");
      starts.push(i);
      ends.push(j);
      i = j;
      continue;
    }
    out.push(SINGLE_QUOTES.includes(ch) ? "'" : DOUBLE_QUOTES.includes(ch) ? '"' : ch);
    starts.push(i);
    ends.push(i + 1);
    i++;
  }
  return { norm: out.join(""), starts, ends };
}

/** The form two pieces of text are compared in. Exported so a caller can ask "are these the same quote?". */
export function normaliseQuote(quote: string): string {
  return normalise(quote).norm.trim();
}

/**
 * Where each quote sits in the text. Spans come back in reading order (by start, then by the
 * order the quotes were given). Quotes that are empty or cannot be found are listed by id in notFound.
 */
export function findQuoteSpans(text: string, quotes: QuoteInput[]): { spans: QuoteSpan[]; notFound: string[] } {
  const { norm, starts, ends } = normalise(text);
  const found: (QuoteSpan & { order: number })[] = [];
  const notFound: string[] = [];
  const seen = new Map<string, number>();
  quotes.forEach((q, order) => {
    const needle = normaliseQuote(q.quote);
    if (!needle) {
      notFound.push(q.id);
      return;
    }
    let at = seen.get(needle);
    if (at === undefined) {
      at = norm.indexOf(needle);
      seen.set(needle, at);
    }
    if (at < 0) {
      notFound.push(q.id);
      return;
    }
    found.push({ id: q.id, start: starts[at], end: ends[at + needle.length - 1], order });
  });
  found.sort((a, b) => a.start - b.start || a.order - b.order);
  return { spans: found.map(({ id, start, end }) => ({ id, start, end })), notFound };
}

/** Cuts the text at every span edge and at every extra cut. Each piece lists the ids that cover it. */
function cut(text: string, spans: QuoteSpan[], extraCuts: number[]): PlacedSegment[] {
  const length = text.length;
  const clamp = (n: number) => Math.min(length, Math.max(0, Math.floor(n)));
  const valid = spans
    .map((s) => ({ id: s.id, start: clamp(s.start), end: clamp(s.end) }))
    .filter((s) => s.end > s.start);
  const edges = new Set<number>([0, length]);
  for (const s of valid) {
    edges.add(s.start);
    edges.add(s.end);
  }
  for (const c of extraCuts) edges.add(clamp(c));
  const sorted = [...edges].sort((a, b) => a - b);
  const pieces: PlacedSegment[] = [];
  for (let k = 0; k + 1 < sorted.length; k++) {
    const from = sorted[k];
    const to = sorted[k + 1];
    const ids: string[] = [];
    for (const s of valid) {
      if (s.start <= from && s.end >= to && !ids.includes(s.id)) ids.push(s.id);
    }
    pieces.push({ text: text.slice(from, to), ids, start: from });
  }
  return pieces;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The whole text cut into pieces, in order, each character in exactly one piece. Where spans
 * overlap, the shared stretch is its own piece and carries every id that covers it.
 */
export function segments(text: string, spans: QuoteSpan[]): Segment[] {
  const merged: Segment[] = [];
  for (const piece of cut(text, spans, [])) {
    const last = merged[merged.length - 1];
    if (last && sameIds(last.ids, piece.ids)) last.text += piece.text;
    else merged.push({ text: piece.text, ids: piece.ids });
  }
  return merged;
}

/** Where each block starts: after a blank line, or after maxLines lines when the document has no blank lines. */
function blockStarts(text: string, maxLines: number): number[] {
  const starts = [0];
  let lines = 0;
  let lineStart = 0;
  let lastBlank = false;
  while (lineStart < text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl < 0 ? text.length : nl;
    const blank = text.slice(lineStart, lineEnd).trim() === "";
    if (lineStart > 0 && !blank && (lastBlank || lines >= maxLines)) {
      starts.push(lineStart);
      lines = 0;
    }
    lines++;
    lastBlank = blank;
    lineStart = lineEnd + 1;
  }
  return starts;
}

/**
 * The same pieces as segments(), grouped into blocks of lines so a long document is drawn as a
 * few hundred elements, not one per character. Blank lines stay at the end of the block before
 * them; draw each block with line breaks kept (white-space: pre-wrap) and the layout is unchanged.
 * A quote that runs across two blocks is cut at the break and both halves carry its id.
 */
export function paragraphs(text: string, spans: QuoteSpan[], maxLines = 40): Paragraph[] {
  const starts = blockStarts(text, Math.max(1, maxLines));
  const blocks: Paragraph[] = starts.map((start) => ({ start, pieces: [] }));
  let b = 0;
  for (const piece of cut(text, spans, starts)) {
    while (b + 1 < blocks.length && blocks[b + 1].start <= piece.start) b++;
    blocks[b].pieces.push(piece);
  }
  return blocks;
}
