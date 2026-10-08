import { describe, expect, it } from "vitest";
import { findQuoteSpans, normaliseQuote, paragraphs, segments } from "../src/lib/quoteSpans";

const joined = (pieces: { text: string }[]) => pieces.map((p) => p.text).join("");

describe("finding quotes in a document", () => {
  it("finds an exact match at the right place", () => {
    const text = "Limit of liability: KES 500,000,000 any one event.";
    const { spans, notFound } = findQuoteSpans(text, [{ id: "limit", quote: "KES 500,000,000" }]);
    expect(notFound).toEqual([]);
    expect(spans).toEqual([{ id: "limit", start: 20, end: 35 }]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("KES 500,000,000");
  });

  it("matches across line breaks, tabs, runs of spaces and non-breaking spaces", () => {
    const text = "Cover:\r\n  Flood and\n\tinundation,   Nairobi\u00A0County only.";
    const { spans, notFound } = findQuoteSpans(text, [{ id: "peril", quote: " Flood  and inundation, Nairobi County\n" }]);
    expect(notFound).toEqual([]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Flood and\n\tinundation,   Nairobi\u00A0County");
  });

  it("treats curly and straight quotation marks and apostrophes as equal", () => {
    const text = "The \u201CReinsured\u201D means the cedant\u2019s company.";
    const { spans, notFound } = findQuoteSpans(text, [
      { id: "a", quote: '"Reinsured" means' },
      { id: "b", quote: "cedant's company" },
    ]);
    expect(notFound).toEqual([]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("\u201CReinsured\u201D means");
    expect(text.slice(spans[1].start, spans[1].end)).toBe("cedant\u2019s company");
    expect(normaliseQuote("  \u2018a\u2019 \n b ")).toBe("'a' b");
  });

  it("lists a quote that is not in the text, and an empty quote, as not found", () => {
    const { spans, notFound } = findQuoteSpans("Deductible KES 5m.", [
      { id: "ded", quote: "KES 5m" },
      { id: "missing", quote: "KES 50m" },
      { id: "blank", quote: "  \n " },
      { id: "case", quote: "deductible" },
    ]);
    expect(spans.map((s) => s.id)).toEqual(["ded"]);
    expect(notFound).toEqual(["missing", "blank", "case"]);
  });

  it("does not match when a space is missing from the document", () => {
    expect(findQuoteSpans("KES5m", [{ id: "x", quote: "KES 5m" }]).notFound).toEqual(["x"]);
  });

  it("cuts two overlapping quotes into pieces that carry every id covering them", () => {
    const text = "Rate on line 12.5% of the limit, payable quarterly.";
    const { spans } = findQuoteSpans(text, [
      { id: "terms", quote: "of the limit, payable quarterly" },
      { id: "rate", quote: "Rate on line 12.5% of the limit" },
    ]);
    expect(spans.map((s) => s.id)).toEqual(["rate", "terms"]);
    const pieces = segments(text, spans);
    expect(pieces).toEqual([
      { text: "Rate on line 12.5% ", ids: ["rate"] },
      { text: "of the limit", ids: ["rate", "terms"] },
      { text: ", payable quarterly", ids: ["terms"] },
      { text: ".", ids: [] },
    ]);
  });

  it("gives two ids that ask for the same quote the same place", () => {
    const text = "Sum insured KES 2bn. Limit KES 2bn.";
    const { spans, notFound } = findQuoteSpans(text, [
      { id: "tsi", quote: "KES 2bn" },
      { id: "limit", quote: "KES  2bn" },
    ]);
    expect(notFound).toEqual([]);
    expect(spans).toEqual([
      { id: "tsi", start: 12, end: 19 },
      { id: "limit", start: 12, end: 19 },
    ]);
    expect(segments(text, spans)[1]).toEqual({ text: "KES 2bn", ids: ["tsi", "limit"] });
  });

  it("keeps positions correct in the original text after earlier whitespace runs", () => {
    const text = "\n\n   Broker:\t\tAcme   Re\r\n\r\nPeriod:  1 January 2026 \u2013 31 December 2026\n";
    const { spans } = findQuoteSpans(text, [
      { id: "period", quote: "1 January 2026 \u2013 31 December 2026" },
      { id: "broker", quote: "Acme Re" },
    ]);
    expect(spans.map((s) => s.id)).toEqual(["broker", "period"]);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("Acme   Re");
    expect(text.slice(spans[1].start, spans[1].end)).toBe("1 January 2026 \u2013 31 December 2026");
    expect(spans[0].start).toBe(text.indexOf("Acme"));
    expect(spans[1].end).toBe(text.length - 1);
  });
});

describe("cutting the text into pieces", () => {
  const text = "One two three.\n\nFour five six.\nSeven eight.\n\n\nNine.";

  it("covers the whole text exactly once", () => {
    const { spans } = findQuoteSpans(text, [
      { id: "a", quote: "two three" },
      { id: "b", quote: "three. Four" },
      { id: "c", quote: "Nine." },
      { id: "d", quote: "One" },
    ]);
    const pieces = segments(text, spans);
    expect(joined(pieces)).toBe(text);
    expect(pieces.every((p) => p.text.length > 0)).toBe(true);
    expect(pieces.filter((p) => p.ids.includes("b")).map((p) => p.text)).toEqual(["three", ".\n\nFour"]);
  });

  it("returns the text as one plain piece when there are no spans, and nothing for no text", () => {
    expect(segments(text, [])).toEqual([{ text, ids: [] }]);
    expect(segments("", [])).toEqual([]);
  });

  it("ignores empty spans and clamps spans that run past the end", () => {
    const pieces = segments("abcdef", [
      { id: "x", start: 2, end: 2 },
      { id: "y", start: 4, end: 99 },
    ]);
    expect(pieces).toEqual([
      { text: "abcd", ids: [] },
      { text: "ef", ids: ["y"] },
    ]);
  });

  it("groups pieces into paragraphs that join back into the text", () => {
    const { spans } = findQuoteSpans(text, [{ id: "b", quote: "three. Four" }]);
    const blocks = paragraphs(text, spans);
    expect(blocks.map((b) => joined(b.pieces))).toEqual(["One two three.\n\n", "Four five six.\nSeven eight.\n\n\n", "Nine."]);
    expect(blocks.map((b) => b.start)).toEqual([0, 16, 46]);
    for (const b of blocks) {
      let at = b.start;
      for (const p of b.pieces) {
        expect(text.slice(at, at + p.text.length)).toBe(p.text);
        expect(p.start).toBe(at);
        at += p.text.length;
      }
    }
    expect(blocks[0].pieces[1]).toEqual({ text: "three.\n\n", ids: ["b"], start: 8 });
    expect(blocks[1].pieces[0]).toEqual({ text: "Four", ids: ["b"], start: 16 });
  });

  it("breaks a document with no blank lines every maxLines lines", () => {
    const long = Array.from({ length: 95 }, (_, i) => `line ${i}`).join("\n");
    const blocks = paragraphs(long, [], 40);
    expect(blocks.length).toBe(3);
    expect(blocks.map((b) => joined(b.pieces)).join("")).toBe(long);
    expect(paragraphs("", [])).toEqual([{ start: 0, pieces: [] }]);
  });

  it("handles a 30,000 character document with 60 quotes quickly", () => {
    const lines: string[] = [];
    for (let i = 0; lines.join("\n").length < 30_000; i++) lines.push(`Clause ${i}:  the  sum of KES ${i * 1000}\u00A0applies to \u201Citem ${i}\u201D.`);
    const doc = lines.join("\n");
    const quotes = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, quote: `sum of KES ${i * 7000} applies to "item ${i * 7}"` }));
    const began = performance.now();
    const { spans, notFound } = findQuoteSpans(doc, quotes);
    const blocks = paragraphs(doc, spans);
    const took = performance.now() - began;
    expect(notFound).toEqual([]);
    expect(spans.length).toBe(60);
    expect(blocks.map((b) => joined(b.pieces)).join("")).toBe(doc);
    expect(took).toBeLessThan(500);
  });
});
