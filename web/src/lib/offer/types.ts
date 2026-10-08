import type { z } from "zod";
import type { Usage } from "../agents/provider";
import type { Check } from "../checks";
import type { DrainageState } from "../geo/drainageView";
import type { GeoCollection, WardProps, WaterwayProps } from "../geo/layers";
import type { InsuranceTerms } from "../model/terms";
import type { Dataset, HazardKind, Hotspot, HousingClass, ModelParams, Raster } from "../model/types";

/**
 * Price a single offer: the contract every file in lib/offer is written against.
 *
 * An underwriter gives a broker's memo (Word, plain text, or a typed sentence). The hosted model,
 * or a set of fixed rules when there is no key, turns it into rows in the exposure file's shape.
 * Code checks every value against the words of the document, and only code prices the rows.
 *
 * Units, everywhere in this folder:
 *   money in KES; areas in m²; depths and distances in metres; latitude and longitude in
 *   decimal degrees with south and west negative; percentages as the number written
 *   (5 means 5%); damage ratios as fractions from 0 to 1; return periods in years.
 *
 * What null means: a value of null is "the document does not say" or "not known". It is never
 * a stand-in for zero. A basement count of 0 means the document says there are none.
 *
 * Loss words, the same as in the rest of the app (see model/terms.ts):
 *   ground-up  the loss to the building before any insurance terms
 *   gross      ground-up less the policy deductible, capped at the policy limit
 * Net is the loss after reinsurance. It is a portfolio figure and is never worked out for an offer.
 *
 * Types and signatures only. Nothing in this file calculates anything.
 */

// ---------------------------------------------------------------------------------------------
// 1. The extraction result: the same shape from the hosted model and from the rules
// ---------------------------------------------------------------------------------------------

/** Where a row came from: the hosted model's reply, or the fixed rules that need no key. */
export type ExtractionPath = "model" | "rules";

/**
 * What code decided about one value.
 *   verified    the quote is in the document and, for a number, the number is in its quote
 *   unverified  a check failed; shown, but not used until the underwriter confirms or edits it
 *   confirmed   the underwriter accepted an unverified value as it stands
 *   edited      the underwriter typed the value; any quote is kept only for reference
 *   missing     the document does not state it (value null, quote "")
 */
export type ValueStatus = "verified" | "unverified" | "confirmed" | "edited" | "missing";

/** The statuses whose value may be used in a calculation. */
export const USABLE_STATUSES = ["verified", "confirmed", "edited"] as const satisfies readonly ValueStatus[];

/** One value read from the document, with the sentence it came from and what the checks said. */
export interface Quoted<T> {
  /** null when the document does not state it, or when what was stated could not be read. */
  value: T | null;
  /** The exact sentence or line from the document. "" when there is none. */
  quote: string;
  status: ValueStatus;
  /**
   * Plain words on which check failed, set when the status is "unverified". Otherwise null.
   * Straight out of fromFlatReply and extractByRules, before verifyExtraction has run, every
   * stated value is "unverified" with a null reason.
   */
  reason: string | null;
}

/** What the insured buildings are used for. Anything but "residential" is priced on a curve built for homes. */
export const OCCUPANCIES = ["residential", "commercial", "industrial", "mixed", "other"] as const;
export type Occupancy = (typeof OCCUPANCIES)[number];

/** Whether the offer asks for flood to be insured ("covered") or leaves it out ("excluded"). */
export const FLOOD_COVERS = ["covered", "excluded"] as const;
export type FloodCover = (typeof FLOOD_COVERS)[number];

/**
 * What the deductible percentage is a percentage of. "percent_of_loss" is the default reading:
 * a share of each loss, with the KES minimum. "percent_of_sum_insured" is used only when the
 * text says so.
 */
export const DEDUCTIBLE_BASES = ["percent_of_loss", "percent_of_sum_insured"] as const;
export type DeductibleBasis = (typeof DEDUCTIBLE_BASES)[number];

/** The values of one insured building, in the exposure file's shape. One per row. */
export interface OfferRowValues {
  name: Quoted<string>;
  /** Decimal degrees, south negative. After verifyExtraction the sign follows the hemisphere letter. */
  lat: Quoted<number>;
  /** Decimal degrees, west negative. */
  lon: Quoted<number>;
  /** One of the four starter-kit classes. A class the document only describes is the model's or the rules' choice; the quote shows the words it rests on. */
  housingClass: Quoted<HousingClass>;
  floorAreaM2: Quoted<number>;
  costPerM2Kes: Quoted<number>;
  tivKes: Quoted<number>;
}

/** One insured building as extracted. */
export interface OfferRow extends OfferRowValues {
  /** Which path produced this row. Shown beside it on screen. */
  path: ExtractionPath;
  /**
   * How the coordinates were read from the latitude quote. Filled by verifyExtraction;
   * null before it runs and when the document gives no coordinates for this row.
   */
  coordinates: CoordinateReading | null;
}

