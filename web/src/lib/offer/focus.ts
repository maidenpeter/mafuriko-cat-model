import { BRIEF_MAX_QUOTES, BRIEF_QUOTE_MAX_CHARS, type OfferBrief } from "../agents/offerBrief";
import type { Deliberation } from "../agents/orchestrate";
import type { Usage } from "../agents/provider";
import type { Check } from "../checks";
import {
  DEDUCTIBLE_LOSS_SHARE,
  flagsFromChecks,
  NEAR_WET_CELL_M,
  SUBLIMIT_LOSS_SHARE,
  suggestedConditions,
  type CheckInput,
  type Flag,
  type FlagEvidence,
  type OfferFacts,
  type Severity,
  type SuggestedCondition,
} from "../decision";
import { fmtInt, fmtNum, fmtPct } from "../format";
import { DRAIN_KINDS, DRAINAGE_DEFAULTS, sampleGrid } from "../geo/drainage";
import { withDrainage, type DrainageState } from "../geo/drainageView";
import type { GeoCollection, WardProps, WaterwayProps } from "../geo/layers";
import { assignPoints } from "../geo/spatial";
import { kes1, rpLabel } from "../labels";
import { averageAnnualLoss, lossAtReturnPeriod, STANDARD_RETURN_PERIODS, type CurvePoint } from "../model/financial";
import { tierSlopes } from "../model/hazard";
import { REFERENCE_PARAMS } from "../model/params";
import { hazardToDepth, scenarioReturnPeriods } from "../model/pipeline";
import type { TermsResult } from "../model/terms";
import { HOUSING_LABELS, type Building, type Dataset, type HazardKind, type HousingClass, type ModelParams, type ModelResult, type ScoreTier } from "../model/types";
import { damageDetail } from "../model/vulnerability";
import { offerChecks } from "./checks";
import { describeReading } from "./coords";
import { NOTE_LABELS } from "./extraction";
import { fieldLabel, fieldText, ROW_FIELDS, TERM_FIELDS, type FieldDef } from "./fields";
import { enforceJudgement, JUDGEMENT_KEYS, REFERENCE_JUDGEMENT, type OfferJudgement } from "./judgement";
import { nearestWaterway, riverDistanceM, wardOf, type WaterwayMatch } from "./locate";
import { priceOffer, pricingRows } from "./price";
import { describeRemoved } from "./redact";
import { fmtDistance, fmtPoint, plural } from "./shared";
import { floodFactsOf, statedFloodHistory, technicalPrice, usableNotes, wetShareAround, type FloodFacts, type StatedFloodHistory, type TechnicalBuilding, type TechnicalPrice } from "./technical";
import { describeTerms, policyTerms, termsSplit } from "./terms";
import {
  OUTSIDE_MAPS_MESSAGE,
  type ExtractionPath,
  type FloodCover,
  type OfferDocument,
  type OfferExtraction,
  type OfferLocation,
  type OfferPricing,
  type OfferScenario,
  type OfferState,
  type OfferTerms,
  type PolicyDefaults,
  type PolicyTerms,
  type PortfolioFigures,
  type PricingRow,
  type Quoted,
  type Redaction,
  type RiverMatch,
  type RowPricing,
  type ValueRef,
  type ValueStatus,
  type WardMatch,
} from "./types";
import { statusCounts, usableValue, waitingValues } from "./verify";

/**
 * One picture of the offer, worked out once, that every step of the walkthrough reads.
 *
 * The walkthrough keeps the offer as the underwriter left it (OfferState). buildOfferFocus turns
 * that, the loaded model and the assumptions in force into an OfferFocus: who and where the building
 * is, what the document says and how it was read, the flood depth, damage and loss at the building
 * for every return period, what the terms take off, what the offer adds to the portfolio, the
 * price under each set of assumptions, the checks, and the points an underwriter should weigh.
 *
 * How to use it:
 *
 *   const focus = useMemo(() => buildOfferFocus({ offer, session: view, active, drainage, policyDefaults: terms,
 *     portfolioTerms: termsResult, deliberation: viewDeliberation, layers }), [...]);
 *
 *   focus === null            no offer has been read
 *   focus.status              "locating" | "waiting" | "outside" | "not_ready" | "priced"
 *   isPriced(focus)           true when every loss figure is there: focus.price, focus.building and focus.site are set
 *   focus.outside             true with focus.outsideMessage when the building lies outside the hazard maps: no loss fields
 *   focus.waiting             the values that hold pricing up, each as a sentence
 *
 * The price is the technical price (technical.ts, method at the top of judgement.ts): the flood
 * maps read around the site, the document's story as loadings, its own loss history and a minimum
 * rate. A reading at the stated point alone can be zero for a building that plainly can flood, so
 * it is kept as one line of evidence and is never the price by itself.
 *
 *   focus.technical           the whole build-up, line by line: null unless the offer is priced
 *   focus.judgement           the five judgement figures in force, and whose they are
 *   focus.price.total         the headline figures: the INDICATED average annual loss and pure rate,
 *                             and the loaded loss at each return period
 *   focus.price.atPoint       the same figures at the stated point alone, as the engine gives them
 *   focus.price.building      the followed building at the stated point: depth, damage and loss per return period
 *
 * Words: "indicated" for the technical price's result; "at the stated point" for the single-cell reading.
 *
 * Every step of the walkthrough receives these props:
 *   focus        PricedFocus | null     the priced offer while the header switch is on "Offer", otherwise null
 *   offerFocus   OfferFocus | null      the offer whatever the switch says and whether or not it is priced
 *   judgement    FocusJudgement | null  offerFocus.judgement, or null when no offer has been read
 *   onJudgement  (next) => void         types over any of the five judgement figures: see OfferFocusProps
 * A step that shows "This offer" reads `focus`; a step in Portfolio mode can show a small card from `offerFocus`.
 *
 * Code only. Nothing here reaches a model, and no loss figure comes from one: a language model
 * reads the document and chooses assumptions; code checks, locates, prices and reconciles.
 *
 * Loss words, the same as everywhere else:
 *   ground-up  the damage before any insurance terms
 *   gross      after the policy deductible and limit
 *   net        after reinsurance: a portfolio figure, never worked out for one offer
 *
 * Units as in types.ts: KES, metres, m², decimal degrees, damage ratios as fractions, return periods in years.
 * null always means "not known" or "the document does not say", never zero.
 */

// ---------------------------------------------------------------------------------------------
// Stated thresholds. Every one is an assumption of this app, listed here so it can be quoted.
// ---------------------------------------------------------------------------------------------

/** Water at the building in a flood this frequent (years) or more frequent is flagged "high"; rarer water is "medium". */
export const FREQUENT_FLOOD_RP = 25;
/** The offer adding this share or more to the portfolio's 1-in-100 ground-up loss is flagged "medium". */
export const ACCUMULATION_MEDIUM_SHARE = 0.01;
/** The same, flagged "high". */
export const ACCUMULATION_HIGH_SHARE = 0.05;
/** One offer holding this share or more of the portfolio's insured value (the offer included) is flagged "medium". */
export const CONCENTRATION_MEDIUM_SHARE = 0.05;
/** The same, flagged "high". */
export const CONCENTRATION_HIGH_SHARE = 0.1;
/** The Cautious price at this many times the Optimist's or more is flagged: the answer rests on the assumptions. */
export const ASSUMPTION_SPREAD_RATIO = 2;
/** Insured buildings of the portfolio within this many metres of the site count as its neighbours. */
export const NEIGHBOUR_RADIUS_M = 1000;
/** The distances, in metres, at which the share of wet ground around the site is reported. */
export const WET_SHARE_RADII_M = [100, 250, 500] as const;

// ---------------------------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------------------------

/** Where a value shown to the underwriter came from, in the words of the table of fields. */
export type FieldOrigin = "AI, verified" | "AI, unverified" | "rules" | "confirmed" | "edited" | "not stated";

/** The mark a quote carries in the document panel. The same five words as DocumentQuotes' QuoteStatus. */
export type QuoteMark = "verified" | "unverified" | "rules" | "confirmed" | "edited";

/** One value read from the document, flat, ready for a table row and for DocumentQuotes. */
export interface FocusField {
  /** Stable id: "row:0:tivKes", "terms:floodLimitKes", "note:2". Use it as the quote id and the row key. */
  id: string;
  /** Points at the value in the extraction, for editValue and confirmValue. */
  ref: ValueRef;
  /** Which part of the offer it belongs to: a building's row, the flood terms, the site facts, or a flood note. */
  group: "building" | "terms" | "site" | "note";
  /** The building's place in the extraction, from 0, for a building's value. null for everything else. */
  row: number | null;
  /** Plain name of the value: "Insured value", "Flood deductible", "Past flood or water damage reported". */
  label: string;
  /** The value as text with its unit: "KES 4,250,000,000", "Concrete / RCC", "1.8 km". "" when there is none. */
  value: string;
  /** The value as held: a number, a word from a fixed list, free text, or null. */
  raw: string | number | null;
  /** The sentence of the document the value rests on. "" when there is none. */
  quote: string;
  /** Where the value came from, for the table. */
  origin: FieldOrigin;
  /** The mark for DocumentQuotes: an unverified value is "unverified" whichever path read it. null when not stated. */
  mark: QuoteMark | null;
  /** What code decided about the value. */
  status: ValueStatus;
  /** Why the check failed, when the status is "unverified". Otherwise null. */
  reason: string | null;
  /** True when the price waits for this value: it is unverified and feeds the price. */
  holdsPricing: boolean;
}

/** The offer in one line. Each part is null when the document does not state it. */
export interface OfferLine {
  /** The insured or the building name as stated. null when no name could be used. */
  insured: string | null;
  /** Where it is, in words: the stated place and the ward it falls in, or the coordinates. null when not located. */
  location: string | null;
  /** The sum insured of every building of the offer that has one, added up. null when none has. */
  sumInsuredKes: number | null;
  /** "Flood covered" or "Flood excluded", as the document asks. null when it does not say. */
  cover: string | null;
  /** The policy period in the document's own words. null when not stated. */
  period: string | null;
  /** The parts that are stated, joined into one line for a heading. */
  text: string;
}

/** The document and the record of how it was read. */
export interface FocusDocument {
  /** The file name, or "typed text". */
  name: string;
  /** How the document arrived. */
  kind: OfferDocument["kind"];
  /** The text every quote was checked against: the document with contact details removed. Show this in DocumentQuotes. */
  text: string;
  /** True unless it is known that nothing was sent to the hosted model. */
  sentToModel: boolean;
  /** The instructions and the message exactly as sent. null when nothing was sent or the server did not report them. */
  sent: { system: string; user: string } | null;
  /** What was taken out before the text was read or sent: counts and block names, never the text itself. */
  removed: Redaction["removed"];
  /** The same as one sentence, ready to show. */
  removedLine: string;
  /** Which path produced the rows: the hosted model, or the fixed rules. */
  path: ExtractionPath;
  /** Why that path read it, in plain words. */
  why: string;
  /** The model that was called. null when none was. */
  model: string | null;
  /** How long the call took, in milliseconds. null when there was no call. */
  ms: number | null;
  /** The tokens the call used. null when not reported. Feed it to usageRows in lib/agents/usage.ts as one more run. */
  usage: Usage | null;
  /** The model's reply as JSON text, as the server handed it back. null when there was none. */
  replyJson: string | null;
}

/** One insured building of the offer. */
export interface FocusBuilding {
  /** Its place in the extraction, from 0. */
  index: number;
  /** "OFFER-1" and so on: the loc_id used in the engine and in the CSV. */
  locId: string;
  /** The stated name, or "Building 1" when none is usable. */
  name: string;
  /** What pricing made of it. Only "priced" has loss figures. */
  status: "priced" | "outside" | "not_ready";
  /** Why it is not priced yet, in plain words. Empty when it is priced or outside. */
  blockers: string[];
  /** Where it is taken to be, as locate and price worked it out. */
  location: OfferLocation;
  /** Latitude in decimal degrees, south negative. null when it has no location. */
  lat: number | null;
  /** Longitude in decimal degrees, west negative. null when it has no location. */
  lon: number | null;
  /** True when a named place stands in for coordinates the document does not give. */
  approximate: boolean;
  /** How the coordinates were read, in one sentence. */
  locationHow: string;
  /** What stands in for the coordinates when the location is approximate: "the centre of Kilimani ward". null otherwise. */
  standIn: string | null;
  /** The ward the point falls in. null when it is outside the ward map, not located, or the map is not loaded. */
  ward: WardMatch | null;
  /** The construction class whose damage curve is used. null when none is usable. */
  housingClass: HousingClass | null;
  /** The class in words: "Concrete / RCC". null when there is none. */
  housingLabel: string | null;
  /** Floor area in m². null when not usable. */
  floorAreaM2: number | null;
  /** Rebuilding cost per m² as stated. null when not usable. */
  costPerM2Kes: number | null;
  /** The insured value. null when there is none. */
  tivKes: number | null;
  /** Whether the insured value is stated, or worked out as floor area × cost per m². null when there is none. */
  tivFrom: "stated" | "area_times_cost" | null;
  /** Insured value ÷ floor area, or the stated cost per m² when either is missing. null when neither can be had. */
  valuePerM2Kes: number | null;
}

