import { HOUSING_CLASSES } from "../model/types";
import { describeReading, inKenya, parseCoordinates } from "./coords";
import { DESIGN_RP_RANGE, LOSS_YEAR_RANGE, missingValue as missing, MOST_EQUIPMENT, MOST_LOSSES } from "./extraction";
import { DISTANCE_SCALES, MONEY_SCALES } from "./shared";
import {
  BI_COVERS,
  DEDUCTIBLE_BASES,
  FLOOD_COVERS,
  OCCUPANCIES,
  OFFER_LOSS_KEYS,
  OFFER_ROW_KEYS,
  OFFER_TERM_KEYS,
  PRESENCES,
  USABLE_STATUSES,
  YES_NO,
  type ConfirmValue,
  type CoordinateReading,
  type CoreTermKey,
  type EditValue,
  type EquipmentItem,
  type FloodLoss,
  type NumberInQuote,
  type OfferExtraction,
  type OfferNote,
  type OfferRow,
  type OfferRowValues,
  type OfferTerms,
  type Quoted,
  type QuoteInDocument,
  type StatusCounts,
  type UsableValue,
  type ValueRef,
  type ValueStatus,
  type VerifyExtraction,
  type WaitingValue,
  type WaitingValues,
} from "./types";

/**
 * The checks on what was read from an offer. Whoever did the reading, the hosted model or the
 * fixed rules, every value must point at a sentence that is in the document, and every number
 * must be written in its sentence. A value that fails is kept and shown, but is not used
 * until the underwriter confirms or changes it.
 *
 * These checks show that a value was written in the document. They cannot show that it was
 * understood: a 5 quoted from the wrong sentence still passes. That is why the quote is shown
 * beside every value on screen.
 */

// ---------------------------------------------------------------------------------------------
// The quote is in the document
// ---------------------------------------------------------------------------------------------

/**
 * Text made comparable. A memo is hard-wrapped, so one sentence often runs over a line break,
 * and a model tends to return plain quotation marks, hyphens and spaces whatever the document
 * used. None of those differences change what was said, so they are evened out on both sides.
 * Letters, digits and every other mark must still match.
 */
function tidy(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u2032`\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\s\u200b]+/g, " ")
    .trim();
}

/** The quote with any quotation marks or dots a model wrapped round it taken off. */
const unwrapped = (tidied: string) => tidied.replace(/^(?:["'(\[]|\.\.\.)+\s*/, "").replace(/\s*(?:["')\]]|\.\.\.)+$/, "");

function inTidied(quote: string, tidiedDocument: string): boolean {
  const q = tidy(quote);
  if (!q) return false;
  if (tidiedDocument.includes(q)) return true;
  const bare = unwrapped(q);
  return bare !== "" && bare !== q && tidiedDocument.includes(bare);
}

export const quoteInDocument: QuoteInDocument = (quote, documentText) => inTidied(quote, tidy(documentText));

// ---------------------------------------------------------------------------------------------
// The number is in its quote
// ---------------------------------------------------------------------------------------------

const SCALES: Record<string, number> = { ...MONEY_SCALES, ...DISTANCE_SCALES };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  no: 0,
  none: 0,
  nil: 0,
  without: 0,
  one: 1,
  single: 1,
  two: 2,
  double: 2,
  twin: 2,
  three: 3,
  triple: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

// The unit must not run on into a word or a figure: the "m" of "m2" and of "metres" is not "million".
const SCALE = `(?:[ \\u00a0]?(${Object.keys(SCALES).sort((a, b) => b.length - a.length).join("|")})(?![A-Za-z0-9]))?`;
// Digits with commas between the thousands, or with spaces between them, or plain.
const DIGITS = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/.source;
const WRITTEN_NUMBER = new RegExp(DIGITS + SCALE, "gi");
const WRITTEN_WORD = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b${SCALE}`, "gi");

/**
 * Every number the text could be read as stating. "8m" gives both 8 and 8,000,000, because
 * only the reader of the sentence knows whether it is metres or millions; the caller asks
 * whether one particular value is among them, so the wider list cannot make a value up.
 */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  const add = (base: number, unit: string | undefined) => {
    out.push(base);
    if (unit) out.push(base * SCALES[unit.toLowerCase()]);
  };
  const t = text.normalize("NFKC");
  for (const m of t.matchAll(WRITTEN_NUMBER)) {
    add(Number(m[1].replace(/[^\d.]/g, "")), m[2]);
    // "5 000" may be one number or two.
    if (/[ \u00a0\u202f]/.test(m[1])) for (const part of m[1].split(/[ \u00a0\u202f]/)) out.push(Number(part));
  }
  for (const m of t.matchAll(WRITTEN_WORD)) add(NUMBER_WORDS[m[1].toLowerCase()], m[2]);
  return out;
}

