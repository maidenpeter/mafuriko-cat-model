import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { describeReading, inKenya, parseCoordinates } from "../src/lib/offer/coords";
import { docxToText, readOfferFile } from "../src/lib/offer/docx";
import { DRIVER_FIELDS, DRIVER_GROUPS, driverFieldDef, driverFields, fieldDefOf, fieldText, HISTORY_YEARS_FIELD, historyFieldDef, historyFields, TERM_FIELDS } from "../src/lib/offer/fields";
import { brokerQuestions } from "../src/lib/offer/questions";
import { describeRemoved, redact } from "../src/lib/offer/redact";
import { extractByRules } from "../src/lib/offer/rules";
import type { OfferExtraction, OfferFile, OfferRow, OfferTerms, Quoted } from "../src/lib/offer/types";
import { confirmValue, editValue, numberInQuote, quoteInDocument, statusCounts, usableValue, verifyExtraction, waitingValues } from "../src/lib/offer/verify";

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
// The document's own loss history
// ---------------------------------------------------------------------------------------------

describe("checking the loss history", () => {
  const HISTORY = `LOSS HISTORY (11 YEARS: 2014-2024)
In April 2018 storm water filled the lower basement.
The 2018 claim was settled at KES 4.2 million.
Summary: 2019 flood, KES 4,200,000 paid.
A pipe burst on level 3 in 2021 and no claim was made.
Excess applied in each case: KES 2,024.`;
  const heading = "LOSS HISTORY (11 YEARS: 2014-2024)";
  const extraction: OfferExtraction = {
    rows: [row()],
    terms: terms({ floodHistoryYears: said(11, heading) }),
    notes: [],
    floodLosses: [
      // An amount in millions, on a sentence of its own.
      { year: said(2018, "In April 2018 storm water filled the lower basement."), amountKes: said(4200000, "The 2018 claim was settled at KES 4.2 million.") },
      // An amount written in full, on the same line as its year.
      { year: said(2019, "Summary: 2019 flood, KES 4,200,000 paid."), amountKes: said(4200000, "Summary: 2019 flood, KES 4,200,000 paid.") },
      // A year only.
      { year: said(2021, "A pipe burst on level 3 in 2021 and no claim was made."), amountKes: unsaid() },
      // A year that is not in its sentence, and an amount whose sentence is not in the document.
      { year: said(2020, "A pipe burst on level 3 in 2021 and no claim was made."), amountKes: said(900000, "The 2020 claim was settled at KES 900,000.") },
      // The figure 2,024 is an amount of money, not the year 2024.
      { year: said(2024, "Excess applied in each case: KES 2,024."), amountKes: said(4500000, "The 2018 claim was settled at KES 4.2 million.") },
    ],
  };
  const checked = verifyExtraction(extraction, HISTORY);
  const losses = checked.floodLosses!;

  it("verifies the years of history, and each loss's year and amount, against their quotes", () => {
    expect(checked.terms.floodHistoryYears).toEqual({ value: 11, quote: heading, status: "verified", reason: null });
    expect(losses[0].year).toMatchObject({ value: 2018, status: "verified", reason: null });
    // "KES 4.2 million" and "KES 4,200,000" are the same amount, and both hold it.
    expect(losses[0].amountKes).toMatchObject({ value: 4200000, status: "verified" });
    expect(losses[1].amountKes).toMatchObject({ value: 4200000, status: "verified" });
    expect(usableValue(losses[0].amountKes)).toBe(4200000);
  });

  it("leaves a loss with no amount as a verified year and an amount that is not stated", () => {
    expect(losses[2].year.status).toBe("verified");
    expect(losses[2].amountKes).toEqual({ value: null, quote: "", status: "missing", reason: null });
    expect(usableValue(losses[2].amountKes)).toBeNull();
  });

  it("marks a year or an amount unverified, with the reason, when a check fails", () => {
    expect(losses[3].year).toMatchObject({ status: "unverified", reason: "The number 2,020 is not written in the quoted sentence." });
    expect(losses[3].amountKes).toMatchObject({ status: "unverified", reason: "The quoted sentence is not in the document as written." });
    expect(losses[4].year).toMatchObject({ status: "unverified", reason: "The year 2024 is not written in the quoted sentence." });
    expect(losses[4].amountKes).toMatchObject({ status: "unverified", reason: "The number 4,500,000 is not written in the quoted sentence." });
    expect(usableValue(losses[3].amountKes)).toBeNull();
    // A wrong number of years is held back the same way.
    expect(verifyExtraction({ ...extraction, terms: terms({ floodHistoryYears: said(10, heading) }) }, HISTORY).terms.floodHistoryYears?.status).toBe("unverified");
  });

  it("gives an extraction built with no loss history an empty list and a years value that is not stated", () => {
    const bare = verifyExtraction({ rows: [row()], terms: terms(), notes: [] }, HISTORY);
    expect(bare.floodLosses).toEqual([]);
    expect(bare.terms.floodHistoryYears).toEqual({ value: null, quote: "", status: "missing", reason: null });
  });

  it("counts the loss history's values with the rest", () => {
    const bare = statusCounts(verifyExtraction({ rows: [row()], terms: terms(), notes: [] }, HISTORY));
    const full = statusCounts(checked);
    // The years of history, then two values for each of the five losses.
    expect(full.verified - bare.verified).toBe(1 + 5);
    expect(full.unverified - bare.unverified).toBe(4);
    // The years value is no longer missing; one loss has no amount.
    expect(full.missing - bare.missing).toBe(1 - 1);
    // Terms built by hand, with no years value at all, count it as not stated.
    expect(statusCounts({ rows: [row()], terms: terms(), notes: [] }).missing).toBe(bare.missing);
  });

  it("never holds the price back for the loss history", () => {
    expect(waitingValues(checked)).toEqual([]);
  });

  it("lets the underwriter confirm, type over, clear and add a loss", () => {
    const confirmed = confirmValue(checked, { scope: "loss", index: 3, key: "amountKes" });
    expect(confirmed.floodLosses![3].amountKes).toMatchObject({ value: 900000, status: "confirmed", reason: null });
    expect(checked.floodLosses![3].amountKes.status).toBe("unverified");
    // A second check keeps the confirmation.
    expect(verifyExtraction(confirmed, HISTORY).floodLosses![3].amountKes.status).toBe("confirmed");

    const typed = editValue(checked, { scope: "loss", index: 2, key: "amountKes" }, "KES 1.5 million");
    expect(typed.floodLosses![2].amountKes).toEqual({ value: 1500000, quote: "", status: "edited", reason: null });
    expect(editValue(checked, { scope: "loss", index: 3, key: "year" }, "2021").floodLosses![3].year).toMatchObject({ value: 2021, status: "edited" });
    expect(editValue(checked, { scope: "terms", key: "floodHistoryYears" }, "12").terms.floodHistoryYears).toMatchObject({ value: 12, status: "edited" });

    // A cleared loss keeps its place, so the ones after it keep their numbers.
    const cleared = editValue(checked, { scope: "loss", index: 0, key: "amountKes" }, null);
    expect(cleared.floodLosses).toHaveLength(5);
    expect(cleared.floodLosses![0].amountKes.status).toBe("missing");

    // One past the end adds a loss the reading did not find.
    const added = editValue(checked, { scope: "loss", index: 5, key: "year" }, 2023);
    expect(added.floodLosses).toHaveLength(6);
    expect(added.floodLosses![5]).toEqual({ year: { value: 2023, quote: "", status: "edited", reason: null }, amountKes: { value: null, quote: "", status: "missing", reason: null } });
    const first = editValue({ rows: [row()], terms: terms(), notes: [] }, { scope: "loss", index: 0, key: "amountKes" }, "950,000");
    expect(first.floodLosses).toHaveLength(1);
    expect(editValue({ rows: [row()], terms: terms(), notes: [] }, { scope: "terms", key: "floodHistoryYears" }, 9).terms.floodHistoryYears).toMatchObject({ value: 9, status: "edited" });
  });

  it("ignores a typed value the loss history cannot hold", () => {
    expect(editValue(checked, { scope: "loss", index: 0, key: "year" }, "18")).toBe(checked);
    expect(editValue(checked, { scope: "loss", index: 0, key: "year" }, "2018.5")).toBe(checked);
    expect(editValue(checked, { scope: "loss", index: 0, key: "amountKes" }, -5)).toBe(checked);
    expect(editValue(checked, { scope: "terms", key: "floodHistoryYears" }, 0)).toBe(checked);
    // Two past the end points at nothing, and clearing a loss that is not there adds none.
    expect(editValue(checked, { scope: "loss", index: 7, key: "year" }, 2023)).toBe(checked);
    expect(editValue(checked, { scope: "loss", index: 5, key: "year" }, null)).toBe(checked);
    expect(confirmValue(checked, { scope: "loss", index: 5, key: "year" })).toBe(checked);
    expect(confirmValue(checked, { scope: "loss", index: 0, key: "year" })).toBe(checked);
  });
});