/** A value pricing waits for, in words. */
export interface FocusWaiting {
  /** Points at the value, for the Confirm and Clear buttons. */
  ref: ValueRef;
  /** The id of the matching FocusField. */
  fieldId: string;
  /** "Building 1" or "Offer". */
  where: string;
  /** "Insured value", "Flood deductible". */
  label: string;
  /** The value as read, in words. "nothing readable" when it could not be read at all. */
  value: string;
  /** Which check failed. */
  reason: string;
  /** The whole thing as one sentence. */
  text: string;
}

/** One return period at the building, from the hazard map to the gross loss. */
export interface FocusReturnPeriod {
  /** The scenario's id in the dataset: a tier name ("common") or a return period tag ("rp100y"). */
  id: string;
  /** The scenario's label in the dataset. */
  label: string;
  /** Return period in years, under the assumptions in force. */
  returnPeriod: number;
  /** The raw value of the hazard map at the point: a 0 to 1 score, or a depth in metres. */
  hazard: number;
  /** Depth from the terrain map alone, in metres. */
  terrainM: number;
  /** Drainage ponding at the point, in metres. 0 when drainage is off or the point is outside its reach. */
  drainageM: number;
  /** The depth the damage curve was read at: the deeper of the two above. */
  depthM: number;
  /** Which of the two gave the depth used. "dry" when both are zero. */
  depthFrom: "terrain" | "drainage" | "dry";
  /** The depth on the curve after the class's fragility multiplier: depth × fragility. */
  effectiveDepthM: number;
  /** The damage the curve gives at that depth, before the class's cap. */
  curveDamage: number;
  /** The damage ratio used: the curve's damage, or the cap where that is lower. */
  damageRatio: number;
  /** True when the cap, not the curve, set the damage ratio. */
  capped: boolean;
  /** Ground-up loss: damage ratio × insured value. */
  groundUpKes: number;
  /** The part of the loss the policyholder keeps under the deductible. */
  deductibleKes: number;
  /** The part of the loss above the limit. */
  overLimitKes: number;
  /** Gross loss: ground-up less the deductible, capped at the limit. */
  grossKes: number;
  /** Metres to the nearest wet cell of this return period's terrain map when the point is dry there. null when it is wet, or the map has no wet cell. */
  nearestWetM: number | null;
}

/**
 * A loss curve and the figures read off it: for the building, or for the whole offer.
 *
 * In FocusPrice.total the curve is the LOADED loss per return period and the average annual loss
 * and the rates are the INDICATED ones. Those can be set by the document's loss history or by the
 * minimum rate, which are yearly figures with no return period, so they need not equal the area
 * under `curve`: OfferFocus.technical.buildUp shows every line between the two.
 * In FocusPrice.atPoint and FocusPrice.building everything is the reading at the stated point.
 */
export interface LossFigures {
  /** The insured value the losses and rates are measured against. */
  tivKes: number;
  /** One point per modelled return period, most frequent first. */
  curve: (OfferScenario & { groundUpKes: number; grossKes: number })[];
  /** The curve read at 10, 25, 50, 100 and 250 years, interpolated the way the portfolio's standard losses are. null where the return period is more frequent than anything modelled. */
  standard: { returnPeriod: number; groundUpKes: number | null; grossKes: number | null; extrapolated: boolean }[];
  /** Average annual loss before any terms. In FocusPrice.total: the indicated average annual loss, ground-up. */
  aalGroundUpKes: number;
  /** Average annual loss after the deductible and the limit. In FocusPrice.total: the indicated average annual loss, gross. */
  aalGrossKes: number;
  /** Pure flood rate, ground-up: average annual loss ÷ insured value × 1000. Before expense, profit and uncertainty loadings. */
  ratePerMilleGroundUp: number;
  /** Pure flood rate, gross. */
  ratePerMilleGross: number;
  /** Ground-up loss in a 1-in-100 flood, read off the curve. null when 100 years is more frequent than anything modelled. */
  loss100GroundUpKes: number | null;
  /** Gross loss in a 1-in-100 flood. null as above. */
  loss100GrossKes: number | null;
  /** True when the 1-in-100 figures are held flat beyond the rarest modelled flood. */
  loss100Extrapolated: boolean;
}

/**
 * The followed building at the stated point: the single map cell its coordinates fall in, read
 * exactly as a portfolio building is read. Evidence for the price, not the price: the headline
 * figures are in FocusPrice.total.
 */
export interface FocusBuildingPrice extends LossFigures {
  /** The building these figures are for: FocusBuilding.locId. */
  locId: string;
  /** The class whose curve was used. */
  housingClass: HousingClass;
  /** The fragility multiplier on depth for that class, under the assumptions in force. */
  fragility: number;
  /** The highest damage ratio that class can reach, under the assumptions in force. */
  cap: number;
  /** One row per modelled return period, most frequent first: the single-building trace. */
  perReturnPeriod: FocusReturnPeriod[];
  /** True when the terrain map is dry at the point in every return period. Drainage ponding may still reach it. */
  dryOnEveryTerrainMap: boolean;
  /** True when the depth used is zero at every return period: terrain and drainage both. */
  dryAtEveryReturnPeriod: boolean;
  /** The most frequent return period at which the depth used is above zero. null when always dry. */
  firstWetReturnPeriod: number | null;
  /** Metres to the nearest mapped flood water on any terrain map: 0 when the point is wet on one, null when no map has water. */
  nearestWetM: number | null;
}

/** Where the offer's value per m² sits among the buildings of its class in the loaded portfolio. */
export interface ClassRange {
  housingClass: HousingClass;
  /** The class in words. */
  label: string;
  /** The offer's value per m². null when it cannot be worked out. */
  perM2Kes: number | null;
  /** How many buildings of the class in the portfolio carry a cost per m². */
  count: number;
  /** The lowest, middle and highest cost per m² among them. null when there are none. */
  minKes: number | null;
  medianKes: number | null;
  maxKes: number | null;
  /** Where the offer sits: below the lowest, within the range, above the highest. "unknown" when it cannot be compared. */
  position: "below" | "within" | "above" | "unknown";
  /** The share of those buildings whose cost per m² is at or below the offer's, 0 to 1. null when it cannot be compared. */
  shareAtOrBelow: number | null;
}

/**
 * What the offer does to the loaded portfolio. Ground-up unless a field says gross.
 *
 * The portfolio's own buildings keep their reading at the point. The offer is added with its
 * LOADED loss at each return period (technical.perReturnPeriod). The document's loss history and
 * the minimum rate are yearly figures with no return period, so they are not in these figures.
 */
export interface FocusPortfolio {
  /** The portfolio as loaded, under the assumptions and flood source in force. */
  without: PortfolioFigures;
  /** The same portfolio with the offer added: its loaded ground-up loss at each return period on top of the portfolio's own. */
  with: PortfolioFigures;
  /** True when "without" is exactly the portfolio the rest of the app shows (the figures in the header in Portfolio mode). */
  sameAsPortfolioView: boolean;
  /** What the offer adds to the portfolio's 1-in-100 ground-up loss: its loaded 1-in-100 loss. null when either side is not modelled. */
  loss100ChangeKes: number | null;
  /** The same as a fraction of the portfolio's 1-in-100 before the offer: 0.004 is 0.4%. null as above, or when that loss is zero. */
  loss100ChangeShare: number | null;
  /** What the offer adds to the portfolio's ground-up average annual loss: the area under its loaded curve. */
  aalChangeKes: number;
  /** The same as a fraction of the portfolio's average annual loss before the offer. null when that is zero. */
  aalChangeShare: number | null;
  /** The same two changes with the offer read at the stated point alone, as the engine adds a building. */
  atPoint: { loss100ChangeKes: number | null; aalChangeKes: number };
  /** The offer's insured value as a share of the portfolio's with the offer in it: 0.06 is 6%. */
  tivShare: number;
  /** The largest single insured value in the portfolio before the offer. */
  largestTivKes: number;
  /** The offer's insured value as a multiple of that largest one. null when the portfolio is empty. */
  timesLargest: number | null;
  /**
   * The same comparison after policy terms: the portfolio's gross 1-in-100 and average annual loss
   * without and with the offer. The portfolio's buildings are on the panel's example terms, the
   * offer on its own. null when the portfolio's terms were not supplied or do not match this run.
   */
  gross: { without100Kes: number | null; with100Kes: number | null; change100Kes: number | null; change100Share: number | null; aalWithoutKes: number; aalWithKes: number } | null;
  /** Where the building's value per m² sits in its class. null when the building has no class. */
  classRange: ClassRange | null;
  /** The buildings of the followed building's class in the portfolio, per return period, as context for its damage ratio. */
  classContext: {
    housingClass: HousingClass;
    /** Buildings of the class in the portfolio. */
    buildings: number;
    /** Their insured value. */
    tivKes: number;
    /** Most frequent first, in the order of FocusBuildingPrice.perReturnPeriod. */
    perReturnPeriod: { id: string; returnPeriod: number; flooded: number; meanDamageRatio: number; meanDamageRatioFlooded: number | null }[];
  } | null;
}

/**
 * The offer's technical price under one set of assumptions. The rows are the same; what differs is
 * the model's parameters and, when the agents argued the offer, the five judgement figures.
 */
export interface AssumptionPrice {
  /** Whose assumptions: the reference set, one agent's proposal, or the set the agents agreed. */
  id: "reference" | "optimist" | "cautious" | "agreed";
  /** "Reference, no AI", "Optimist", "Cautious", "Agreed by agents". */
  label: string;
  /** True for the set the rest of the focus is priced on. */
  inForce: boolean;
  /** The model's parameters themselves. */
  params: ModelParams;
  /**
   * The five judgement figures this set was priced with: this set's own when the agents gave one
   * for the offer, otherwise the reference values. A figure the underwriter typed replaces that
   * figure in every set, so the sets stay comparable.
   */
  judgement: OfferJudgement;
  /** True when the agents gave this set its own judgement figures for the offer. */
  judgementFromAgents: boolean;
  /** Whole offer, loaded gross loss in a 1-in-100 flood. null when 100 years is more frequent than anything modelled under this set. */
  loss100GrossKes: number | null;
  /** Whole offer, loaded ground-up loss in a 1-in-100 flood. */
  loss100GroundUpKes: number | null;
  /** True when those two are held flat beyond the rarest modelled flood. */
  loss100Extrapolated: boolean;
  /** Whole offer, indicated average annual loss, gross. */
  aalGrossKes: number;
  /** Whole offer, indicated average annual loss, ground-up. */
  aalGroundUpKes: number;
  /** Whole offer, indicated pure rate per mille, gross. */
  ratePerMilleGross: number;
  /** Which line set the indicated gross figure under this set: the blended line, or the minimum rate. */
  setBy: "blended" | "minimum rate";
  /** The same set read at the stated point alone: the engine's figures, with no surroundings, loadings, loss history or minimum. */
  atPoint: { loss100GrossKes: number | null; loss100GroundUpKes: number | null; loss100Extrapolated: boolean; aalGrossKes: number; aalGroundUpKes: number; ratePerMilleGross: number };
  /** The followed building at the stated point under this set, one point per return period, most frequent first: for its points on the class curve. */
  building: { id: string; returnPeriod: number; depthM: number; effectiveDepthM: number; damageRatio: number; capped: boolean; groundUpKes: number; grossKes: number }[];
}

