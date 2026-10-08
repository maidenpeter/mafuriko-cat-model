import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/offer/extract/route";
import { strictSchema } from "../src/lib/agents/openai";
import { extractOffer } from "../src/lib/offer/client";
import { buildOfferPrompt, fromFlatReply, OFFER_RESPONSE_SCHEMA, offerReplySchema } from "../src/lib/offer/extraction";
import { extractByRules } from "../src/lib/offer/rules";
import { OFFER_FIELDS, OFFER_MAX_CHARS, type OfferExtractResponse, type OfferExtraction, type OfferFlatEntry } from "../src/lib/offer/types";
import { verifyExtraction } from "../src/lib/offer/verify";

// Every document here is invented. None of it comes from a real offer.
const MEMO = `PLACEMENT NOTE
BROKER: Baraka Risk Partners
CLIENT: Jacaranda Heights Limited
ENQUIRIES:
Wanjiru Example
+254 (20) 555-0142
w.example@baraka.example

STREET ADDRESS: Plot 7, Acacia Road, Westlands, Nairobi
GPS COORDINATES: -1.2650°S, 36.8030°E
GROSS FLOOR AREA: 12,400 m² (every level counted)
CONSTRUCTION CLASSIFICATION: RCC frame, masonry infill panels
Storeys: 9 above ground and 2 basement levels
CLASS OF BUSINESS: Commercial property (offices over shops)
TOTAL SUM INSURED: KES 2,480,000,000

STANDBY GENERATOR:
- Housed on basement level 2, beside the lift pit (-1.26512°S, 36.80311°E)

WHAT IS NEARBY:
- Kirichwa River (to the south) - 0.6 km

FLOOD RECORD:
The site has not flooded since it was built in 2015.

SITE DRAINS:
- Open channels on two sides, cleaned in March 2026

TERMS ASKED FOR:
The owner wants flood added at renewal. Flood cover is requested, with a flood
deductible of 5% of each loss, minimum KES 1,500,000. The flood limit asked for
is KES 900,000,000 any one event.
TERM: 12 months (1 January 2027 - 31 December 2027)`;

const SHOP = "two-storey masonry shop in Kibera worth KES 8 million";
const PLACES = ["Mathare", "Kibera", "Westlands", "Nairobi West", "Hospital"];

/** Every value of an extraction that the document states, by name. */
function statedValues(extraction: OfferExtraction) {
  const { path, coordinates, ...row } = extraction.rows[0];
  void path;
  void coordinates;
  return Object.entries({ ...row, ...extraction.terms }).filter(([, q]) => q.status !== "missing");
}