describe("the loss history as a list for the screen", () => {
  const extraction: OfferExtraction = {
    rows: [row()],
    terms: terms({ floodHistoryYears: { value: 11, quote: "LOSS HISTORY (11 YEARS: 2014-2024)", status: "verified", reason: null } }),
    notes: [],
    floodLosses: [{ year: { value: 2018, quote: "LOSS #1: 2018, April", status: "verified", reason: null }, amountKes: { value: 4200000, quote: "Amount paid: KES 4.2 million", status: "verified", reason: null } }],
  };

  it("names each value in plain words and writes it with its unit", () => {
    const list = historyFields(extraction);
    expect(list.map((f) => [f.id, f.label, f.value])).toEqual([
      ["terms:floodHistoryYears", "Years of loss history", "11 years"],
      ["loss:0:year", "Past flood loss 1: year", "2018"],
      ["loss:0:amountKes", "Past flood loss 1: amount", "KES 4,200,000"],
    ]);
    expect(list.map((f) => f.ref)).toEqual([
      { scope: "terms", key: "floodHistoryYears" },
      { scope: "loss", index: 0, key: "year" },
      { scope: "loss", index: 0, key: "amountKes" },
    ]);
    expect(list[2].quoted).toBe(extraction.floodLosses![0].amountKes);
    // Each reference points at the value it names: an edit through it lands there.
    expect(editValue(extraction, list[1].ref, 2019).floodLosses![0].year.value).toBe(2019);
  });

  it("gives one entry, not stated, for an offer with no loss history", () => {
    const list = historyFields({ rows: [row()], terms: terms(), notes: [] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "terms:floodHistoryYears", label: "Years of loss history", value: "", quoted: { value: null, status: "missing" } });
  });

  it("finds the box a loss history value is typed into, and leaves the other values to their own lists", () => {
    expect(historyFieldDef({ scope: "terms", key: "floodHistoryYears" })?.kind).toBe("years");
    expect(historyFieldDef({ scope: "loss", index: 2, key: "year" })?.kind).toBe("year");
    expect(historyFieldDef({ scope: "loss", index: 2, key: "amountKes" })?.kind).toBe("kes");
    expect(historyFieldDef({ scope: "terms", key: "floodLimitKes" })).toBeNull();
    expect(historyFieldDef({ scope: "note", index: 0 })).toBeNull();
    // The years value is listed with the losses, so it is not also among the offer-level boxes.
    expect(TERM_FIELDS.some((f) => (f.key as string) === "floodHistoryYears")).toBe(false);
    expect(fieldText(1, HISTORY_YEARS_FIELD)).toBe("1 year");
  });
});

