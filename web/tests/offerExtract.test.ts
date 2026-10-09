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

// Invented loss histories, in the three shapes a memo writes them in.
const HISTORY = `CLAIMS AND LOSS HISTORY (8 YEARS: 2017-2024)

LOSS #1: 2018, April
Description: Storm water entered the lower ground car park
Cause: Blocked culvert on the service road
Damage: Lift pit and two pump sets, stock in the store room worth KES 9,000,000
Amount paid: KES 4.2 million
Status: Closed

LOSS #2: 2020, July
Description: Fire in the kitchen extract duct
Cause: Grease build-up
Damage: Duct and ceiling, water damage from the sprinklers
Amount paid: KES 600,000

LOSS #3: 2022, November
Description: Burst pipe on the second floor
Cause: Failed joint
Status: Repaired by the tenant, no claim made

Total losses: KES 4,800,000 over 8 years
GPS COORDINATES: 1.0000°S, 36.9000°E`;

const TOLD_THREE_TIMES = `FLOOD EVENT #1 (May 2019):
Rainfall: Three days of heavy rain
Damage:
  - Stock on the ground floor: KES 1,100,000
  - Total claim: KES 2,400,000 (reduced from KES 2.6M to KES 2,150,000 after adjustment)

SUMMARY OF FLOOD LOSSES:
Event 1 (2019): KES 2,150,000 (0.3 m of water)
Event 2 (2021): KES 800,000
TOTAL (6 years): KES 2,950,000

ALL CLAIMS (6 years):
1. 2019 Flood: KES 2,150,000 paid
2. 2021 Flood: KES 800,000 paid
3. 2022 Theft of copper cable: KES 95,000 paid
4. 2023 Machinery breakdown: KES 310,000 paid`;

const DATED = `LOSS HISTORY (5 YEARS):
- April 2018: storm water flooded the basement, stock worth KES 30 million was moved in time, claim paid KES 4,200,000
- 2020: fire in the kitchen, KES 600,000
- 2021: burst pipe on the second floor, no amount recorded
- 2022: no flood losses

IMPROVEMENTS:
- 2023 flood barrier at the ramp: KES 2,000,000 spent`;