describe("reading a memo by the rules", () => {
  const read = extractByRules(MEMO, PLACES);
  const row = read.rows[0];

  it("gives one row, marked as read by the rules", () => {
    expect(read.rows).toHaveLength(1);
    expect(row.path).toBe("rules");
    expect(row.name.value).toBe("Jacaranda Heights Limited");
  });

  it("takes the coordinates from the labelled line, not from the generator's", () => {
    expect(row.lat.value).toBeCloseTo(-1.265, 6);
    expect(row.lon.value).toBeCloseTo(36.803, 6);
    expect(row.lat.quote).toBe("GPS COORDINATES: -1.2650°S, 36.8030°E");
    expect(row.lon.quote).toBe(row.lat.quote);
  });

  it("reads the floor area, the class and the insured value from their labelled lines", () => {
    expect(row.floorAreaM2).toMatchObject({ value: 12_400, quote: "GROSS FLOOR AREA: 12,400 m² (every level counted)" });
    // A concrete frame with masonry infill is concrete, and the line it rests on is kept.
    expect(row.housingClass).toMatchObject({ value: "concrete_rcc", quote: "CONSTRUCTION CLASSIFICATION: RCC frame, masonry infill panels" });
    expect(row.tivKes).toMatchObject({ value: 2_480_000_000, quote: "TOTAL SUM INSURED: KES 2,480,000,000" });
    // Nothing states a cost per m², and the rules never work one out.
    expect(row.costPerM2Kes).toEqual({ value: null, quote: "", status: "missing", reason: null });
  });

  it("reads the offer's terms, each with the sentence it came from", () => {
    const { terms } = read;
    expect(terms.basements.value).toBe(2);
    expect(terms.occupancy.value).toBe("commercial");
    expect(terms.floodDeductiblePct.value).toBe(5);
    // "KES 1,500,000" is one and a half million: the m of "minimum" is not a scale.
    expect(terms.floodDeductibleMinKes.value).toBe(1_500_000);
    expect(terms.floodDeductibleBasis.value).toBe("percent_of_loss");
    // The sentence ran over a line break in the memo. The quote is the sentence, on one line.
    expect(terms.floodDeductiblePct.quote).toBe("Flood cover is requested, with a flood deductible of 5% of each loss, minimum KES 1,500,000.");
    expect(terms.floodLimitKes).toMatchObject({ value: 900_000_000, quote: "The flood limit asked for is KES 900,000,000 any one event." });
    expect(terms.policyPeriod.value).toBe("12 months (1 January 2027 - 31 December 2027)");
    expect(terms.floodCover.value).toBe("covered");
    expect(terms.placeName).toMatchObject({ value: "Westlands", quote: "STREET ADDRESS: Plot 7, Acacia Road, Westlands, Nairobi" });
    expect(terms.riverName.value).toBe("Kirichwa River");
    expect(terms.riverDistanceM.value).toBe(600);
  });

  it("notes plant in the basement and the drains, and does not turn a denial into a flood", () => {
    const kinds = read.notes.map((n) => n.kind);
    expect(kinds).toContain("basement_plant");
    expect(kinds).toContain("drainage_condition");
    expect(kinds).not.toContain("past_flood");
    expect(read.notes.find((n) => n.kind === "basement_plant")?.quote).toContain("basement level 2");
  });

  it("leaves every value provisional, and every one then passes the checks against the document", () => {
    for (const [, q] of statedValues(read)) expect(q).toMatchObject({ status: "unverified", reason: null });
    const checked = verifyExtraction(read, MEMO);
    for (const [name, q] of statedValues(checked)) expect(`${name}: ${q.status}`).toBe(`${name}: verified`);
    for (const note of checked.notes) expect(note.status).toBe("verified");
    // Written with a minus sign and an S: still south, and flagged as written both ways.
    expect(checked.rows[0].coordinates).toMatchObject({ latHow: "both_agree", writtenBothWays: true, conflict: false });
    expect(checked.rows[0].lat.value).toBeLessThan(0);
  });
});

