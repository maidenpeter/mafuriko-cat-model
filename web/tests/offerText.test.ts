import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { describeReading, inKenya, parseCoordinates } from "../src/lib/offer/coords";
import { docxToText, readOfferFile } from "../src/lib/offer/docx";
import { describeRemoved, redact } from "../src/lib/offer/redact";
import type { OfferExtraction, OfferFile, OfferRow, OfferTerms, Quoted } from "../src/lib/offer/types";
import { confirmValue, editValue, numberInQuote, quoteInDocument, usableValue, verifyExtraction } from "../src/lib/offer/verify";

// Every name, address, number and sentence in this file is invented for the tests.

// ---------------------------------------------------------------------------------------------
// Word files
// ---------------------------------------------------------------------------------------------

const run = (text: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (...runs: string[]) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs.join("")}</w:p>`;
const documentXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

async function docx(body: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", documentXml(body));
  return zip.generateAsync({ type: "uint8array" });
}

const asFile = (name: string, bytes: Uint8Array): OfferFile => ({
  name,
  text: async () => new TextDecoder().decode(bytes),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
});

describe("reading a Word file", () => {
  it("gives one line per paragraph and joins runs that split a word", async () => {
    const bytes = await docx(
      [
        para(run("PLACEMENT MEMO")),
        "<w:p/>",
        // The spell checker often cuts a run in the middle of a word.
        para(run("The ware"), run("house stands on "), run("Mto"), run("ni Road.")),
        para(run("Smith &amp; Jones Ltd insure stock &lt; KES 5m at 36.82&#176;E, 1.28&#xB0;S.")),
        para(run("FLOOR AREA:"), "<w:r><w:tab/></w:r>", run("4,200 m²")),
        para(run("First line"), "<w:r><w:br/></w:r>", run("second line")),
      ].join(""),
    );
    const text = await docxToText(bytes);
    expect(text.split("\n")).toEqual([
      "PLACEMENT MEMO",
      "",
      "The warehouse stands on Mtoni Road.",
      "Smith & Jones Ltd insure stock < KES 5m at 36.82°E, 1.28°S.",
      "FLOOR AREA:\t4,200 m²",
      "First line",
      "second line",
    ]);
  });

  it("leaves out struck-out text, field codes and the second copy of a text box", async () => {
    const bytes = await docx(
      [
        para(run("Sum insured KES 80m"), "<w:del><w:r><w:delText>KES 95m</w:delText></w:r></w:del>", '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>', run(".")),
        `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent>${para(run("Boxed note"))}</w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent>${para(run("Boxed note"))}</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r>${run("After the box")}</w:p>`,
      ].join(""),
    );
    expect((await docxToText(bytes)).split("\n")).toEqual(["Sum insured KES 80m.", "Boxed note", "After the box"]);
  });

  it("accepts an ArrayBuffer and a Blob as well as bytes", async () => {
    const bytes = await docx(para(run("One paragraph.")));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(await docxToText(buffer)).toBe("One paragraph.");
    expect(await docxToText(new Blob([buffer]))).toBe("One paragraph.");
  });

  it("says in plain words when the file is not a Word document", async () => {
    await expect(docxToText(new TextEncoder().encode("just some text"))).rejects.toThrow(/could not be opened as a Word document/);
    const zip = new JSZip();
    zip.file("notes.txt", "a zip, but not a Word file");
    await expect(docxToText(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow(/no document text inside/);
  });

  it("reads a file by its extension", async () => {
    const word = await readOfferFile(asFile("Offer 12.DOCX", await docx(para(run("Line one")) + para(run("Line two")))));
    expect(word).toEqual({ name: "Offer 12.DOCX", kind: "docx", text: "Line one\nLine two" });

    const plain = await readOfferFile(asFile("offer.txt", new TextEncoder().encode("\ufeffLine one\r\nLine two\r\n")));
    expect(plain).toEqual({ name: "offer.txt", kind: "txt", text: "Line one\nLine two\n" });

    await expect(readOfferFile(asFile("offer.pdf", new Uint8Array([1, 2, 3])))).rejects.toThrow(/Only \.docx and \.txt/);
    await expect(readOfferFile(asFile("offer.doc", new Uint8Array([1, 2, 3])))).rejects.toThrow(/older Word file/);
    await expect(readOfferFile(asFile("empty.txt", new TextEncoder().encode("  \n ")))).rejects.toThrow(/no text/);
  });
});

// ---------------------------------------------------------------------------------------------
// What is removed before sending
// ---------------------------------------------------------------------------------------------

const MEMO = [
  "PLACEMENT MEMO",
  "BROKER: Example Brokers Ltd",
  "ACCOUNT HANDLER: Jane Example (jane.example@example-brokers.test)",
  "DATE ISSUED: 3 March 2031",
  "",
  "PRINCIPAL CONTACT:",
  "Mr. John Sample",
  "Sample Holdings Ltd",
  "Tel: +254 (20) 555-0100",
  "Email: j.sample@sample-holdings.test",
  "",
  "GPS COORDINATES: -1.2850°S, 36.8200°E",
  "SUM INSURED: KES 1,250,000,000",
  "The period runs from 1 January 2032 to 31 December 2032. Queries to 0712 345 678.",
  "Value of plant: KES 2 050 000 000.",
  "",
  "AREAS REQUIRING ATTENTION:",
  "Drains on the east side were blocked at the 2030 survey.",
  "",
  "SIGNATURE: ____________  Date: __________",
  "(Authorised signatory, Example Brokers Ltd)",
  "",
  "Prepared by: Jane Example, Account Handler",
  "Example Brokers Ltd",
  "Date: 3 March 2031",
  "Contact: +254 (20) 555-0199 | info@example-brokers.test",
].join("\n");

describe("removing contact details", () => {
  const result = redact(MEMO);

  it("takes out emails, phones, and the contact and signature blocks, and nothing else", () => {
    expect(result.text.split("\n")).toEqual([
      "PLACEMENT MEMO",
      "BROKER: Example Brokers Ltd",
      "[contact details removed]",
      "DATE ISSUED: 3 March 2031",
      "",
      "[contact details removed]",
      "",
      "GPS COORDINATES: -1.2850°S, 36.8200°E",
      "SUM INSURED: KES 1,250,000,000",
      "The period runs from 1 January 2032 to 31 December 2032. Queries to [phone removed].",
      "Value of plant: KES 2 050 000 000.",
      "",
      "AREAS REQUIRING ATTENTION:",
      "Drains on the east side were blocked at the 2030 survey.",
      "",
      "[signature block removed]",
      "",
      "[signature block removed]",
    ]);
  });

  it("counts what was removed", () => {
    expect(result.removed.emails).toBe(3);
    expect(result.removed.phones).toBe(3);
    expect(result.removed.blocks).toEqual([
      { name: "ACCOUNT HANDLER", lines: 1 },
      { name: "PRINCIPAL CONTACT", lines: 5 },
      { name: "SIGNATURE", lines: 2 },
      { name: "Prepared by", lines: 4 },
    ]);
    expect(describeRemoved(result.removed)).toBe("Removed before sending: 3 email addresses, 3 phone numbers and 4 contact or signature blocks (ACCOUNT HANDLER, PRINCIPAL CONTACT, SIGNATURE, Prepared by).");
    expect(describeRemoved({ emails: 1, phones: 0, blocks: [] })).toBe("Removed before sending: 1 email address.");
    expect(describeRemoved(redact("A dry site.").removed)).toMatch(/^Nothing was removed/);
  });

  it("changes nothing when run on its own output", () => {
    const again = redact(result.text);
    expect(again.text).toBe(result.text);
    expect(again.removed).toEqual({ emails: 0, phones: 0, blocks: [] });
  });

  it("removes a block under any heading when it holds an email or a phone", () => {
    const out = redact(["LOSS ADJUSTER:", "Peter Placeholder", "Placeholder Adjusters, Kisumu", "p.placeholder@adjusters.test", "", "The site is level."].join("\n"));
    expect(out.text).toBe("[contact details removed]\n\nThe site is level.");
    expect(out.removed.blocks).toEqual([{ name: "LOSS ADJUSTER", lines: 4 }]);
  });

  it("keeps a block that holds figures, and strips only the details from it", () => {
    const site = ["SITE DETAILS:", "Example Mills, Mtoni Road", "Floor area 4,200 m²", "Tel: 020 555 0100"].join("\n");
    expect(redact(site).text).toBe(["SITE DETAILS:", "Example Mills, Mtoni Road", "Floor area 4,200 m²", "Tel: [phone removed]"].join("\n"));
  });

  it("keeps a sentence that follows a heading about a person", () => {
    const text = "RISK MANAGER:\nThe basement pumps were tested in March and found to be working.";
    expect(redact(text).text).toBe(text);
    const finding = "SITE MANAGER: reports 3 floods since 2019, the deepest 0.6 m";
    expect(redact(finding).text).toBe(finding);
  });

  it("leaves amounts, coordinates, dates and reference numbers alone", () => {
    const lines = [
      "TIV (KES 4,250,000,000) with a flood limit of KES 500,000,000 any one event.",
      "Deductible 5% of loss, minimum KES 2,500,000. Plant KES 1 000 000 000.",
      "GPS COORDINATES: 0.1234°N, 34.5678°E and -1.29210, 36.82190",
      "Policy period 01/01/2032 to 31/12/2032, reference EXB-2031-0042, built 2009-2012.",
      "The river is 1.8 km away; the 2018 flood reached +0.45 m on the gauge.",
    ];
    const out = redact(lines.join("\n"));
    expect(out.text).toBe(lines.join("\n"));
    expect(out.removed).toEqual({ emails: 0, phones: 0, blocks: [] });
  });

  it("recognises the common ways a Kenyan phone number is written", () => {
    for (const phone of ["+254 712 345 678", "+254712345678", "+254 (20) 555-0100", "0712 345 678", "0712-345678", "0712345678", "020 555 0100", "(020) 555 0100"]) {
      const out = redact(`Call the site on ${phone} before a visit.`);
      expect(out.text, phone).toBe("Call the site on [phone removed] before a visit.");
      expect(out.removed.phones, phone).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------------------------

describe("reading coordinates", () => {
  it("reads a minus sign with an S as south, and flags that it was written both ways", () => {
    const reading = parseCoordinates("GPS COORDINATES: -1.2921°S, 36.8219°E");
    expect(reading).toEqual({
      lat: -1.2921,
      lon: 36.8219,
      latHow: "both_agree",
      lonHow: "hemisphere",
      raw: "-1.2921°S, 36.8219°E",
      writtenBothWays: true,
      conflict: false,
    });
    expect(describeReading(reading!)).toBe("1.2921° S (by its letter, with a minus sign that says the same), 36.8219° E (by its letter)");
  });

  it("reads N and E letters as north and east", () => {
    const reading = parseCoordinates("GPS COORDINATES: 0.1234°N, 34.5678°E");
    expect(reading).toMatchObject({ lat: 0.1234, lon: 34.5678, latHow: "hemisphere", lonHow: "hemisphere", writtenBothWays: false, conflict: false });
  });

  it("takes the direction from the letter alone when there is no minus", () => {
    expect(parseCoordinates("at 1.2921 S, 36.8219 E")).toMatchObject({ lat: -1.2921, lon: 36.8219, latHow: "hemisphere" });
    expect(parseCoordinates("S 1.2921, E 36.8219")).toMatchObject({ lat: -1.2921, lon: 36.8219, latHow: "hemisphere", lonHow: "hemisphere" });
    expect(parseCoordinates("1.2921° South, 36.8219° East")).toMatchObject({ lat: -1.2921, lon: 36.8219 });
  });

  it("takes the direction from the sign when there is no letter, and says so", () => {
    expect(parseCoordinates("The site (-1.2921, 36.8219) is level.")).toMatchObject({ lat: -1.2921, lon: 36.8219, latHow: "sign", lonHow: "sign", raw: "-1.2921, 36.8219", writtenBothWays: false });
    // No minus and no letter is read as written, north: nothing is assumed from where Kenya is.
    expect(parseCoordinates("1.2921, 36.8219")).toMatchObject({ lat: 1.2921, latHow: "sign" });
    expect(parseCoordinates("Latitude: -0.0917 Longitude: 34.7680")).toMatchObject({ lat: -0.0917, lon: 34.768, latHow: "sign" });
    expect(parseCoordinates("\u22121.2921, 36.8219")).toMatchObject({ lat: -1.2921 });
  });

  it("flags a minus sign with N or E as a conflict and goes by the letter", () => {
    expect(parseCoordinates("-1.2921°N, 36.8219°E")).toMatchObject({ lat: 1.2921, latHow: "both_conflict", writtenBothWays: true, conflict: true });
    expect(parseCoordinates("1.2921°S, -36.8219°E")).toMatchObject({ lat: -1.2921, lon: 36.8219, lonHow: "both_conflict", conflict: true });
  });

  it("accepts longitude first when the letters say which is which", () => {
    expect(parseCoordinates("36.8219°E, 1.2921°S")).toMatchObject({ lat: -1.2921, lon: 36.8219 });
    expect(parseCoordinates("Lon 36.8219, Lat -1.2921")).toMatchObject({ lat: -1.2921, lon: 36.8219 });
  });

  it("reads degrees, minutes and seconds", () => {
    const dms = parseCoordinates("1°17'31.6\"S 36°49'18.8\"E");
    expect(dms!.lat).toBeCloseTo(-(1 + 17 / 60 + 31.6 / 3600), 9);
    expect(dms!.lon).toBeCloseTo(36 + 49 / 60 + 18.8 / 3600, 9);
    expect(parseCoordinates("1°17.5'S, 36°49.3'E")!.lat).toBeCloseTo(-1.291667, 5);
  });

  it("returns the first pair only, and does not take other numbers for a place", () => {
    expect(parseCoordinates("Tower at 1.2921°S, 36.8219°E; generator at 1.29300°S, 36.82250°E")).toMatchObject({ lat: -1.2921, lon: 36.8219 });
    for (const text of [
      "TIV KES 4,250,000,000 and a limit of KES 500,000,000",
      "3 floors, 2 basements, built 2009-2012",
      "Deductible 5%, minimum KES 2.5 million; river 1.8 km away",
      "Floor area 48,500 m² at KES 87,600 per m²",
      "Depths of 0.45, 1.20 and 2.75 m",
      "Latitude 95.0000 N, 36.8219 E",
      "",
    ]) {
      expect(parseCoordinates(text), text).toBeNull();
    }
  });

  it("knows what is inside Kenya", () => {
    expect(inKenya(-1.2921, 36.8219)).toBe(true); // Nairobi
    expect(inKenya(0.1234, 34.5678)).toBe(true); // western Kenya
    expect(inKenya(-4.05, 39.67)).toBe(true); // the coast
    expect(inKenya(1.2921, -36.8219)).toBe(false); // the Atlantic
    expect(inKenya(36.8219, -1.2921)).toBe(false); // the two numbers swapped
    expect(inKenya(-6.8, 39.28)).toBe(false); // Dar es Salaam
    expect(inKenya(51.5, -0.12)).toBe(false); // London
    expect(inKenya(Number.NaN, 36.8)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The quote checks
// ---------------------------------------------------------------------------------------------

const DOCUMENT = [
  "OFFER SUMMARY",
  "INSURED: Baraka Towers Limited",
  "GPS COORDINATES: -1.2850°S, 36.8200°E",
  "GROSS FLOOR AREA: 12,400 m²",
  "CONSTRUCTION CLASSIFICATION: Reinforced concrete frame",
  "The flood deductible is 5% of each loss, subject to a minimum of",
  "KES 2 million any one event. The flood limit is KES 300m.",
  "The building is 1.8 km from the Nairobi River and has two basement levels.",
  "Total insured value is KES 1.25 billion. The broker\u2019s view is that flood risk is \u201clow\u201d.",
  "Cover runs from 1\u00a0January 2032 to 31 December 2032.",
].join("\n");

describe("the quote is in the document", () => {
  it("finds a quote copied word for word", () => {
    expect(quoteInDocument("GROSS FLOOR AREA: 12,400 m²", DOCUMENT)).toBe(true);
  });

  it("does not find a quote that was reworded, or an empty one", () => {
    expect(quoteInDocument("The flood deductible is 10% of each loss", DOCUMENT)).toBe(false);
    expect(quoteInDocument("the flood deductible is 5% of each loss", DOCUMENT)).toBe(false);
    expect(quoteInDocument("", DOCUMENT)).toBe(false);
    expect(quoteInDocument("   ", DOCUMENT)).toBe(false);
  });

  it("treats a line break, a tab and a run of spaces as one space", () => {
    expect(quoteInDocument("subject to a minimum of KES 2 million any one event.", DOCUMENT)).toBe(true);
    expect(quoteInDocument("  The flood deductible   is 5% of\teach loss,\nsubject to a minimum of\r\nKES 2 million ", DOCUMENT)).toBe(true);
  });

  it("does not mind straight or curly quotation marks, or non-breaking spaces", () => {
    expect(quoteInDocument("The broker's view is that flood risk is \"low\".", DOCUMENT)).toBe(true);
    expect(quoteInDocument("Cover runs from 1 January 2032 to 31 December 2032.", DOCUMENT)).toBe(true);
    expect(quoteInDocument("GROSS FLOOR AREA: 12,400 m2", DOCUMENT)).toBe(true);
    // Marks a model wrapped round the sentence are not part of it.
    expect(quoteInDocument("\"Total insured value is KES 1.25 billion.\"", DOCUMENT)).toBe(true);
  });
});

describe("the number is in its quote", () => {
  it("finds a number written with thousands separators", () => {
    expect(numberInQuote(12400, "GROSS FLOOR AREA: 12,400 m²")).toBe(true);
    expect(numberInQuote(12400, "about 12 400 sq m of lettable space")).toBe(true);
    expect(numberInQuote(4250000000, "TIV (KES 4,250,000,000)")).toBe(true);
  });

  it("does not find a number that is not there", () => {
    expect(numberInQuote(12500, "GROSS FLOOR AREA: 12,400 m²")).toBe(false);
    expect(numberInQuote(400, "GROSS FLOOR AREA: 12,400 m²")).toBe(false);
    expect(numberInQuote(5, "The deductible applies to each and every loss.")).toBe(false);
    expect(numberInQuote(Number.NaN, "KES 5")).toBe(false);
  });

  it("applies million, billion and thousand, written as a word or a letter", () => {
    expect(numberInQuote(8000000, "worth KES 8 million")).toBe(true);
    expect(numberInQuote(8000000, "worth KES 8m")).toBe(true);
    expect(numberInQuote(8000000, "worth KES 8M")).toBe(true);
    expect(numberInQuote(8500000000, "a total of KES 8.5 billion")).toBe(true);
    expect(numberInQuote(8500000000, "a total of KES 8.5bn")).toBe(true);
    expect(numberInQuote(4350000, "KES 4.35 Mn")).toBe(true);
    expect(numberInQuote(250000, "a deductible of KES 250k")).toBe(true);
    expect(numberInQuote(2000000, "two million shillings")).toBe(true);
    expect(numberInQuote(9000000, "worth KES 8 million")).toBe(false);
    expect(numberInQuote(8000, "worth KES 8 million")).toBe(false);
  });

  it("reads a percent sign, an area unit and a distance in km", () => {
    expect(numberInQuote(5, "5% of each loss")).toBe(true);
    expect(numberInQuote(2.5, "2.5 per cent of the sum insured")).toBe(true);
    expect(numberInQuote(0.05, "5% of each loss")).toBe(false);
    expect(numberInQuote(48500, "48,500 sq m gross")).toBe(true);
    expect(numberInQuote(1800, "1.8 km from the river")).toBe(true);
    expect(numberInQuote(350, "350 m from the river")).toBe(true);
    expect(numberInQuote(1.8, "1.8 km from the river")).toBe(true);
  });

  it("ignores the sign, because the hemisphere letter carries it", () => {
    expect(numberInQuote(-1.2921, "1.2921°S, 36.8219°E")).toBe(true);
    expect(numberInQuote(1.2921, "-1.2921°S, 36.8219°E")).toBe(true);
    expect(numberInQuote(-1.29, "1.2921°S, 36.8219°E")).toBe(false);
  });

  it("reads small numbers written as words", () => {
    expect(numberInQuote(2, "has two basement levels")).toBe(true);
    expect(numberInQuote(0, "The tower has no basement.")).toBe(true);
    expect(numberInQuote(3, "has two basement levels")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The whole extraction
// ---------------------------------------------------------------------------------------------

const said = <T>(value: T, quote: string): Quoted<T> => ({ value, quote, status: "unverified", reason: null });
const unsaid = <T>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });

const row = (over: Partial<OfferRow> = {}): OfferRow => ({
  name: unsaid(),
  lat: unsaid(),
  lon: unsaid(),
  housingClass: unsaid(),
  floorAreaM2: unsaid(),
  costPerM2Kes: unsaid(),
  tivKes: unsaid(),
  path: "model",
  coordinates: null,
  ...over,
});

const terms = (over: Partial<OfferTerms> = {}): OfferTerms => ({
  basements: unsaid(),
  occupancy: unsaid(),
  floodDeductiblePct: unsaid(),
  floodDeductibleMinKes: unsaid(),
  floodDeductibleBasis: unsaid(),
  floodLimitKes: unsaid(),
  policyPeriod: unsaid(),
  floodCover: unsaid(),
  placeName: unsaid(),
  riverName: unsaid(),
  riverDistanceM: unsaid(),
  ...over,
});

const GPS = "GPS COORDINATES: -1.2850°S, 36.8200°E";

describe("checking a whole extraction", () => {
  const extraction: OfferExtraction = {
    rows: [
      row({
        name: said("Baraka Towers", "INSURED: Baraka Towers Limited"),
        // The value arrives without its sign: the letter in the quote supplies it.
        lat: said(1.285, GPS),
        lon: said(36.82, GPS),
        housingClass: said("concrete_rcc", "CONSTRUCTION CLASSIFICATION: Reinforced concrete frame"),
        floorAreaM2: said(12400, "GROSS FLOOR AREA: 12,400 m²"),
        costPerM2Kes: said(100000, "The cost is KES 100,000 per square metre."),
        tivKes: said(1300000000, "Total insured value is KES 1.25 billion."),
      }),
    ],
    terms: terms({
      basements: said(2, "The building is 1.8 km from the Nairobi River and has two basement levels."),
      floodDeductiblePct: said(5, "The flood deductible is 5% of each loss, subject to a minimum of KES 2 million any one event."),
      floodDeductibleMinKes: said(2000000, "The flood deductible is 5% of each loss, subject to a minimum of KES 2 million any one event."),
      floodLimitKes: said(300000000, "The flood limit is KES 300m."),
      riverName: said("Nairobi River", "The building is 1.8 km from the Nairobi River and has two basement levels."),
      riverDistanceM: said(1800, "The building is 1.8 km from the Nairobi River and has two basement levels."),
      placeName: said("Westlands", "INSURED: Baraka Towers Limited"),
      occupancy: { value: null, quote: "CONSTRUCTION CLASSIFICATION: Reinforced concrete frame", status: "unverified", reason: "\"offices and shops\" is not one of the listed uses." },
      policyPeriod: said("1 January 2032 to 31 December 2032", ""),
      floodCover: said("covered", "5"),
    }),
    notes: [
      { kind: "broker_view", ...said("Broker rates the flood risk as low", "The broker's view is that flood risk is \"low\".") },
      { kind: "past_flood", ...said("Flooded in 2018", "The basement flooded in 2018.") },
    ],
  };
  const checked = verifyExtraction(extraction, DOCUMENT);
  const first = checked.rows[0];

  it("marks a value verified when its quote is in the document and its number is in the quote", () => {
    expect(first.name).toMatchObject({ status: "verified", reason: null });
    expect(first.housingClass).toMatchObject({ value: "concrete_rcc", status: "verified" });
    expect(first.floorAreaM2).toMatchObject({ value: 12400, status: "verified" });
    expect(checked.terms.basements.status).toBe("verified");
    expect(checked.terms.floodDeductiblePct.status).toBe("verified");
    expect(checked.terms.floodDeductibleMinKes.status).toBe("verified");
    expect(checked.terms.floodLimitKes.status).toBe("verified");
    expect(checked.terms.riverName.status).toBe("verified");
    expect(checked.terms.riverDistanceM.status).toBe("verified");
    expect(checked.notes[0]).toMatchObject({ kind: "broker_view", status: "verified" });
  });

  it("marks a value unverified, with the reason, when a check fails", () => {
    expect(first.costPerM2Kes).toMatchObject({ value: 100000, status: "unverified", reason: "The quoted sentence is not in the document as written." });
    expect(first.tivKes.status).toBe("unverified");
    expect(first.tivKes.reason).toBe("The number 1,300,000,000 is not written in the quoted sentence.");
    expect(checked.terms.placeName).toMatchObject({ status: "unverified", reason: "\"Westlands\" is not written in the quoted sentence." });
    expect(checked.terms.policyPeriod).toMatchObject({ status: "unverified", reason: "No sentence from the document was given for this value." });
    expect(checked.notes[1]).toMatchObject({ kind: "past_flood", status: "unverified" });
    // "5" is in the document, but one figure says nothing about whether flood is covered.
    expect(checked.terms.floodCover).toMatchObject({ value: "covered", status: "unverified", reason: "The quote is a single word or figure, too short to show what the value refers to." });
    // A reason set when the reply was first read is kept.
    expect(checked.terms.occupancy).toMatchObject({ value: null, status: "unverified", reason: "\"offices and shops\" is not one of the listed uses." });
  });

  it("accepts a one-word quote only when that word is the whole document", () => {
    const typed = verifyExtraction({ rows: [row()], terms: terms({ placeName: said("Kibera", "Kibera") }), notes: [] }, "Kibera");
    expect(typed.terms.placeName.status).toBe("verified");
    const priced = verifyExtraction({ rows: [row({ tivKes: said(8000000, "two-storey masonry shop in Kibera worth KES 8 million") })], terms: terms({ placeName: said("Kibera", "two-storey masonry shop in Kibera worth KES 8 million") }), notes: [] }, "two-storey masonry shop in Kibera worth KES 8 million");
    expect(priced.rows[0].tivKes).toMatchObject({ value: 8000000, status: "verified" });
    expect(priced.terms.placeName.status).toBe("verified");
  });

  it("marks what the document does not state as missing", () => {
    expect(checked.terms.floodDeductibleBasis).toEqual({ value: null, quote: "", status: "missing", reason: null });
    expect(usableValue(checked.terms.floodDeductibleBasis)).toBeNull();
  });

  it("reads the coordinates from the quote and takes the sign from the letter", () => {
    expect(first.lat).toMatchObject({ value: -1.285, status: "verified" });
    expect(first.lon).toMatchObject({ value: 36.82, status: "verified" });
    expect(first.coordinates).toMatchObject({ lat: -1.285, lon: 36.82, latHow: "both_agree", writtenBothWays: true, conflict: false });
  });

  it("does not change the extraction it was given", () => {
    expect(extraction.rows[0].lat).toEqual(said(1.285, GPS));
    expect(extraction.rows[0].coordinates).toBeNull();
  });

  it("only lets a verified, confirmed or edited value be used", () => {
    expect(usableValue(first.floorAreaM2)).toBe(12400);
    expect(usableValue(first.tivKes)).toBeNull();
    expect(usableValue({ value: 7, quote: "", status: "confirmed", reason: null })).toBe(7);
    expect(usableValue({ value: 7, quote: "", status: "edited", reason: null })).toBe(7);
    expect(usableValue({ value: 7, quote: "", status: "unverified", reason: null })).toBeNull();
    expect(usableValue({ value: null, quote: "", status: "missing", reason: null })).toBeNull();
  });

  it("rejects a point outside Kenya", () => {
    const doc = "The plant is at 6.8000°S, 39.2800°E beside the harbour.";
    const out = verifyExtraction({ rows: [row({ lat: said(-6.8, doc), lon: said(39.28, doc) })], terms: terms(), notes: [] }, doc).rows[0];
    expect(out.lat).toMatchObject({ value: -6.8, status: "unverified", reason: "The point -6.8, 39.28 is outside Kenya." });
    expect(out.lon.status).toBe("unverified");
    expect(usableValue(out.lat)).toBeNull();
  });

  it("does not trust a minus sign with an N", () => {
    const doc = "GPS COORDINATES: -1.2850°N, 36.8200°E";
    const out = verifyExtraction({ rows: [row({ lat: said(-1.285, doc), lon: said(36.82, doc) })], terms: terms(), notes: [] }, doc).rows[0];
    expect(out.lat).toMatchObject({ value: 1.285, status: "unverified" });
    expect(out.lat.reason).toMatch(/minus sign and the letter N/);
    // The longitude is written one way only, but a point is only as sure as both of its numbers.
    expect(out.lon).toMatchObject({ value: 36.82, status: "unverified" });
    expect(out.lon.reason).toMatch(/^The latitude written with it is in doubt\. Written with a minus sign and the letter N/);
    expect(out.coordinates).toMatchObject({ conflict: true, latHow: "both_conflict" });
  });

  it("does not let a hemisphere be supplied that the document does not write", () => {
    const doc = "The site is at 1.2850, 36.8200 on the ring road.";
    const out = verifyExtraction({ rows: [row({ lat: said(-1.285, doc), lon: said(36.82, doc) })], terms: terms(), notes: [] }, doc).rows[0];
    expect(out.lat).toMatchObject({ value: 1.285, status: "unverified" });
    expect(out.lat.reason).toMatch(/no minus sign and no S/);
    expect(out.lon.status).toBe("unverified");
    expect(usableValue(out.lon)).toBeNull();
  });

  it("flags coordinates that are not the ones in the quote, or have no pair to read", () => {
    const wrong = verifyExtraction({ rows: [row({ lat: said(-1.3, GPS), lon: said(36.82, GPS) })], terms: terms(), notes: [] }, DOCUMENT).rows[0];
    expect(wrong.lat.status).toBe("unverified");
    expect(wrong.lat.reason).toMatch(/not the number first given \(-1\.3\)/);
    expect(wrong.lon.status).toBe("unverified");

    const none = verifyExtraction({ rows: [row({ lat: said(-1.285, "INSURED: Baraka Towers Limited"), lon: said(36.82, "INSURED: Baraka Towers Limited") })], terms: terms(), notes: [] }, DOCUMENT).rows[0];
    expect(none.lat).toMatchObject({ value: -1.285, status: "unverified", reason: "No latitude and longitude pair could be read from the quoted sentence." });
    expect(none.coordinates).toBeNull();
  });

  it("reads a pair whose two numbers came with separate sentences", () => {
    const doc = "Latitude 1.2850 S\nLongitude 36.8200 E";
    const out = verifyExtraction({ rows: [row({ lat: said(-1.285, "Latitude 1.2850 S"), lon: said(36.82, "Longitude 36.8200 E") })], terms: terms(), notes: [] }, doc).rows[0];
    expect(out.lat).toMatchObject({ value: -1.285, status: "verified" });
    expect(out.lon).toMatchObject({ value: 36.82, status: "verified", quote: "Longitude 36.8200 E" });
  });

  it("leaves confirmed and edited values exactly as they are", () => {
    const confirmed: Quoted<number> = { value: 1300000000, quote: "not in the document", status: "confirmed", reason: null };
    const edited: Quoted<number> = { value: -1.3, quote: GPS, status: "edited", reason: null };
    const out = verifyExtraction({ rows: [row({ tivKes: confirmed, lat: edited, lon: { ...edited, value: 36.9 } })], terms: terms(), notes: [] }, DOCUMENT).rows[0];
    expect(out.tivKes).toEqual(confirmed);
    expect(out.lat).toEqual(edited);
    expect(out.lon.value).toBe(36.9);
    expect(out.coordinates).toBeNull();
  });

  it("lets the underwriter confirm an unverified value", () => {
    const next = confirmValue(checked, { scope: "row", row: 0, key: "tivKes" });
    expect(next.rows[0].tivKes).toMatchObject({ value: 1300000000, status: "confirmed", reason: null });
    expect(usableValue(next.rows[0].tivKes)).toBe(1300000000);
    expect(checked.rows[0].tivKes.status).toBe("unverified");
    // Nothing to confirm: already verified, or no value to accept.
    expect(confirmValue(checked, { scope: "row", row: 0, key: "floorAreaM2" })).toBe(checked);
    expect(confirmValue(checked, { scope: "terms", key: "occupancy" })).toBe(checked);
    expect(confirmValue(checked, { scope: "note", index: 1 }).notes[1]).toMatchObject({ kind: "past_flood", status: "confirmed" });
    // A second check keeps the confirmation.
    expect(verifyExtraction(next, DOCUMENT).rows[0].tivKes.status).toBe("confirmed");
  });

  it("lets the underwriter type a value, read the way it is written", () => {
    const tiv = editValue(checked, { scope: "row", row: 0, key: "tivKes" }, "KES 1.25 billion");
    expect(tiv.rows[0].tivKes).toEqual({ value: 1250000000, quote: "Total insured value is KES 1.25 billion.", status: "edited", reason: null });
    expect(editValue(checked, { scope: "row", row: 0, key: "tivKes" }, "8,000,000").rows[0].tivKes.value).toBe(8000000);
    expect(editValue(checked, { scope: "row", row: 0, key: "tivKes" }, "8m").rows[0].tivKes.value).toBe(8000000);
    expect(editValue(checked, { scope: "row", row: 0, key: "floorAreaM2" }, "450 m²").rows[0].floorAreaM2.value).toBe(450);
    expect(editValue(checked, { scope: "terms", key: "riverDistanceM" }, "2.4 km").terms.riverDistanceM.value).toBe(2400);
    expect(editValue(checked, { scope: "terms", key: "riverDistanceM" }, "350 m").terms.riverDistanceM.value).toBe(350);
    expect(editValue(checked, { scope: "terms", key: "floodDeductiblePct" }, "2.5%").terms.floodDeductiblePct.value).toBe(2.5);
    expect(editValue(checked, { scope: "terms", key: "occupancy" }, "Commercial").terms.occupancy).toMatchObject({ value: "commercial", status: "edited", reason: null });
    expect(editValue(checked, { scope: "row", row: 0, key: "housingClass" }, "permanent_masonry").rows[0].housingClass.value).toBe("permanent_masonry");
    expect(editValue(checked, { scope: "note", index: 1 }, "No flood on record").notes[1]).toMatchObject({ kind: "past_flood", value: "No flood on record", status: "edited" });
  });

  it("drops the note on how coordinates were read once one is typed", () => {
    const next = editValue(checked, { scope: "row", row: 0, key: "lat" }, -1.3);
    expect(next.rows[0].lat).toMatchObject({ value: -1.3, status: "edited" });
    expect(next.rows[0].coordinates).toBeNull();
    expect(checked.rows[0].coordinates).not.toBeNull();
  });

  it("clears a value on null, and ignores a typed value its field cannot hold", () => {
    const cleared = editValue(checked, { scope: "row", row: 0, key: "floorAreaM2" }, null);
    expect(cleared.rows[0].floorAreaM2).toEqual({ value: null, quote: "", status: "missing", reason: null });
    expect(editValue(checked, { scope: "row", row: 0, key: "name" }, "  ").rows[0].name.status).toBe("missing");

    expect(editValue(checked, { scope: "row", row: 0, key: "tivKes" }, "a lot")).toBe(checked);
    expect(editValue(checked, { scope: "row", row: 0, key: "tivKes" }, -5)).toBe(checked);
    expect(editValue(checked, { scope: "row", row: 0, key: "lat" }, 95)).toBe(checked);
    expect(editValue(checked, { scope: "row", row: 0, key: "housingClass" }, "glass")).toBe(checked);
    expect(editValue(checked, { scope: "row", row: 4, key: "tivKes" }, 1)).toBe(checked);
    expect(editValue(checked, { scope: "note", index: 9 }, "x")).toBe(checked);
  });
});

// ---------------------------------------------------------------------------------------------
// The two test offers, when they are on this machine. Nothing of their text is printed:
// every assertion is on a yes or no, or a count.
// ---------------------------------------------------------------------------------------------

const TEST_DATA = join(__dirname, "..", "..", "data", "test-data");
const offers = existsSync(TEST_DATA) ? readdirSync(TEST_DATA).filter((f) => f.toLowerCase().endsWith(".docx")) : [];

describe.skipIf(offers.length === 0)("the test offers", () => {
  it("lose their contact details and keep their coordinates", async () => {
    for (const [i, file] of offers.entries()) {
      const label = `offer ${i + 1}`;
      const text = await docxToText(readFileSync(join(TEST_DATA, file)));
      const sent = redact(text);
      expect(sent.removed.emails > 0 && sent.removed.phones > 0 && sent.removed.blocks.length > 0, label).toBe(true);
      expect(/@/.test(sent.text), label).toBe(false);
      expect(/\+\d{2,3}[ (]/.test(sent.text), label).toBe(false);
      expect(redact(sent.text).text === sent.text, label).toBe(true);

      // Apart from the markers, every line that is left is a line of the document, word for word.
      const original = new Set(text.split("\n"));
      const changed = sent.text.split("\n").filter((line) => !original.has(line));
      expect(changed.every((line) => /^\[(contact details|signature block) removed\]$/.test(line)), label).toBe(true);

      const gps = sent.text.split("\n").find((line) => line.startsWith("GPS COORDINATES:"));
      const reading = gps ? parseCoordinates(gps) : null;
      expect(reading !== null && !reading.conflict && inKenya(reading.lat, reading.lon), label).toBe(true);
      expect(gps !== undefined && quoteInDocument(gps, sent.text), label).toBe(true);
    }
  });
});