describe("the document's own loss history, by the rules", () => {
  const missing = { value: null, quote: "", status: "missing", reason: null };

  it("reads the years the history covers from its heading", () => {
    const read = extractByRules(HISTORY);
    expect(read.terms.floodHistoryYears).toEqual({ value: 8, quote: "CLAIMS AND LOSS HISTORY (8 YEARS: 2017-2024)", status: "unverified", reason: null });
  });

  it("reads a numbered flood loss with its year and amount, each with its own line", () => {
    const [first] = extractByRules(HISTORY).floodLosses!;
    expect(first.year).toEqual({ value: 2018, quote: "LOSS #1: 2018, April", status: "unverified", reason: null });
    // The amount paid, not the value of the stock that stood in the water.
    expect(first.amountKes).toEqual({ value: 4_200_000, quote: "Amount paid: KES 4.2 million", status: "unverified", reason: null });
  });

  it("leaves out the fire, and the burst pipe, which is water from inside the building", () => {
    const losses = extractByRules(HISTORY).floodLosses!;
    // The fire's own lines mention water from the sprinklers. It is still a fire. A burst pipe is water damage, not a flood.
    expect(losses.map((l) => l.year.value)).toEqual([2018]);
  });

  it("does not count water from inside the building as flood history", () => {
    // The shape of a memo that reports a claim for water from an air-conditioning condensate line.
    const INTERNAL = `PREVIOUS LOSS HISTORY (11 YEARS: 2015-2026)
LOSS #1: 2018, May
Description: Water intrusion from AC condensation in F4 office area
Cause: Blocked condensate drainage line
Damage: Water staining on ceiling tiles, minor content damage
Amount claimed: KES 850,000
Status: Settled (June 2018)

LOSS #2: 2021, July
Description: Electrical fire in electrical distribution board
Amount claimed: KES 300,000

LOSS #3: 2023, March
Description: Leak from a roof water tank onto the sixth floor
Amount claimed: KES 120,000`;
    const read = extractByRules(INTERNAL);
    expect(read.floodLosses).toEqual([]);
    // The length of the history is still read: eleven years with no flood loss is a fact worth having.
    expect(read.terms.floodHistoryYears?.value).toBe(11);

    // The same building with a real flood beside the leak: the flood is kept, the leak is not.
    const MIXED = `${INTERNAL}

LOSS #4: 2024, April
Description: Storm water entered the basement through the ramp after a pipe gave way
Amount claimed: KES 2,000,000`;
    expect(extractByRules(MIXED).floodLosses!.map((l) => [l.year.value, l.amountKes.value])).toEqual([[2024, 2_000_000]]);

    // In typed sentences too.
    const typed = extractByRules("Loss history: a pipe burst on level 3 in 2021 with damage of KES 400,000. The basement flooded in 2019 with a loss of KES 1.2 million.");
    expect(typed.floodLosses!.map((l) => l.year.value)).toEqual([2019]);
  });

  it("verifies each value against the document, and counts them", () => {
    const checked = verifyExtraction(extractByRules(HISTORY), HISTORY);
    expect(checked.terms.floodHistoryYears).toMatchObject({ value: 8, status: "verified" });
    expect(checked.floodLosses!.map((l) => [l.year.status, l.amountKes.status])).toEqual([["verified", "verified"]]);
  });

  it("keeps a flood once when the memo tells it in three places, at the figure the claim ended at", () => {
    const read = extractByRules(TOLD_THREE_TIMES);
    expect(read.floodLosses!.map((l) => [l.year.value, l.amountKes.value])).toEqual([
      [2019, 2_150_000],
      [2021, 800_000],
    ]);
    expect(read.floodLosses![0].amountKes.quote).toBe("- Total claim: KES 2,400,000 (reduced from KES 2.6M to KES 2,150,000 after adjustment)");
    // The second flood has no heading of its own: the summary it stands in says what it was.
    expect(read.floodLosses![1].year.quote).toBe("Event 2 (2021): KES 800,000");
    expect(read.terms.floodHistoryYears).toMatchObject({ value: 6, quote: "TOTAL (6 years): KES 2,950,000" });
    const checked = verifyExtraction(read, TOLD_THREE_TIMES);
    expect(checked.floodLosses!.flatMap((l) => [l.year.status, l.amountKes.status])).toEqual(["verified", "verified", "verified", "verified"]);
  });

  it("reads lines that open with the date, and only where losses are being listed", () => {
    const read = extractByRules(DATED);
    expect(read.terms.floodHistoryYears?.value).toBe(5);
    // The burst pipe of 2021 is water from inside the building: not flood history.
    expect(read.floodLosses!.map((l) => [l.year.value, l.amountKes.value])).toEqual([[2018, 4_200_000]]);
    // "No flood losses" is not a loss, and money spent on a barrier is not one either.
    expect(read.floodLosses!.some((l) => l.year.value === 2022 || l.year.value === 2023)).toBe(false);
  });

  it("gives an empty list and a years value that is not stated when the document has no loss history", () => {
    for (const read of [extractByRules(MEMO, PLACES), extractByRules(SHOP, PLACES), extractByRules("Please call me when you have a moment.")]) {
      expect(read.floodLosses).toEqual([]);
      expect(read.terms.floodHistoryYears).toEqual(missing);
    }
    const checked = verifyExtraction(extractByRules(MEMO, PLACES), MEMO);
    expect(checked.floodLosses).toEqual([]);
    expect(checked.terms.floodHistoryYears).toEqual(missing);
  });

  it("does not read a range of dates, a return period or an age as years of history", () => {
    const years = (text: string) => extractByRules(text).terms.floodHistoryYears?.value;
    expect(years("LOSS HISTORY (2014-2024):\nNo losses reported.")).toBeNull();
    expect(years("Storm drains are sized for a 25-year storm, and no flood claims have been made.")).toBeNull();
    expect(years("The block is 12 years old and has had no losses.")).toBeNull();
    expect(years("Loss frequency: 3 events in 11 years")).toBe(11);
    expect(years("The insured has a 7-year claims history with this office.")).toBe(7);
  });

  it("reads a flood and its loss from a typed sentence, apart from the insured value", () => {
    const typed = "Masonry shop in Kibera worth KES 8 million, flooded in 2018 with a loss of KES 1.2 million, 10 years of loss history";
    const read = extractByRules(typed, PLACES);
    expect(read.rows[0].tivKes.value).toBe(8_000_000);
    expect(read.floodLosses!.map((l) => [l.year.value, l.amountKes.value])).toEqual([[2018, 1_200_000]]);
    expect(read.terms.floodHistoryYears?.value).toBe(10);
    const checked = verifyExtraction(read, typed);
    expect(checked.floodLosses![0]).toMatchObject({ year: { status: "verified" }, amountKes: { status: "verified" } });
    // A year the building was put up in, beside a request for flood cover, is not a flood.
    expect(extractByRules("Masonry shop in Kibera built in 2018, worth KES 8 million, flood cover requested", PLACES).floodLosses).toEqual([]);
    expect(extractByRules("Masonry shop in Kibera worth KES 8 million, has not flooded since 2018", PLACES).floodLosses).toEqual([]);
  });
});

