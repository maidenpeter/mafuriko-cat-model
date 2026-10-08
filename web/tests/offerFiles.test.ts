import { describe, expect, it } from "vitest";
import { ACCEPT, OLD_WORD_MESSAGE, UNKNOWN_KIND_MESSAGE, offerFileKind, offerFileProblem } from "../src/lib/offerFiles/kind";
import { PDF_NO_TEXT_MESSAGE, PDF_UNREADABLE_MESSAGE, joinPages, pdfToText, textItemsToText, type PdfTextItem } from "../src/lib/offerFiles/pdf";

// Every name, number and sentence in this file is invented for the tests.

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ---------------------------------------------------------------------------------------------
// Which kind of file
// ---------------------------------------------------------------------------------------------

describe("offerFileKind", () => {
  it("reads the extension", () => {
    expect(offerFileKind("offer.docx")).toBe("docx");
    expect(offerFileKind("offer.pdf")).toBe("pdf");
    expect(offerFileKind("offer.txt")).toBe("txt");
    expect(offerFileKind("offer.doc")).toBe("doc");
  });

  it("ignores the case of the extension and spaces round the name", () => {
    expect(offerFileKind("OFFER.DOCX")).toBe("docx");
    expect(offerFileKind("Slip 2026.Pdf")).toBe("pdf");
    expect(offerFileKind("  notes.TXT  ")).toBe("txt");
    expect(offerFileKind("old.DOC")).toBe("doc");
  });

  it("takes the last extension of a name with several dots", () => {
    expect(offerFileKind("offer.v2.final.pdf")).toBe("pdf");
    expect(offerFileKind("offer.pdf.docx")).toBe("docx");
  });

  it("lets the extension win over the mime type", () => {
    expect(offerFileKind("offer.pdf", "text/plain")).toBe("pdf");
    expect(offerFileKind("offer.doc", DOCX_MIME)).toBe("doc");
    expect(offerFileKind("offer.docx", "application/msword")).toBe("docx");
  });

  it("falls back to the mime type when the extension says nothing", () => {
    expect(offerFileKind("offer", DOCX_MIME)).toBe("docx");
    expect(offerFileKind("offer", "application/pdf")).toBe("pdf");
    expect(offerFileKind("offer", "application/x-pdf")).toBe("pdf");
    expect(offerFileKind("offer", "text/plain")).toBe("txt");
    expect(offerFileKind("offer", "application/msword")).toBe("doc");
    expect(offerFileKind("offer.bin", "Application/PDF")).toBe("pdf");
    expect(offerFileKind("offer", "text/plain; charset=utf-8")).toBe("txt");
  });

  it("gives unknown for anything else", () => {
    expect(offerFileKind("photo.png", "image/png")).toBe("unknown");
    expect(offerFileKind("sheet.xlsx")).toBe("unknown");
    expect(offerFileKind("offer")).toBe("unknown");
    expect(offerFileKind("offer", "")).toBe("unknown");
    expect(offerFileKind("offer", null)).toBe("unknown");
    expect(offerFileKind("")).toBe("unknown");
    expect(offerFileKind("docx")).toBe("unknown");
    expect(offerFileKind("offer.")).toBe("unknown");
    expect(offerFileKind("offer.constructor", "toString")).toBe("unknown");
  });
});

describe("messages and the accept list", () => {
  it("uses the agreed words for an old Word file", () => {
    expect(OLD_WORD_MESSAGE).toBe("Old Word format, please save as .docx");
    expect(offerFileProblem("doc")).toBe(OLD_WORD_MESSAGE);
  });

  it("has a message for an unknown kind and none for the kinds it reads", () => {
    expect(offerFileProblem("unknown")).toBe(UNKNOWN_KIND_MESSAGE);
    expect(UNKNOWN_KIND_MESSAGE).toContain(".docx, .pdf or .txt");
    expect(offerFileProblem("docx")).toBeNull();
    expect(offerFileProblem("pdf")).toBeNull();
    expect(offerFileProblem("txt")).toBeNull();
  });

  it("accepts the three kinds by extension and mime type, and not old Word", () => {
    const parts = ACCEPT.split(",");
    expect(parts).toEqual([".docx", ".pdf", ".txt", DOCX_MIME, "application/pdf", "text/plain"]);
    expect(parts).not.toContain(".doc");
    expect(parts).not.toContain("application/msword");
  });
});

// ---------------------------------------------------------------------------------------------
// Rebuilding lines from text runs
// ---------------------------------------------------------------------------------------------

const item = (str: string, x: number, y: number, width: number, extra: Partial<PdfTextItem> = {}): PdfTextItem => ({
  str,
  transform: [12, 0, 0, 12, x, y],
  width,
  height: 12,
  ...extra,
});

