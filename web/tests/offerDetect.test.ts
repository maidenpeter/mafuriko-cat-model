import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as getTestOffer } from "../src/app/api/test-offer/route";
import { detectDatasets, looksLikeOffer, type FileSource } from "../src/lib/ingest";

// Every name, place, number and sentence in this file is invented for the tests.

const OFFER_WITH_COORDINATES = [
  "PLACEMENT MEMO",
  "Insured: Baraka Hardware Stores Ltd",
  "Risk: a three-storey concrete shop and store on Mwangaza Road.",
  "Location: 1.2864 S, 36.8172 E",
  "Cover: property damage including flood.",
].join("\n");

const OFFER_WITH_SUM_INSURED = [
  "FACULTATIVE OFFER",
  "Insured: Upendo Millers Ltd",
  "Risk: a maize mill and its stock, in the industrial area.",
  "Sum insured: KES 240,000,000",
  "Flood deductible: 2% of the sum insured.",
].join("\n");

const DATA_DICTIONARY = [
  "Data dictionary",
  "loc_id: the building's identifier.",
  "lat, lon: the position in decimal degrees, for example -1.2864, 36.8172.",
  "tiv_kes: the total insured value, for example KES 4,500,000.",
  "housing_class: one of six construction classes.",
].join("\n");

const PROBLEM_STATEMENT = [
  "Team C Problem Statement",
  "Build a flood loss model for the city. The study area is centred near 1.2900 S, 36.8200 E.",
  "The portfolio has a total insured value of KES 90,000,000,000 across the synthetic buildings.",
  "Judges will score the explanation as much as the numbers.",
].join("\n");

const PLAIN_NOTES = "Meeting notes. Bring the projector, 12 chairs and 3 tables. Lunch is at 13.00.";

const source = (path: string, content: string | Uint8Array): FileSource => {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    path,
    size: bytes.byteLength,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};

async function docx(text: string): Promise<Uint8Array> {
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const body = text.split("\n").map((line) => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("telling an offer from documentation by its text", () => {
  it("takes a document with coordinates in Kenya as an offer", () => {
    expect(looksLikeOffer("memo.txt", OFFER_WITH_COORDINATES)).toBe(true);
  });

  it("takes a document with a sum insured and no coordinates as an offer", () => {
    expect(looksLikeOffer("memo.txt", OFFER_WITH_SUM_INSURED)).toBe(true);
  });

  it("leaves a data dictionary as documentation, whatever it quotes", () => {
    expect(looksLikeOffer("columns.txt", DATA_DICTIONARY)).toBe(false);
    expect(looksLikeOffer("Data_Dictionary.docx", OFFER_WITH_SUM_INSURED)).toBe(false);
  });

  it("leaves a problem statement as documentation, whatever it quotes", () => {
    expect(looksLikeOffer("brief.txt", PROBLEM_STATEMENT)).toBe(false);
    expect(looksLikeOffer("Team_C_Problem_Statement.docx", OFFER_WITH_COORDINATES)).toBe(false);
  });

  it("does not take other numbers, or a position outside Kenya, for an offer", () => {
    expect(looksLikeOffer("notes.txt", PLAIN_NOTES)).toBe(false);
    expect(looksLikeOffer("far.txt", "The warehouse stands at 48.8566 N, 2.3522 E.")).toBe(false);
  });
});

describe("offers in an upload", () => {
  it("sorts .docx and .txt files into offers and documentation", async () => {
    const files = [
      source("kit/OFFER_BARAKA.docx", await docx(OFFER_WITH_COORDINATES)),
      source("kit/upendo.txt", OFFER_WITH_SUM_INSURED),
      source("kit/columns.txt", DATA_DICTIONARY),
      source("kit/Team_C_Problem_Statement.docx", await docx(PROBLEM_STATEMENT)),
      source("kit/notes.txt", PLAIN_NOTES),
      source("kit/broken.docx", "not a zip at all"),
      source("kit/guide.md", "Sum insured: KES 1,000,000"),
    ];
    const found = await detectDatasets(files, "kit");

    expect(found.offers.map((f) => f.path)).toEqual(["kit/OFFER_BARAKA.docx", "kit/upendo.txt"]);
    expect(found.candidates).toEqual([]);

    const kinds = Object.fromEntries(found.files.map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({
      "OFFER_BARAKA.docx": "offer",
      "upendo.txt": "offer",
      "columns.txt": "other",
      "Team_C_Problem_Statement.docx": "other",
      "notes.txt": "other",
      "broken.docx": "other",
      "guide.md": "other",
    });
    const note = (name: string) => found.files.find((f) => f.name === name)?.note;
    expect(note("OFFER_BARAKA.docx")).not.toBe("Documentation");
    expect(note("columns.txt")).toBe("Documentation");
    expect(note("Team_C_Problem_Statement.docx")).toBe("Documentation");
  });

  it("keeps the data set and hands back the offer that came with it", async () => {
    const files = [
      source("kit/exposure.csv", "loc_id,lat,lon,housing_class,tiv_kes,hazard_score_extreme\nX-1,-1.25,36.85,concrete_rcc,1000000,0.1\n"),
      source("kit/offer.txt", OFFER_WITH_SUM_INSURED),
    ];
    const found = await detectDatasets(files, "kit");
    expect(found.candidates.map((c) => c.name)).toEqual(["kit"]);
    expect(found.offers.map((f) => f.path)).toEqual(["kit/offer.txt"]);
  });
});

describe("the rehearsal route for the Nairobi test offer", () => {
  const saved = process.env.MODEL_DATA_DIR;
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "test-offer-route-"));
    mkdirSync(join(base, "with", "data"), { recursive: true });
    mkdirSync(join(base, "with", "test-data"));
    writeFileSync(join(base, "with", "test-data", "OFFER_KISUMU_MILL.docx"), "other offer");
    writeFileSync(join(base, "with", "test-data", "Offer_Nairobi_Shop.docx"), "invented bytes");
    writeFileSync(join(base, "with", "test-data", "nairobi_notes.txt"), "not a Word file");
    mkdirSync(join(base, "empty", "data"), { recursive: true });
    mkdirSync(join(base, "empty", "test-data"));
    mkdirSync(join(base, "none", "data"), { recursive: true });
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.MODEL_DATA_DIR;
    else process.env.MODEL_DATA_DIR = saved;
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("serves the first Word file with Nairobi in its name, whatever the case", async () => {
    process.env.MODEL_DATA_DIR = join(base, "with", "data");
    const res = await getTestOffer();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(res.headers.get("Content-Disposition")).toContain('filename="Offer_Nairobi_Shop.docx"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("invented bytes");
  });

  it("answers 404 with a reason when the folder has no Nairobi offer, or is not there", async () => {
    for (const kit of ["empty", "none"]) {
      process.env.MODEL_DATA_DIR = join(base, kit, "data");
      const res = await getTestOffer();
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toMatch(/test-data/);
    }
  });
});