describe("the rules on other wording", () => {
  it("finds an insured value in brackets after the letters TIV, on a wrapped line", () => {
    const text = "PROPOSED TERMS:\nThe flood limit sought is the whole TIV (KES 3.2 billion), with one\nreinstatement at full premium.\nGPS COORDINATES: 1.0000°S, 36.9000°E";
    const read = extractByRules(text);
    expect(read.rows[0].tivKes.value).toBe(3_200_000_000);
    expect(read.terms.floodLimitKes.value).toBe(3_200_000_000);
    expect(read.rows[0].tivKes.quote).toBe("The flood limit sought is the whole TIV (KES 3.2 billion), with one reinstatement at full premium.");
    const checked = verifyExtraction(read, text);
    expect(checked.rows[0].tivKes.status).toBe("verified");
    expect(checked.terms.floodLimitKes.status).toBe("verified");
  });

  it("does not take a share of the insured value for the value or the limit", () => {
    const read = extractByRules("NOTES:\nThe flood limit is to be 25% of TIV (KES 500,000,000) any one event.\nGPS COORDINATES: 1.0000°S, 36.9000°E");
    expect(read.rows[0].tivKes.status).toBe("missing");
    expect(read.terms.floodLimitKes.status).toBe("missing");
  });

  it("reads a flat deductible and a limit from one sentence", () => {
    const read = extractByRules("SUMMARY:\nQuote on the basis of a flood limit of KES 400,000,000\nand a deductible of KES 12,000,000 for flood claims.\nGPS COORDINATES: 0.5000°N, 34.5000°E");
    expect(read.terms.floodLimitKes.value).toBe(400_000_000);
    expect(read.terms.floodDeductibleMinKes.value).toBe(12_000_000);
    expect(read.terms.floodDeductiblePct.status).toBe("missing");
    // North and east, by their letters.
    expect(read.rows[0].lat.value).toBeCloseTo(0.5, 6);
  });

  it("maps construction wording to the four classes", () => {
    const classOf = (wording: string) => extractByRules(`CONSTRUCTION CLASSIFICATION: ${wording}`).rows[0].housingClass.value;
    expect(classOf("Reinforced concrete frame with glazed curtain wall")).toBe("concrete_rcc");
    expect(classOf("Dressed stone walls under a tiled roof")).toBe("permanent_masonry");
    expect(classOf("Brick walls, iron sheet roof")).toBe("permanent_masonry");
    expect(classOf("Timber frame and boarding")).toBe("semi_permanent");
    expect(classOf("Mixed construction")).toBe("semi_permanent");
    expect(classOf("Iron sheet walls and roof")).toBe("informal_iron_sheet");
    // Wording that names no class is left for the underwriter. A class is never assumed.
    expect(extractByRules("CONSTRUCTION CLASSIFICATION: Grade A, completed 2019").rows[0].housingClass.status).toBe("missing");
  });

  it("does not choose a class when several buildings each have a construction line", () => {
    const read = extractByRules("STORE ONE:\n- Construction: Stone walls\nSTORE TWO:\n- Construction: Timber frame\nGPS COORDINATES: 0.5000°N, 34.5000°E");
    expect(read.rows[0].housingClass.status).toBe("missing");
  });

  it("notes a flood that happened and a broker's rating", () => {
    const read = extractByRules("LOSS RECORD:\nFLOOD EVENT 1 (April 2018):\nThe yard was flooded twice that season.\nThere were no flood claims in 2021.\nFLOOD RISK RATING: High, in the broker's opinion\nGPS COORDINATES: 0.5000°N, 34.5000°E");
    expect(read.notes.filter((n) => n.kind === "past_flood").map((n) => n.quote)).toEqual(["FLOOD EVENT 1 (April 2018):", "The yard was flooded twice that season."]);
    expect(read.notes.filter((n) => n.kind === "broker_view").map((n) => n.quote)).toEqual(["FLOOD RISK RATING: High, in the broker's opinion"]);
  });

  it("does not read the height of a river as the distance to it", () => {
    const read = extractByRules("RIVER:\nThe Nzoia River rose 2.4 m above its banks.\nSite lies 1.8 km north of the Nzoia River.\nGPS COORDINATES: 0.5000°N, 34.5000°E");
    expect(read.terms.riverName.value).toBe("Nzoia River");
    expect(read.terms.riverDistanceM.value).toBe(1800);
  });

  it("says flood is excluded when the text leaves it out", () => {
    expect(extractByRules("COVER: All risks excluding flood.\nGPS COORDINATES: 0.5000°N, 34.5000°E").terms.floodCover.value).toBe("excluded");
  });

  it("returns one row of missing values for text with nothing in it", () => {
    const read = extractByRules("Please call me when you have a moment.");
    expect(read.rows).toHaveLength(1);
    expect(statedValues(read)).toEqual([]);
    expect(read.notes).toEqual([]);
  });
});

describe("one typed sentence", () => {
  it("gives a class from the wording, a value, and a place name for the locator, with no coordinates", () => {
    const read = extractByRules(SHOP, PLACES);
    const row = read.rows[0];
    expect(row.housingClass).toMatchObject({ value: "permanent_masonry", quote: SHOP });
    expect(row.tivKes).toMatchObject({ value: 8_000_000, quote: SHOP });
    expect(row.lat.status).toBe("missing");
    expect(row.lon.status).toBe("missing");
    expect(read.terms.placeName).toMatchObject({ value: "Kibera", quote: SHOP });
    expect(read.terms.occupancy.value).toBe("commercial");

    const checked = verifyExtraction(read, SHOP);
    expect(checked.rows[0].housingClass.status).toBe("verified");
    expect(checked.rows[0].tivKes.status).toBe("verified");
    expect(checked.terms.placeName.status).toBe("verified");
    expect(checked.rows[0].coordinates).toBeNull();
  });

  it("still offers the place name when no list of places is given", () => {
    expect(extractByRules(SHOP).terms.placeName.value).toBe("Kibera");
  });

  it("prefers the place the sentence says the building is in", () => {
    expect(extractByRules("Stone house by the Hospital road in Mathare, insured for KES 3,500,000", PLACES).terms.placeName.value).toBe("Mathare");
  });

  it("reads typed coordinates, a floor area and a cost per m²", () => {
    const read = extractByRules("Timber workshop at -1.3110, 36.7880, 240 m2, rebuilding at KES 35,000 per m2");
    const row = read.rows[0];
    expect(row.lat.value).toBeCloseTo(-1.311, 6);
    expect(row.lon.value).toBeCloseTo(36.788, 6);
    expect(row.housingClass.value).toBe("semi_permanent");
    expect(row.floorAreaM2.value).toBe(240);
    expect(row.costPerM2Kes.value).toBe(35_000);
    // The only amount is a rate, so no insured value is stated.
    expect(row.tivKes.status).toBe("missing");
  });
});