/** Terms and facts stated once for the whole offer, not per building. */
export interface OfferTerms {
  /** Number of basement levels. 0 when the document says there are none. */
  basements: Quoted<number>;
  occupancy: Quoted<Occupancy>;
  /** The flood deductible as a percentage: 5 means 5%. */
  floodDeductiblePct: Quoted<number>;
  /** The KES minimum of the flood deductible, or the whole deductible when only an amount is stated. */
  floodDeductibleMinKes: Quoted<number>;
  /** Stated only when the text says what the percentage applies to. Missing means the default reading. */
  floodDeductibleBasis: Quoted<DeductibleBasis>;
  /** The most the policy pays for one flood. */
  floodLimitKes: Quoted<number>;
  /** The policy period in the document's own words, for example "1 January 2027 to 31 December 2027". */
  policyPeriod: Quoted<string>;
  floodCover: Quoted<FloodCover>;
  /** A place name to fall back on for any row without coordinates. */
  placeName: Quoted<string>;
  /** The river the document names as nearest. */
  riverName: Quoted<string>;
  /** The stated distance to that river, in metres ("1.8 km" is 1800). */
  riverDistanceM: Quoted<number>;
}

/**
 * The kinds of flood note. They are also the flat field names the model replies with.
 *   basement_plant      critical plant (generators, switchgear, pumps) kept in a basement
 *   past_flood          a past flood or water damage event at the site that the document reports.
 *                       A statement that there has been none is NOT a note of this kind.
 *   drainage_condition  the state of the site's drains
 *   broker_view         the broker's own opinion of the flood risk
 */
