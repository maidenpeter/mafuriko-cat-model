import { z } from "zod";
import { HOUSING_CLASSES } from "../model/types";
import {
  DEDUCTIBLE_BASES,
  FLOOD_COVERS,
  NOTE_KINDS,
  OCCUPANCIES,
  OFFER_FIELDS,
  OFFER_ROW_FIELDS,
  OFFER_ROW_KEYS,
  OFFER_TERM_FIELDS,
  OFFER_TERM_KEYS,
  type BuildOfferPrompt,
  type ExtractionPath,
  type FromFlatReply,
  type NoteKind,
  type OfferField,
  type OfferFlatEntry,
  type OfferNote,
  type OfferReplySchema,
  type OfferResponseSchema,
  type OfferRow,
  type OfferRowField,
  type OfferTermField,
  type OfferTerms,
  type Quoted,
} from "./types";

/**
 * The hosted model's side of reading an offer: the reply shape it is held to, the
 * instructions it is given, and the step that turns its flat reply into an extraction.
 * Nothing here decides whether a value is right. verify.ts does that, against the
 * document's own words.
 */

// ---------------------------------------------------------------------------------------------
// Values as they leave an extractor, before any check has run
// ---------------------------------------------------------------------------------------------

/** A value the document does not state. */
export const missingValue = <T>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });

/** A value read from the document. It stays "unverified" until verifyExtraction has checked it. */
export const statedValue = <T>(value: T, quote: string): Quoted<T> => ({ value, quote, status: "unverified", reason: null });

/** Something was written for this field but it could not be read as a value: the quote is kept and the reason says why. */
export const unreadValue = <T>(quote: string, reason: string): Quoted<T> => ({ value: null, quote, status: "unverified", reason });

/** A row with nothing stated, so the underwriter always has a row to fill in. */
export const emptyRow = (path: ExtractionPath): OfferRow => ({
  name: missingValue(),
  lat: missingValue(),
  lon: missingValue(),
  housingClass: missingValue(),
  floorAreaM2: missingValue(),
  costPerM2Kes: missingValue(),
  tivKes: missingValue(),
  path,
  coordinates: null,
});

/** Offer-level terms with nothing stated. */
export const emptyTerms = (): OfferTerms => ({
  basements: missingValue(),
  occupancy: missingValue(),
  floodDeductiblePct: missingValue(),
  floodDeductibleMinKes: missingValue(),
  floodDeductibleBasis: missingValue(),
  floodLimitKes: missingValue(),
  policyPeriod: missingValue(),
  floodCover: missingValue(),
  placeName: missingValue(),
  riverName: missingValue(),
  riverDistanceM: missingValue(),
});

/** What a note of each kind is called when the extractor gave it no summary of its own. */
export const NOTE_LABELS: Record<NoteKind, string> = {
  basement_plant: "Critical plant in a basement",
  past_flood: "Past flood or water damage reported",
  drainage_condition: "Condition of the site's drainage",
  broker_view: "The broker's view of the flood risk",
};

// ---------------------------------------------------------------------------------------------
// The reply shape
// ---------------------------------------------------------------------------------------------

type Schema = Record<string, unknown>;

const text: Schema = { type: "STRING" };
const object = (properties: Record<string, Schema>): Schema => ({
  type: "OBJECT",
  properties,
  required: Object.keys(properties),
  propertyOrdering: Object.keys(properties),
});

/**
 * The reply in the form the provider enforces while it generates, in the same spelling as
 * agents/responseSchema.ts; openai.ts turns it into the form OpenAI enforces.
 *
 * One flat list of entries, because a nested shape stalled one provider. Every property is
 * required, which strict mode needs, so "not stated" is said by leaving the entry out of the
 * list, never by an empty or optional property. The quote is written before the value, so
 * the value follows from the sentence and not the other way round.
 */
export const OFFER_RESPONSE_SCHEMA: OfferResponseSchema = object({
  entries: {
    type: "ARRAY",
    items: object({ field: { type: "STRING", enum: [...OFFER_FIELDS] }, row: { type: "INTEGER" }, quote: text, value: text }),
  },
});

const isField = (name: string): name is OfferField => (OFFER_FIELDS as readonly string[]).includes(name);

/**
 * What the route checks a reply with. It is strict about the shape and lenient about slips
 * that lose nothing: a number sent as a number, a row sent as text, a field name in capitals.
 * An entry under a field name that is not on the list is dropped, so one stray entry does
 * not cost the whole reply.
 */
export const offerReplySchema: OfferReplySchema = z
  .object({
    entries: z.array(
      z.object({
        field: z.string(),
        row: z.union([z.number(), z.string().regex(/^\s*\d+\s*$/)]).transform(Number).pipe(z.number().int().min(0)),
        value: z.union([z.string(), z.number()]).transform(String),
        quote: z.string(),
      }),
    ),
  })
  .transform(({ entries }) => ({
    entries: entries.flatMap((entry): OfferFlatEntry[] => {
      const field = entry.field.trim().toLowerCase();
      return isField(field) ? [{ ...entry, field }] : [];
    }),
  }));