// 4.35 x 1,000,000 is not exactly 4,350,000 in binary arithmetic. Nothing wider than that is let through.
const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

export const numberInQuote: NumberInQuote = (value, quote) => Number.isFinite(value) && numbersIn(quote).some((n) => sameNumber(n, Math.abs(value)));

// ---------------------------------------------------------------------------------------------
// One value
// ---------------------------------------------------------------------------------------------

const NO_QUOTE = "No sentence from the document was given for this value.";
const NOT_IN_DOCUMENT = "The quoted sentence is not in the document as written.";
const NOT_READ = "What the document says here could not be read as a value.";
const TOO_SHORT = "The quote is a single word or figure, too short to show what the value refers to.";
const NO_PAIR = "No latitude and longitude pair could be read from the quoted sentence.";

const plain = (value: number) => value.toLocaleString("en-KE", { maximumFractionDigits: 6 });

const userSet = (q: Quoted<unknown>) => q.status === "confirmed" || q.status === "edited";
const stated = (q: Quoted<unknown>) => q.value !== null || q.quote.trim() !== "";

const verified = <T>(q: Quoted<T>): Quoted<T> => ({ ...q, status: "verified", reason: null });
const unverified = <T>(q: Quoted<T>, reason: string): Quoted<T> => ({ ...q, status: "unverified", reason });