describe("the reply shape asked of the model", () => {
  it("is a flat list in which every property is required", () => {
    const schema = strictSchema(OFFER_RESPONSE_SCHEMA) as { type: string; required: string[]; additionalProperties: boolean; properties: { entries: { type: string; items: { required: string[]; additionalProperties: boolean; properties: Record<string, { type: string; enum?: string[] }> } } } };
    expect(schema).toMatchObject({ type: "object", required: ["entries"], additionalProperties: false });
    const { items } = schema.properties.entries;
    expect(schema.properties.entries.type).toBe("array");
    // The quote is written before the value, so the value follows from the sentence.
    expect(Object.keys(items.properties)).toEqual(["field", "row", "quote", "value"]);
    expect(items.required).toEqual(["field", "row", "quote", "value"]);
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.field).toEqual({ type: "string", enum: [...OFFER_FIELDS] });
    expect(items.properties.row).toEqual({ type: "integer" });
    expect(JSON.stringify(schema)).not.toMatch(/propertyOrdering|"(OBJECT|ARRAY|STRING|INTEGER)"/);
  });

  it("asks for quotes word for word, names every field, and carries the document", () => {
    const { system, user } = buildOfferPrompt("THE DOCUMENT TEXT");
    for (const field of OFFER_FIELDS) expect(system).toContain(field);
    for (const name of ["concrete_rcc", "permanent_masonry", "semi_permanent", "informal_iron_sheet"]) expect(system).toContain(`"${name}"`);
    expect(system).toMatch(/copied word for word/);
    expect(system).toMatch(/Never invent a value/);
    expect(system).toMatch(/one row per insured building/);
    expect(user).toContain("THE DOCUMENT TEXT");
    expect(system + user).not.toMatch(/[\u2013\u2014]/);
  });

  it("drops an entry under an unknown field name and tidies harmless slips", () => {
    const parsed = offerReplySchema.parse({
      entries: [
        { field: "tiv_kes", row: "1", value: 8000000, quote: "worth KES 8 million" },
        { field: "Housing_Class", row: 1, value: "permanent_masonry", quote: "masonry shop" },
        { field: "roof_colour", row: 1, value: "red", quote: "red roof" },
      ],
    });
    expect(parsed.entries).toEqual([
      { field: "tiv_kes", row: 1, value: "8000000", quote: "worth KES 8 million" },
      { field: "housing_class", row: 1, value: "permanent_masonry", quote: "masonry shop" },
    ]);
  });

  it("rejects a reply in another shape", () => {
    expect(offerReplySchema.safeParse({ rows: [] }).success).toBe(false);
    expect(offerReplySchema.safeParse({ entries: [{ field: "tiv_kes", row: 1, value: "1" }] }).success).toBe(false);
    expect(offerReplySchema.safeParse({ entries: [{ field: "tiv_kes", row: -1, value: "1", quote: "q" }] }).success).toBe(false);
  });
});