/** The five judgement figures behind the technical price, and whose they are. */
export interface FocusJudgement {
  /** The figures the price is worked out with, inside their allowed ranges. */
  inForce: OfferJudgement;
  /**
   * Whose they are, for the screen to say:
   *   "reference"  the reference values: no agent has argued this offer, or "Reference, no AI" is on
   *   "agents"     the set the agents agreed for this offer, while "Agreed by agents" is on
   *   "typed"      the underwriter typed one or more of the five; the rest are as `base` says
   */
  source: "reference" | "agents" | "typed";
  /** The reference values. */
  reference: OfferJudgement;
  /** The set the agents agreed when they ran with this offer. null when they have not. */
  agreed: OfferJudgement | null;
  /** What the figures the underwriter has not typed rest on. */
  base: "reference" | "agents";
  /** The figures the underwriter typed, as used. Empty when none is typed. */
  typed: Partial<OfferJudgement>;
  /**
   * Whether the agents have argued the five figures:
   *   "this_offer"     they ran with the offer now on screen: `agreed` is their set when the Chair decided
   *   "another_offer"  they ran with a different offer, or its facts have changed since: their figures are not used
   *   "none"           they have not run, or ran with no offer loaded
   */
  agents: "this_offer" | "another_offer" | "none";
}

/** One of the two terms the gross loss was worked out with. */
export interface FocusTerm {
  /** The term in one plain sentence: "5% of each loss, with a minimum of KES 2.5m." */
  text: string;
  /** Where it came from. A term the underwriter typed over is "typed by you"; one the document does not state is "example terms". */
  source: "from the document" | "typed by you" | "example terms";
  /** True when part of it was read from the document and part typed by the underwriter. The source then says "from the document". */
  mixed: boolean;
  /** The sentences of the document it rests on. Empty for example terms and for typed figures. */
  quotes: string[];
}

/** The deductible and the limit in force, and where each came from. Present whether or not the offer is priced. */
export interface FocusTerms {
  /** The terms as numbers, exactly as the engine used them. */
  policy: PolicyTerms;
  deductible: FocusTerm;
  limit: FocusTerm;
  /** Both in a few words, for the key figures strip: "From the document", "Example terms", "Deductible from the document, limit example terms". */
  summary: string;
  /** Whether the document asks for flood to be covered or excluded. null when it does not say. */
  floodCover: FloodCover | null;
}

/** Facts about the site, for the map and the checks. */
export interface FocusSite {
  /** The point the hazard maps were read at. */
  lat: number;
  lon: number;
  /** True when a named place stands in for coordinates. Every distance below is then approximate too. */
  approximate: boolean;
  /** True when the open waterways layer is loaded. When false, the two distances below are null for that reason. */
  waterwaysLoaded: boolean;
  river: {
    /** The river the document names as nearest. null when it names none. */
    statedName: string | null;
    /** The distance the document states to it, in metres. null when it states none. */
    statedDistanceM: number | null;
    /** The sentence that says so. "" when there is none. */
    quote: string;
    /** The measured distance to the river the document names, on the waterways layer. null when it names none or the layer does not hold it. */
    named: RiverMatch | null;
    /** The nearest river or stream on the waterways layer, whatever the document says. null when the layer is missing. */
    nearest: WaterwayMatch | null;
  };
  /** The nearest drain, ditch or canal on the waterways layer. null when the layer is missing or has none. */
  drain: WaterwayMatch | null;
  /** Drainage stress at the site, 0 to 1: 1 on a drain or inside an informal settlement, fading to 0 at the reach. null when drainage is off or the building is not priced. */
  drainageStress: number | null;
  /** The reach of the drainage zone in metres, when drainage is on. */
  drainageReachM: number | null;
  /** True when the site's cell lies inside a mapped informal settlement. null when drainage is off or the building is not priced. */
  inInformalSettlement: boolean | null;
  /**
   * How much of the ground around the point is wet in the rarest flood modelled, which has the widest
   * footprint: the share of map cells at each of WET_SHARE_RADII_M, terrain water or drainage
   * ponding as the view shows it. null when the building is not priced.
   */
  mappedWater: { id: string; label: string; returnPeriod: number; within: { radiusM: number; cells: number; wetCells: number; wetShare: number }[] } | null;
  /** The insured buildings of the loaded portfolio around the site. */
  neighbours: {
    /** The radius searched, in metres. */
    radiusM: number;
    /** How many portfolio buildings lie inside it. */
    count: number;
    /** Their insured value. */
    tivKes: number;
    /** Metres to the nearest one. null when the portfolio is empty. */
    nearestM: number | null;
    /** Their places in session.dataset.buildings, nearest first: draw these around the offer on the map. */
    indices: number[];
  };
  /** The portfolio's holding in the ward the site falls in, before the offer. null when the site is outside the ward map. */
  wardPortfolio: { name: string; subcounty: string; buildings: number; tivKes: number; shareOfPortfolioTiv: number } | null;
}

/** Everything that exists only once the offer is priced. */
export interface FocusPrice {
  /** The modelled floods, most frequent first, under the assumptions in force. */
  scenarios: OfferScenario[];
  /** How many buildings of the offer were priced. */
  pricedCount: number;
  /** The building the steps follow, the first priced one, read at the stated point: the trace from the map cell to the gross loss. */
  building: FocusBuildingPrice;
  /**
   * The headline figures, from the technical price, for every priced building of the offer together:
   * the loaded loss per return period, and the indicated average annual loss and pure rate.
   */
  total: LossFigures;
  /** The same offer read at the stated point alone, as the engine gives it. With one building it equals `building`. */
  atPoint: LossFigures;
  /** What the offer does to the portfolio. */
  portfolio: FocusPortfolio;
  /** The technical price on the reference assumptions, and on the Optimist's, the Cautious and the agreed set once the agents have run. */
  assumptions: AssumptionPrice[];
}

/** What the Dashboard shows of the latest offer. The same shape as OfferSummary in components/dashboard/Dashboard.tsx. */
export interface FocusSummary {
  name: string;
  fieldsRead: number;
  fieldsVerified: number;
  loss100Kes: number | null;
  aalKes: number | null;
  outside: boolean;
}

export interface OfferFocus {
  // --- identity ---------------------------------------------------------------------------------
  /** The document's name: the file name, or "typed text". */
  documentName: string;
  /** The offer in one line, each part null when the document does not state it. */
  line: OfferLine;

  // --- where things stand -----------------------------------------------------------------------
  /**
   * "locating"   the ward map and waterways are still loading; nothing is placed yet
   * "outside"    the building lies outside the hazard maps: no loss figure exists
   * "waiting"    one or more unverified values hold pricing up
   * "not_ready"  something needed for a price is missing: a location, a class or an insured value
   * "priced"     every figure is there
   */
  status: "locating" | "outside" | "waiting" | "not_ready" | "priced";
  /** The status as one sentence for the screen. */
  statusLine: string;
  /** True when no building of the offer is inside the hazard maps. `price` is then null: there are no loss fields. */
  outside: boolean;
  /** Exactly "Outside the hazard maps loaded: flood cannot be priced here" when outside, otherwise null. */
  outsideMessage: typeof OUTSIDE_MAPS_MESSAGE | null;
  /** The ground the loaded hazard maps cover, in one sentence. null when no maps are loaded. */
  coverage: string | null;
  /** The values that hold pricing up: unverified, feeding the price, not yet confirmed or edited. Empty when none. */
  waiting: FocusWaiting[];

  // --- the document -----------------------------------------------------------------------------
  /** The document's text and the record of how it was read. */
  document: FocusDocument;
  /** What was read, with the underwriter's confirmations and edits applied. Every value carries its quote and status. */
  extraction: OfferExtraction;
  /** Every value as a flat list, in the order shown: each building's values, the flood terms, the site facts, the notes. */
  fields: FocusField[];
  /** How many values hold each status. */
  counts: Record<ValueStatus, number>;

  // --- the building(s) --------------------------------------------------------------------------
  /** Every insured building of the offer, in the document's order. */
  buildings: FocusBuilding[];
  /** The building the steps follow: the first priced one, or the first listed when none is priced. null only while locating or when the offer has no row. */
  building: FocusBuilding | null;
  /** True when the offer lists more than one building. */
  several: boolean;
  /** Says so in a sentence, naming the building followed. null when there is one building. */
  severalLine: string | null;

  // --- the model it was priced on ---------------------------------------------------------------
  /** The loaded data set's name. */
  datasetName: string;
  /** "score" for the Nairobi susceptibility proxy, "depth_m" for measured depth maps. */
  hazardKind: HazardKind;
  /** True when drainage ponding is part of the run. */
  drainageOn: boolean;
  /** Which assumptions the figures use: the agents' agreed set, or the reference set. */
  assumptionsInForce: "ai" | "reference";
  /** The deductible and the limit in force and where each came from. */
  terms: FocusTerms;

  // --- the price --------------------------------------------------------------------------------
  /** The five judgement figures behind the technical price, and whose they are. Present whether or not the offer is priced. */
  judgement: FocusJudgement;
  /**
   * The technical price under the assumptions and the judgement in force, line by line: at the
   * stated point, around the site, with loadings, the loss history, blended, the minimum rate,
   * indicated. null unless status is "priced": outside the maps, or while a value waits, there is no figure.
   */
  technical: TechnicalPrice | null;
  /** Depth, damage, loss, the portfolio effect and the price under each set of assumptions. null unless status is "priced". */
  price: FocusPrice | null;
  /** Distances to rivers and drains, drainage stress and the portfolio around the site. null when the followed building has no location or is outside the maps. */
  site: FocusSite | null;

  // --- for the underwriter ----------------------------------------------------------------------
  /** The checks on the offer. While pricing waits, only the check on the values themselves. */
  checks: Check[];
  /** Points to weigh, worst first: every check that did not pass, and the flags below, each with a document quote or a model figure. */
  flags: Flag[];
  /** What suggestedConditions needs, filled from the document and the price. */
  facts: OfferFacts;
  /** suggestedConditions(flags, facts), worked out here so every step shows the same list. */
  conditions: SuggestedCondition[];
  /** The offer as the Dashboard's "Latest priced offer" card shows it. */
  summary: FocusSummary;

  // --- the engine's own output ------------------------------------------------------------------
  /** The rows as they went into the engine. Also what offerCsv takes. Empty while locating. */
  rows: PricingRow[];
  /** priceOffer's result exactly as returned, for anything not lifted out above. null while locating. */
  pricing: OfferPricing | null;
}

/** An offer with every loss figure in place. This is what a step receives as `focus` in Offer mode. */
export type PricedFocus = OfferFocus & { status: "priced"; price: FocusPrice; technical: TechnicalPrice; building: FocusBuilding; site: FocusSite };

/** True when the offer is priced: the price, its build-up, the building and the site facts are all there. */
export const isPriced = (focus: OfferFocus | null | undefined): focus is PricedFocus =>
  !!focus && focus.status === "priced" && focus.price !== null && focus.technical !== null && focus.building !== null && focus.site !== null;

/** The props every step of the walkthrough receives. Add them to a step's Props as they are, all optional. */
export interface OfferFocusProps {
  /** The priced offer while the header switch is on "Offer". null in Portfolio mode and whenever no offer is priced. */
  focus?: PricedFocus | null;
  /** The offer whatever the switch says, priced or not. null when no offer has been read. */
  offerFocus?: OfferFocus | null;
  /** The judgement figures in force and whose they are: offerFocus.judgement. null when no offer has been read. */
  judgement?: FocusJudgement | null;
  /**
   * Types over judgement figures. Each figure in `next` replaces what was typed for it before; a
   * figure left out keeps what was typed; a figure given as undefined goes back to the reference or
   * the agents' value; an empty object clears everything typed. Code keeps every figure in its range.
   */
  onJudgement?: (next: Partial<OfferJudgement>) => void;
}

/** The agents' judgement on the offer, as the deliberation carries it once they have run with an offer loaded. */
export interface AgentsJudgement {
  optimist: OfferJudgement | null;
  cautious: OfferJudgement | null;
  final: OfferJudgement | null;
  /**
   * The facts of the offer the agents were given. buildOfferFocus compares them with the offer now
   * on screen (sameOffer) and leaves the agents' figures out when they argued another offer.
   * Left out, the figures are taken to be for this offer.
   */
  brief?: OfferBrief;
}