// ---------------------------------------------------------------------------------------------
// The instructions
// ---------------------------------------------------------------------------------------------

const SYSTEM = `You read one document for a reinsurer in Kenya: a broker's placement memo, or an underwriter's own short description of a risk. You list what it states about the insured buildings and about the flood terms, so that a flood model can price the offer.

How the work is divided:
- You find and copy what the document states. You never calculate, never estimate and never fill a gap. Code checks every entry against the document's own words, and code does all the pricing.
- Every entry carries a quote: the exact sentence or line of the document the value came from, copied word for word, with the same spelling, punctuation, figures and symbols. Do not shorten it, tidy it, translate it or join passages that are apart in the document. An entry whose quote cannot be found in the document is rejected.
- A number must be visible in its own quote.
- Never invent a value. When the document does not state something, leave that entry out of the list altogether. Do not send an empty value, a typical figure, or the words "not stated".
- Words in square brackets, such as [email removed], mark where contact details were taken out before the text reached you. Ignore them.
- Reply with one JSON object in exactly the shape requested. No markdown, no text outside the JSON.

Reply shape:
{
  "entries": [ { "field": string, "row": integer, "quote": string, "value": string } ]
}

Rows:
- Send one row per insured building, in the shape of an exposure file. Number the buildings from 1 in the order the document lists them, and give every entry about a building that building's number in "row".
- A building is a structure that is insured. Plant, machinery, equipment, stock and contents are not buildings and get no row, even when the document gives them their own coordinates or values.
- When the document describes one building, or one site with a single total, send one row.
- Entries about the offer as a whole, and all notes, have "row": 0.

Values are always text:
- A number is plain digits in the base unit, with a dot for decimals and no separators, units or scale words. "KES 4.25 billion" is "4250000000". "48,500 m²" is "48500". "1.8 km" is "1800". "5%" is "5".
- Where a field takes one of a list of words, send the word exactly as listed.

Fields for a building (row is the building's number):
- name: the name of the building, or of the insured when the building has no name of its own.
- lat and lon: the site's position in decimal degrees, south and west negative. Send both, and give both the same quote: the line that states the coordinates, exactly as written, with its degree signs and the letters N, S, E and W. The letter decides the direction: "1.2921°S" and "-1.2921°S" are both "-1.2921". Use the coordinates of the building or its site, never those of a generator, a landmark or a river.
- housing_class: one of ${HOUSING_CLASSES.map((c) => `"${c}"`).join(", ")}. "concrete_rcc" is a reinforced concrete frame. "permanent_masonry" is stone, brick or block walls. "semi_permanent" is timber, mud and wattle, or a mix of permanent and light materials. "informal_iron_sheet" is iron sheet walls on a light frame. Choose the class closest to how the document says the building is constructed, and quote the sentence that justifies the choice. When the document says nothing about the construction, leave it out.
- floor_area_m2: the building's gross floor area in m².
- cost_per_m2_kes: a rebuilding cost or value per m², only when the document states one. Never divide one figure by another to get it.
- tiv_kes: the building's total insured value in KES, also called the sum insured. When the document gives one total for a single building or site, use it. Do not convert from another currency: when no KES figure is stated, leave it out.

Fields for the offer (row 0):
- basements: the number of basement levels. Send "0" only when the document says there are none.
- occupancy: one of ${OCCUPANCIES.map((o) => `"${o}"`).join(", ")}: what the buildings are used for.
- flood_deductible_pct: the flood deductible as a percentage. "5" means 5%.
- flood_deductible_min_kes: the KES minimum of the flood deductible, or the whole deductible when it is stated only as an amount.
- flood_deductible_basis: only when the document says what the percentage is a percentage of: "percent_of_loss" for a share of each loss, "percent_of_sum_insured" for a share of the insured value. Otherwise leave it out.
- flood_limit_kes: the most the policy would pay for one flood.
- policy_period: the period of insurance, in the document's own words.
- flood_cover: one of ${FLOOD_COVERS.map((c) => `"${c}"`).join(", ")}. "covered" when the offer asks for flood to be insured, "excluded" when it leaves flood out.
- place_name: the neighbourhood, estate, ward or town the site is in, as short as the document allows, for example "Kibera" or "Upper Hill". Send it whenever the document names the place, with or without coordinates.
- river_name: the river the document names as nearest to the site.
- river_distance_m: the stated distance from the site to that river, in metres.
Where the document states both the terms of the current policy and the terms asked for in this offer, send the terms asked for.

Notes (row 0). A note's value is one short line in plain words; its quote is the document's sentence. A kind may be sent more than once:
- basement_plant: critical plant, such as generators, switchgear, pumps or lift machinery, kept in a basement.
- past_flood: a flood or water damage event that the document reports has happened at the site. A statement that there has been none is not a note.
- drainage_condition: what the document says about the state or capacity of the site's drains.
- broker_view: the broker's own opinion of the flood risk.`;