export const NOTE_KINDS = ["basement_plant", "past_flood", "drainage_condition", "broker_view"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** One flood-relevant remark. The value is a one-line summary; the quote is the document's sentence. */
export interface OfferNote extends Quoted<string> {
  kind: NoteKind;
}

/** Everything read from one document. */
export interface OfferExtraction {
  /** One per insured building, in the order the document lists them. */
  rows: OfferRow[];
  terms: OfferTerms;
  /** Any number of notes; a kind can appear more than once. */
  notes: OfferNote[];
}

// ---------------------------------------------------------------------------------------------
// 2. The flat reply the hosted model is asked for
// ---------------------------------------------------------------------------------------------

/** Row fields, named as the exposure file's columns. Sent with row = the building's number, from 1. */
export const OFFER_ROW_FIELDS = ["name", "lat", "lon", "housing_class", "floor_area_m2", "cost_per_m2_kes", "tiv_kes"] as const;
export type OfferRowField = (typeof OFFER_ROW_FIELDS)[number];

/** Offer-level fields. Sent with row = 0. */
export const OFFER_TERM_FIELDS = [
  "basements",
  "occupancy",
  "flood_deductible_pct",
  "flood_deductible_min_kes",
  "flood_deductible_basis",
  "flood_limit_kes",
  "policy_period",
  "flood_cover",
  "place_name",
  "river_name",
  "river_distance_m",
] as const;
export type OfferTermField = (typeof OFFER_TERM_FIELDS)[number];

/** Every field name the model may reply with: row fields, offer-level fields, then the note kinds (row = 0). */
export const OFFER_FIELDS = [...OFFER_ROW_FIELDS, ...OFFER_TERM_FIELDS, ...NOTE_KINDS] as const;
export type OfferField = (typeof OFFER_FIELDS)[number];

/** Flat field name to the key that holds it on OfferRowValues. */
export const OFFER_ROW_KEYS = {
  name: "name",
  lat: "lat",
  lon: "lon",
  housing_class: "housingClass",
  floor_area_m2: "floorAreaM2",
  cost_per_m2_kes: "costPerM2Kes",
  tiv_kes: "tivKes",
} as const satisfies Record<OfferRowField, keyof OfferRowValues>;

/** Flat field name to the key that holds it on OfferTerms. */
export const OFFER_TERM_KEYS = {
  basements: "basements",
  occupancy: "occupancy",
  flood_deductible_pct: "floodDeductiblePct",
  flood_deductible_min_kes: "floodDeductibleMinKes",
  flood_deductible_basis: "floodDeductibleBasis",
  flood_limit_kes: "floodLimitKes",
  policy_period: "policyPeriod",
  flood_cover: "floodCover",
  place_name: "placeName",
  river_name: "riverName",
  river_distance_m: "riverDistanceM",
} as const satisfies Record<OfferTermField, keyof OfferTerms>;

/**
 * One entry of the reply. The list is flat, like the parameter list in agents/responseSchema.ts,
 * because a nested shape stalled one provider.
 *
 * The value is always text, so one entry shape serves every field:
 *   numbers       plain digits with a dot for decimals, in the base unit, with no separators,
 *                 units or scale words: "4250000000", "48500", "1800", "5", "-1.2921"
 *   lat and lon   decimal degrees, south and west negative
 *   housing_class one of HOUSING_CLASSES
 *   occupancy, flood_cover, flood_deductible_basis: one of their lists above
 *   text fields and notes: a short phrase
 * A field the document does not state is left out. It is never guessed and never sent empty.
 */
export interface OfferFlatEntry {
  field: OfferField;
  /** The building's number, counted from 1, for a row field. 0 for offer-level fields and notes. */
  row: number;
  value: string;
  /** The exact sentence or line the value came from, copied from the document. */
  quote: string;
}

/** The whole reply. A row field repeated for the same row keeps its last entry; notes may repeat and all are kept. */
export interface OfferFlatReply {
  entries: OfferFlatEntry[];
}

// ---------------------------------------------------------------------------------------------
// 3. Coordinates as read
// ---------------------------------------------------------------------------------------------

/**
 * How the direction of one coordinate was decided.
 *   hemisphere     from the letter alone: "1.2921°S"
 *   sign           from the sign alone: "-1.2921"
 *   both_agree     a minus sign and a letter that say the same thing: "-1.2921°S" is south
 *   both_conflict  a minus sign with N or E: "-1.2921°N". The letter is used and the value is not trusted.
 */
export type CoordinateHow = "hemisphere" | "sign" | "both_agree" | "both_conflict";

/** One latitude and longitude pair found in a piece of text. */
export interface CoordinateReading {
  /** Decimal degrees, south negative. The hemisphere letter decides the sign whenever one is written. */
  lat: number;
  /** Decimal degrees, west negative. */
  lon: number;
  latHow: CoordinateHow;
  lonHow: CoordinateHow;
  /** The matched text exactly as written, for example "-1.2921°S, 36.8219°E". */
  raw: string;
  /** True when either coordinate carried both a minus sign and a hemisphere letter. Flagged on screen. */
  writtenBothWays: boolean;
  /** True when either coordinate is "both_conflict". verifyExtraction then marks lat and lon unverified. */
  conflict: boolean;
}

// ---------------------------------------------------------------------------------------------
// 4. The located offer
// ---------------------------------------------------------------------------------------------

/** Where one row is taken to be. */
export type OfferLocation =
  | {
      kind: "exact";
      lat: number;
      lon: number;
      /** How the document's coordinates were read. null when the underwriter typed them. */
      reading: CoordinateReading | null;
    }
  | {
      /** No usable coordinates: a point standing in for a named place. Labelled "approximate" on screen. */
      kind: "approximate";
      lat: number;
      lon: number;
      /** "ward" is the centroid of the ward; "hotspot" is the point of a named flood area in the dataset. */
      source: "ward" | "hotspot";
      /** The ward or hotspot name that matched. */
      matchedName: string;
      /** The place name as the document gave it. */
      placeName: string;
    }
  | {
      kind: "none";
      /** Plain words: no coordinates and no place name, the place is not known, or the point is outside Kenya. */
      reason: string;
    };

/** A named point returned by locateByName. */
export interface PlaceMatch {
  lat: number;
  lon: number;
  source: "ward" | "hotspot";
  matchedName: string;
}

/** The ward a point falls in. */
export interface WardMatch {
  /** Index into the ward collection. */
  index: number;
  name: string;
  subcounty: string;
}

/** The distance from a point to a named river in the open waterways layer. */
export interface RiverMatch {
  distanceM: number;
  /** The river's name as the layer spells it. */
  matchedName: string;
}

// ---------------------------------------------------------------------------------------------
// 5. Policy terms as numbers
// ---------------------------------------------------------------------------------------------

/** Where a term came from: the offer itself, or the example terms of the Insurance terms panel. */
export type TermSource = "document" | "example";

/** The panel's policy terms, used for whatever the document does not state. */
export type PolicyDefaults = Pick<InsuranceTerms, "deductibleShare" | "deductibleMinKes" | "limitShare">;

/**
 * The deductible and the limit in force for one offer, ready for the maths, each with where it came from.
 *
 * From the document ("document" also covers a figure the underwriter typed into the offer's own box):
 *   deductible = the greater of (pct / 100 × base) and minKes, never more than the loss
 *   limit      = kes, the most paid for one flood
 * where base is the ground-up loss ("percent_of_loss", the default reading) or the insured value
 * ("percent_of_sum_insured", only when the text says so). These apply once per flood to the whole
 * offer, and the result is shared between its buildings in proportion.
 *
 * Example terms, when the document states none: policyLoss in model/terms.ts, building by building,
 * exactly as the portfolio is treated.
 *   deductible = the greater of (share × insured value) and minKes, never more than the loss
 *   limit      = share × insured value
 *
 * Either way: gross loss = the lesser of the limit and (ground-up loss less the deductible).
 */
export interface PolicyTerms {
  deductible:
    | {
        source: "document";
        /** 5 means 5%. null when no percentage is stated. */
        pct: number | null;
        /** null when no amount is stated. With no percentage, this is a flat deductible. */
        minKes: number | null;
        basis: DeductibleBasis;
      }
    | {
        source: "example";
        /** A share of each building's insured value: 0.02 is 2%. */
        share: number;
        minKes: number;
      };
  limit:
    | { source: "document"; kes: number }
    | {
        source: "example";
        /** A share of each building's insured value: 1 is 100%. */
        share: number;
      };
}

// ---------------------------------------------------------------------------------------------
// 6. Pricing
// ---------------------------------------------------------------------------------------------

/** Shown, word for word, wherever a point is outside the loaded maps. */
export const OUTSIDE_MAPS_MESSAGE = "Outside the hazard maps loaded: flood cannot be priced here";

/** One building as it goes into the engine: usable values only, as plain numbers, with its location resolved. */
export interface PricingRow {
  /** Position in OfferExtraction.rows, from 0. */
  index: number;
  /** "OFFER-1", "OFFER-2" and so on. Used as the loc_id in the engine and in the CSV. */
  locId: string;
  /** The stated name, or "Building 1" and so on when none is usable. */
  name: string;
  path: ExtractionPath;
  location: OfferLocation;
  /** null when no usable class is stated. Never defaulted: the underwriter picks one. */
  housingClass: HousingClass | null;
  floorAreaM2: number | null;
  costPerM2Kes: number | null;
  /** The stated insured value, or floor area × cost per m² when it is not stated and both of those are usable. */
  tivKes: number | null;
  /** Where tivKes came from. null when there is none. */
  tivFrom: "stated" | "area_times_cost" | null;
  /**
   * Plain-word reasons the row cannot be priced yet: no location, no housing class, no insured value,
   * or a value that feeds the price and is still unverified (see waitingValues).
   * Empty when it is ready. A row with a location but no insured value still gets the inside-or-outside
   * answer; it is only the loss figures that need all three.
   */
  blockers: string[];
}

/** One scenario of the run, most frequent first, as in ModelResult.scenarios. */
export interface OfferScenario {
  id: string;
  label: string;
  returnPeriod: number;
}

/** One building in one scenario. */
export interface RowScenario extends OfferScenario {
  /** The raw value of the hazard map at the point: a 0 to 1 score, or a depth in metres. */
  hazard: number;
  /** Depth from the terrain map alone. */
  terrainM: number;
  /** Drainage ponding at the point. 0 when drainage is off or the point is outside its reach. */
  drainageM: number;
  /** The depth the damage curve was read at: the deeper of the two above. */
  depthM: number;
  damageRatio: number;
  groundUpKes: number;
  /**
   * The gross loss: ground-up less the deductible, capped at the limit. This building's part of
   * grossLosses for the event. With one building it is simply grossLoss(groundUpKes).
   */
  grossKes: number;
  /**
   * Distance in metres to the nearest wet cell of this scenario's terrain map, given when the
   * point's own cell is dry there. null when the point is wet in this map, or the map has no wet cell.
   */
  nearestWetM: number | null;
}

/** The result for one row. Only "priced" carries loss figures, so a zero can never be shown for a point that was not priced. */
export type RowPricing =
  | {
      status: "priced";
      locId: string;
      name: string;
      location: OfferLocation;
      housingClass: HousingClass;
      tivKes: number;
      /** PricingRow.tivFrom, never null here. */
      tivFrom: "stated" | "area_times_cost";
      /** The ward the point falls in. null when it is outside the ward map or the map is not loaded. */
      ward: WardMatch | null;
      /** In the order of OfferPricing.scenarios. */
      scenarios: RowScenario[];
      /** True when the terrain map is dry at the point in every scenario. */
      dryInEveryTier: boolean;
      aalGroundUpKes: number;
      aalGrossKes: number;
      /** Pure flood rate: average annual loss ÷ insured value × 1000. Before expense, profit and uncertainty loadings. */
      ratePerMilleGroundUp: number;
      ratePerMilleGross: number;
    }
  | {
      /** The point is not inside every loaded hazard map, or no maps are loaded. No loss fields at all. */
      status: "outside";
      locId: string;
      name: string;
      location: OfferLocation;
      message: typeof OUTSIDE_MAPS_MESSAGE;
    }
  | {
      /** The point is inside the maps, or has no location, but something needed for a loss is missing. No loss fields. */
      status: "not_ready";
      locId: string;
      name: string;
      location: OfferLocation;
      /** PricingRow.blockers, never empty here. */
      blockers: string[];
    };

/** The priced rows added together. */
export interface OfferTotals {
  rows: number;
  tivKes: number;
  /** In the order of OfferPricing.scenarios. Each figure is the sum over the priced rows. */
  scenarios: (OfferScenario & { groundUpKes: number; grossKes: number })[];
  aalGroundUpKes: number;
  aalGrossKes: number;
  ratePerMilleGroundUp: number;
  ratePerMilleGross: number;
}

/** The loaded portfolio's own figures, ground-up: before any deductible, limit or reinsurance. */
export interface PortfolioFigures {
  buildings: number;
  totalTivKes: number;
  /** The 1-in-100 loss read off the curve. null when 100 years is more frequent than anything modelled. */
  loss100Kes: number | null;
  /** True when the 1-in-100 loss is held flat beyond the rarest modelled scenario. */
  loss100Extrapolated: boolean;
  aalKes: number;
}

/** The portfolio with and without the priced rows of the offer. One per offer, not per row. */
export interface PortfolioEffect {
  without: PortfolioFigures;
  with: PortfolioFigures;
}

/** Everything priceOffer returns. */
export interface OfferPricing {
  /** Most frequent first. Present even when no row could be priced. */
  scenarios: OfferScenario[];
  /** One per PricingRow, in the same order. */
  rows: RowPricing[];
  /** null when no row was priced. */
  totals: OfferTotals | null;
  /** null when no row was priced. */
  portfolio: PortfolioEffect | null;
  /** The terms the gross figures were worked out with, and where each came from. */
  terms: PolicyTerms;
  /** True when drainage ponding was part of the run. */
  drainageOn: boolean;
}

/** What priceOffer needs. */
export interface PriceOfferInput {
  /**
   * The loaded dataset. Its hazard maps are sampled for the new rows; its buildings are the
   * portfolio. Any drainage already on it is ignored: the drainage field below alone decides.
   */
  dataset: Dataset;
  /** The assumptions in force: Active.params. */
  params: ModelParams;
  /** The drainage state when drainage is switched on, otherwise null. */
  drainage: DrainageState | null;
  rows: PricingRow[];
  terms: PolicyTerms;
  /** For the ward each row falls in. null when the ward map is not loaded. */
  wards: GeoCollection<WardProps> | null;
}

// ---------------------------------------------------------------------------------------------
// 7. Signatures, by module. Each module exports a function of the stated name and type,
//    for example: export const docxToText: DocxToText = async (data) => { ... }
// ---------------------------------------------------------------------------------------------

// --- docx.ts: docxToText, readOfferFile --------------------------------------------------------

/** An uploaded file. A browser File fits; so does a stand-in built in a test. */
export interface OfferFile {
  name: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The text an offer is read from, however it arrived. */
export interface OfferDocument {
  /** The file name, kept for the CSV's source column. "typed text" for the box on screen. */
  name: string;
  kind: "docx" | "txt" | "typed";
  text: string;
}

/**
 * The text of a Word file, read with JSZip from word/document.xml. One line per paragraph,
 * joined with "\n"; line breaks and tabs inside a paragraph kept; XML entities decoded.
 * Rejects with a plain-words Error when the file is not a Word document.
 */
export type DocxToText = (data: ArrayBuffer | Uint8Array | Blob) => Promise<string>;

/** Reads a .docx or a .txt by its extension. Rejects with a plain-words Error for anything else. */
export type ReadOfferFile = (file: OfferFile) => Promise<OfferDocument>;

// --- redact.ts: redact, describeRemoved --------------------------------------------------------

/** A contact or signature block that was taken out. */
export interface RemovedBlock {
  /** The block's heading as written, or a plain name such as "signature" when it has none. */
  name: string;
  /** How many lines went with it. */
  lines: number;
}

/** The text that may leave the browser, and a count of what was taken out of it. */
export interface Redaction {
  /** Each removal leaves a short marker in square brackets, so the reader can see where something was. */
  text: string;
  removed: {
    emails: number;
    phones: number;
    blocks: RemovedBlock[];
  };
}

/**
 * Removes email addresses, phone numbers, and contact and signature blocks. Must leave
 * coordinates, amounts and dates alone, and must change nothing when run on its own output:
 * the route runs it a second time as a guard.
 */
export type Redact = (text: string) => Redaction;

/**
 * One plain sentence on what was taken out. sent says whether the text then went to the hosted
 * model ("before sending", the default) or was only read in the browser ("before reading").
 */
export type DescribeRemoved = (removed: Redaction["removed"], sent?: boolean) => string;

// --- coords.ts: parseCoordinates, inKenya, describeReading -------------------------------------

/**
 * The first latitude and longitude pair in the text, or null. Reads decimal degrees with or
 * without a degree sign, hemisphere letters, signs, and either order when letters are written.
 */
export type ParseCoordinates = (text: string) => CoordinateReading | null;

/** True when the point is inside a box drawn around Kenya with a small margin. */
export type InKenya = (lat: number, lon: number) => boolean;

/** A reading in words, with how each direction was decided: "1.2921° S (by its letter), 36.8219° E (by its letter)". */
export type DescribeReading = (reading: CoordinateReading) => string;

// --- verify.ts: quoteInDocument, numberInQuote, verifyExtraction, usableValue, waitingValues, statusCounts, editValue, confirmValue ---

/**
 * True when the quote appears in the document once both have every run of spaces, tabs and
 * line breaks turned into one space. Letters and punctuation must match. An empty quote is false.
 */
export type QuoteInDocument = (quote: string, documentText: string) => boolean;

/**
 * True when a number written in the quote equals the value. Thousands separators and the sign
 * are ignored (the hemisphere letter carries a coordinate's sign), a scale word or letter after
 * the number is applied (thousand or k, million or m or mn, billion or b or bn), and a number
 * in km counts as 1000 times as many metres. Equal means equal to the precision written.
 */
export type NumberInQuote = (value: number, quote: string) => boolean;

/**
 * Checks every value and returns a new extraction with status and reason filled in.
 *   - no value and no quote: "missing"
 *   - quote not in the document, or a number not in its quote: "unverified", with the reason
 *   - otherwise "verified"
 *   - "confirmed" and "edited" values are left exactly as they are
 * For coordinates it also runs parseCoordinates on the latitude quote, stores the reading on
 * the row, sets lat and lon from it, and marks both unverified when the reading conflicts,
 * disagrees with the stated numbers, or falls outside Kenya.
 * documentText is the text the extraction was made from: the redacted text, on both paths.
 */
export type VerifyExtraction = (extraction: OfferExtraction, documentText: string) => OfferExtraction;

/** The value when its status is one of USABLE_STATUSES and it is not null, otherwise null. The one rule for "may this be used". */
export type UsableValue = <T>(quoted: Quoted<T>) => T | null;

/** Points at one value in an extraction, for the edit and confirm buttons. */
export type ValueRef =
  | { scope: "row"; row: number; key: keyof OfferRowValues }
  | { scope: "terms"; key: keyof OfferTerms }
  | { scope: "note"; index: number };

/** An unverified value that feeds the price. Pricing waits until it is confirmed, edited or cleared. */
export interface WaitingValue {
  ref: ValueRef;
  /** Plain words for the value, starting with a capital: "Insured value", "Flood deductible". */
  label: string;
  quoted: Quoted<string | number>;
}

/**
 * Every unverified value that the price depends on, in the order shown on screen: a row's
 * coordinates, class and insured value (floor area and cost per m² only when no insured value is
 * usable), the flood deductible and limit, and the place name when a row has no usable coordinates.
 * pricingRows turns each one into a blocker, so nothing is priced around a value that failed its check.
 */
export type WaitingValues = (extraction: OfferExtraction) => WaitingValue[];

/** How many values hold each status: every row field, every offer-level field and every note. */
export type StatusCounts = (extraction: OfferExtraction) => Record<ValueStatus, number>;

/**
 * A new extraction with that value replaced by what the underwriter typed: status "edited",
 * reason null, quote kept. A value of null clears it: status "missing". A typed value that cannot
 * be read for its field returns the extraction it was given, unchanged, so the caller can tell
 * by comparing the two.
 */
export type EditValue = (extraction: OfferExtraction, ref: ValueRef, value: string | number | null) => OfferExtraction;

/** A new extraction with that unverified value accepted as it stands: status "confirmed". Other statuses are left alone. */
export type ConfirmValue = (extraction: OfferExtraction, ref: ValueRef) => OfferExtraction;

// --- extraction.ts: offerReplySchema, OFFER_RESPONSE_SCHEMA, buildOfferPrompt, fromFlatReply ---

/** The Zod schema the route checks the model's reply with. Entries with an unknown field name are dropped, not failed. */
export type OfferReplySchema = z.ZodType<OfferFlatReply>;

/** The reply shape in the form the provider enforces, built like RESPONSE_SCHEMAS in agents/responseSchema.ts. */
export type OfferResponseSchema = Record<string, unknown>;

/** The instructions and the message for one extraction. The document text is expected already redacted. */
export type BuildOfferPrompt = (documentText: string) => { system: string; user: string };

/**
 * The flat reply turned into an extraction: rows numbered from 1 become rows in order, every row
 * has path "model", number text is parsed, and anything not stated is "missing". Statuses are
 * provisional until verifyExtraction runs. Text that should be a number or a listed word but
 * is not keeps its quote with a null value, "unverified", and a reason.
 */
export type FromFlatReply = (reply: OfferFlatReply) => OfferExtraction;

// --- rules.ts: extractByRules ------------------------------------------------------------------

/**
 * The rules-only reading, for when no key is set or the call fails. Looks for the labelled lines
 * (GPS COORDINATES:, GROSS FLOOR AREA:, CONSTRUCTION CLASSIFICATION:, a TIV in KES), the plain
 * deductible and limit phrases, and words that name a housing class. Every row has path "rules".
 * knownPlaces are the ward and hotspot names: one found in the text becomes the place name, which
 * is how a typed sentence with no coordinates gets a location. Statuses are provisional until
 * verifyExtraction runs. A text with nothing recognisable still returns one row of missing values.
 */
export type ExtractByRules = (documentText: string, knownPlaces?: readonly string[]) => OfferExtraction;

// --- route.ts (src/app/api/offer/extract): POST ------------------------------------------------

/** The longest text the route accepts, in characters. A long memo is about 30,000. */
export const OFFER_MAX_CHARS = 120_000;

/** The request body. The text is redacted by the browser before it is posted. */
export interface OfferExtractRequest {
  text: string;
}

/**
 * Why the route returned no extraction, and the status it answers with.
 *   no_key       503  no key is set for the hosted model; nothing was sent
 *   bad_request  400  no text, or too much of it; nothing was sent
 *   provider     502  the call to the model failed
 *   bad_reply    422  the model answered twice in the wrong shape
 */
export type OfferExtractFailure = "no_key" | "bad_request" | "provider" | "bad_reply";

/**
 * The response body. The route runs redact once more, calls generateJson with keyFor("chair"),
 * and never logs document text: the provider's own log line carries token counts only.
 */
export type OfferExtractResponse =
  | {
      ok: true;
      model: string;
      ms: number;
      /** 1, or 2 when the first reply was rejected and the model was asked again. */
      attempts: number;
      usage: Usage;
      /** The instructions and the message exactly as sent. */
      prompt: { system: string; user: string };
      /** The document text exactly as sent, after the route's own redaction. Quotes are checked against this. */
      documentText: string;
      reply: OfferFlatReply;
    }
  | {
      ok: false;
      code: OfferExtractFailure;
      /** Plain words, safe to show. Never contains document text. */
      error: string;
      model?: string;
      ms?: number;
    };

// --- client.ts: extractOffer -------------------------------------------------------------------

export interface ExtractOptions {
  /** Skip the hosted model: nothing leaves the browser. */
  rulesOnly?: boolean;
  /** Ward and hotspot names, handed to the rules so they can spot a place in free text. */
  knownPlaces?: readonly string[];
  signal?: AbortSignal;
}

/** One extraction, with the record of how it was made. */
export interface ExtractionRun {
  /** Already through verifyExtraction. */
  extraction: OfferExtraction;
  /** The redacted text: what was sent on the model path, and what the quotes were checked against on both. */
  documentText: string;
  removed: Redaction["removed"];
  /** The path that produced the rows. */
  path: ExtractionPath;
  /** Why the rules were used, in plain words. null on the model path. */
  fallbackReason: string | null;
  /**
   * False only when it is known that no call to the hosted model was made: rules only was chosen,
   * or the route answered no_key or bad_request. True otherwise, even when the reply was unusable.
   */
  sentToModel: boolean;
  /** The exact instructions and message sent. null when the route did not report them. */
  prompt: { system: string; user: string } | null;
  model: string | null;
  usage: Usage | null;
  ms: number | null;
}

/**
 * What the screen calls. Redacts, posts to /api/offer/extract, turns the reply into an extraction,
 * and falls back to extractByRules on the redacted text when there is no key or the call fails.
 * Runs verifyExtraction either way. Never rejects: every failure ends on the rules path.
 */
export type ExtractOffer = (text: string, options?: ExtractOptions) => Promise<ExtractionRun>;

// --- locate.ts: locateByName, wardOf, riverDistanceM, nearestWetCellM --------------------------

/**
 * A place name matched against the ward names, then the hotspot names, ignoring case and
 * punctuation. Returns the ward's centroid or the hotspot's point, or null when nothing matches.
 */
export type LocateByName = (name: string, wards: GeoCollection<WardProps> | null, hotspots: readonly Hotspot[]) => PlaceMatch | null;

/** The ward that contains the point, or null. */
export type WardOf = (point: { lat: number; lon: number }, wards: GeoCollection<WardProps> | null) => WardMatch | null;

/**
 * Metres from the point to the nearest stretch of the named river in the waterways layer.
 * Names are matched loosely ("Nairobi River", "Nairobi river" and "River Nairobi" are one river).
 * null when the layer is missing or has no river of that name.
 */
export type RiverDistanceM = (point: { lat: number; lon: number }, riverName: string, waterways: GeoCollection<WaterwayProps> | null) => RiverMatch | null;

/**
 * Metres from the point to the centre of the nearest cell with a hazard value above zero.
 * 0 when the point's own cell is wet. null when the point is outside the map or the map has no wet cell.
 */
export type NearestWetCellM = (raster: Raster, lon: number, lat: number, kind: HazardKind) => number | null;

// --- terms.ts: grossLosses, grossLoss, policyTerms, describeTerms ------------------------------

/**
 * One flood, every building of the offer: the gross loss of each, by the formulas on PolicyTerms.
 * The two lists run in the same order. Never below 0 and never above the building's ground-up loss.
 * With example terms for both the deductible and the limit, each figure is policyLoss(...).grossKes.
 */
export type GrossLosses = (groundUpKes: readonly number[], tivKes: readonly number[], terms: PolicyTerms) => number[];

/** grossLosses for an offer of one building. */
export type GrossLoss = (groundUpKes: number, terms: PolicyTerms, tivKes: number) => number;

/**
 * The terms in force. A usable stated deductible (a percentage, an amount, or both) is taken
 * from the document, otherwise the panel's deductible is used; the same for the limit. Anything
 * unverified counts as not stated here, and waitingValues holds the price back until it is settled.
 */
export type PolicyTermsOf = (terms: OfferTerms, defaults: PolicyDefaults) => PolicyTerms;

/** One plain sentence each on the deductible and the limit in force, for the screen. */
export type DescribeTerms = (terms: PolicyTerms) => { deductible: string; limit: string };

// --- price.ts: pricingRows, priceOffer ---------------------------------------------------------

/**
 * The extraction as engine-ready rows. Uses usableValue for every value. A row's location is its
 * own coordinates when both are usable and inside Kenya; otherwise the offer's place name through
 * locateByName; otherwise "none". Coordinates that are stated but unverified give "none", not the
 * place name: the underwriter settles them first. Every waitingValues entry for the row or the
 * offer is a blocker. Code only.
 */
export type PricingRows = (extraction: OfferExtraction, wards: GeoCollection<WardProps> | null, hotspots: readonly Hotspot[]) => PricingRow[];

/**
 * Prices the rows. Samples every hazard map with sampleRaster, adds the ready rows to the
 * dataset's buildings, applies withDrainage when a drainage state is given, and runs runModel
 * with the given assumptions, once with the offer and once without. A row outside any map is
 * "outside" and takes no part. Code only: nothing here reaches a model.
 */
export type PriceOffer = (input: PriceOfferInput) => OfferPricing;

// --- checks.ts: offerChecks --------------------------------------------------------------------

/**
 * The checks shown with an offer. Row-level checks give one Check per row, with the id
 * "<check id>:<locId>"; the rest give one per offer.
 *   offer-values         per offer  how many values are verified, unverified, confirmed, edited
 *   offer-coordinates    per row    inside the maps or not, and how the location was read
 *   offer-river          per row    stated river distance against the distance on the map
 *   offer-value-per-m2   per row    insured value ÷ floor area against the dataset's range for the class
 *   offer-basements      per offer  basements present: water entering them is not modelled
 *   offer-flood-history  per row    past flood reported but dry in every tier, or the reverse
 *   offer-curve          per offer  a non-residential building on the residential damage curve
 * They use the existing check groups: "ai" for offer-values, "data" for offer-coordinates and
 * offer-value-per-m2, "hazard" for offer-river, offer-basements and offer-flood-history, and
 * "vulnerability" for offer-curve. A stated limit of the model is a "warn", never a "fail".
 */
export const OFFER_CHECK_IDS = ["offer-values", "offer-coordinates", "offer-river", "offer-value-per-m2", "offer-basements", "offer-flood-history", "offer-curve"] as const;
export type OfferCheckId = (typeof OFFER_CHECK_IDS)[number];

export interface OfferChecksInput {
  extraction: OfferExtraction;
  rows: PricingRow[];
  pricing: OfferPricing;
  /** For the range of cost per m² by housing class. */
  dataset: Dataset;
  /** null when the waterways layer is not loaded; the river check then says so. */
  waterways: GeoCollection<WaterwayProps> | null;
}

/** Worded like the checks in lib/checks: a title that states what should hold, and a detail with the figures. */
export type OfferChecks = (input: OfferChecksInput) => Check[];

// --- csv.ts: offerCsv --------------------------------------------------------------------------

/** The exposure file's columns, then where the row came from. */
export const OFFER_CSV_COLUMNS = ["loc_id", "lat", "lon", "housing_class", "floor_area_m2", "cost_per_m2_kes", "tiv_kes", "synthetic", "source"] as const;

/**
 * Every row as CSV text with a header line. synthetic is "false" and source is
 * "offer:<file name>". A value that is not known is left blank, so no row silently disappears.
 */
export type OfferCsv = (rows: PricingRow[], fileName: string) => string;