describe("turning the flat reply into rows", () => {
  const entry = (field: OfferFlatEntry["field"], row: number, value: string, quote: string): OfferFlatEntry => ({ field, row, value, quote });
  const made = fromFlatReply({
    entries: [
      entry("name", 1, "Mill house", "The mill house is the oldest building."),
      entry("lat", 1, "-1.2650", "Position: 1.2650°S, 36.8030°E"),
      entry("lon", 1, "36.8030", "Position: 1.2650°S, 36.8030°E"),
      entry("housing_class", 1, "Permanent Masonry", "The mill house has stone walls."),
      entry("floor_area_m2", 1, "1,250", "The mill house covers 1,250 m²."),
      entry("tiv_kes", 1, "40000000", "an early figure"),
      entry("tiv_kes", 1, "45000000", "The mill house is insured for KES 45 million."),
      // The model left building 2 out and numbered the next one 3.
      entry("name", 3, "Grain store", "The grain store stands beside it."),
      entry("housing_class", 3, "steel portal frame", "The grain store is a steel portal frame."),
      entry("tiv_kes", 3, "about 20 million", "The grain store is insured for about KES 20 million."),
      entry("cost_per_m2_kes", 3, "not stated", ""),
      entry("basements", 0, "0", "Neither building has a basement."),
      entry("occupancy", 0, "industrial", "The site mills maize."),
      entry("flood_deductible_pct", 0, "2.5", "Flood deductible 2.5% of the sum insured."),
      entry("flood_deductible_basis", 0, "percent_of_sum_insured", "Flood deductible 2.5% of the sum insured."),
      entry("flood_limit_kes", 0, "-5", "Flood limit to be agreed."),
      entry("river_distance_m", 0, "1800", "The river is 1.8 km to the north."),
      entry("flood_cover", 0, "maybe", "Flood cover is under discussion."),
      entry("past_flood", 0, "The yard flooded in 2019", "The yard flooded in 2019."),
      entry("past_flood", 0, "", "Water reached the store door in 2021."),
      entry("broker_view", 0, "", ""),
    ],
  });

  it("makes one row per building in order, each marked as read by the model", () => {
    expect(made.rows).toHaveLength(2);
    expect(made.rows.map((r) => r.path)).toEqual(["model", "model"]);
    expect(made.rows.map((r) => r.name.value)).toEqual(["Mill house", "Grain store"]);
    expect(made.rows.every((r) => r.coordinates === null)).toBe(true);
  });

  it("reads numbers and listed words, and keeps the last of a repeated field", () => {
    const [mill] = made.rows;
    expect(mill.lat.value).toBe(-1.265);
    expect(mill.lon.value).toBe(36.803);
    expect(mill.housingClass.value).toBe("permanent_masonry");
    expect(mill.floorAreaM2.value).toBe(1250);
    expect(mill.tivKes).toEqual({ value: 45_000_000, quote: "The mill house is insured for KES 45 million.", status: "unverified", reason: null });
    expect(made.terms.basements.value).toBe(0);
    expect(made.terms.occupancy.value).toBe("industrial");
    expect(made.terms.floodDeductiblePct.value).toBe(2.5);
    expect(made.terms.floodDeductibleBasis.value).toBe("percent_of_sum_insured");
    expect(made.terms.riverDistanceM.value).toBe(1800);
  });

  it("keeps the quote, with no value and a reason, where the reply is not a number or a listed word", () => {
    const store = made.rows[1];
    expect(store.housingClass).toMatchObject({ value: null, status: "unverified", quote: "The grain store is a steel portal frame." });
    expect(store.housingClass.reason).toMatch(/steel portal frame.*not one of: informal_iron_sheet/);
    expect(store.tivKes).toMatchObject({ value: null, status: "unverified" });
    expect(store.tivKes.reason).toMatch(/not a plain number/);
    expect(made.terms.floodLimitKes.reason).toMatch(/below zero/);
    expect(made.terms.floodCover).toMatchObject({ value: null, status: "unverified" });
  });

  it("treats what is left out, or sent as not stated, as missing", () => {
    const missing = { value: null, quote: "", status: "missing", reason: null };
    expect(made.rows[1].costPerM2Kes).toEqual(missing);
    expect(made.rows[1].lat).toEqual(missing);
    expect(made.terms.policyPeriod).toEqual(missing);
    expect(made.terms.placeName).toEqual(missing);
  });

  it("keeps every note that says something", () => {
    expect(made.notes.map((n) => [n.kind, n.value, n.status])).toEqual([
      ["past_flood", "The yard flooded in 2019", "unverified"],
      ["past_flood", "Past flood or water damage reported", "unverified"],
    ]);
  });

  it("files a building's fields sent under row 0 as the first building, and never returns no row", () => {
    const one = fromFlatReply({ entries: [entry("tiv_kes", 0, "8000000", SHOP), entry("place_name", 0, "Kibera", SHOP)] });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0].tivKes.value).toBe(8_000_000);
    expect(one.terms.placeName.value).toBe("Kibera");
    const none = fromFlatReply({ entries: [] });
    expect(none.rows).toHaveLength(1);
    expect(none.rows[0]).toMatchObject({ path: "model", tivKes: { status: "missing" } });
  });
});

// ---------------------------------------------------------------------------------------------
// The route and the client, against a local stand-in for the provider. No real model is called.
// ---------------------------------------------------------------------------------------------