// An invented memo that states everything the loss drivers beyond flood depth read.
const DRIVERS = `PLACEMENT NOTE
CLIENT: Mwangaza Court Limited
GPS COORDINATES: 1.2700°S, 36.8100°E
CONSTRUCTION CLASSIFICATION: Reinforced concrete frame
Storeys: 14 above ground and 3 basement levels
The lowest basement floor is 9.5 m below ground level.

SUMS INSURED:
- Buildings: KES 3,100,000,000
- Plant and machinery: KES 420,000,000
- Contents: KES 180,000,000
- Stock: KES 15,000,000
- Loss of rent (12 months): KES 300,000,000
TOTAL SUM INSURED: KES 4,000,000,000

BASEMENT PLANT:
- Standby generators (2 x 800 kVA)
- LV switchgear and fire pumps
- Diesel tank, bunded
The chillers are on the roof.
Plant and equipment in the basements is valued at KES 260 million.

SITE DRAINAGE:
The storm drains are designed for a 1-in-10 year storm and were
overwhelmed in the long rains of 2018.
- Sump pumps: 2 x 15 l/s, connected to the standby generator
- Non-return valves are fitted on both outfalls
- There are no flood barriers at the ramp

COVER REQUESTED:
Material damage including flood, and business interruption (loss of rent, 12 months indemnity).
ANNUAL PREMIUM: KES 9,600,000
TERM: 12 months (1 January 2028 - 31 December 2028)`;

// An invented memo full of things that look like those values and are not.
const TRAPS = `RISK NOTES
The building has 2 basement levels, each 3.2 m high.
In 2019 the lower basement flooded to a depth of 1.4 m.
The generator was moved from the basement to the roof in 2020.
No plant is kept below ground.

DRAINAGE:
The April 2019 storm was a 1-in-50 year event that overwhelmed the drains.
The drainage pipes have a design life of 40 years.
Flood barriers are recommended at the ramp.
Are non-return valves fitted?
The sump pumps stand next to the standby generator room.

LOSS #1: 2019, April
Description: Storm water in the basement damaged switchgear worth KES 45,000,000
Business interruption: 6 days, claim paid KES 3,000,000
Amount paid: KES 12,000,000

FINANCIALS:
Monthly rent roll: KES 20,000,000
Additional premium for flood: KES 1,200,000
Premiums paid over 5 years: KES 40,000,000
Machinery breakdown: KES 310,000 paid`;

const DRIVER_KEYS = [
  "basementDepthM",
  "drainDesignRp",
  "sumpPumpCapacity",
  "sumpPumpBackup",
  "floodBarriers",
  "nonReturnValves",
  "valueBuildingKes",
  "valueMachineryKes",
  "valueContentsKes",
  "valueBelowGroundKes",
  "annualRentKes",
  "biCovered",
  "premiumKes",
] as const;