describe("textItemsToText", () => {
  it("joins runs on one line, with a space only where there is a gap", () => {
    const text = textItemsToText([item("Sum insured:", 72, 700, 66), item("KES 5,000,000", 200, 700, 80), item(".", 280, 700, 3)]);
    expect(text).toBe("Sum insured: KES 5,000,000.");
  });

  it("does not double a space the runs already carry", () => {
    expect(textItemsToText([item("Ceding ", 72, 700, 40), item("company", 130, 700, 50)])).toBe("Ceding company");
    expect(textItemsToText([item("Ceding", 72, 700, 36), item(" ", 108, 700, 3), item("company", 111, 700, 50)])).toBe("Ceding company");
  });

  it("starts a new line when the vertical position changes", () => {
    expect(textItemsToText([item("First line", 72, 700, 50), item("Second line", 72, 686, 60)])).toBe("First line\nSecond line");
  });

  it("keeps a small raised mark on its line", () => {
    expect(textItemsToText([item("Note", 72, 700, 24), item("1", 96, 704, 4, { height: 7 })])).toBe("Note1");
  });

  it("starts a new line where a run is marked as the end of one", () => {
    const text = textItemsToText([item("Period: 12 months", 72, 700, 90, { hasEOL: true }), item("Deductible: 2%", 300, 700, 70)]);
    expect(text).toBe("Period: 12 months\nDeductible: 2%");
    const empty = textItemsToText([item("One", 72, 700, 20), item("", 92, 700, 0, { height: 0, hasEOL: true }), item("Two", 300, 700, 20)]);
    expect(empty).toBe("One\nTwo");
  });

  it("puts a blank line where the gap is clearly larger than a line", () => {
    const text = textItemsToText([
      item("Paragraph one, line one", 72, 700, 120),
      item("Paragraph one, line two", 72, 686, 120),
      item("Paragraph one, line three", 72, 672, 120),
      item("Paragraph two", 72, 640, 80),
    ]);
    expect(text).toBe("Paragraph one, line one\nParagraph one, line two\nParagraph one, line three\n\nParagraph two");
  });

  it("puts no blank lines in evenly spaced text, even widely spaced", () => {
    const text = textItemsToText([item("A", 72, 700, 8), item("B", 72, 676, 8), item("C", 72, 652, 8)]);
    expect(text).toBe("A\nB\nC");
  });

  it("sees a paragraph gap with only two lines on the page", () => {
    expect(textItemsToText([item("Heading", 72, 700, 40), item("Body", 72, 650, 30)])).toBe("Heading\n\nBody");
  });

  it("starts a paragraph when the text jumps back up the page", () => {
    expect(textItemsToText([item("Left column", 72, 300, 60), item("Right column", 320, 700, 60)])).toBe("Left column\n\nRight column");
  });

  it("drops empty lines and tidies spaces", () => {
    expect(textItemsToText([item("  Wide   spaces  ", 72, 700, 90), item("   ", 72, 686, 9), item("Next", 72, 672, 20)])).toBe("Wide spaces\nNext");
    expect(textItemsToText([])).toBe("");
  });
});

describe("joinPages", () => {
  it("separates pages with a blank line and leaves out empty ones", () => {
    expect(joinPages(["Page one\n", "", "  ", "Page two"])).toBe("Page one\n\nPage two");
    expect(joinPages([])).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// A real PDF, written by hand
// ---------------------------------------------------------------------------------------------

/** A small PDF in raw syntax: one page per content stream, text in Helvetica, with a correct xref table. */
function pdf(pageStreams: string[]): Uint8Array {
  const n = pageStreams.length;
  const fontId = 3 + 2 * n;
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pageStreams.map((_, i) => `${3 + 2 * i} 0 R`).join(" ")}] /Count ${n} >>`);
  pageStreams.forEach((stream, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + 2 * i} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const PAGE_ONE = [
  "BT /F1 12 Tf",
  "72 760 Td (Flood cover offer for Mto Mills Ltd) Tj",
  "0 -14 Td (Sum insured:) Tj",
  "160 0 Td (KES 5,000,000) Tj",
  "-160 -14 Td (Period of cover is twelve months.) Tj",
  "0 -42 Td (The site is beside the Ngare river.) Tj",
  "ET",
].join("\n");

const PAGE_TWO = ["BT /F1 12 Tf", "72 760 Td (Deductible: 2% of each loss) Tj", "0 -14 Td (Broker: Pwani Risk Partners) Tj", "ET"].join("\n");

describe("pdfToText", () => {
  it("gives the lines, the paragraph gap and the page break of a two page PDF", async () => {
    const text = await pdfToText(pdf([PAGE_ONE, PAGE_TWO]));
    expect(text).toBe(
      [
        "Flood cover offer for Mto Mills Ltd",
        "Sum insured: KES 5,000,000",
        "Period of cover is twelve months.",
        "",
        "The site is beside the Ngare river.",
        "",
        "Deductible: 2% of each loss",
        "Broker: Pwani Risk Partners",
      ].join("\n"),
    );
  });

  it("takes an ArrayBuffer and leaves the caller's bytes usable", async () => {
    const bytes = pdf([PAGE_TWO]);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(await pdfToText(buffer)).toBe("Deductible: 2% of each loss\nBroker: Pwani Risk Partners");
    expect(buffer.byteLength).toBe(bytes.byteLength);
    expect(await pdfToText(bytes)).toContain("Pwani Risk Partners");
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("says so when the PDF has no text, as a scan has not", async () => {
    const drawingOnly = "0.5 g\n72 600 200 100 re\nf";
    await expect(pdfToText(pdf([drawingOnly]))).rejects.toThrow(PDF_NO_TEXT_MESSAGE);
    await expect(pdfToText(pdf([""]))).rejects.toThrow(PDF_NO_TEXT_MESSAGE);
    expect(PDF_NO_TEXT_MESSAGE).toBe("This PDF has no text in it. It may be a scan: please supply the document as text or Word.");
  });

  it("says so when the file is not a PDF at all", async () => {
    await expect(pdfToText(new TextEncoder().encode("This is only a text file, whatever its name says."))).rejects.toThrow(PDF_UNREADABLE_MESSAGE);
  });
});