/** The instructions and the message for one extraction. The text is expected already redacted. */
export const buildOfferPrompt: BuildOfferPrompt = (documentText) => ({
  system: SYSTEM,
  user: `The document is everything between the two marker lines.

<<<DOCUMENT
${documentText}
DOCUMENT>>>

List every entry the document supports, each with its quote copied word for word from the text above.`,
});

// ---------------------------------------------------------------------------------------------
// From the flat reply to an extraction
// ---------------------------------------------------------------------------------------------

/** Words a model may send in place of leaving an entry out. They mean "not stated". */
const NOT_STATED = /^(?:not[ _]stated|not[ _]given|not[ _]specified|unknown|none stated|n\/?a|null|nil)?$/i;

const NUMBER_FIELDS = new Set<OfferField>(["lat", "lon", "floor_area_m2", "cost_per_m2_kes", "tiv_kes", "basements", "flood_deductible_pct", "flood_deductible_min_kes", "flood_limit_kes", "river_distance_m"]);
const WORD_LISTS: Partial<Record<OfferField, readonly string[]>> = {
  housing_class: HOUSING_CLASSES,
  occupancy: OCCUPANCIES,
  flood_cover: FLOOD_COVERS,
  flood_deductible_basis: DEDUCTIBLE_BASES,
};

/** "4250000000", "48,500" and " 1800 " are numbers. "8 million" and "about 5" are not: the model was asked for plain digits. */
function plainNumber(written: string): number | null {
  const tidy = written.trim().replace(/(\d)[, ](?=\d{3}(?:\D|$))/g, "$1");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(tidy)) return null;
  const n = Number(tidy);
  return Number.isFinite(n) ? n : null;
}

/** One entry as a value of the type its field holds, or as an unread value with the reason. */
function readEntry(entry: OfferFlatEntry): Quoted<unknown> {
  const written = entry.value.trim();
  const quote = entry.quote.trim();
  if (NUMBER_FIELDS.has(entry.field)) {
    const n = plainNumber(written);
    if (n === null) return unreadValue(quote, `The model's value "${written}" is not a plain number.`);
    if (n < 0 && entry.field !== "lat" && entry.field !== "lon") return unreadValue(quote, `The model's value "${written}" is below zero.`);
    if (entry.field === "basements" && !Number.isInteger(n)) return unreadValue(quote, `The model's value "${written}" is not a whole number of basement levels.`);
    return statedValue(n, quote);
  }
  const words = WORD_LISTS[entry.field];
  if (words) {
    const word = written.toLowerCase().replace(/[\s-]+/g, "_");
    return words.includes(word) ? statedValue(word, quote) : unreadValue(quote, `The model's value "${written}" is not one of: ${words.join(", ")}.`);
  }
  return statedValue(written, quote);
}

/**
 * The flat reply as an extraction. A field repeated for the same row keeps its last entry;
 * notes all stay. A reply with no entry about any building still gives one empty row, as the
 * rules do, so there is always a row on screen to fill in.
 */
export const fromFlatReply: FromFlatReply = (reply) => {
  const rowEntries = new Map<number, Map<OfferRowField, OfferFlatEntry>>();
  const terms = emptyTerms();
  const notes: OfferNote[] = [];

  for (const entry of reply.entries) {
    const { field } = entry;
    if ((NOTE_KINDS as readonly string[]).includes(field)) {
      const quote = entry.quote.trim();
      const summary = NOT_STATED.test(entry.value.trim()) ? "" : entry.value.trim();
      // A note with neither a summary nor a sentence says nothing.
      if (summary || quote) notes.push({ kind: field as NoteKind, ...statedValue(summary || NOTE_LABELS[field as NoteKind], quote) });
      continue;
    }
    if (NOT_STATED.test(entry.value.trim())) continue;
    if ((OFFER_TERM_FIELDS as readonly string[]).includes(field)) {
      // Each term key holds a different type; readEntry has already matched the value to its field.
      (terms as unknown as Record<string, Quoted<unknown>>)[OFFER_TERM_KEYS[field as OfferTermField]] = readEntry(entry);
      continue;
    }
    if ((OFFER_ROW_FIELDS as readonly string[]).includes(field)) {
      // A model with a single building sometimes files its fields under row 0.
      const number = Math.max(1, entry.row);
      if (!rowEntries.has(number)) rowEntries.set(number, new Map());
      rowEntries.get(number)!.set(field as OfferRowField, entry);
    }
  }

  const rows = [...rowEntries.keys()]
    .sort((a, b) => a - b)
    .map((number) => {
      const row = emptyRow("model");
      for (const [field, entry] of rowEntries.get(number)!) (row as unknown as Record<string, Quoted<unknown>>)[OFFER_ROW_KEYS[field]] = readEntry(entry);
      return row;
    });

  return { rows: rows.length ? rows : [emptyRow("model")], terms, notes };
};