describe("what the loss drivers need, by the rules", () => {
  const missing = { value: null, quote: "", status: "missing", reason: null };
  const read = extractByRules(DRIVERS);
  const { terms } = read;

  it("reads the depth of the basements, and the equipment listed under the basement heading", () => {
    expect(terms.basements.value).toBe(3);
    expect(terms.basementDepthM).toEqual({ value: 9.5, quote: "The lowest basement floor is 9.5 m below ground level.", status: "unverified", reason: null });
    expect(read.equipmentBelowGround!.map((e) => [e.item.value, e.item.quote])).toEqual([
      ["Standby generators", "- Standby generators (2 x 800 kVA)"],
      ["LV switchgear", "- LV switchgear and fire pumps"],
      ["Fire pumps", "- LV switchgear and fire pumps"],
      ["Diesel tank", "- Diesel tank, bunded"],
    ]);
    // The chillers are on the roof, and the sump pumps are not said to be below ground.
    expect(read.equipmentBelowGround!.some((e) => /chiller|sump/i.test(e.item.value ?? ""))).toBe(false);
  });

  it("reads the storm the drains are designed for, over a line break, and not the year they failed", () => {
    expect(terms.drainDesignRp).toMatchObject({ value: 10, quote: "The storm drains are designed for a 1-in-10 year storm and were overwhelmed in the long rains of 2018." });
  });

  it("reads the sump pumps, their backup power, the valves and the missing barriers", () => {
    const pumps = "- Sump pumps: 2 x 15 l/s, connected to the standby generator";
    expect(terms.sumpPumpCapacity).toMatchObject({ value: "2 x 15 l/s", quote: pumps });
    expect(terms.sumpPumpBackup).toMatchObject({ value: "yes", quote: pumps });
    expect(terms.nonReturnValves).toMatchObject({ value: "present", quote: "- Non-return valves are fitted on both outfalls" });
    expect(terms.floodBarriers).toMatchObject({ value: "absent", quote: "- There are no flood barriers at the ramp" });
  });

  it("reads each part of the insured value from its own line, and never adds stock to contents", () => {
    expect(terms.valueBuildingKes).toMatchObject({ value: 3_100_000_000, quote: "- Buildings: KES 3,100,000,000" });
    expect(terms.valueMachineryKes).toMatchObject({ value: 420_000_000, quote: "- Plant and machinery: KES 420,000,000" });
    expect(terms.valueContentsKes).toMatchObject({ value: 180_000_000, quote: "- Contents: KES 180,000,000" });
    expect(terms.valueBelowGroundKes).toMatchObject({ value: 260_000_000, quote: "Plant and equipment in the basements is valued at KES 260 million." });
    // The total is still the insured value, and no part of the split is taken for it.
    expect(read.rows[0].tivKes.value).toBe(4_000_000_000);
  });

  it("reads a year's rent, the business interruption cover and the annual premium", () => {
    expect(terms.annualRentKes).toMatchObject({ value: 300_000_000, quote: "- Loss of rent (12 months): KES 300,000,000" });
    expect(terms.biCovered?.value).toBe("covered");
    expect(terms.premiumKes).toMatchObject({ value: 9_600_000, quote: "ANNUAL PREMIUM: KES 9,600,000" });
  });

  it("leaves every one provisional, and every one then passes the checks against the document", () => {
    for (const key of DRIVER_KEYS) expect(`${key}: ${terms[key]?.status}`).toBe(`${key}: unverified`);
    const checked = verifyExtraction(read, DRIVERS);
    for (const key of DRIVER_KEYS) expect(`${key}: ${checked.terms[key]?.status}`).toBe(`${key}: verified`);
    expect(checked.equipmentBelowGround!.map((e) => e.item.status)).toEqual(["verified", "verified", "verified", "verified"]);
  });

  it("reads none of them from a height, a water depth, a past storm, a plan, a question or a loss", () => {
    const traps = extractByRules(TRAPS);
    for (const key of DRIVER_KEYS) expect(`${key}: ${traps.terms[key]?.status}`).toBe(`${key}: missing`);
    // The generator was moved out, the plant is denied, and the switchgear is only named in a past loss.
    expect(traps.equipmentBelowGround).toEqual([]);
    // What the rules read before is still read: the levels, and the loss with its amount.
    expect(traps.terms.basements.value).toBe(2);
    expect(traps.floodLosses!.map((l) => [l.year.value, l.amountKes.value])).toEqual([[2019, 12_000_000]]);
  });

  it("reads a depth below ground however it is written, the deepest level where several are given", () => {
    const depth = (text: string) => extractByRules(text).terms.basementDepthM?.value;
    expect(depth("Basement levels: B1 at -3.5 m, B2 at -7.0 m")).toBe(7);
    expect(depth("The basement car park is 6 m deep.")).toBe(6);
    expect(depth("Depth of the lowest basement: 10.5 metres")).toBe(10.5);
    // A dash before a figure is not a minus sign, and a clearance is not a depth.
    expect(depth("Basement parking - 3 m clearance")).toBeNull();
    // An area is not a depth.
    expect(depth("The basement covers 40 m² below ground.")).toBeNull();
  });

  it("places equipment only where the statement places it", () => {
    const items = (text: string) => extractByRules(text).equipmentBelowGround!.map((e) => e.item.value);
    expect(items("Generators and switchgear are in basement 2; the chillers are on the roof.")).toEqual(["Generators", "Switchgear"]);
    expect(items("No plant is kept in the basement: the generator is on the podium.")).toEqual([]);
    expect(items("UNDERGROUND SERVICES:\n- Fuel tanks (2 x 20,000 litres)\n- Fire pump room")).toEqual(["Fuel tanks", "Fire pump room"]);
    // The same item named twice is one item.
    expect(items("The UPS room is in the basement.\nBASEMENT 1:\n- UPS room and server room")).toEqual(["UPS room", "Server room"]);
  });

  it("reads the sump pumps from under their own heading, and not another pump's figures", () => {
    const { terms } = extractByRules("SUMP PUMP SYSTEM\n\nFire pumps: 2 x 30 l/s\nCapacity: 2 x 20 l/s\nPower: mains with generator backup");
    expect(terms.sumpPumpCapacity).toMatchObject({ value: "2 x 20 l/s", quote: "Capacity: 2 x 20 l/s" });
    expect(terms.sumpPumpBackup).toMatchObject({ value: "yes", quote: "Power: mains with generator backup" });
  });

  it("reads the design storm however it is written, and leaves two different designs not stated", () => {
    const design = (text: string) => extractByRules(text).terms.drainDesignRp?.value;
    expect(design("Storm water drains are sized for the 25-year storm.")).toBe(25);
    expect(design("DRAIN DESIGN STANDARD: 1 in 5 years")).toBe(5);
    expect(design("SITE DRAINS:\n- Open channels, 1:50 design capacity")).toBe(50);
    expect(design("The site drains are designed for a 1-in-10 year storm.\nThe road culvert is designed for a 1-in-25 year storm.")).toBeNull();
    // A design that was beaten says nothing about what the design is.
    expect(design("The design capacity of the drains was exceeded by the 1-in-100 year storm of 2018.")).toBeNull();
    // A building is not a drain.
    expect(design("The tower is designed for a 50-year life.")).toBeNull();
  });

  it("tells backup power from none, and something fitted from something absent", () => {
    const of = (text: string) => extractByRules(text).terms;
    expect(of("Sump pumps have no backup power.").sumpPumpBackup?.value).toBe("no");
    expect(of("The sump pumps run on mains only.").sumpPumpBackup?.value).toBe("no");
    expect(of("SUMP PUMPS:\n- Capacity: 500 litres per minute each\n- Backup power: Yes").sumpPumpCapacity?.value).toBe("500 litres per minute each");
    expect(of("SUMP PUMPS:\n- Capacity: 500 litres per minute each\n- Backup power: Yes").sumpPumpBackup?.value).toBe("yes");
    expect(of("Flood barriers are fitted at both ramps.").floodBarriers?.value).toBe("present");
    expect(of("Demountable flood barriers: none").floodBarriers?.value).toBe("absent");
    // "No losses since" denies the losses, not the barriers.
    expect(of("No losses since the flood barriers were fitted in 2021.").floodBarriers?.value).toBe("present");
    expect(of("Backflow preventers have not been fitted on the basement drains.").nonReturnValves?.value).toBe("absent");
    // One statement says there are, another says there are not: the rules cannot tell which holds.
    expect(of("Flood barriers are fitted at the ramp.\nThere are no flood barriers at the loading bay.").floodBarriers).toEqual(missing);
  });

  it("reads business interruption as excluded only where it is what is left out", () => {
    const cover = (text: string) => extractByRules(text).terms.biCovered?.value;
    expect(cover("Cover: material damage only, business interruption is excluded.")).toBe("excluded");
    expect(cover("All risks excluding flood and business interruption.")).toBe("excluded");
    expect(cover("All risks excluding flood, including business interruption.")).toBe("covered");
    // The terms asked for outrank the policy now in force.
    expect(cover("CURRENT POLICY:\nBusiness interruption is not covered.\n\nTERMS ASKED FOR:\nLoss of rent cover is requested for 12 months.")).toBe("covered");
    // Said in passing, with no word of cover, it is not a statement about the cover.
    expect(cover("The owner worries about business interruption.")).toBeNull();
  });

  it("takes a yearly rent only, and the premium now paid before a proposed one", () => {
    const of = (text: string) => extractByRules(text).terms;
    expect(of("The annual rental income is KES 420 million.").annualRentKes?.value).toBe(420_000_000);
    // A monthly figure is never multiplied up.
    expect(of("Rent is KES 35 million per month.").annualRentKes).toEqual(missing);
    expect(of("Annual turnover: KES 2.1 billion").annualRentKes?.value).toBe(2_100_000_000);
    expect(of("CURRENT ANNUAL PREMIUM: KES 11,000,000\nPROPOSED PREMIUM: KES 12,500,000").premiumKes).toMatchObject({ value: 11_000_000, quote: "CURRENT ANNUAL PREMIUM: KES 11,000,000" });
    expect(of("The flood limit sought is KES 3.2 billion, with one reinstatement at full premium.").premiumKes).toEqual(missing);
  });

  it("does not take the whole insured value for the value below ground", () => {
    const read = extractByRules("The tower has 3 basements housing the plant and is valued at KES 4,000,000,000.\nTOTAL SUM INSURED: KES 4,000,000,000");
    expect(read.rows[0].tivKes.value).toBe(4_000_000_000);
    expect(read.terms.valueBelowGroundKes).toEqual(missing);
  });

  it("names the generator from the heading of the line that says where it is housed", () => {
    // The first memo of this file: a standby generator on basement level 2.
    expect(extractByRules(MEMO, PLACES).equipmentBelowGround!.map((e) => e.item.value)).toEqual(["Standby generator"]);
  });

  it("leaves an offer that states none of this exactly as it was read before", () => {
    for (const text of [SHOP, "Please call me when you have a moment.", "Timber workshop at -1.3110, 36.7880, 240 m2, rebuilding at KES 35,000 per m2"]) {
      const plain = extractByRules(text, PLACES);
      for (const key of DRIVER_KEYS) expect(plain.terms[key]).toEqual(missing);
      expect(plain.equipmentBelowGround).toEqual([]);
    }
    // The values read before these existed are untouched by them.
    const shop = extractByRules(SHOP, PLACES);
    expect(shop.rows[0].tivKes.value).toBe(8_000_000);
    expect(shop.rows[0].housingClass.value).toBe("permanent_masonry");
    expect(shop.terms.placeName.value).toBe("Kibera");
    const checked = verifyExtraction(shop, SHOP);
    for (const key of DRIVER_KEYS) expect(checked.terms[key]).toEqual(missing);
    expect(checked.equipmentBelowGround).toEqual([]);
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

  it("gives an empty loss history when the reply holds none", () => {
    expect(made.floodLosses).toEqual([]);
    expect(made.terms.floodHistoryYears).toEqual({ value: null, quote: "", status: "missing", reason: null });
  });
});

describe("the loss history in the flat reply", () => {
  const entry = (field: OfferFlatEntry["field"], row: number, value: string, quote: string): OfferFlatEntry => ({ field, row, value, quote });
  // An invented document, and a made-up reply to it.
  const TEXT = `Loss history (11 years: 2014 to 2024)
In April 2018 storm water filled the lower basement.
The 2018 claim was settled at KES 4.2 million.
A pipe burst on level 3 in 2021; no claim was made.
Summary of flood losses: 2018 flood, KES 4,200,000.
A further loss followed the long rains of 2023, put at about KES 2 million.`;
  const made = fromFlatReply({
    entries: [
      entry("flood_history_years", 0, "11", "Loss history (11 years: 2014 to 2024)"),
      entry("flood_loss_year", 1, "2018", "In April 2018 storm water filled the lower basement."),
      entry("flood_loss_amount_kes", 1, "4200000", "The 2018 claim was settled at KES 4.2 million."),
      entry("flood_loss_year", 2, "2021", "A pipe burst on level 3 in 2021; no claim was made."),
      // The same flood, listed again from the summary. The model skipped number 3.
      entry("flood_loss_year", 4, "2018", "Summary of flood losses: 2018 flood, KES 4,200,000."),
      entry("flood_loss_amount_kes", 4, "4200000", "Summary of flood losses: 2018 flood, KES 4,200,000."),
      entry("flood_loss_year", 5, "2023", "A further loss followed the long rains of 2023, put at about KES 2 million."),
      entry("flood_loss_amount_kes", 5, "about 2 million", "A further loss followed the long rains of 2023, put at about KES 2 million."),
      entry("flood_loss_amount_kes", 6, "not stated", ""),
    ],
  });

  it("builds one loss per number, in order, with a missing amount where none was sent", () => {
    expect(made.terms.floodHistoryYears).toEqual({ value: 11, quote: "Loss history (11 years: 2014 to 2024)", status: "unverified", reason: null });
    expect(made.floodLosses!.map((l) => [l.year.value, l.amountKes.value])).toEqual([
      [2018, 4_200_000],
      [2021, null],
      [2023, null],
    ]);
    expect(made.floodLosses![1].amountKes).toEqual({ value: null, quote: "", status: "missing", reason: null });
  });

  it("keeps a loss listed twice once, and holds words sent for an amount with the reason", () => {
    expect(made.floodLosses!.filter((l) => l.year.value === 2018)).toHaveLength(1);
    expect(made.floodLosses![2].amountKes).toMatchObject({ value: null, status: "unverified", quote: "A further loss followed the long rains of 2023, put at about KES 2 million." });
    expect(made.floodLosses![2].amountKes.reason).toMatch(/not a plain number/);
  });

  it("does not take a figure that is not a year, or no years at all, for the history", () => {
    const odd = fromFlatReply({ entries: [entry("flood_loss_year", 1, "18", "flooded in '18"), entry("flood_loss_year", 2, "2018.5", "mid 2018"), entry("flood_history_years", 0, "0", "no history is held")] });
    expect(odd.floodLosses!.map((l) => [l.year.value, l.year.status])).toEqual([
      [null, "unverified"],
      [null, "unverified"],
    ]);
    expect(odd.floodLosses![0].year.reason).toMatch(/not a year/);
    expect(odd.terms.floodHistoryYears).toMatchObject({ value: null, status: "unverified" });
  });

  it("files a single loss sent under 0 as the first loss", () => {
    const one = fromFlatReply({ entries: [entry("flood_loss_year", 0, "2019", "The yard flooded in 2019."), entry("flood_loss_amount_kes", 0, "950000", "The 2019 flood cost KES 950,000.")] });
    expect(one.floodLosses!.map((l) => [l.year.value, l.amountKes.value])).toEqual([[2019, 950_000]]);
  });

  it("verifies an amount written in millions and one written in full the same way", () => {
    const checked = verifyExtraction(made, TEXT);
    expect(checked.terms.floodHistoryYears?.status).toBe("verified");
    expect(checked.floodLosses![0]).toMatchObject({ year: { value: 2018, status: "verified" }, amountKes: { value: 4_200_000, status: "verified" } });
    const inFull = verifyExtraction(fromFlatReply({ entries: [entry("flood_loss_year", 1, "2018", "Summary of flood losses: 2018 flood, KES 4,200,000."), entry("flood_loss_amount_kes", 1, "4200000", "Summary of flood losses: 2018 flood, KES 4,200,000.")] }), TEXT);
    expect(inFull.floodLosses![0].amountKes).toMatchObject({ value: 4_200_000, status: "verified" });
    // A year with no amount is still a verified year, and the amount stays not stated.
    expect(checked.floodLosses![1]).toMatchObject({ year: { status: "verified" }, amountKes: { status: "missing" } });
  });

  it("asks the model for each loss once, with its sentence, and never for an estimate", () => {
    const { system } = buildOfferPrompt("THE DOCUMENT TEXT");
    expect(system).toMatch(/List each loss once/);
    expect(system).toMatch(/Never invent, estimate or add up an amount/);
    expect(system).toMatch(/listed with its year only/);
    expect(system).toMatch(/Leave out fire, theft, machinery breakdown/);
  });
});

describe("what the loss drivers need, in the flat reply", () => {
  const entry = (field: OfferFlatEntry["field"], row: number, value: string, quote: string): OfferFlatEntry => ({ field, row, value, quote });
  const missing = { value: null, quote: "", status: "missing", reason: null };
  // A made-up reply to the invented memo above.
  const made = fromFlatReply({
    entries: [
      entry("basements", 0, "3", "Storeys: 14 above ground and 3 basement levels"),
      entry("basement_depth_m", 0, "9.5", "The lowest basement floor is 9.5 m below ground level."),
      entry("drain_design_rp", 0, "10", "The storm drains are designed for a 1-in-10 year storm and were overwhelmed in the long rains of 2018."),
      entry("sump_pump_capacity", 0, "2 x 15 l/s", "- Sump pumps: 2 x 15 l/s, connected to the standby generator"),
      entry("sump_pump_backup", 0, "Yes", "- Sump pumps: 2 x 15 l/s, connected to the standby generator"),
      entry("flood_barriers", 0, "absent", "- There are no flood barriers at the ramp"),
      entry("non_return_valves", 0, "fitted", "- Non-return valves are fitted on both outfalls"),
      entry("value_building_kes", 0, "3100000000", "- Buildings: KES 3,100,000,000"),
      entry("value_machinery_kes", 0, "420 million", "- Plant and machinery: KES 420,000,000"),
      entry("value_below_ground_kes", 0, "260000000", "Plant and equipment in the basements is valued at KES 260 million."),
      entry("annual_rent_kes", 0, "300000000", "- Loss of rent (12 months): KES 300,000,000"),
      entry("bi_covered", 0, "covered", "Material damage including flood, and business interruption (loss of rent, 12 months indemnity)."),
      entry("premium_kes", 0, "not stated", ""),
      // The model numbered the items 1, 2 and 4, named one twice, and sent one with a sentence and no name.
      entry("equipment_below_ground", 2, "LV switchgear", "- LV switchgear and fire pumps"),
      entry("equipment_below_ground", 1, "Standby generators", "- Standby generators (2 x 800 kVA)"),
      entry("equipment_below_ground", 4, "standby generator", "- Sump pumps: 2 x 15 l/s, connected to the standby generator"),
      entry("equipment_below_ground", 4, "", "- Diesel tank, bunded"),
      entry("equipment_below_ground", 5, "", ""),
    ],
  });

  it("builds each value with its sentence, numbers as numbers and listed words as listed", () => {
    const { terms } = made;
    expect(terms.basementDepthM).toEqual({ value: 9.5, quote: "The lowest basement floor is 9.5 m below ground level.", status: "unverified", reason: null });
    expect(terms.drainDesignRp?.value).toBe(10);
    expect(terms.sumpPumpCapacity?.value).toBe("2 x 15 l/s");
    expect(terms.sumpPumpBackup?.value).toBe("yes");
    expect(terms.floodBarriers?.value).toBe("absent");
    expect(terms.valueBuildingKes?.value).toBe(3_100_000_000);
    expect(terms.valueBelowGroundKes?.value).toBe(260_000_000);
    expect(terms.annualRentKes?.value).toBe(300_000_000);
    expect(terms.biCovered?.value).toBe("covered");
  });

  it("keeps the quote, with no value and a reason, where the reply is not a number or a listed word", () => {
    expect(made.terms.nonReturnValves).toMatchObject({ value: null, status: "unverified", quote: "- Non-return valves are fitted on both outfalls" });
    expect(made.terms.nonReturnValves?.reason).toMatch(/"fitted" is not one of: present, absent/);
    expect(made.terms.valueMachineryKes).toMatchObject({ value: null, status: "unverified" });
    expect(made.terms.valueMachineryKes?.reason).toMatch(/not a plain number/);
    const odd = fromFlatReply({ entries: [entry("drain_design_rp", 0, "0", "The drains have no design standard."), entry("basement_depth_m", 0, "-7", "B2 is at -7 m.")] });
    expect(odd.terms.drainDesignRp?.reason).toMatch(/not a return period in years/);
    expect(odd.terms.basementDepthM?.reason).toMatch(/below zero/);
  });

  it("treats what is left out, or sent as not stated, as missing: nothing is filled in", () => {
    expect(made.terms.premiumKes).toEqual(missing);
    expect(made.terms.valueContentsKes).toEqual(missing);
    const none = fromFlatReply({ entries: [entry("tiv_kes", 1, "8000000", SHOP)] });
    for (const key of DRIVER_KEYS) expect(none.terms[key]).toEqual(missing);
    expect(none.equipmentBelowGround).toEqual([]);
  });

  it("lists the equipment in the order of its numbers, each item once", () => {
    expect(made.equipmentBelowGround!.map((e) => [e.item.value, e.item.quote, e.item.status])).toEqual([
      ["Standby generators", "- Standby generators (2 x 800 kVA)", "unverified"],
      ["LV switchgear", "- LV switchgear and fire pumps", "unverified"],
      // An item with a sentence and no name is kept under a plain name.
      ["Equipment below ground", "- Diesel tank, bunded", "unverified"],
    ]);
  });

  it("verifies them against the document like every other value", () => {
    const checked = verifyExtraction(made, DRIVERS);
    for (const key of ["basementDepthM", "drainDesignRp", "sumpPumpCapacity", "sumpPumpBackup", "floodBarriers", "valueBuildingKes", "valueBelowGroundKes", "annualRentKes", "biCovered"] as const) {
      expect(`${key}: ${checked.terms[key]?.status}`).toBe(`${key}: verified`);
    }
    expect(checked.equipmentBelowGround!.every((e) => e.item.status === "verified")).toBe(true);
    // A figure that is in the document, but not in the sentence quoted for it, is held back.
    const wrong = verifyExtraction(fromFlatReply({ entries: [entry("value_below_ground_kes", 0, "420000000", "Plant and equipment in the basements is valued at KES 260 million.")] }), DRIVERS);
    expect(wrong.terms.valueBelowGroundKes).toMatchObject({ status: "unverified", reason: "The number 420,000,000 is not written in the quoted sentence." });
  });

  it("asks the model for each of them with its sentence, and tells it plainly never to guess", () => {
    const { system } = buildOfferPrompt("THE DOCUMENT TEXT");
    expect(system).toMatch(/Never guess one, never work one out from other figures/);
    expect(system).toMatch(/recorded as not stated, and the broker is asked for it/);
    expect(system).toMatch(/Never multiply a number of levels by a height/);
    expect(system).toMatch(/Never multiply a monthly figure/);
    expect(system).toMatch(/"Designed for a 1-in-50 year storm" and "50-year design standard" are both "50"/);
    expect(system).toMatch(/Equipment below ground \(row is the item's number, from 1\)/);
    expect(system).toMatch(/"present", "absent"/);
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