/** What buildOfferFocus needs. The walkthrough holds every one of these already. */
export interface OfferFocusInput {
  /** The offer as it stands on screen. null gives a null focus. */
  offer: OfferState | null;
  /** The view session: the dataset with the drainage setting applied. Only the dataset is read. */
  session: { dataset: Dataset };
  /** The assumptions in force and the portfolio's result under them. */
  active: { source: "ai" | "reference"; params: ModelParams; result: ModelResult };
  /** The drainage state when drainage is switched on, otherwise null. */
  drainage: DrainageState | null;
  /** The policy terms of the Insurance terms panel, used for whatever the document does not state. */
  policyDefaults: PolicyDefaults;
  /** applyTerms(view.dataset, active.result, terms): the portfolio through the panel's terms, for the gross portfolio comparison. Optional. */
  portfolioTerms?: TermsResult | null;
  /**
   * The agents' deliberation when there is one. The three parameter sets are read, and
   * offerJudgement when the agents ran with an offer loaded: its figures are used only when the
   * brief it carries is for the offer now on screen.
   */
  deliberation: (Pick<Deliberation, "optimist" | "cautious" | "final"> & { offerJudgement?: AgentsJudgement | null }) | null;
  /** Judgement figures the underwriter typed. Each one replaces that figure whoever proposed it; code keeps it in its range. */
  judgement?: Partial<OfferJudgement>;
  /** The ward map and the waterways once loadGeo has answered: each null when its file is missing. Pass null while they are still loading. */
  layers: { wards: GeoCollection<WardProps> | null; waterways: GeoCollection<WaterwayProps> | null } | null;
}

// ---------------------------------------------------------------------------------------------
// The document and its fields
// ---------------------------------------------------------------------------------------------

type PricedRow = Extract<RowPricing, { status: "priced" }>;

function originOf(status: ValueStatus, path: ExtractionPath): { origin: FieldOrigin; mark: QuoteMark | null } {
  if (status === "missing") return { origin: "not stated", mark: null };
  if (status === "confirmed") return { origin: "confirmed", mark: "confirmed" };
  if (status === "edited") return { origin: "edited", mark: "edited" };
  if (path === "rules") return { origin: "rules", mark: status === "unverified" ? "unverified" : "rules" };
  return status === "verified" ? { origin: "AI, verified", mark: "verified" } : { origin: "AI, unverified", mark: "unverified" };
}

const SITE_KEYS: ReadonlySet<keyof OfferTerms> = new Set(["basements", "occupancy", "placeName", "riverName", "riverDistanceM"]);

function fieldList(extraction: OfferExtraction, path: ExtractionPath, holding: ReadonlySet<string>): FocusField[] {
  const out: FocusField[] = [];
  const add = (id: string, ref: ValueRef, group: FocusField["group"], row: number | null, label: string, value: string, quoted: Quoted<string | number>, by: ExtractionPath) => {
    out.push({ id, ref, group, row, label, value, raw: quoted.value, quote: quoted.quote, ...originOf(quoted.status, by), status: quoted.status, reason: quoted.reason, holdsPricing: holding.has(id) });
  };
  extraction.rows.forEach((r, i) => {
    for (const f of ROW_FIELDS) add(`row:${i}:${f.key}`, { scope: "row", row: i, key: f.key }, "building", i, fieldLabel(f), fieldText(r[f.key].value, f), r[f.key], r.path);
  });
  for (const f of TERM_FIELDS) {
    add(`terms:${f.key}`, { scope: "terms", key: f.key }, SITE_KEYS.has(f.key) ? "site" : "terms", null, fieldLabel(f), fieldText(extraction.terms[f.key].value, f), extraction.terms[f.key], path);
  }
  extraction.notes.forEach((n, index) => add(`note:${index}`, { scope: "note", index }, "note", null, NOTE_LABELS[n.kind], n.value ?? "", n, path));
  return out;
}

const refId = (ref: ValueRef): string => (ref.scope === "row" ? `row:${ref.row}:${ref.key}` : ref.scope === "terms" ? `terms:${ref.key}` : `note:${ref.index}`);

function waitingList(extraction: OfferExtraction): FocusWaiting[] {
  return waitingValues(extraction).map((w): FocusWaiting => {
    const { ref } = w;
    const field: FieldDef<string> | undefined = ref.scope === "row" ? ROW_FIELDS.find((f) => f.key === ref.key) : ref.scope === "terms" ? TERM_FIELDS.find((f) => f.key === ref.key) : undefined;
    const where = ref.scope === "row" ? `Building ${ref.row + 1}` : "Offer";
    const value = w.quoted.value === null ? "nothing readable" : field ? fieldText(w.quoted.value, field) : String(w.quoted.value);
    const reason = w.quoted.reason ?? "Not checked.";
    return { ref, fieldId: refId(ref), where, label: w.label, value, reason, text: `${where}, ${w.label.toLowerCase()}: ${value}. ${reason}` };
  });
}

function documentRecord(document: OfferDocument, run: OfferState["run"]): FocusDocument {
  const why =
    run.path === "model"
      ? `${run.model ?? "The model"} listed the buildings and the terms, and code checked every value against the same text.`
      : (run.fallbackReason ?? "The fixed rules read the text.");
  return {
    name: document.name,
    kind: document.kind,
    text: run.documentText,
    sentToModel: run.sentToModel,
    sent: run.sentToModel ? run.prompt : null,
    removed: run.removed,
    removedLine: describeRemoved(run.removed, run.sentToModel),
    path: run.path,
    why,
    model: run.model,
    ms: run.ms,
    usage: run.usage,
    replyJson: run.replyJson ?? null,
  };
}

/** The ground the loaded hazard maps cover, in words. */
function coverageOf(dataset: Dataset): string | null {
  const boxes = dataset.rasters.map((r) => r.bbox);
  if (boxes.length === 0) return null;
  const minLon = Math.max(...boxes.map((b) => b[0]));
  const minLat = Math.max(...boxes.map((b) => b[1]));
  const maxLon = Math.min(...boxes.map((b) => b[2]));
  const maxLat = Math.min(...boxes.map((b) => b[3]));
  const lat = (v: number) => `${fmtNum(Math.abs(v), 2)}° ${v < 0 ? "S" : "N"}`;
  const lon = (v: number) => `${fmtNum(Math.abs(v), 2)}° ${v < 0 ? "W" : "E"}`;
  return `The maps loaded (${dataset.name}) cover ${lat(minLat)} to ${lat(maxLat)} and ${lon(minLon)} to ${lon(maxLon)}.`;
}

// ---------------------------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------------------------

function termFrom(text: string, fromDocument: boolean, used: Quoted<unknown>[]): FocusTerm {
  if (!fromDocument) return { text, source: "example terms", mixed: false, quotes: [] };
  const usable = used.filter((q) => usableValue(q) !== null);
  const typed = usable.filter((q) => q.status === "edited").length;
  const quotes = [...new Set(usable.filter((q) => q.status !== "edited").map((q) => q.quote.trim()).filter(Boolean))];
  const allTyped = usable.length > 0 && typed === usable.length;
  return { text, source: allTyped ? "typed by you" : "from the document", mixed: typed > 0 && !allTyped, quotes };
}

const capital = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

function termsUsed(policy: PolicyTerms, stated: OfferTerms): FocusTerms {
  const words = describeTerms(policy);
  const deductible = termFrom(words.deductible, policy.deductible.source === "document", [stated.floodDeductiblePct, stated.floodDeductibleMinKes, stated.floodDeductibleBasis]);
  const limit = termFrom(words.limit, policy.limit.source === "document", [stated.floodLimitKes]);
  const summary = deductible.source === limit.source ? capital(deductible.source) : `Deductible ${deductible.source}, limit ${limit.source}`;
  return { policy, deductible, limit, summary, floodCover: usableValue(stated.floodCover) };
}

// ---------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------

function standInOf(location: OfferLocation): string | null {
  if (location.kind !== "approximate") return null;
  return location.source === "ward" ? `the centre of ${location.matchedName} ward` : `the point of the named flood area "${location.matchedName}"`;
}

function locationHow(location: OfferLocation): string {
  if (location.kind === "none") return `Not located. ${location.reason}`;
  if (location.kind === "approximate") return `No usable coordinates, so "${location.placeName}" stands in: ${standInOf(location)}, at ${fmtPoint(location.lat, location.lon)}.`;
  const r = location.reading;
  if (!r) return `${fmtPoint(location.lat, location.lon)}, typed by the underwriter.`;
  const twice = r.conflict
    ? " The minus sign and the hemisphere letter disagree; the letter was used."
    : r.writtenBothWays
      ? " The document gives a minus sign and a hemisphere letter for the same number; they say the same thing."
      : "";
  return `${fmtPoint(location.lat, location.lon)}, read from "${r.raw}" as ${describeReading(r)}.${twice}`;
}

function buildingOf(row: PricingRow, priced: RowPricing | undefined, wards: GeoCollection<WardProps> | null): FocusBuilding {
  const { location } = row;
  const located = location.kind !== "none";
  const status = priced?.status ?? "not_ready";
  const valuePerM2Kes = row.tivKes !== null && row.floorAreaM2 !== null ? row.tivKes / row.floorAreaM2 : row.costPerM2Kes;
  return {
    index: row.index,
    locId: row.locId,
    name: row.name,
    status,
    blockers: priced?.status === "not_ready" ? priced.blockers : [],
    location,
    lat: located ? location.lat : null,
    lon: located ? location.lon : null,
    approximate: location.kind === "approximate",
    locationHow: locationHow(location),
    standIn: standInOf(location),
    ward: priced?.status === "priced" ? priced.ward : located ? wardOf(location, wards) : null,
    housingClass: row.housingClass,
    housingLabel: row.housingClass ? HOUSING_LABELS[row.housingClass] : null,
    floorAreaM2: row.floorAreaM2,
    costPerM2Kes: row.costPerM2Kes,
    tivKes: row.tivKes,
    tivFrom: row.tivFrom,
    valuePerM2Kes,
  };
}

function lineOf(extraction: OfferExtraction, rows: PricingRow[], building: FocusBuilding | null): OfferLine {
  const name = extraction.rows[building?.index ?? 0]?.name;
  const insured = (name ? usableValue(name)?.trim() : null) || null;
  const place = usableValue(extraction.terms.placeName)?.trim() || null;
  const ward = building?.ward ? `${building.ward.name} ward${building.ward.subcounty ? `, ${building.ward.subcounty}` : ""}` : null;
  const point = building && building.lat !== null && building.lon !== null ? fmtPoint(building.lat, building.lon) : null;
  const location = place && ward ? `${place} (${ward})` : (place ?? ward ?? point);
  const values = rows.map((r) => r.tivKes).filter((v): v is number => v !== null);
  const sumInsuredKes = values.length > 0 ? values.reduce((t, v) => t + v, 0) : null;
  const floodCover = usableValue(extraction.terms.floodCover);
  const cover = floodCover === "covered" ? "Flood covered" : floodCover === "excluded" ? "Flood excluded" : null;
  const period = usableValue(extraction.terms.policyPeriod)?.trim() || null;
  const text = [insured, location, sumInsuredKes !== null ? `sum insured ${kes1(sumInsuredKes)}` : null, cover ? cover.toLowerCase() : null, period].filter(Boolean).join(" · ");
  return { insured, location, sumInsuredKes, cover, period, text: capital(text) };
}

// ---------------------------------------------------------------------------------------------
// Loss figures
// ---------------------------------------------------------------------------------------------

function lossFigures(tivKes: number, curve: LossFigures["curve"]): LossFigures {
  const groundUp: CurvePoint[] = curve.map((p) => ({ returnPeriod: p.returnPeriod, lossKes: p.groundUpKes }));
  const gross: CurvePoint[] = curve.map((p) => ({ returnPeriod: p.returnPeriod, lossKes: p.grossKes }));
  const aalGroundUpKes = averageAnnualLoss(groundUp);
  const aalGrossKes = averageAnnualLoss(gross);
  const standard = STANDARD_RETURN_PERIODS.map((returnPeriod) => {
    const g = lossAtReturnPeriod(groundUp, returnPeriod);
    return { returnPeriod, groundUpKes: g.lossKes, grossKes: lossAtReturnPeriod(gross, returnPeriod).lossKes, extrapolated: g.extrapolated };
  });
  const at100 = lossAtReturnPeriod(groundUp, 100);
  return {
    tivKes,
    curve,
    standard,
    aalGroundUpKes,
    aalGrossKes,
    ratePerMilleGroundUp: tivKes > 0 ? (aalGroundUpKes / tivKes) * 1000 : 0,
    ratePerMilleGross: tivKes > 0 ? (aalGrossKes / tivKes) * 1000 : 0,
    loss100GroundUpKes: at100.lossKes,
    loss100GrossKes: lossAtReturnPeriod(gross, 100).lossKes,
    loss100Extrapolated: at100.extrapolated,
  };
}