type Sent = { body: { messages: { role: string; content: string }[]; response_format: unknown } };
let server: Server;
let sent: Sent[] = [];
let handler: (res: ServerResponse, n: number) => void;
let logged: ReturnType<typeof vi.spyOn>;

const SETTINGS = ["AGENT_PROVIDER", "OPENAI_API_KEY", "OPENAI_API_KEY_CHAIR", "OPENAI_BASE_URL", "OPENAI_MODEL", "GEMINI_API_KEY", "GEMINI_API_KEY_CHAIR"];
const before = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
let standIn = "";

const json = (res: ServerResponse, status: number, payload: object) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};
const completion = (content: string, finish = "stop") => ({
  choices: [{ finish_reason: finish, message: { role: "assistant", content, refusal: null } }],
  usage: { prompt_tokens: 900, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 20 } },
});
const post = (body: unknown) => POST(new Request("http://localhost/api/offer/extract", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const answer = async (res: Response) => (await res.json()) as OfferExtractResponse;

const GOOD_REPLY = {
  entries: [
    { field: "lat", row: 1, quote: "GPS COORDINATES: -1.2650°S, 36.8030°E", value: "-1.2650" },
    { field: "lon", row: 1, quote: "GPS COORDINATES: -1.2650°S, 36.8030°E", value: "36.8030" },
    { field: "housing_class", row: 1, quote: "CONSTRUCTION CLASSIFICATION: RCC frame, masonry infill panels", value: "concrete_rcc" },
    { field: "tiv_kes", row: 1, quote: "TOTAL SUM INSURED: KES 2,480,000,000", value: "2480000000" },
    // A sentence the document does not contain, and a number its sentence does not contain.
    { field: "floor_area_m2", row: 1, quote: "The tower has a gross floor area of 12,400 m².", value: "12400" },
    { field: "flood_limit_kes", row: 0, quote: "The flood limit asked for is KES 900,000,000 any one event.", value: "950000000" },
    { field: "flood_deductible_pct", row: 0, quote: "Flood cover is requested, with a flood deductible of 5% of each loss, minimum KES 1,500,000.", value: "5" },
  ],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      sent.push({ body: JSON.parse(body) });
      handler(res, sent.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  standIn = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  for (const name of SETTINGS) {
    if (before[name] === undefined) delete process.env[name];
    else process.env[name] = before[name];
  }
});
beforeEach(() => {
  sent = [];
  handler = (res) => json(res, 200, completion(JSON.stringify(GOOD_REPLY)));
  for (const name of SETTINGS) delete process.env[name];
  process.env.AGENT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = standIn;
  logged = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/offer/extract", () => {
  it("answers 503 and says which setting is missing when there is no key", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await post({ text: MEMO });
    expect(res.status).toBe(503);
    expect(await answer(res)).toEqual({ ok: false, code: "no_key", error: "No API key is set for the model. Set OPENAI_API_KEY_CHAIR or OPENAI_API_KEY in web/.env.local. Nothing was sent." });
    expect(sent).toHaveLength(0);
  });

  it("refuses a request with no text, and one that is too long, without calling the model", async () => {
    for (const body of [{}, { text: "   " }, { text: 42 }, "not json"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await answer(res)).toMatchObject({ ok: false, code: "bad_request" });
    }
    const res = await post({ text: "x".repeat(OFFER_MAX_CHARS + 1) });
    expect(res.status).toBe(400);
    const body = await answer(res);
    expect(body).toMatchObject({ ok: false, code: "bad_request" });
    expect(body.ok === false && body.error).toMatch(/120,001 characters long and the most that can be sent is 120,000/);
    expect(sent).toHaveLength(0);
  });

  it("sends the text with contact details taken out, and returns the reply with what was sent", async () => {
    const res = await post({ text: MEMO });
    expect(res.status).toBe(200);
    const body = await answer(res);
    if (!body.ok) throw new Error("expected a reply");
    expect(body).toMatchObject({ model: "gpt-6-luna", attempts: 1, usage: { promptTokens: 900, outputTokens: 100, thinkingTokens: 20, finishReason: "stop" } });
    expect(body.reply.entries).toHaveLength(GOOD_REPLY.entries.length);
    expect(body.reply.entries[3]).toEqual({ field: "tiv_kes", row: 1, quote: "TOTAL SUM INSURED: KES 2,480,000,000", value: "2480000000" });

    // The route redacts by itself, so an unredacted post still does not reach the model whole.
    expect(body.documentText).not.toMatch(/@|555-0142/);
    expect(body.documentText).toContain("GPS COORDINATES: -1.2650°S, 36.8030°E");
    expect(body.documentText).toContain("TOTAL SUM INSURED: KES 2,480,000,000");
    expect(body.prompt.user).toContain(body.documentText);

    expect(sent).toHaveLength(1);
    const [instructions, message] = sent[0].body.messages;
    expect(instructions.content).toBe(body.prompt.system);
    expect(message.content).toBe(body.prompt.user);
    expect(message.content).not.toMatch(/@|555-0142/);
    expect(sent[0].body.response_format).toEqual({ type: "json_schema", json_schema: { name: "reply", strict: true, schema: strictSchema(OFFER_RESPONSE_SCHEMA) } });
  });

  it("writes nothing of the document to the server's log", async () => {
    await post({ text: MEMO });
    handler = (res) => json(res, 200, completion("{ not json"));
    await post({ text: MEMO });
    const lines = logged.mock.calls.map((call: unknown[]) => call.join(" "));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\[offer\] /);
      expect(line).not.toMatch(/Jacaranda|Westlands|1\.2650|2,480,000,000|Kirichwa|Baraka/);
    }
  });

  it("asks once more when the reply is not in the required shape", async () => {
    handler = (res, n) => json(res, 200, completion(n === 1 ? '{"rows": []}' : "```json\n" + JSON.stringify(GOOD_REPLY) + "\n```"));
    const res = await post({ text: MEMO });
    expect(res.status).toBe(200);
    expect(await answer(res)).toMatchObject({ ok: true, attempts: 2 });
    expect(sent).toHaveLength(2);
    expect(sent[1].body.messages[1].content).toMatch(/Your previous reply was rejected: entries: .*Reply again with the complete JSON object/);
  });

  it("gives up with 422 after two bad replies, and keeps the reply's text out of the error", async () => {
    handler = (res) => json(res, 200, completion('{"entries": [{"field": "tiv_kes", "row": 1, "quote": "TOTAL SUM INSURED: KES 2,480,000,000"'));
    const res = await post({ text: MEMO });
    expect(res.status).toBe(422);
    const body = await answer(res);
    expect(body).toMatchObject({ ok: false, code: "bad_reply", model: "gpt-6-luna" });
    expect(body.ok === false && body.error).toBe("The model's reply did not match the required shape: the reply was not valid JSON");
    expect(sent).toHaveLength(2);
  });

  it("says when the reply ran out of room", async () => {
    handler = (res) => json(res, 200, completion('{"entries": [', "length"));
    const body = await answer(await post({ text: MEMO }));
    expect(body.ok === false && body.error).toMatch(/hit the output limit before it was complete/);
  });

  it("answers 502 when the call to the model fails", async () => {
    handler = (res) => json(res, 401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", param: null } });
    const res = await post({ text: MEMO });
    expect(res.status).toBe(502);
    expect(await answer(res)).toMatchObject({ ok: false, code: "provider", error: "401 Incorrect API key provided." });
    expect(sent).toHaveLength(1);
  });
});

