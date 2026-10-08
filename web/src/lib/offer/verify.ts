import { HOUSING_CLASSES } from "../model/types";
import { describeReading, inKenya, parseCoordinates } from "./coords";
import { missingValue as missing } from "./extraction";
import { DISTANCE_SCALES, MONEY_SCALES } from "./shared";
import {
  DEDUCTIBLE_BASES,
  FLOOD_COVERS,
  OCCUPANCIES,
  OFFER_ROW_KEYS,
  OFFER_TERM_KEYS,
  USABLE_STATUSES,
  type ConfirmValue,
  type CoordinateReading,
  type EditValue,
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
  const terms = { ...extraction.terms } as Record<keyof OfferTerms, Quoted<unknown>>;
  for (const key of Object.keys(terms) as (keyof OfferTerms)[]) terms[key] = check(terms[key], doc, NAMED_TERMS.has(key));
  const notes = extraction.notes.map((note): OfferNote => ({ ...check(note, doc), kind: note.kind }));
  return { rows, terms: terms as unknown as OfferTerms, notes };
};

export const usableValue: UsableValue = (quoted) => ((USABLE_STATUSES as readonly string[]).includes(quoted.status) ? quoted.value : null);

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

const PRICED_TERMS: [keyof OfferTerms, string][] = [
  ["floodDeductiblePct", "Flood deductible"],
  ["floodDeductibleMinKes", "Deductible minimum"],
  ["floodDeductibleBasis", "What the deductible is a percentage of"],
  ["floodLimitKes", "Flood limit"],
  ["placeName", "Place name"],
];

export const waitingValues: WaitingValues = (extraction) => {
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
  return out;
};

export const statusCounts: StatusCounts = (extraction) => {
  const counts: Record<ValueStatus, number> = { verified: 0, unverified: 0, confirmed: 0, edited: 0, missing: 0 };
  for (const row of extraction.rows) for (const key of Object.values(OFFER_ROW_KEYS)) counts[row[key].status]++;
  for (const key of Object.values(OFFER_TERM_KEYS)) counts[extraction.terms[key].status]++;
  for (const note of extraction.notes) counts[note.status]++;
  return counts;
};

// ---------------------------------------------------------------------------------------------
// The underwriter's own changes
// ---------------------------------------------------------------------------------------------

/** What kind of thing each value holds, so a typed edit can be read the same way wherever it is made. */
type ValueKind = "text" | "count" | "kes" | "percent" | "area" | "distance" | "lat" | "lon" | readonly string[];

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
};

// A sign, the digits, then whatever unit was typed after them.
const TYPED_NUMBER = /^([-\u2212\u2013+]?)\s*(\d{1,3}(?:[, \u00a0]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*([^\d.,\s].*)?$/;

/**
 * A number as an underwriter types it into a box: "8,000,000", "8 million", "8m" in a money
 * box, "1.8 km" in a distance box, "5%" in a percentage box. Outside a money box the letter m
 * means metres, never millions. Returns undefined when it cannot be read.
 */
function typedNumber(input: string | number, kind: ValueKind): number | undefined {
  let n: number;
  if (typeof input === "number") n = input;
  else {
    const match = TYPED_NUMBER.exec(input.trim().replace(/^(?:KES|KSH|KSHS)\.?\s*/i, ""));
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
    const next = change(extraction.terms[ref.key], TERM_KINDS[ref.key]);
    if (next === extraction.terms[ref.key]) return extraction;
    return { ...extraction, terms: { ...extraction.terms, [ref.key]: next } as OfferTerms };
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