/**
 * The priced rows under another set of assumptions, without running the portfolio again. The
 * hazard value and the drainage ponding at each building do not depend on the assumptions, so
 * they are taken from the engine's run; depth, damage, loss and the return periods are worked
 * out afresh with the same functions the engine uses.
 */
function priceUnder(dataset: Dataset, params: ModelParams, policy: PolicyTerms, priced: PricedRow[], follow: number) {
  const slopes = tierSlopes(dataset);
  const rps = scenarioReturnPeriods(dataset, params);
  const order = dataset.scenarios.map((_, i) => i).sort((a, b) => rps[a] - rps[b]);
  const tivs = priced.map((r) => r.tivKes);
  const events = order.map((si) => {
    const { id, label } = dataset.scenarios[si];
    const cells = priced.map((r) => {
      const s = r.scenarios.find((x) => x.id === id);
      const terrainM = hazardToDepth(s?.hazard ?? 0, dataset, params, slopes[si]);
      const depthM = Math.max(terrainM, s?.drainageM ?? 0);
      const d = damageDetail(depthM, r.housingClass, params);
      return { depthM, ...d, groundUpKes: d.damageRatio * r.tivKes };
    });
    const split = termsSplit(cells.map((c) => c.groundUpKes), tivs, policy);
    return { id, label, returnPeriod: rps[si], cells, split };
  });
  const total = lossFigures(
    tivs.reduce((t, v) => t + v, 0),
    events.map((e) => ({ id: e.id, label: e.label, returnPeriod: e.returnPeriod, groundUpKes: e.cells.reduce((t, c) => t + c.groundUpKes, 0), grossKes: e.split.reduce((t, x) => t + x.grossKes, 0) })),
  );
  const building = events.map((e) => {
    const c = e.cells[follow];
    return { id: e.id, returnPeriod: e.returnPeriod, depthM: c.depthM, effectiveDepthM: c.effectiveDepthM, damageRatio: c.damageRatio, capped: c.capped, groundUpKes: c.groundUpKes, grossKes: e.split[follow].grossKes };
  });
  return { total, building };
}

const ASSUMPTION_LABELS: Record<AssumptionPrice["id"], string> = { reference: "Reference, no AI", optimist: "Optimist", cautious: "Cautious", agreed: "Agreed by agents" };

// ---------------------------------------------------------------------------------------------
// The technical price in the focus
// ---------------------------------------------------------------------------------------------

/** The drainage grid of a drainage state for a list of scenarios, worked out once: it does not depend on the buildings. */
const drainageInfoCache = new WeakMap<DrainageState, { scenarios: Dataset["scenarios"]; info: NonNullable<Dataset["drainage"]> }>();

/**
 * The data set the technical price reads its maps from. Like priceOffer, the drainage argument
 * alone decides whether ponding is read: drainage the data set arrived with is used when it is
 * switched on, and dropped when it is not.
 */
function mapsFor(dataset: Dataset, drainage: DrainageState | null): Dataset {
  if (!drainage) return dataset.drainage ? { ...dataset, drainage: undefined } : dataset;
  if (dataset.drainage) return dataset;
  let cached = drainageInfoCache.get(drainage);
  if (!cached || cached.scenarios !== dataset.scenarios) {
    cached = { scenarios: dataset.scenarios, info: withDrainage({ ...dataset, buildings: [] }, drainage).drainage! };
    drainageInfoCache.set(drainage, cached);
  }
  return { ...dataset, drainage: cached.info };
}

/** The headline figures of a technical price in the shape every step reads: the loaded curve, and the indicated average annual loss and rates. */
function technicalFigures(technical: TechnicalPrice): LossFigures {
  const loaded = lossFigures(technical.tivKes, technical.perReturnPeriod.map((r) => ({ id: r.id, label: r.label, returnPeriod: r.returnPeriod, groundUpKes: r.groundUpKes, grossKes: r.grossKes })));
  const { indicated } = technical;
  return { ...loaded, aalGroundUpKes: indicated.aalGroundUpKes, aalGrossKes: indicated.aalGrossKes, ratePerMilleGroundUp: indicated.ratePerMilleGroundUp, ratePerMilleGross: indicated.ratePerMilleGross };
}