/** Lower-case words, for asking whether a name is written in a sentence whatever its capitals or word order. */
const wordsOf = (text: string) => tidy(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The checks on one value. `named` is for a value that is itself a name taken from the page
 * (a place, a river): each of its words must then be in the quote, so "Nzoia River" stands on
 * a sentence that says "the River Nzoia" but not on one that names another river.
 */
function check<T>(q: Quoted<T>, tidiedDocument: string, named = false): Quoted<T> {
  if (userSet(q)) return q;
  if (!stated(q)) return missing();
  // The reply held words where a number or a listed choice was expected. The reason set then is kept.
  if (q.value === null) return unverified(q, q.reason ?? NOT_READ);
  if (!q.quote.trim()) return unverified(q, NO_QUOTE);
  if (!inTidied(q.quote, tidiedDocument)) return unverified(q, NOT_IN_DOCUMENT);
  // A single word or figure is in almost any document, so finding it there shows nothing.
  // The one exception is a document that is itself that short.
  if (wordsOf(q.quote).length < 2 && tidy(q.quote) !== tidiedDocument) return unverified(q, TOO_SHORT);
  if (typeof q.value === "number") {
    if (!Number.isFinite(q.value)) return unverified(q, NOT_READ);
    if (!numberInQuote(q.value, q.quote)) return unverified(q, `The number ${plain(q.value)} is not written in the quoted sentence.`);
  }
  if (named && typeof q.value === "string") {
    const inQuote = new Set(wordsOf(q.quote));
    if (!wordsOf(q.value).every((word) => inQuote.has(word))) return unverified(q, `"${q.value}" is not written in the quoted sentence.`);
  }
  return verified(q);
}

/**
 * A loss's year, checked as a number and then as a year: "KES 2,024" holds the number 2024,
 * but a year is written as four digits standing on their own, so that quote does not hold it.
 */
function checkYear(q: Quoted<number>, tidiedDocument: string): Quoted<number> {
  const checked = check(q, tidiedDocument);
  if (checked.status !== "verified" || checked.value === null) return checked;
  const year = checked.value;
  if (!Number.isInteger(year) || year < LOSS_YEAR_RANGE.min || year > LOSS_YEAR_RANGE.max) return unverified(checked, `${plain(year)} is not a year.`);
  if (!new RegExp(`(?:^|[^\\d.,])${year}(?![\\d]|[.,]\\d)`).test(checked.quote.normalize("NFKC"))) return unverified(checked, `The year ${year} is not written in the quoted sentence.`);
  return checked;
}

/** True when the text writes the number as a return period: "50-year", "1-in-50", "1:50", "return period of 50 years". */
function writtenAsReturnPeriod(years: number, text: string): boolean {
  const n = `(?:${years}|${years.toLocaleString("en-US").replace(/[.]/g, "\\.")})`;
  const end = "(?!\\d|[.,]\\d)";
  const forms = [
    `(?:^|[^\\d.,])${n}[\\s-]*(?:years?|yrs?)\\b`,
    `(?:^|[^\\d.,])1[\\s-]*(?:in|[:/])[\\s-]*${n}${end}`,
    `\\b(?:return\\s+period|recurrence(?:\\s+interval)?|RP|ARI)[^\\d]{0,25}${n}${end}`,
  ];
  return new RegExp(forms.join("|"), "i").test(tidy(text));
}

/**
 * A drain design return period, checked as a number and then as a return period: "50 mm of
 * rain" holds the number 50, but a return period is written as a number of years or as one
 * chance in so many, so that quote does not hold it.
 */
function checkReturnPeriod(q: Quoted<number>, tidiedDocument: string): Quoted<number> {
  const checked = check(q, tidiedDocument);
  if (checked.status !== "verified" || checked.value === null) return checked;
  const years = checked.value;
  if (years < DESIGN_RP_RANGE.min || years > DESIGN_RP_RANGE.max) return unverified(checked, `${plain(years)} is not a return period in years.`);
  if (!writtenAsReturnPeriod(years, checked.quote)) return unverified(checked, `${plain(years)} is not written as a number of years, or as a 1-in-${plain(years)} chance, in the quoted sentence.`);
  return checked;
}

// ---------------------------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------------------------

// About five metres on the ground: room for a model that rounds degrees and minutes, no more.
const SAME_PLACE_DEG = 5e-5;

const LETTERS = { lat: ["N", "S"], lon: ["E", "W"] } as const;
const DIRECTIONS = { N: "north", S: "south", E: "east", W: "west" } as const;

/**
 * Latitude and longitude are checked as a pair, from the sentence itself. Code reads the
 * quote again, takes the direction from the hemisphere letter when one is written, and puts
 * that reading in place of whatever sign the value arrived with.
 */
function checkCoordinates(row: OfferRow, tidiedDocument: string): Pick<OfferRow, "lat" | "lon" | "coordinates"> {
  if (userSet(row.lat) && userSet(row.lon)) return { lat: row.lat, lon: row.lon, coordinates: row.coordinates };
  if (!stated(row.lat) && !stated(row.lon)) return { lat: userSet(row.lat) ? row.lat : missing(), lon: userSet(row.lon) ? row.lon : missing(), coordinates: null };

  const latQuote = row.lat.quote.trim();
  const lonQuote = row.lon.quote.trim();
  // Normally one sentence holds both. When each number came with its own sentence, the two are read together.
  const sources = [latQuote, lonQuote, latQuote && lonQuote && latQuote !== lonQuote ? `${latQuote}, ${lonQuote}` : ""].filter(Boolean);
  let reading: CoordinateReading | null = null;
  let readFrom = "";
  for (const source of sources) {
    reading = parseCoordinates(source);
    if (reading) {
      readFrom = source;
      break;
    }
  }

  if (!reading) {
    const fail = (q: Quoted<number>): Quoted<number> => (userSet(q) ? q : !stated(q) ? missing() : unverified(q, q.quote.trim() ? NO_PAIR : NO_QUOTE));
    return { lat: fail(row.lat), lon: fail(row.lon), coordinates: null };
  }

  const point = {
    lat: userSet(row.lat) && row.lat.value !== null ? row.lat.value : reading.lat,
    lon: userSet(row.lon) && row.lon.value !== null ? row.lon.value : reading.lon,
  };
  const found = reading;
  const other = (axis: "lat" | "lon") => (axis === "lat" ? "lon" : "lat");

  /** What is wrong with the way one of the two numbers was written or given, if anything. */
  const doubt = (axis: "lat" | "lon"): string | null => {
    const q = row[axis];
    if (userSet(q)) return null;
    const read = found[axis];
    const how = axis === "lat" ? found.latHow : found.lonHow;
    if (how === "both_conflict") {
      const letter = LETTERS[axis][read < 0 ? 1 : 0];
      return `Written with a minus sign and the letter ${letter}, which disagree. Read as ${DIRECTIONS[letter]}, by the letter. Check which is meant.`;
    }
    if (q.value !== null && Math.abs(Math.abs(q.value) - Math.abs(read)) > SAME_PLACE_DEG) {
      return `The quoted sentence reads as ${describeReading(found)}, which is not the number first given (${plain(q.value)}).`;
    }
    // With a letter on the page the letter settles it. Without one, a value that points the other way is a guess.
    if (q.value !== null && how === "sign" && read !== 0 && Math.sign(q.value) !== Math.sign(read)) {
      const [positive, negative] = LETTERS[axis];
      return `The document writes this number ${read < 0 ? "with a minus sign" : `with no minus sign and no ${negative}`}, but the value first given was ${q.value < 0 ? DIRECTIONS[negative] : DIRECTIONS[positive]}. Read as written. Check which is meant.`;
    }
    return null;
  };
  const doubts = { lat: doubt("lat"), lon: doubt("lon") };
  const outside = inKenya(point.lat, point.lon) ? null : `The point ${plain(point.lat)}, ${plain(point.lon)} is outside Kenya.`;

  const one = (axis: "lat" | "lon"): Quoted<number> => {
    const q = row[axis];
    if (userSet(q)) return q;
    // Next to a number the underwriter set, one they left empty stays empty.
    if (!stated(q) && userSet(row[other(axis)])) return missing();
    // A number that arrived without its own sentence takes the one the pair was read from.
    const next: Quoted<number> = { ...q, value: found[axis], quote: q.quote.trim() ? q.quote : readFrom };
    if (!inTidied(next.quote, tidiedDocument)) return unverified(next, NOT_IN_DOCUMENT);
    const mine = doubts[axis];
    if (mine) return unverified(next, mine);
    // A point is only as sure as both of its numbers, so a doubt about one holds back the other.
    const theirs = doubts[other(axis)];
    if (theirs) return unverified(next, `The ${axis === "lat" ? "longitude" : "latitude"} written with it is in doubt. ${theirs}`);
    if (outside) return unverified(next, outside);
    return verified(next);
  };
  // After an edit the reading no longer describes the pair in use, so the row keeps what the edit left.
  const edited = row.lat.status === "edited" || row.lon.status === "edited";
  return { lat: one("lat"), lon: one("lon"), coordinates: edited ? row.coordinates : reading };
}

// ---------------------------------------------------------------------------------------------
// The whole extraction
// ---------------------------------------------------------------------------------------------

const NAMED_TERMS: ReadonlySet<keyof OfferTerms> = new Set<keyof OfferTerms>(["placeName", "riverName"]);

export const verifyExtraction: VerifyExtraction = (extraction, documentText) => {
  const doc = tidy(documentText);
  const rows = extraction.rows.map((row): OfferRow => ({
    ...row,
    name: check(row.name, doc),
    housingClass: check(row.housingClass, doc),
    floorAreaM2: check(row.floorAreaM2, doc),
    costPerM2Kes: check(row.costPerM2Kes, doc),
    tivKes: check(row.tivKes, doc),
    ...checkCoordinates(row, doc),
  }));
  // Terms built by hand may carry no years of loss history and none of the loss drivers' values: each is read as not stated.
  const given = extraction.terms as Partial<Record<keyof OfferTerms, Quoted<unknown>>>;
  const terms = { ...given } as Record<keyof OfferTerms, Quoted<unknown>>;
  for (const key of Object.keys(TERM_KINDS) as (keyof OfferTerms)[]) {
    const read = given[key] ?? missing();
    terms[key] = key === "drainDesignRp" ? checkReturnPeriod(read as Quoted<number>, doc) : check(read, doc, NAMED_TERMS.has(key));
  }
  const notes = extraction.notes.map((note): OfferNote => ({ ...check(note, doc), kind: note.kind }));
  // Each loss's year and amount stand on their own sentence, and each is checked like any other number.
  const floodLosses = (extraction.floodLosses ?? []).map((loss): FloodLoss => ({ year: checkYear(loss.year, doc), amountKes: check(loss.amountKes, doc) }));
  // An item of equipment stands on the sentence that says where it is.
  const equipmentBelowGround = (extraction.equipmentBelowGround ?? []).map((entry): EquipmentItem => ({ item: check(entry.item, doc) }));
  return { rows, terms: terms as unknown as OfferTerms, notes, floodLosses, equipmentBelowGround };
};

export const usableValue: UsableValue = (quoted) => (quoted && (USABLE_STATUSES as readonly string[]).includes(quoted.status) ? quoted.value : null);

// ---------------------------------------------------------------------------------------------
// What still waits on the underwriter
// ---------------------------------------------------------------------------------------------

/** The row values the price rests on, in the order they are shown. The name is not one of them. */
const PRICED_ROW_VALUES: [keyof OfferRowValues, string][] = [
  ["lat", "Latitude"],
  ["lon", "Longitude"],
  ["housingClass", "Construction class"],
  ["floorAreaM2", "Floor area"],
  ["costPerM2Kes", "Cost per m²"],
  ["tivKes", "Insured value"],
];

const PRICED_TERMS: [CoreTermKey, string][] = [
  ["floodDeductiblePct", "Flood deductible"],
  ["floodDeductibleMinKes", "Deductible minimum"],
  ["floodDeductibleBasis", "What the deductible is a percentage of"],
  ["floodLimitKes", "Flood limit"],
  ["placeName", "Place name"],
];

/**
 * The values that switch a loss driver on or set its size. With all loss drivers an unverified one
 * holds pricing like any other value the price rests on; with Depth only none of them is read.
 */
const PRICED_DRIVER_TERMS: [keyof OfferTerms, string][] = [
  ["basements", "Basement levels"],
  ["valueBelowGroundKes", "Value below ground"],
  ["drainDesignRp", "Drain design return period"],
  ["biCovered", "Business interruption cover"],
  ["annualRentKes", "Rent or revenue for a year"],
];

export const waitingValues: WaitingValues = (extraction, mode = "depth_only") => {
  const out: WaitingValue[] = [];
  extraction.rows.forEach((row, i) => {
    for (const [key, label] of PRICED_ROW_VALUES) {
      const quoted = row[key];
      if (quoted.status !== "unverified") continue;
      // Floor area and cost per m² feed the price only when there is no insured value to use.
      if ((key === "floorAreaM2" || key === "costPerM2Kes") && usableValue(row.tivKes) !== null) continue;
      out.push({ ref: { scope: "row", row: i, key }, label, quoted });
    }
  });
  // The place name stands in only for a row without usable coordinates of its own.
  const needsPlace = extraction.rows.some((row) => usableValue(row.lat) === null || usableValue(row.lon) === null);
  for (const [key, label] of PRICED_TERMS) {
    const quoted = extraction.terms[key];
    if (quoted.status !== "unverified" || (key === "placeName" && !needsPlace)) continue;
    out.push({ ref: { scope: "terms", key }, label, quoted });
  }
  if (mode === "all_drivers") {
    // A year's rent is read only while interruption could be priced: not when cover is excluded or nothing is said of it.
    const cover = extraction.terms.biCovered;
    const rentRead = cover !== undefined && cover.status !== "missing" && !(usableValue(cover) === "excluded");
    for (const [key, label] of PRICED_DRIVER_TERMS) {
      const quoted = extraction.terms[key] as Quoted<string | number> | undefined;
      if (!quoted || quoted.status !== "unverified" || (key === "annualRentKes" && !rentRead)) continue;
      out.push({ ref: { scope: "terms", key }, label, quoted });
    }
  }
  return out;
};

export const statusCounts: StatusCounts = (extraction) => {
  const counts: Record<ValueStatus, number> = { verified: 0, unverified: 0, confirmed: 0, edited: 0, missing: 0 };
  for (const row of extraction.rows) for (const key of Object.values(OFFER_ROW_KEYS)) counts[row[key].status]++;
  // An offer-level value that is absent, on terms built by hand, is one that was not stated.
  for (const key of Object.values(OFFER_TERM_KEYS)) counts[extraction.terms[key]?.status ?? "missing"]++;
  for (const loss of extraction.floodLosses ?? []) for (const key of Object.values(OFFER_LOSS_KEYS)) counts[loss[key].status]++;
  for (const entry of extraction.equipmentBelowGround ?? []) counts[entry.item.status]++;
  for (const note of extraction.notes) counts[note.status]++;
  return counts;
};

// ---------------------------------------------------------------------------------------------
// The underwriter's own changes
// ---------------------------------------------------------------------------------------------

/** What kind of thing each value holds, so a typed edit can be read the same way wherever it is made. */
type ValueKind = "text" | "count" | "kes" | "percent" | "area" | "distance" | "depth" | "lat" | "lon" | "year" | "years" | "returnPeriod" | readonly string[];

const ROW_KINDS: Record<keyof OfferRowValues, ValueKind> = {
  name: "text",
  lat: "lat",
  lon: "lon",
  housingClass: HOUSING_CLASSES,
  floorAreaM2: "area",
  costPerM2Kes: "kes",
  tivKes: "kes",
};

const TERM_KINDS: Record<keyof OfferTerms, ValueKind> = {
  basements: "count",
  occupancy: OCCUPANCIES,
  floodDeductiblePct: "percent",
  floodDeductibleMinKes: "kes",
  floodDeductibleBasis: DEDUCTIBLE_BASES,
  floodLimitKes: "kes",
  policyPeriod: "text",
  floodCover: FLOOD_COVERS,
  placeName: "text",
  riverName: "text",
  riverDistanceM: "distance",
  floodHistoryYears: "years",
  basementDepthM: "depth",
  drainDesignRp: "returnPeriod",
  sumpPumpCapacity: "text",
  sumpPumpBackup: YES_NO,
  floodBarriers: PRESENCES,
  nonReturnValves: PRESENCES,
  valueBuildingKes: "kes",
  valueMachineryKes: "kes",
  valueContentsKes: "kes",
  valueBelowGroundKes: "kes",
  annualRentKes: "kes",
  biCovered: BI_COVERS,
  premiumKes: "kes",
};

const LOSS_KINDS: Record<keyof FloodLoss, ValueKind> = {
  year: "year",
  amountKes: "kes",
};

// A sign, the digits, then whatever unit was typed after them.
const TYPED_NUMBER = /^([-\u2212\u2013+]?)\s*(\d{1,3}(?:[, \u00a0]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*([^\d.,\s].*)?$/;

/**
 * A number as an underwriter types it into a box: "8,000,000", "8 million", "8m" in a money
 * box, "1.8 km" in a distance box, "5%" in a percentage box, "1-in-50" or "50-year" in a return
 * period box. Outside a money box the letter m means metres, never millions. Returns undefined
 * when it cannot be read.
 */
function typedNumber(input: string | number, kind: ValueKind): number | undefined {
  let n: number;
  if (typeof input === "number") n = input;
  else {
    let written = input.trim().replace(/^(?:KES|KSH|KSHS)\.?\s*/i, "");
    // "1-in-50" and "1:50" are the 50-year storm: the years are the number that follows.
    if (kind === "returnPeriod") written = written.replace(/^1\s*(?:-?\s*in\s*-?|[:/])\s*(?=\d)/i, "");
    const match = TYPED_NUMBER.exec(written);
    if (!match) return undefined;
    n = Number(match[2].replace(/[, \u00a0]/g, ""));
    if (match[1] !== "" && match[1] !== "+") n = -n;
    const unit = (match[3] ?? "").trim().toLowerCase();
    if (kind === "kes" && unit in MONEY_SCALES) n *= MONEY_SCALES[unit];
    if (kind === "distance" && unit in DISTANCE_SCALES) n *= DISTANCE_SCALES[unit];
  }
  if (!Number.isFinite(n)) return undefined;
  if (kind === "lat") return Math.abs(n) <= 90 ? n : undefined;
  if (kind === "lon") return Math.abs(n) <= 180 ? n : undefined;
  // A loss happened in a year; a history covers some years, never none.
  if (kind === "year") return Number.isInteger(n) && n >= LOSS_YEAR_RANGE.min && n <= LOSS_YEAR_RANGE.max ? n : undefined;
  if (kind === "years") return n > 0 ? n : undefined;
  if (kind === "returnPeriod") return n >= DESIGN_RP_RANGE.min && n <= DESIGN_RP_RANGE.max ? n : undefined;
  // Nothing else on an offer can be below zero.
  return n >= 0 ? n : undefined;
}

/** The typed value in the form its field holds. null clears the field; undefined means it could not be read. */
function typedValue(input: string | number | null, kind: ValueKind): string | number | null | undefined {
  if (input === null || (typeof input === "string" && !input.trim())) return null;
  if (kind === "text") return String(input).trim();
  if (typeof kind !== "string") {
    const word = String(input).trim().toLowerCase();
    return kind.includes(word) ? word : undefined;
  }
  return typedNumber(input, kind);
}

/** The extraction with one value put through `change`. An address that points at nothing changes nothing. */
function withValue(extraction: OfferExtraction, ref: ValueRef, change: (q: Quoted<unknown>, kind: ValueKind) => Quoted<unknown>): OfferExtraction {
  if (ref.scope === "row") {
    const row = extraction.rows[ref.row];
    if (!row || !(ref.key in ROW_KINDS)) return extraction;
    const next = change(row[ref.key], ROW_KINDS[ref.key]);
    if (next === row[ref.key]) return extraction;
    const changed = { ...row, [ref.key]: next } as OfferRow;
    // Typed coordinates were not read from the document, so the note on how they were read goes.
    if ((ref.key === "lat" || ref.key === "lon") && next.status !== "confirmed") changed.coordinates = null;
    return { ...extraction, rows: extraction.rows.map((r, i) => (i === ref.row ? changed : r)) };
  }
  if (ref.scope === "terms") {
    if (!(ref.key in TERM_KINDS)) return extraction;
    // The years of loss history and the loss drivers' values can be absent, and absent is not stated.
    const now: Quoted<unknown> = extraction.terms[ref.key] ?? missing();
    const next = change(now, TERM_KINDS[ref.key]);
    if (next === now) return extraction;
    return { ...extraction, terms: { ...extraction.terms, [ref.key]: next } as OfferTerms };
  }
  if (ref.scope === "loss") {
    const losses = extraction.floodLosses ?? [];
    if (!(ref.key in LOSS_KINDS) || !Number.isInteger(ref.index) || ref.index < 0 || ref.index > Math.min(losses.length, MOST_LOSSES - 1)) return extraction;
    // One past the end is a loss the reading did not find: it starts with nothing stated.
    const loss: FloodLoss = losses[ref.index] ?? { year: missing(), amountKes: missing() };
    const next = change(loss[ref.key], LOSS_KINDS[ref.key]) as Quoted<number>;
    // Nothing typed into a loss that is not there yet adds no loss.
    if (next === loss[ref.key] || (ref.index === losses.length && next.value === null)) return extraction;
    const changed: FloodLoss = { ...loss, [ref.key]: next };
    // A cleared loss keeps its place, so the losses after it are still found by the same number.
    return { ...extraction, floodLosses: ref.index === losses.length ? [...losses, changed] : losses.map((l, i) => (i === ref.index ? changed : l)) };
  }
  if (ref.scope === "equipment") {
    const items = extraction.equipmentBelowGround ?? [];
    if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index > Math.min(items.length, MOST_EQUIPMENT - 1)) return extraction;
    // One past the end is an item the reading did not find: it starts with nothing stated.
    const now: Quoted<string> = items[ref.index]?.item ?? missing();
    const next = change(now, "text") as Quoted<string>;
    if (next === now || (ref.index === items.length && next.value === null)) return extraction;
    // A cleared item keeps its place, so the items after it are still found by the same number.
    return { ...extraction, equipmentBelowGround: ref.index === items.length ? [...items, { item: next }] : items.map((entry, i) => (i === ref.index ? { item: next } : entry)) };
  }
  const note = extraction.notes[ref.index];
  if (!note) return extraction;
  const next = change(note, "text");
  if (next === note) return extraction;
  // A cleared note keeps its place, so the notes after it are still found by the same number.
  return { ...extraction, notes: extraction.notes.map((n, i) => (i === ref.index ? ({ ...next, kind: note.kind } as OfferNote) : n)) };
}

/**
 * A typed value that cannot be read for its field (letters in a number box, a class that is
 * not one of the four, a latitude beyond 90) leaves the extraction exactly as it was, so the
 * screen can tell by comparing what it gets back with what it passed in.
 */
export const editValue: EditValue = (extraction, ref, value) =>
  withValue(extraction, ref, (q, kind) => {
    const typed = typedValue(value, kind);
    if (typed === undefined) return q;
    if (typed === null) return missing();
    return { value: typed, quote: q.quote, status: "edited", reason: null };
  });

export const confirmValue: ConfirmValue = (extraction, ref) =>
  // Only a value that is there can be accepted: one that could not be read has to be typed in.
  withValue(extraction, ref, (q) => (q.status === "unverified" && q.value !== null ? { ...q, status: "confirmed", reason: null } : q));