describe("extractOffer, as the screen calls it", () => {
  /** The browser's fetch, answered by the route itself. Calls to the stand-in provider go through untouched. */
  function routeAsFetch() {
    const real = globalThis.fetch;
    const posted: string[] = [];
    vi.stubGlobal("fetch", (url: RequestInfo | URL, init?: RequestInit) => {
      if (url !== "/api/offer/extract") return real(url, init);
      posted.push(JSON.parse(String(init?.body)).text);
      return POST(new Request("http://localhost/api/offer/extract", init));
    });
    return posted;
  }

  it("uses the model's reply when there is a key, and lets only checked values through", async () => {
    const posted = routeAsFetch();
    const run = await extractOffer(MEMO, { knownPlaces: PLACES });
    expect(run).toMatchObject({ path: "model", fallbackReason: null, sentToModel: true, model: "gpt-6-luna" });
    expect(run.usage?.promptTokens).toBe(900);
    expect(run.prompt?.user).toContain(run.documentText);

    // Contact details were gone before the text left the browser, and the record says so.
    expect(posted).toEqual([run.documentText]);
    expect(run.documentText).not.toMatch(/@|555-0142/);
    expect(run.removed.emails).toBe(1);
    expect(run.removed.phones).toBe(1);

    const row = run.extraction.rows[0];
    expect(row.path).toBe("model");
    expect(row.housingClass).toMatchObject({ value: "concrete_rcc", status: "verified" });
    expect(row.tivKes).toMatchObject({ value: 2_480_000_000, status: "verified" });
    expect(row.lat).toMatchObject({ status: "verified" });
    expect(row.lat.value).toBeCloseTo(-1.265, 6);
    expect(row.coordinates).toMatchObject({ writtenBothWays: true });
    expect(run.extraction.terms.floodDeductiblePct).toMatchObject({ value: 5, status: "verified" });
    // The quote is not in the document, so the value is shown but not trusted.
    expect(row.floorAreaM2).toMatchObject({ value: 12_400, status: "unverified" });
    expect(row.floorAreaM2.reason).toMatch(/not in the document/);
    // The sentence is real but states another number.
    expect(run.extraction.terms.floodLimitKes).toMatchObject({ value: 950_000_000, status: "unverified" });
    expect(run.extraction.terms.floodLimitKes.reason).toMatch(/not written in the quoted sentence/);
  });

  it("falls back to the rules when no key is set, and sends nothing", async () => {
    delete process.env.OPENAI_API_KEY;
    routeAsFetch();
    const run = await extractOffer(SHOP, { knownPlaces: PLACES });
    expect(run).toMatchObject({ path: "rules", sentToModel: false, prompt: null, model: null, usage: null, documentText: SHOP });
    expect(run.fallbackReason).toMatch(/No API key is set for the model\. Set OPENAI_API_KEY_CHAIR or OPENAI_API_KEY/);
    expect(sent).toHaveLength(0);
    const row = run.extraction.rows[0];
    expect(row.path).toBe("rules");
    expect(row.housingClass).toMatchObject({ value: "permanent_masonry", status: "verified" });
    expect(row.tivKes).toMatchObject({ value: 8_000_000, status: "verified" });
    expect(run.extraction.terms.placeName).toMatchObject({ value: "Kibera", status: "verified" });
  });

  it("falls back to the rules when the call fails, and says the text was sent", async () => {
    routeAsFetch();
    handler = (res) => json(res, 429, { error: { message: "You exceeded your current quota.", type: "insufficient_quota", param: null } });
    const run = await extractOffer(MEMO, { knownPlaces: PLACES });
    expect(run).toMatchObject({ path: "rules", sentToModel: true, model: "gpt-6-luna" });
    expect(run.fallbackReason).toMatch(/The call to the model failed: quota or rate limit reached/);
    expect(run.extraction.rows[0]).toMatchObject({ path: "rules", housingClass: { value: "concrete_rcc", status: "verified" } });
  });

  it("falls back to the rules when the reply never takes the required shape, or says nothing", async () => {
    routeAsFetch();
    handler = (res) => json(res, 200, completion('{"entries": "none"}'));
    const bad = await extractOffer(MEMO);
    expect(bad).toMatchObject({ path: "rules", sentToModel: true });
    expect(bad.fallbackReason).toMatch(/did not match the required shape/);

    handler = (res) => json(res, 200, completion('{"entries": []}'));
    const empty = await extractOffer(MEMO);
    expect(empty).toMatchObject({ path: "rules", sentToModel: true });
    expect(empty.fallbackReason).toMatch(/found nothing to list/);
    expect(empty.prompt?.user).toContain(empty.documentText);
  });

  it("never rejects: a server that cannot be reached also ends on the rules", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("Failed to fetch")));
    const run = await extractOffer(SHOP);
    expect(run).toMatchObject({ path: "rules", sentToModel: true });
    expect(run.fallbackReason).toMatch(/could not be reached \(Failed to fetch\)/);
    expect(run.extraction.rows[0].tivKes.value).toBe(8_000_000);
  });

  it("does not call anything when the rules are chosen", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const run = await extractOffer(MEMO, { rulesOnly: true, knownPlaces: PLACES });
    expect(fetched).not.toHaveBeenCalled();
    expect(run).toMatchObject({ path: "rules", sentToModel: false });
    expect(run.documentText).not.toMatch(/@|555-0142/);
    expect(run.extraction.terms.placeName).toMatchObject({ value: "Westlands", status: "verified" });
  });
});