/** The figures the underwriter typed, out of whatever was handed in: finite numbers only. */
function typedFigures(given: Partial<OfferJudgement> | undefined): Partial<OfferJudgement> {
  const out: Partial<OfferJudgement> = {};
  for (const key of JUDGEMENT_KEYS) {
    const v = given?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** One set of judgement figures with the typed ones over it, inside the allowed ranges. */
const withTyped = (base: OfferJudgement, typed: Partial<OfferJudgement>): OfferJudgement => enforceJudgement({ ...base, ...typed }).judgement;

/**
 * The judgement in force: the agents' agreed set when they ran with this offer and "Agreed by
 * agents" is on, otherwise the reference set; anything the underwriter typed goes over either.
 */
function judgementOf(input: OfferFocusInput, agents: AgentsJudgement | null, ran: FocusJudgement["agents"]): FocusJudgement {
  const agreed = agents?.final ? enforceJudgement(agents.final).judgement : null;
  const base: FocusJudgement["base"] = input.active.source === "ai" && agreed ? "agents" : "reference";
  const given = typedFigures(input.judgement);
  const inForce = withTyped(base === "agents" && agreed ? agreed : REFERENCE_JUDGEMENT, given);
  const typed: Partial<OfferJudgement> = {};
  for (const key of JUDGEMENT_KEYS) if (key in given) typed[key] = inForce[key];
  return { inForce, source: Object.keys(typed).length > 0 ? "typed" : base, reference: { ...REFERENCE_JUDGEMENT }, agreed, base, typed, agents: ran };
}

// ---------------------------------------------------------------------------------------------
// What the agents are told about the offer
// ---------------------------------------------------------------------------------------------

/** A sentence as it is sent: one line, cut at the brief's limit. */
const briefLine = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, BRIEF_QUOTE_MAX_CHARS);

/** The part of the brief that comes from the document and the location alone: it does not change with the flood source or the assumptions. */
type BriefFacts = Pick<OfferBrief, "housingClass" | "insuredValueKes" | "basements" | "criticalPlantInBasement" | "drainageCondition" | "floodLossCount" | "floodLossTotalKes" | "floodHistoryYears" | "nearestRiverM" | "nearestDrainM" | "quotes">;

function briefFacts(extraction: OfferExtraction, building: FocusBuilding | null, site: FocusSite | null): BriefFacts {
  const facts = floodFactsOf(extraction);
  const history = statedFloodHistory(extraction);
  // Only sentences already shown on screen, and only those behind a usable value.
  const candidates: [string, string | undefined][] = [
    ["basements", facts.basementsQuote],
    ["basement plant", facts.criticalPlantQuote],
    ["drainage", facts.drainageQuote || usableNotes(extraction, "drainage_condition")[0]?.quote],
    ...usableNotes(extraction, "past_flood").slice(0, 2).map((n): [string, string] => ["past flood", n.quote]),
    ["loss history", history.yearsQuote],
    ...history.losses.slice(0, 2).map((l): [string, string] => ["flood loss", l.quote]),
    ["river", site?.river.quote],
  ];
  const quotes: OfferBrief["quotes"] = [];
  for (const [about, text] of candidates) {
    const quote = briefLine(text);
    if (quote && !quotes.some((q) => q.quote === quote) && quotes.length < BRIEF_MAX_QUOTES) quotes.push({ about, quote });
  }
  return {
    housingClass: building?.housingClass ?? null,
    insuredValueKes: building?.tivKes ?? null,
    basements: facts.basements,
    criticalPlantInBasement: facts.criticalPlantInBasement,
    drainageCondition: briefLine(facts.drainageCondition) || null,
    floodLossCount: history.losses.length,
    floodLossTotalKes: history.losses.length > 0 ? history.losses.reduce((t, l) => t + l.amountKes, 0) : null,
    floodHistoryYears: history.years,
    nearestRiverM: site?.river.nearest?.distanceM ?? null,
    nearestDrainM: site?.drain?.distanceM ?? null,
    quotes,
  };
}

/**
 * True when two briefs describe the same offer: the same building, the same story in the document
 * and the same place. What the maps show at the point is left out of the comparison, because it
 * moves with the flood source switch and not with the offer.
 */
export function sameOffer(a: BriefFacts, b: BriefFacts): boolean {
  const whole = (v: number | null) => (v === null ? null : Math.round(v));
  const key = (x: BriefFacts) =>
    JSON.stringify([x.housingClass, whole(x.insuredValueKes), x.basements, x.criticalPlantInBasement, x.drainageCondition, x.floodLossCount, whole(x.floodLossTotalKes), x.floodHistoryYears, whole(x.nearestRiverM), whole(x.nearestDrainM), x.quotes.map((q) => q.quote)]);
  return key(a) === key(b);
}

/**
 * What the agents are told about the offer when they run with one loaded: plain facts worked out
 * by code, and the few short sentences of the document already quoted on screen. No name, no
 * address and no other text of the document. Anything not known is null.
 */
export function offerBrief(focus: OfferFocus): OfferBrief {
  const trace = focus.price?.building.perReturnPeriod ?? [];
  // The rarest flood modelled has the widest footprint.
  const widest = trace[trace.length - 1];
  const within = (radiusM: number) => focus.site?.mappedWater?.within.find((w) => w.radiusM === radiusM)?.wetShare ?? null;
  return {
    ...briefFacts(focus.extraction, focus.building, focus.site),
    pointDryByTier: trace.map((r) => ({ tier: r.id, dry: !(r.depthM > 0) })),
    nearestMappedWaterM: widest ? (widest.depthM > 0 || widest.hazard > 0 ? 0 : widest.nearestWetM) : null,
    wetShareWidestTier: { within100m: within(100), within250m: within(250), within500m: within(500) },
  };
}

// ---------------------------------------------------------------------------------------------
// The portfolio around the offer
// ---------------------------------------------------------------------------------------------

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320;

/** The ward each portfolio building falls in, worked out once per portfolio and ward map. */
const wardIndexCache = new WeakMap<readonly Building[], WeakMap<object, number[]>>();
function wardIndices(buildings: Building[], wards: GeoCollection<WardProps>): number[] {
  let byWards = wardIndexCache.get(buildings);
  if (!byWards) wardIndexCache.set(buildings, (byWards = new WeakMap()));
  let found = byWards.get(wards);
  if (!found) byWards.set(wards, (found = assignPoints(buildings, wards)));
  return found;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function classRangeOf(building: FocusBuilding, dataset: Dataset): ClassRange | null {
  const cls = building.housingClass;
  if (!cls) return null;
  const costs = dataset.buildings.filter((b) => b.housingClass === cls && b.costPerM2Kes !== null && b.costPerM2Kes > 0).map((b) => b.costPerM2Kes as number).sort((a, b) => a - b);
  const perM2Kes = building.valuePerM2Kes;
  const minKes = costs[0] ?? null;
  const maxKes = costs[costs.length - 1] ?? null;
  const comparable = perM2Kes !== null && minKes !== null && maxKes !== null;
  return {
    housingClass: cls,
    label: HOUSING_LABELS[cls],
    perM2Kes,
    count: costs.length,
    minKes,
    medianKes: median(costs),
    maxKes,
    position: !comparable ? "unknown" : perM2Kes < minKes ? "below" : perM2Kes > maxKes ? "above" : "within",
    shareAtOrBelow: comparable ? costs.filter((c) => c <= perM2Kes).length / costs.length : null,
  };
}

function siteOf(building: FocusBuilding, input: OfferFocusInput, extraction: OfferExtraction, priced: PricedRow | null, maps: Dataset): FocusSite | null {
  if (building.lat === null || building.lon === null || building.status === "outside") return null;
  const point = { lat: building.lat, lon: building.lon };
  const { dataset } = input.session;

  // Wet ground around the point in the rarest flood modelled: the last of the priced row's scenarios.
  let mappedWater: FocusSite["mappedWater"] = null;
  const rarest = priced?.scenarios[priced.scenarios.length - 1];
  if (rarest) {
    const within = wetShareAround(maps, point.lon, point.lat, maps.scenarios.findIndex((s) => s.id === rarest.id), WET_SHARE_RADII_M);
    if (within) mappedWater = { id: rarest.id, label: rarest.label, returnPeriod: rarest.returnPeriod, within };
  }
  const waterways = input.layers?.waterways ?? null;
  const wards = input.layers?.wards ?? null;

  const statedName = usableValue(extraction.terms.riverName)?.trim() || null;
  const statedDistanceM = usableValue(extraction.terms.riverDistanceM);

  // Drainage stress as the engine used it: the ponding at the point over the full ponding depth of the same flood.
  let drainageStress: number | null = null;
  let inInformalSettlement: boolean | null = null;
  if (input.drainage && priced) {
    drainageStress = 0;
    for (const s of priced.scenarios) {
      const full = DRAINAGE_DEFAULTS.depthM[s.id as ScoreTier] ?? 0;
      if (full > 0) drainageStress = Math.min(1, Math.max(drainageStress, s.drainageM / full));
    }
    const { grid, toSettlement } = input.drainage.distances;
    const [minLon, minLat, maxLon, maxLat] = grid.bbox;
    const onGrid = point.lon >= minLon && point.lon < maxLon && point.lat > minLat && point.lat <= maxLat;
    inInformalSettlement = onGrid ? sampleGrid(grid, toSettlement, point.lon, point.lat) === 0 : false;
  }

  const mLon = M_PER_DEG_LON * Math.cos((point.lat * Math.PI) / 180);
  const near = dataset.buildings
    .map((b, index) => ({ index, tivKes: b.tivKes, m: Math.hypot((b.lon - point.lon) * mLon, (b.lat - point.lat) * M_PER_DEG_LAT) }))
    .sort((a, b) => a.m - b.m);
  const inside = near.filter((n) => n.m <= NEIGHBOUR_RADIUS_M);

  let wardPortfolio: FocusSite["wardPortfolio"] = null;
  if (building.ward && wards) {
    const indices = wardIndices(dataset.buildings, wards);
    let buildings = 0;
    let tivKes = 0;
    let all = 0;
    dataset.buildings.forEach((b, i) => {
      all += b.tivKes;
      if (indices[i] === building.ward!.index) {
        buildings += 1;
        tivKes += b.tivKes;
      }
    });
    wardPortfolio = { name: building.ward.name, subcounty: building.ward.subcounty, buildings, tivKes, shareOfPortfolioTiv: all > 0 ? tivKes / all : 0 };
  }

  return {
    ...point,
    approximate: building.approximate,
    waterwaysLoaded: waterways !== null,
    river: {
      statedName,
      statedDistanceM,
      quote: (extraction.terms.riverDistanceM.quote || extraction.terms.riverName.quote).trim(),
      named: statedName ? riverDistanceM(point, statedName, waterways) : null,
      nearest: nearestWaterway(point, waterways, ["river", "stream"]),
    },
    drain: nearestWaterway(point, waterways, DRAIN_KINDS),
    drainageStress,
    drainageReachM: input.drainage ? DRAINAGE_DEFAULTS.reachM : null,
    inInformalSettlement,
    mappedWater,
    neighbours: { radiusM: NEIGHBOUR_RADIUS_M, count: inside.length, tivKes: inside.reduce((t, n) => t + n.tivKes, 0), nearestM: near[0]?.m ?? null, indices: inside.map((n) => n.index) },
    wardPortfolio,
  };
}

const share = (change: number | null, base: number | null): number | null => (change !== null && base !== null && base > 0 ? change / base : null);

function portfolioOf(input: OfferFocusInput, pricing: OfferPricing, total: LossFigures, technical: TechnicalPrice, building: FocusBuilding, housingClass: HousingClass): FocusPortfolio {
  const { dataset } = input.session;
  const { result } = input.active;
  const effect = pricing.portfolio!;
  const a = effect.without;
  // The engine's own "with": the offer read at the stated point alone.
  const point = effect.with;
  // The offer's loaded loss on top of the portfolio's own, return period by return period. Reading a
  // curve at a return period and taking the area under it are both sums over its points, so the
  // portfolio's figure plus the offer's is exactly the figure of the two curves added together.
  const loaded100 = total.loss100GroundUpKes;
  const b: PortfolioFigures = {
    buildings: point.buildings,
    totalTivKes: point.totalTivKes,
    loss100Kes: a.loss100Kes !== null && loaded100 !== null ? a.loss100Kes + loaded100 : null,
    loss100Extrapolated: a.loss100Extrapolated,
    aalKes: a.aalKes + technical.model.aalGroundUpKes,
  };
  const loss100ChangeKes = a.loss100Kes !== null && loaded100 !== null ? loaded100 : null;
  const largestTivKes = dataset.buildings.reduce((m, x) => Math.max(m, x.tivKes), 0);
  const sameAsPortfolioView = Math.abs(a.aalKes - result.aalKes) <= 1e-6 * Math.max(1, result.aalKes) && a.buildings === result.buildingCount;

  // The portfolio after policy terms, with the offer's own gross loss added event by event.
  let gross: FocusPortfolio["gross"] = null;
  const pt = input.portfolioTerms;
  if (pt && sameAsPortfolioView && pt.scenarios.length === total.curve.length && pt.scenarios.every((s, k) => s.id === total.curve[k].id)) {
    const without: CurvePoint[] = pt.scenarios.map((s) => ({ returnPeriod: s.returnPeriod, lossKes: s.grossKes }));
    const withOffer: CurvePoint[] = without.map((p, k) => ({ returnPeriod: p.returnPeriod, lossKes: p.lossKes + total.curve[k].grossKes }));
    const without100Kes = lossAtReturnPeriod(without, 100).lossKes;
    const with100Kes = lossAtReturnPeriod(withOffer, 100).lossKes;
    const change100Kes = without100Kes !== null && with100Kes !== null ? with100Kes - without100Kes : null;
    gross = { without100Kes, with100Kes, change100Kes, change100Share: share(change100Kes, without100Kes), aalWithoutKes: averageAnnualLoss(without), aalWithKes: averageAnnualLoss(withOffer) };
  }

  // The class in the portfolio as the app shows it, flood by flood, matched by scenario id.
  const classContext: FocusPortfolio["classContext"] = sameAsPortfolioView
    ? {
        housingClass,
        buildings: result.scenarios[0]?.byClass[housingClass].count ?? 0,
        tivKes: result.scenarios[0]?.byClass[housingClass].tivKes ?? 0,
        perReturnPeriod: pricing.scenarios.flatMap((s) => {
          const c = result.scenarios.find((x) => x.id === s.id)?.byClass[housingClass];
          return c ? [{ id: s.id, returnPeriod: s.returnPeriod, flooded: c.affected, meanDamageRatio: c.tivKes > 0 ? c.lossKes / c.tivKes : 0, meanDamageRatioFlooded: c.tivExposedKes > 0 ? c.lossKes / c.tivExposedKes : null }] : [];
        }),
      }
    : null;

  return {
    without: a,
    with: b,
    sameAsPortfolioView,
    loss100ChangeKes,
    loss100ChangeShare: share(loss100ChangeKes, a.loss100Kes),
    aalChangeKes: technical.model.aalGroundUpKes,
    aalChangeShare: share(technical.model.aalGroundUpKes, a.aalKes),
    atPoint: { loss100ChangeKes: a.loss100Kes !== null && point.loss100Kes !== null ? point.loss100Kes - a.loss100Kes : null, aalChangeKes: point.aalKes - a.aalKes },
    tivShare: b.totalTivKes > 0 ? total.tivKes / b.totalTivKes : 0,
    largestTivKes,
    timesLargest: largestTivKes > 0 ? total.tivKes / largestTivKes : null,
    gross,
    classRange: classRangeOf(building, dataset),
    classContext,
  };
}

// ---------------------------------------------------------------------------------------------
// Flags and facts
// ---------------------------------------------------------------------------------------------

const figure = (text: string): FlagEvidence => ({ kind: "figure", text });
const quoteOr = (quote: string | undefined, fallback: string): FlagEvidence => (quote?.trim() ? { kind: "quote", text: quote.trim() } : figure(fallback));
const depthText = (m: number) => (m >= 0.005 ? `${fmtNum(m, 2)} m` : m > 0 ? "under 0.01 m" : "dry");

/** A check that did not pass, retitled as a point to weigh and given the sentence or figure behind it. */
function checkAsFlag(check: Check, extraction: OfferExtraction, rows: PricingRow[], pricing: OfferPricing, counts: Record<ValueStatus, number>, technical: TechnicalPrice | null): CheckInput {
  const [base, locId] = check.id.split(":");
  const row = rows.find((r) => r.locId === locId) ?? rows[0];
  const source = row ? extraction.rows[row.index] : undefined;
  const priced = pricing.rows.find((r) => r.locId === row?.locId);
  let title = check.title;
  let evidence: FlagEvidence = figure(check.detail);
  if (base === "offer-values") {
    title = counts.unverified > 0 ? `${plural(counts.unverified, "value is", "values are")} not verified against the document` : "No value could be read from the document";
    const first = [...extraction.rows.flatMap((r) => ROW_FIELDS.map((f) => r[f.key] as Quoted<unknown>)), ...TERM_FIELDS.map((f) => extraction.terms[f.key] as Quoted<unknown>), ...extraction.notes].find((q) => q.status === "unverified" && q.quote.trim());
    if (first) evidence = { kind: "quote", text: first.quote.trim() };
  } else if (base === "offer-coordinates") {
    const location = row?.location;
    if (!location || location.kind === "none") title = "The building has no usable location";
    else if (priced?.status === "outside") title = "The building is outside the hazard maps loaded";
    else if (location.kind === "approximate") title = "The location is approximate";
    else if (location.reading?.conflict) title = "The coordinates contradict themselves";
    else if (location.reading?.writtenBothWays) title = "The coordinates are written both ways";
    evidence = location?.kind === "approximate" ? quoteOr(extraction.terms.placeName.quote, check.detail) : quoteOr(source?.lat.quote, check.detail);
  } else if (base === "offer-river") {
    title = "The stated river distance is not confirmed by the map";
    evidence = quoteOr(extraction.terms.riverDistanceM.quote || extraction.terms.riverName.quote, check.detail);
  } else if (base === "offer-value-per-m2") {
    title = /below the lowest/.test(check.detail)
      ? "Value per m² is below the portfolio's range for its class: possible underinsurance"
      : /above the highest/.test(check.detail)
        ? "Value per m² is above the portfolio's range for its class"
        : "Value per m² could not be compared with the portfolio";
  } else if (base === "offer-basements") {
    // Water entering a basement is still not modelled. The price answers it with a loading, which is an assumption.
    title = technical?.loadings.applied.some((l) => l.id !== "drainage") ? "Basements are not modelled: the price carries a loading for them" : "Basements are not in the modelled loss";
    evidence = quoteOr(extraction.terms.basements.quote || usableNotes(extraction, "basement_plant")[0]?.quote, check.detail);
  } else if (base === "offer-flood-history") {
    title = "Flood history and the hazard maps disagree";
    evidence = quoteOr(usableNotes(extraction, "past_flood")[0]?.quote, check.detail);
  } else if (base === "offer-curve") {
    title = "A residential damage curve is used for a building that is not residential";
    evidence = quoteOr(extraction.terms.occupancy.quote, check.detail);
  }
  return { id: check.id, status: check.status, title, detail: check.detail, evidence };
}

function ownFlags(input: OfferFocusInput, extraction: OfferExtraction, terms: FocusTerms, building: FocusBuilding, price: FocusPrice, technical: TechnicalPrice, facts: FloodFacts): Flag[] {
  const flags: Flag[] = [];
  const add = (id: string, severity: Severity, title: string, detail: string, evidence: FlagEvidence) => flags.push({ id, severity, title, detail, evidence });
  const b = price.building;
  const { total, portfolio } = price;
  const { aroundSite, indicated, experience } = technical;
  const perMille = (v: number) => `${fmtNum(v, v !== 0 && Math.abs(v) < 0.1 ? 4 : 2)} per mille`;
  const loadingFor = (id: TechnicalPrice["loadings"]["applied"][number]["id"]) => technical.loadings.applied.find((l) => l.id === id);
  const loadingText = (share: number) => ` The price carries a loading of +${fmtPct(share, 0)} on the flood loss for it, which is an assumption.`;
  const isScore = input.session.dataset.hazardKind === "score";
  const depths = b.perReturnPeriod.map((r) => `${rpLabel(r.returnPeriod)} ${depthText(r.depthM)}`).join(", ");

  // Water at the building, and how often.
  if (b.firstWetReturnPeriod !== null) {
    const frequent = b.firstWetReturnPeriod <= FREQUENT_FLOOD_RP;
    add(
      "flood-depth",
      frequent ? "high" : "medium",
      `Water reaches the building from the ${rpLabel(b.firstWetReturnPeriod)} flood`,
      `The depth used at the building is above zero from the ${rpLabel(b.firstWetReturnPeriod)} flood onwards. A flood of ${rpLabel(FREQUENT_FLOOD_RP)} or more frequent is marked high.`,
      figure(`Depth used at the building: ${depths}.`),
    );
  } else if (aroundSite.perReturnPeriod.some((r) => r.wetCells > 0)) {
    // Dry at the stated point, but the radius read around it holds mapped water: that water is in the price.
    const widest = aroundSite.perReturnPeriod.reduce((m, r) => (r.wetCells > m.wetCells ? r : m));
    add(
      "dry-point-wet-nearby",
      "medium",
      `Dry at the stated point, but mapped flood water lies within ${fmtInt(aroundSite.radiusM)} m`,
      "Read at the stated point alone, the maps give no loss. The price counts the water around the site in proportion to the ground it covers, so a small error in the coordinates does not decide the answer.",
      figure(
        `${fmtInt(widest.wetCells)} of the ${fmtInt(aroundSite.cells)} map cells within ${fmtInt(aroundSite.radiusM)} m are wet in the ${rpLabel(widest.returnPeriod)} flood (${fmtPct(widest.wetShare, 1)})${b.nearestWetM !== null ? `, the nearest ${fmtDistance(b.nearestWetM)} from the point` : ""}. Average annual loss around the site, ground-up and before loadings: ${kes1(aroundSite.aalGroundUpKes)}, against ${kes1(technical.atPoint.aalGroundUpKes)} at the stated point.`,
      ),
    );
  } else if (b.nearestWetM !== null && b.nearestWetM <= NEAR_WET_CELL_M) {
    add(
      "near-water",
      "medium",
      `Dry on every map, but ${fmtDistance(b.nearestWetM)} from mapped flood water`,
      `The maps are dry at the stated point and across the ${fmtInt(aroundSite.radiusM)} m read around it, so this water is not in the price. A small error in the coordinates, or in the map, would change that.`,
      figure(`Nearest wet cell on any terrain map: ${fmtDistance(b.nearestWetM)} from the point (${building.approximate ? "approximate location" : "stated coordinates"}).`),
    );
  }

  // The price itself: when nothing the maps or the document give reaches the minimum, the minimum is the price.
  if (indicated.setBy === "minimum rate") {
    const blended = technical.buildUp.find((l) => l.id === "blended");
    add(
      "minimum-rate",
      "medium",
      "The indicated rate is the minimum rate, not a modelled loss",
      "What the maps and the document give comes to less than the minimum pure rate, so the minimum is the price. It is an assumption that no risk inside the mapped area is priced at zero, not a measurement of this risk.",
      figure(
        `Blended gross average annual loss ${kes1(blended?.aalGrossKes ?? 0)} (${perMille(blended?.ratePerMilleGross ?? 0)}), against the minimum of ${perMille(technical.judgement.minimumRatePerMille)}: ${kes1(indicated.aalGrossKes)} a year on a sum insured of ${kes1(technical.tivKes)}.`,
      ),
    );
  }

  // The size of the loaded 1-in-100 loss against the sum insured.
  if (total.loss100GrossKes !== null && total.tivKes > 0) {
    const lossShare = total.loss100GrossKes / total.tivKes;
    if (lossShare >= DEDUCTIBLE_LOSS_SHARE) {
      add(
        "loss-share",
        lossShare >= SUBLIMIT_LOSS_SHARE ? "high" : "medium",
        `The 1-in-100 gross loss is ${fmtPct(lossShare, 1)} of the sum insured`,
        `Marked medium from ${fmtPct(DEDUCTIBLE_LOSS_SHARE, 0)} of the sum insured and high from ${fmtPct(SUBLIMIT_LOSS_SHARE, 0)}.`,
        figure(`1-in-100 gross loss ${kes1(total.loss100GrossKes)} on a sum insured of ${kes1(total.tivKes)}.`),
      );
    }
  }
  if (total.loss100GrossKes === null || total.loss100Extrapolated) {
    add(
      "loss-100-not-read",
      "low",
      total.loss100GrossKes === null ? "No 1-in-100 loss can be read for this offer" : "The 1-in-100 loss is held flat beyond the rarest flood modelled",
      total.loss100GrossKes === null ? "A 1-in-100 flood is more frequent than the most frequent flood modelled under these assumptions." : "The rarest flood modelled is more frequent than 1-in-100 under these assumptions, so its loss stands in.",
      figure(`Return periods modelled: ${price.scenarios.map((s) => rpLabel(s.returnPeriod)).join(", ")}.`),
    );
  }

  // What the offer does to the portfolio.
  if (portfolio.loss100ChangeShare !== null && portfolio.loss100ChangeShare >= ACCUMULATION_MEDIUM_SHARE) {
    add(
      "portfolio-accumulation",
      portfolio.loss100ChangeShare >= ACCUMULATION_HIGH_SHARE ? "high" : "medium",
      `The offer adds ${fmtPct(portfolio.loss100ChangeShare, 1)} to the portfolio's 1-in-100 loss`,
      `Ground-up, before any terms. Marked medium from ${fmtPct(ACCUMULATION_MEDIUM_SHARE, 0)} and high from ${fmtPct(ACCUMULATION_HIGH_SHARE, 0)}.`,
      figure(`Portfolio 1-in-100 ground-up loss: ${kes1(portfolio.without.loss100Kes)} without the offer, ${kes1(portfolio.with.loss100Kes)} with it.`),
    );
  }
  if (portfolio.tivShare >= CONCENTRATION_MEDIUM_SHARE) {
    add(
      "single-risk-concentration",
      portfolio.tivShare >= CONCENTRATION_HIGH_SHARE ? "high" : "medium",
      `The offer would be ${fmtPct(portfolio.tivShare, 1)} of the portfolio's insured value`,
      `One risk holding a large share of the book. Marked medium from ${fmtPct(CONCENTRATION_MEDIUM_SHARE, 0)} and high from ${fmtPct(CONCENTRATION_HIGH_SHARE, 0)}.`,
      figure(`Sum insured ${kes1(total.tivKes)} against a portfolio of ${kes1(portfolio.without.totalTivKes)}${portfolio.timesLargest !== null ? `; ${fmtNum(portfolio.timesLargest, 1)} times the largest building now in it (${kes1(portfolio.largestTivKes)})` : ""}.`),
    );
  }

  // What the document itself reports.
  const plant = usableNotes(extraction, "basement_plant")[0];
  if (plant) {
    const loading = loadingFor("basement_plant");
    add(
      "critical-plant",
      b.dryAtEveryReturnPeriod ? "medium" : "high",
      "Critical plant is kept below ground",
      `Water entering a basement is not modelled.${loading ? loadingText(loading.share) : ""}${b.dryAtEveryReturnPeriod ? "" : " The maps show water at the building."}`,
      quoteOr(plant.quote, plant.value ?? NOTE_LABELS.basement_plant),
    );
  }
  const past = usableNotes(extraction, "past_flood")[0];
  if (past) {
    const inPrice =
      experience.usable && experience.burningCostKes !== null
        ? `The stated losses are in the price: ${kes1(experience.burningCostKes)} a year, given a weight of ${fmtPct(experience.weight, 0)}.`
        : `Its losses are not in the price. ${experience.why ?? ""} Ask for the loss history: with the years it covers and the amounts paid, code blends it in.`;
    add("past-flood-loss", "medium", "The document reports a past flood or water damage", `A site that has flooded before is likely to flood again. ${inPrice}`, quoteOr(past.quote, past.value ?? NOTE_LABELS.past_flood));
  }
  if (facts.drainagePoor) {
    const loading = loadingFor("drainage");
    add(
      "drainage-condition",
      "medium",
      "The document reports poor drainage at the site",
      `Blocked or undersized drains flood a site that the terrain maps show as dry.${loading ? loadingText(loading.share) : ""}`,
      quoteOr(facts.drainageQuote, facts.drainageCondition ?? NOTE_LABELS.drainage_condition),
    );
  }
  if (terms.floodCover === "excluded") {
    add("flood-excluded", "medium", "The document asks for flood to be excluded", "The figures here are what flood would cost if it were covered.", quoteOr(extraction.terms.floodCover.quote, "Flood cover: excluded."));
  }

  // What the figures rest on.
  const ponding = b.perReturnPeriod.filter((r) => r.depthFrom === "drainage");
  if (ponding.length > 0) {
    add(
      "drainage-ponding",
      "low",
      "The depth here comes from assumed drainage ponding",
      "The terrain maps are shallower at this point than the ponding assumed near drains and informal settlements, so the loss rests on that assumption.",
      figure(`Ponding against terrain depth: ${ponding.map((r) => `${rpLabel(r.returnPeriod)} ${depthText(r.drainageM)} against ${depthText(r.terrainM)}`).join(", ")}.`),
    );
  }
  if (terms.deductible.source === "example terms" || terms.limit.source === "example terms") {
    const which = terms.deductible.source === "example terms" && terms.limit.source === "example terms" ? "Both the deductible and the limit are" : terms.deductible.source === "example terms" ? "The deductible is" : "The limit is";
    add(
      "example-terms",
      "low",
      "The gross loss uses example terms where the document states none",
      `${which} taken from the Insurance terms panel, not from the offer. The gross figures change when the real terms are known.`,
      figure(`Deductible used: ${terms.deductible.text} Limit used: ${terms.limit.text}`),
    );
  }
  if (building.tivFrom === "area_times_cost") {
    add(
      "sum-insured-worked-out",
      "low",
      "The sum insured is not stated: it is floor area × cost per m²",
      "Every loss and rate here is measured against that worked-out value.",
      quoteOr(extraction.rows[building.index]?.floorAreaM2.quote, `${fmtInt(building.floorAreaM2 ?? 0)} m² × ${kes1(building.costPerM2Kes)} per m².`),
    );
  }
  if (isScore) {
    add(
      "proxy-hazard",
      "low",
      "Depth is an assumed scale on a susceptibility score, not a measured depth",
      "The hazard maps give a 0 to 1 score built from terrain and distance to rivers. The depth scale and the return periods are assumptions.",
      figure(`Depth scale ${fmtNum(input.active.params.depthScaleM, 2)} m at a score of 1; return periods ${price.scenarios.map((s) => rpLabel(s.returnPeriod)).join(", ")}.`),
    );
  }
  const optimist = price.assumptions.find((a) => a.id === "optimist");
  const cautious = price.assumptions.find((a) => a.id === "cautious");
  if (optimist && cautious && cautious.aalGrossKes > 0 && cautious.aalGrossKes >= ASSUMPTION_SPREAD_RATIO * optimist.aalGrossKes) {
    add(
      "assumption-spread",
      "medium",
      "The price rests heavily on the assumptions",
      `The Cautious agent's assumptions give ${optimist.aalGrossKes > 0 ? `${fmtNum(cautious.aalGrossKes / optimist.aalGrossKes, 1)} times` : "a loss where"} the Optimist's ${optimist.aalGrossKes > 0 ? "indicated average annual loss" : "give none"} for the same building.`,
      figure(`Indicated average annual loss, gross: ${price.assumptions.map((a) => `${a.label} ${kes1(a.aalGrossKes)}`).join(", ")}.`),
    );
  }
  return flags;
}

function factsOf(extraction: OfferExtraction, counts: Record<ValueStatus, number>, building: FocusBuilding | null, price: FocusPrice | null, flags: Flag[]): OfferFacts {
  const occupancy = usableValue(extraction.terms.occupancy);
  return {
    basements: usableValue(extraction.terms.basements),
    criticalPlantInBasement: usableNotes(extraction, "basement_plant").length > 0,
    pastFloodLoss: usableNotes(extraction, "past_flood").length > 0,
    dryInEveryTier: price?.building.dryAtEveryReturnPeriod ?? false,
    nearestWetCellM: price?.building.nearestWetM ?? null,
    approximateLocation: building?.approximate ?? false,
    unverifiedValues: counts.unverified,
    underInsured: price?.portfolio.classRange?.position === "below",
    commercialOnResidentialCurve: occupancy !== null && occupancy !== "residential",
    drainagePoor: flags.some((f) => f.id === "drainage-condition"),
    grossLoss100Kes: price?.total.loss100GrossKes ?? null,
    tivKes: price?.total.tivKes ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// The focus
// ---------------------------------------------------------------------------------------------

/**
 * The offer as every step sees it. Pure: the same input gives the same focus, and nothing is
 * fetched or stored. Fast enough to run on every edit of a field (the tests time it on the
 * Nairobi starter kit). Returns null when there is no offer.
 */
export function buildOfferFocus(input: OfferFocusInput): OfferFocus | null {
  const { offer, layers } = input;
  if (!offer) return null;
  const { document, run, extraction } = offer;
  const { dataset } = input.session;

  const waiting = waitingList(extraction);
  const held = waiting.length > 0;
  const counts = statusCounts(extraction);
  const policy = policyTerms(extraction.terms, input.policyDefaults);
  const terms = termsUsed(policy, extraction.terms);
  const fieldsRead = counts.verified + counts.unverified + counts.confirmed + counts.edited;

  const common = {
    documentName: document.name,
    coverage: coverageOf(dataset),
    waiting,
    document: documentRecord(document, run),
    extraction,
    fields: fieldList(extraction, run.path, new Set(waiting.map((w) => w.fieldId))),
    counts,
    several: extraction.rows.length > 1,
    datasetName: dataset.name,
    hazardKind: dataset.hazardKind,
    drainageOn: input.drainage !== null,
    assumptionsInForce: input.active.source,
    terms,
  };
  const summary = (loss100Kes: number | null, aalKes: number | null, outside: boolean): FocusSummary => ({ name: document.name, fieldsRead, fieldsVerified: counts.verified, loss100Kes, aalKes, outside });

  // The ward map decides where a place name is and which ward a point falls in: nothing is placed without it.
  if (!layers) {
    return {
      ...common,
      line: lineOf(extraction, [], null),
      status: "locating",
      statusLine: "Loading the ward map before the offer is placed.",
      outside: false,
      outsideMessage: null,
      buildings: [],
      building: null,
      severalLine: null,
      judgement: judgementOf(input, null, "none"),
      technical: null,
      price: null,
      site: null,
      checks: [],
      flags: [],
      facts: factsOf(extraction, counts, null, null, []),
      conditions: [],
      summary: summary(null, null, false),
      rows: [],
      pricing: null,
    };
  }

  // Code only from here on. The rows hold usable values and nothing else: an unverified value is
  // left out and blocks the row it belongs to, so nothing is priced around it.
  const rows = pricingRows(extraction, layers.wards, dataset.hotspots);
  const pricing = priceOffer({ dataset, params: input.active.params, drainage: input.drainage, rows, terms: policy, wards: layers.wards });
  const allChecks = offerChecks({ extraction, rows, pricing, dataset, waterways: layers.waterways });
  // While pricing waits, the checks that rest on a price or a location wait with it.
  const checks = held ? allChecks.filter((c) => c.id === "offer-values") : allChecks;

  const buildings = rows.map((row, i) => buildingOf(row, pricing.rows[i], layers.wards));
  const pricedRows = pricing.rows.filter((r): r is PricedRow => r.status === "priced");
  // A row with a location that is not "outside" is inside the maps, priced or not: outside is tested first.
  const anyInside = buildings.some((b) => b.status !== "outside" && b.lat !== null);
  const outside = buildings.some((b) => b.status === "outside") && !anyInside;
  let status: OfferFocus["status"] = outside ? "outside" : held ? "waiting" : pricedRows.length > 0 && pricing.totals ? "priced" : "not_ready";

  const followed = (status === "priced" ? buildings.find((b) => b.status === "priced") : outside ? buildings.find((b) => b.status === "outside") : undefined) ?? buildings[0] ?? null;
  const followedPriced = followed ? (pricedRows.find((r) => r.locId === followed.locId) ?? null) : null;
  const severalLine =
    buildings.length > 1 && followed
      ? `This offer lists ${plural(buildings.length, "building")}. The steps follow ${followed.name}${status === "priced" ? `, the first of the ${fmtInt(pricedRows.length)} priced; the totals cover all of them` : ""}.`
      : null;

  // Where the building is does not wait for the price, and the agents' brief is compared against it.
  const maps = mapsFor(dataset, input.drainage);
  const site = followed ? siteOf(followed, input, extraction, followedPriced, maps) : null;

  // The judgement in force. The agents' figures count only when they argued the offer now on screen.
  const argued = input.deliberation?.offerJudgement ?? null;
  const ran: FocusJudgement["agents"] = !argued ? "none" : !argued.brief || sameOffer(argued.brief, briefFacts(extraction, followed, site)) ? "this_offer" : "another_offer";
  const agents = ran === "this_offer" ? argued : null;
  const judgement = judgementOf(input, agents, ran);
  const floodFacts = floodFactsOf(extraction);

  // The technical price: the maps around the site, the document's story and its loss history, by code.
  let technical: TechnicalPrice | null = null;
  let priceWith: ((params: ModelParams, figures: OfferJudgement) => TechnicalPrice | null) | null = null;
  if (status === "priced" && followedPriced) {
    const history = statedFloodHistory(extraction);
    // A priced row always has a location. Were one without, it has no point to read and no figure is given.
    const asBuilding = (r: PricedRow): TechnicalBuilding => ({ lon: r.location.kind === "none" ? Number.NaN : r.location.lon, lat: r.location.kind === "none" ? Number.NaN : r.location.lat, housingClass: r.housingClass, tivKes: r.tivKes });
    const building = asBuilding(followedPriced);
    const others = pricedRows.filter((r) => r !== followedPriced).map(asBuilding);
    priceWith = (params, figures) => technicalPrice({ dataset: maps, params, building, others, terms: policy, history, facts: floodFacts, judgement: figures });
    technical = priceWith(input.active.params, judgement.inForce);
    // The engine has already found every building inside every map, so this does not happen. Were it to, no figure is shown.
    if (!technical) status = "not_ready";
  }

  let price: FocusPrice | null = null;
  if (status === "priced" && followed && followedPriced && pricing.totals && technical && priceWith) {
    const follow = pricedRows.indexOf(followedPriced);
    const tivs = pricedRows.map((r) => r.tivKes);
    const params = input.active.params;
    const cls = followedPriced.housingClass;

    const perReturnPeriod: FocusReturnPeriod[] = followedPriced.scenarios.map((s, k) => {
      const d = damageDetail(s.depthM, cls, params);
      const split = termsSplit(pricedRows.map((r) => r.scenarios[k].groundUpKes), tivs, policy)[follow];
      return {
        id: s.id,
        label: s.label,
        returnPeriod: s.returnPeriod,
        hazard: s.hazard,
        terrainM: s.terrainM,
        drainageM: s.drainageM,
        depthM: s.depthM,
        depthFrom: !(s.depthM > 0) ? "dry" : s.drainageM > s.terrainM ? "drainage" : "terrain",
        effectiveDepthM: d.effectiveDepthM,
        curveDamage: d.curveDamage,
        damageRatio: s.damageRatio,
        capped: d.capped,
        groundUpKes: s.groundUpKes,
        deductibleKes: split.deductibleKes,
        overLimitKes: split.overLimitKes,
        grossKes: s.grossKes,
        nearestWetM: s.nearestWetM,
      };
    });
    const wetDistances = followedPriced.scenarios.map((s) => (s.hazard > 0 ? 0 : s.nearestWetM)).filter((m): m is number => m !== null);
    const firstWet = perReturnPeriod.find((r) => r.depthM > 0);
    const building: FocusBuildingPrice = {
      ...lossFigures(followedPriced.tivKes, followedPriced.scenarios.map((s) => ({ id: s.id, label: s.label, returnPeriod: s.returnPeriod, groundUpKes: s.groundUpKes, grossKes: s.grossKes }))),
      locId: followedPriced.locId,
      housingClass: cls,
      fragility: params.fragility[cls],
      cap: params.cap[cls],
      perReturnPeriod,
      dryOnEveryTerrainMap: followedPriced.dryInEveryTier,
      dryAtEveryReturnPeriod: !firstWet,
      firstWetReturnPeriod: firstWet?.returnPeriod ?? null,
      nearestWetM: wetDistances.length > 0 ? Math.min(...wetDistances) : null,
    };
    // At the stated point the figures are the engine's own. The headline figures are the technical price's.
    const atPoint = lossFigures(pricing.totals.tivKes, pricing.totals.scenarios);
    const total = technicalFigures(technical);

    // The same rows under each set of assumptions: that set's parameters, and its own judgement
    // figures when the agents argued this offer. What the underwriter typed goes over every set.
    const d = input.deliberation;
    const sets: { id: AssumptionPrice["id"]; params: ModelParams; own: OfferJudgement | null }[] = [
      { id: "reference", params: REFERENCE_PARAMS, own: null },
      ...(d?.optimist ? [{ id: "optimist" as const, params: d.optimist.params, own: agents?.optimist ?? null }] : []),
      ...(d?.cautious ? [{ id: "cautious" as const, params: d.cautious.params, own: agents?.cautious ?? null }] : []),
      ...(d?.final ? [{ id: "agreed" as const, params: d.final.params, own: agents?.final ?? null }] : []),
    ];
    const inForceId: AssumptionPrice["id"] = input.active.source === "ai" && d?.final ? "agreed" : "reference";
    const assumptions = sets.map((set): AssumptionPrice => {
      const inForce = set.id === inForceId;
      // The set in force takes the figures already worked out: the engine's at the point, and the technical price above.
      const under = priceUnder(dataset, set.params, policy, pricedRows, follow);
      const figures = inForce ? judgement.inForce : withTyped(set.own ? enforceJudgement(set.own).judgement : REFERENCE_JUDGEMENT, judgement.typed);
      const priced = inForce ? technical! : (priceWith!(set.params, figures) ?? technical!);
      const headline = inForce ? total : technicalFigures(priced);
      const point = inForce ? atPoint : under.total;
      return {
        id: set.id,
        label: ASSUMPTION_LABELS[set.id],
        inForce,
        params: set.params,
        judgement: figures,
        judgementFromAgents: set.own !== null,
        loss100GrossKes: headline.loss100GrossKes,
        loss100GroundUpKes: headline.loss100GroundUpKes,
        loss100Extrapolated: headline.loss100Extrapolated,
        aalGrossKes: headline.aalGrossKes,
        aalGroundUpKes: headline.aalGroundUpKes,
        ratePerMilleGross: headline.ratePerMilleGross,
        setBy: priced.indicated.setBy,
        atPoint: {
          loss100GrossKes: point.loss100GrossKes,
          loss100GroundUpKes: point.loss100GroundUpKes,
          loss100Extrapolated: point.loss100Extrapolated,
          aalGrossKes: point.aalGrossKes,
          aalGroundUpKes: point.aalGroundUpKes,
          ratePerMilleGross: point.ratePerMilleGross,
        },
        building: under.building,
      };
    });

    price = {
      scenarios: pricing.scenarios,
      pricedCount: pricedRows.length,
      building,
      total,
      atPoint,
      portfolio: portfolioOf(input, pricing, total, technical, followed, cls),
      assumptions,
    };
  }
  if (!price) technical = null;

  const fromChecks = checks.filter((c) => c.status !== "pass").map((c) => checkAsFlag(c, extraction, rows, pricing, counts, technical));
  const flags = flagsFromChecks(fromChecks, price && followed && technical ? ownFlags(input, extraction, terms, followed, price, technical, floodFacts) : []);
  const facts = factsOf(extraction, counts, followed, price, flags);

  const statusLine =
    status === "outside"
      ? `${OUTSIDE_MAPS_MESSAGE}.`
      : status === "waiting"
        ? `Pricing is waiting for ${plural(waiting.length, "value")}: ${waiting.map((w) => `${w.where.toLowerCase()}, ${w.label.toLowerCase()}`).join("; ")}.`
        : status === "priced"
          ? "Priced by code on the hazard maps loaded."
          : `Not priced yet. ${buildings.flatMap((b) => b.blockers).join(" ") || (buildings.length > 0 ? "The hazard maps could not be read around the building." : "The offer lists no building.")}`;

  return {
    ...common,
    line: lineOf(extraction, rows, followed),
    status,
    statusLine,
    outside,
    outsideMessage: outside ? OUTSIDE_MAPS_MESSAGE : null,
    buildings,
    building: followed,
    severalLine,
    judgement,
    technical,
    price,
    site,
    checks,
    flags,
    facts,
    conditions: suggestedConditions(flags, facts),
    summary: summary(price?.total.loss100GrossKes ?? null, price?.total.aalGrossKes ?? null, outside),
    rows,
    pricing,
  };
}