// ---------------------------------------------------------------------------------------------
// What the loss drivers beyond flood depth read
// ---------------------------------------------------------------------------------------------

describe("checking what the loss drivers read", () => {
  const SITE = `The tower has three basement levels, the lowest 9.5 m below ground.
The storm drains are designed for a 1-in-50 year storm.
Rain of 50 mm fell in one hour in April 2018.
The channel was rebuilt to a 25-year standard.
Sump pumps: 2 x 15 l/s, with no backup power.
Flood barriers are fitted at both ramps.
Plant in the basements is valued at KES 260 million.
Annual rent: KES 300,000,000. Business interruption is excluded.
Annual premium: KES 9.6 million.
The standby generator is in basement 2.`;
  const drains = "The storm drains are designed for a 1-in-50 year storm.";
  const extraction: OfferExtraction = {
    rows: [row()],
    terms: terms({
      basementDepthM: said(9.5, "The tower has three basement levels, the lowest 9.5 m below ground."),
      drainDesignRp: said(50, drains),
      sumpPumpCapacity: said("2 x 15 l/s", "Sump pumps: 2 x 15 l/s, with no backup power."),
      sumpPumpBackup: said("no", "Sump pumps: 2 x 15 l/s, with no backup power."),
      floodBarriers: said("present", "Flood barriers are fitted at both ramps."),
      // A sentence the document does not hold.
      nonReturnValves: said("present", "Non-return valves are fitted."),
      valueBelowGroundKes: said(260000000, "Plant in the basements is valued at KES 260 million."),
      // A number that is not in its sentence.
      annualRentKes: said(320000000, "Annual rent: KES 300,000,000."),
      biCovered: said("excluded", "Business interruption is excluded."),
      premiumKes: said(9600000, "Annual premium: KES 9.6 million."),
    }),
    notes: [],
    equipmentBelowGround: [{ item: said("Standby generator", "The standby generator is in basement 2.") }, { item: said("Fire pumps", "The fire pumps are in basement 1.") }],
  };
  const checked = verifyExtraction(extraction, SITE);

  it("verifies each one against its sentence, numbers and words alike", () => {
    for (const key of ["basementDepthM", "drainDesignRp", "sumpPumpCapacity", "sumpPumpBackup", "floodBarriers", "valueBelowGroundKes", "biCovered", "premiumKes"] as const) {
      expect(`${key}: ${checked.terms[key]?.status}`).toBe(`${key}: verified`);
    }
    expect(usableValue(checked.terms.drainDesignRp)).toBe(50);
    expect(checked.equipmentBelowGround![0].item).toMatchObject({ value: "Standby generator", status: "verified", reason: null });
  });

  it("marks one unverified, with the reason, when a check fails", () => {
    expect(checked.terms.nonReturnValves).toMatchObject({ status: "unverified", reason: "The quoted sentence is not in the document as written." });
    expect(checked.terms.annualRentKes).toMatchObject({ status: "unverified", reason: "The number 320,000,000 is not written in the quoted sentence." });
    expect(checked.equipmentBelowGround![1].item).toMatchObject({ status: "unverified", reason: "The quoted sentence is not in the document as written." });
    expect(usableValue(checked.terms.annualRentKes)).toBeNull();
  });

  it("takes a return period only where the sentence writes one", () => {
    const design = (value: number, quote: string) => verifyExtraction({ rows: [row()], terms: terms({ drainDesignRp: said(value, quote) }), notes: [] }, SITE).terms.drainDesignRp;
    // "50-year", "1-in-50", "1:50" and "return period of 50 years" all hold 50.
    expect(design(25, "The channel was rebuilt to a 25-year standard.")?.status).toBe("verified");
    expect(verifyExtraction({ rows: [row()], terms: terms({ drainDesignRp: said(50, "Drains: 1:50 design.") }), notes: [] }, "Drains: 1:50 design.").terms.drainDesignRp?.status).toBe("verified");
    expect(verifyExtraction({ rows: [row()], terms: terms({ drainDesignRp: said(50, "The design return period of the drains is 50 years.") }), notes: [] }, "The design return period of the drains is 50 years.").terms.drainDesignRp?.status).toBe("verified");
    // 50 mm of rain holds the number 50, but not as a return period.
    expect(design(50, "Rain of 50 mm fell in one hour in April 2018.")).toMatchObject({
      status: "unverified",
      reason: "50 is not written as a number of years, or as a 1-in-50 chance, in the quoted sentence.",
    });
    // The 1 of "1-in-50" is not a one-year storm, and 2018 is a date.
    expect(design(1, drains)?.status).toBe("unverified");
    expect(design(2018, "Rain of 50 mm fell in one hour in April 2018.")?.status).toBe("unverified");
    expect(design(100, drains)).toMatchObject({ status: "unverified", reason: "The number 100 is not written in the quoted sentence." });
  });

  it("gives terms built by hand every one of them, not stated, and counts them", () => {
    const bare = verifyExtraction({ rows: [row()], terms: terms(), notes: [] }, SITE);
    for (const f of DRIVER_FIELDS) expect(bare.terms[f.key]).toEqual({ value: null, quote: "", status: "missing", reason: null });
    expect(bare.equipmentBelowGround).toEqual([]);
    // An absent value is read as not stated everywhere.
    expect(usableValue(terms().drainDesignRp)).toBeNull();
    expect(statusCounts({ rows: [row()], terms: terms(), notes: [] })).toEqual(statusCounts(bare));
    const full = statusCounts(checked);
    const none = statusCounts(bare);
    // Eight of the ten values hold, and one of the two items.
    expect(full.verified - none.verified).toBe(8 + 1);
    expect(full.unverified - none.unverified).toBe(2 + 1);
    expect(none.missing - full.missing).toBe(10);
  });

  it("never holds the price back for them", () => {
    expect(waitingValues(checked)).toEqual([]);
  });

  it("lets the underwriter confirm, type over and clear them, read the way they are written", () => {
    expect(confirmValue(checked, { scope: "terms", key: "annualRentKes" }).terms.annualRentKes).toMatchObject({ value: 320000000, status: "confirmed", reason: null });
    expect(editValue(checked, { scope: "terms", key: "drainDesignRp" }, "1-in-25").terms.drainDesignRp).toMatchObject({ value: 25, status: "edited", reason: null });
    expect(editValue(checked, { scope: "terms", key: "drainDesignRp" }, "1 in 100 years").terms.drainDesignRp?.value).toBe(100);
    expect(editValue(checked, { scope: "terms", key: "drainDesignRp" }, "10-year").terms.drainDesignRp?.value).toBe(10);
    expect(editValue(checked, { scope: "terms", key: "drainDesignRp" }, 5).terms.drainDesignRp?.value).toBe(5);
    // The letter m after a depth is metres, never millions.
    expect(editValue(checked, { scope: "terms", key: "basementDepthM" }, "7.5 m").terms.basementDepthM?.value).toBe(7.5);
    expect(editValue(checked, { scope: "terms", key: "valueBelowGroundKes" }, "380m").terms.valueBelowGroundKes?.value).toBe(380000000);
    expect(editValue(checked, { scope: "terms", key: "sumpPumpBackup" }, "Yes").terms.sumpPumpBackup).toMatchObject({ value: "yes", status: "edited" });
    expect(editValue(checked, { scope: "terms", key: "floodBarriers" }, "absent").terms.floodBarriers?.value).toBe("absent");
    expect(editValue(checked, { scope: "terms", key: "biCovered" }, "covered").terms.biCovered?.value).toBe("covered");
    expect(editValue(checked, { scope: "terms", key: "sumpPumpCapacity" }, "3 x 20 l/s").terms.sumpPumpCapacity?.value).toBe("3 x 20 l/s");
    expect(editValue(checked, { scope: "terms", key: "premiumKes" }, null).terms.premiumKes?.status).toBe("missing");
    // A value typed into terms that never held one.
    expect(editValue({ rows: [row()], terms: terms(), notes: [] }, { scope: "terms", key: "drainDesignRp" }, "50").terms.drainDesignRp).toMatchObject({ value: 50, status: "edited" });

    // What the field cannot hold changes nothing.
    expect(editValue(checked, { scope: "terms", key: "drainDesignRp" }, "0")).toBe(checked);
    expect(editValue(checked, { scope: "terms", key: "drainDesignRp" }, "soon")).toBe(checked);
    expect(editValue(checked, { scope: "terms", key: "floodBarriers" }, "maybe")).toBe(checked);
    expect(editValue(checked, { scope: "terms", key: "basementDepthM" }, -3)).toBe(checked);
  });

  it("lets the underwriter confirm, rename, clear and add an item of equipment", () => {
    const confirmed = confirmValue(checked, { scope: "equipment", index: 1 });
    expect(confirmed.equipmentBelowGround![1].item).toMatchObject({ value: "Fire pumps", status: "confirmed", reason: null });
    expect(verifyExtraction(confirmed, SITE).equipmentBelowGround![1].item.status).toBe("confirmed");
    expect(editValue(checked, { scope: "equipment", index: 0 }, "Two standby generators").equipmentBelowGround![0].item).toMatchObject({ value: "Two standby generators", status: "edited" });
    // A cleared item keeps its place; one past the end adds an item.
    const cleared = editValue(checked, { scope: "equipment", index: 0 }, null);
    expect(cleared.equipmentBelowGround).toHaveLength(2);
    expect(cleared.equipmentBelowGround![0].item.status).toBe("missing");
    const added = editValue(checked, { scope: "equipment", index: 2 }, "LV switchgear");
    expect(added.equipmentBelowGround![2]).toEqual({ item: { value: "LV switchgear", quote: "", status: "edited", reason: null } });
    expect(editValue({ rows: [row()], terms: terms(), notes: [] }, { scope: "equipment", index: 0 }, "Lift motors").equipmentBelowGround).toHaveLength(1);
    // Nothing to do: already verified, past the end, or nothing typed for an item that is not there.
    expect(confirmValue(checked, { scope: "equipment", index: 0 })).toBe(checked);
    expect(editValue(checked, { scope: "equipment", index: 4 }, "Tanks")).toBe(checked);
    expect(editValue(checked, { scope: "equipment", index: 2 }, null)).toBe(checked);
  });

  it("lists them for the screen in their groups, each with its unit, stated or not", () => {
    expect(DRIVER_GROUPS.map((g) => [g.title, g.fields.map((f) => f.key)])).toEqual([
      ["Below ground", ["basementDepthM", "valueBelowGroundKes"]],
      ["Value split", ["valueBuildingKes", "valueMachineryKes", "valueContentsKes", "annualRentKes"]],
      ["Drainage and protection", ["drainDesignRp", "sumpPumpCapacity", "sumpPumpBackup", "floodBarriers", "nonReturnValves"]],
      ["Cover and premium", ["biCovered", "premiumKes"]],
    ]);
    const list = driverFields(checked);
    const shown = Object.fromEntries(list.map((f) => [f.id, [f.group, f.label, f.value]]));
    expect(shown["terms:basementDepthM"]).toEqual(["Below ground", "Depth of the lowest basement floor", "9.5 m"]);
    expect(shown["terms:valueBelowGroundKes"]).toEqual(["Below ground", "Value below ground", "KES 260,000,000"]);
    expect(shown["equipment:0"]).toEqual(["Below ground", "Equipment below ground 1", "Standby generator"]);
    // A return period is written as everywhere else, with its annual chance.
    expect(shown["terms:drainDesignRp"]).toEqual(["Drainage and protection", "Drain design return period", "1-in-50 (2% a year)"]);
    expect(shown["terms:sumpPumpBackup"]).toEqual(["Drainage and protection", "Sump pumps have backup power", "No"]);
    expect(shown["terms:floodBarriers"]).toEqual(["Drainage and protection", "Flood barriers", "Present"]);
    expect(shown["terms:biCovered"]).toEqual(["Cover and premium", "Business interruption", "Excluded"]);
    expect(shown["terms:valueBuildingKes"]).toEqual(["Value split", "Value of the building", ""]);
    expect(list.map((f) => f.id).slice(0, 4)).toEqual(["terms:basementDepthM", "terms:valueBelowGroundKes", "equipment:0", "equipment:1"]);
    // Each reference points at the value it names.
    const pumps = list.find((f) => f.id === "equipment:1")!;
    expect(editValue(checked, pumps.ref, "Booster pumps").equipmentBelowGround![1].item.value).toBe("Booster pumps");

    // An offer that states none of it still lists the thirteen values, every one not stated.
    const none = driverFields({ rows: [row()], terms: terms(), notes: [] });
    expect(none).toHaveLength(13);
    expect(none.every((f) => f.value === "" && f.quoted.status === "missing")).toBe(true);
  });

  it("finds the box any value is typed into, and keeps the new values out of the old list", () => {
    expect(driverFieldDef({ scope: "terms", key: "drainDesignRp" })?.kind).toBe("returnPeriod");
    expect(driverFieldDef({ scope: "equipment", index: 3 })?.kind).toBe("text");
    expect(driverFieldDef({ scope: "terms", key: "floodLimitKes" })).toBeNull();
    expect(fieldDefOf({ scope: "terms", key: "floodLimitKes" })?.kind).toBe("kes");
    expect(fieldDefOf({ scope: "terms", key: "floodHistoryYears" })?.kind).toBe("years");
    expect(fieldDefOf({ scope: "terms", key: "basementDepthM" })?.kind).toBe("depth");
    expect(fieldDefOf({ scope: "row", row: 0, key: "tivKes" })?.kind).toBe("kes");
    expect(fieldDefOf({ scope: "loss", index: 0, key: "year" })?.kind).toBe("year");
    expect(fieldDefOf({ scope: "equipment", index: 0 })?.label).toBe("Equipment below ground");
    expect(fieldDefOf({ scope: "note", index: 0 })).toBeNull();
    // The offer-level boxes shown before are the same ones: code that reads them unguarded still can.
    expect(TERM_FIELDS.some((f) => DRIVER_FIELDS.some((d) => (d.key as string) === f.key))).toBe(false);
    expect(TERM_FIELDS).toHaveLength(11);
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

  it("give up their loss history to the rules, each flood or water loss once and every value verified", async () => {
    for (const [i, file] of offers.entries()) {
      const label = `offer ${i + 1}`;
      const text = redact(await docxToText(readFileSync(join(TEST_DATA, file)))).text;
      const read = verifyExtraction(extractByRules(text), text);
      const losses = read.floodLosses ?? [];
      expect(read.terms.floodHistoryYears?.status === "verified" && (read.terms.floodHistoryYears.value ?? 0) > 0, label).toBe(true);
      expect(losses.length > 0, label).toBe(true);
      expect(losses.every((l) => l.year.status === "verified" && l.amountKes.status === "verified"), label).toBe(true);
      // Both memos tell a loss in more than one place. No year is listed twice.
      expect(new Set(losses.map((l) => l.year.value)).size === losses.length, label).toBe(true);
      // The other perils in the same history are left out: fewer losses are read than loss lines are written.
      const lossLines = text.split("\n").filter((line) => /^(?:LOSS #\d+:|\d+\.\s+(?:19|20)\d{2}\s)/.test(line.trim())).length;
      expect(lossLines > losses.length, label).toBe(true);
    }
  });

  it("give the rules what the loss drivers read only in the document's own words, and the rest becomes questions", async () => {
    for (const [i, file] of offers.entries()) {
      const label = `offer ${i + 1}`;
      const text = redact(await docxToText(readFileSync(join(TEST_DATA, file)))).text;
      const read = verifyExtraction(extractByRules(text), text);
      const equipment = read.equipmentBelowGround ?? [];
      const stated = DRIVER_FIELDS.filter((f) => read.terms[f.key]?.status !== "missing").map((f) => f.key as string);
      // Whatever the rules read passes the same checks as every other value. Nothing is guessed.
      expect(DRIVER_FIELDS.every((f) => ["verified", "missing"].includes(read.terms[f.key]?.status ?? "missing")), label).toBe(true);
      expect(equipment.every((e) => e.item.status === "verified"), label).toBe(true);
      // No value the document states is asked of the broker, and each of these is asked when it is not stated.
      const asked = brokerQuestions(read).map((q) => q.id);
      expect(asked.some((id) => stated.includes(id)), label).toBe(false);
      for (const key of ["drainDesignRp", "biCovered", "premiumKes"]) expect(asked.includes(key) !== stated.includes(key), label).toBe(true);
      expect(asked.includes("equipmentBelowGround"), label).toBe(equipment.length === 0 && read.terms.basements.value !== 0);
      // Each memo gives the rules some of what the drivers read, and names equipment below ground.
      expect(stated.length > 0 && equipment.length > 0, label).toBe(true);
    }
  });
});
