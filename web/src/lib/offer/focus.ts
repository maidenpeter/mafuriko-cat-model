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
import { kes1, LOSS_MODE_LABELS, perMille, rpLabel, SETTER_ORDER, SETTER_WORDS } from "../labels";
import type { LossMode } from "../model/drivers";
import { averageAnnualLoss, lossAtReturnPeriod, STANDARD_RETURN_PERIODS, type CurvePoint } from "../model/financial";
import { REFERENCE_PARAMS } from "../model/params";
import { runModel } from "../model/pipeline";
import { DEFAULT_TERMS, policyLoss, sanitiseTerms } from "../model/terms";
import { HOUSING_LABELS, type Building, type Dataset, type HazardKind, type HousingClass, type ModelParams, type ModelResult, type ScoreTier } from "../model/types";
import { damageDetail } from "../model/vulnerability";
import { offerChecks, offerDriverChecks, valuePerM2Of, type ValuePerM2 } from "./checks";
import { describeReading } from "./coords";
import {
  DRIVER_LABELS,
  drainageFact,
  offerDrivers,
  statedFloodHistory,
  statedValues,
  usableNotes,
  type DriverBuilding,
  type DriverId,
  type DriverReturnPeriod,
  type OfferDrivers,
  type OfferStated,
  type StatedValue,
} from "./drivers";
import { NOTE_LABELS } from "./extraction";
import { DRIVER_FIELDS, equipmentLabel, fieldLabel, fieldText, historyFieldDef, historyFields, ROW_FIELDS, TERM_FIELDS, type FieldDef } from "./fields";
import { AGENT_JUDGEMENT_KEYS, BASEMENT_LADDER, enforceJudgement, JUDGEMENT_KEYS, OUTAGE_LADDER, REFERENCE_JUDGEMENT, type OfferJudgement } from "./judgement";
import { nearestWaterway, riverDistanceM, wardOf, type WaterwayMatch } from "./locate";
import { priceOffer, pricingRows } from "./price";
import { brokerQuestions } from "./questions";
import { describeRemoved } from "./redact";
import { fmtDistance, fmtPoint, plural } from "./shared";
import { describeTerms, policyTerms } from "./terms";
import {
  OUTSIDE_MAPS_MESSAGE,
  type BrokerQuestion,
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
 * is, what the document says and how it was read, the water at the building and each loss driver's
 * loss for every return period, what the terms take off, what the offer adds to the portfolio, the
 * premium build-up, the price under each set of assumptions, the checks, the questions for the
 * broker, and the points an underwriter should weigh.
 *
 * How to use it:
 *
 *   const focus = useMemo(() => buildOfferFocus({ offer, session: view, active, drainage, policyDefaults: terms,
 *     deliberation: viewDeliberation, layers, mode, judgement: typedJudgement }), [...]);
 *
 *   focus === null            no offer has been read
 *   focus.status              "locating" | "waiting" | "outside" | "not_ready" | "priced"
 *   isPriced(focus)           true when every loss figure is there: focus.price, focus.drivers, focus.building and focus.site are set
 *   focus.outside             true with focus.outsideMessage when the building lies outside the hazard maps: no loss fields
 *   focus.waiting             the values that hold pricing up, each as a sentence
 *
 * The price is the sum of the loss drivers (drivers.ts, method at the top of judgement.ts), then
 * the deductible and the limit. The header switch chooses the mode:
 *
 *   "depth_only"   the depth at the stated point and drainage ponding, nothing else: the model as
 *                  it was before the drivers, to the last decimal
 *   "all_drivers"  surrounding flooding, drainage ponding, drain overload, basement ingress,
 *                  business interruption and the uncertainty loading
 *
 *   focus.mode                the mode in force
 *   focus.drivers             every driver per return period, each with its source; the building as
 *                             components; average annual loss by driver; the premium build-up
 *   focus.judgement           the judgement figures in force, and who set each one
 *   focus.questions           what to ask the broker: every value that matters to the price and is not stated
 *   focus.price.total         the headline figures under the mode in force
 *   focus.price.depthOnly     the same offer with Depth only, whatever the mode, so the effect of the drivers can be shown
 *   focus.price.building      the followed building: water, damage and loss per return period
 *
 * Words: "at the point" and "within the buffer" for the two map depths; the drivers by the names in DRIVER_LABELS.
 *
 * Every step of the walkthrough receives these props:
 *   focus        PricedFocus | null     the priced offer while the header switch is on "Offer", otherwise null
 *   offerFocus   OfferFocus | null      the offer whatever the switch says and whether or not it is priced
 *   mode         LossMode               "depth_only" or "all_drivers", as the header switch says
 *   judgement    FocusJudgement         the judgement figures in force and who set each: the offer's, or the portfolio's when no offer is read
 *   onJudgement  (next) => void         types over any judgement figure: see OfferFocusProps
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

// ---------------------------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------------------------

/** Where a value shown to the underwriter came from, in the words of the table of fields. */
export type FieldOrigin = "AI, verified" | "AI, unverified" | "rules" | "confirmed" | "edited" | "not stated";

/** The mark a quote carries in the document panel. The same five words as DocumentQuotes' QuoteStatus. */
export type QuoteMark = "verified" | "unverified" | "rules" | "confirmed" | "edited";

/** One value read from the document, flat, ready for a table row and for DocumentQuotes. */
export interface FocusField {
  /** Stable id: "row:0:tivKes", "terms:floodLimitKes", "equipment:1", "note:2", "loss:0:amountKes". Use it as the quote id and the row key. */
  id: string;
  /** Points at the value in the extraction, for editValue and confirmValue. */
  ref: ValueRef;
  /** Which part of the offer it belongs to: a building's row, the flood terms (the document's own loss history among them), the site facts, or a flood note. */
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
  /**
   * The value per m² set against the class range: the building's own value ÷ floor area where the
   * offer states that value, otherwise insured value ÷ floor area, or the stated cost per m² when
   * either is missing. null when none can be had.
   */
  valuePerM2Kes: number | null;
  /** Which of those it is, and how it was worked out in a few words. null and "" when there is none. */
  valuePerM2From: ValuePerM2["from"];
  valuePerM2How: string;
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

/** One return period at the followed building, from the hazard map to the gross loss, under the mode in force. */
export interface FocusReturnPeriod {
  /** The scenario's id in the dataset: a tier name ("common") or a return period tag ("rp100y"). */
  id: string;
  /** The scenario's label in the dataset. */
  label: string;
  /** Return period in years, under the assumptions in force. */
  returnPeriod: number;
  /** The raw value of the hazard map at the point: a 0 to 1 score, or a depth in metres. */
  hazard: number;
  /** Depth at the point, from the terrain map alone, in metres. */
  terrainM: number;
  /** The highest map depth within the buffer, in metres. Never below terrainM. Counted only with all loss drivers. */
  bufferM: number;
  /** Drainage ponding at the point, in metres. 0 when drainage is off or the point is outside its reach. */
  drainageM: number;
  /** True when the event is rarer than the drains were designed for. Counted only with all loss drivers. */
  overloaded: boolean;
  /** Surface water from drain overload, in metres. 0 when the drains are not overloaded. */
  overloadM: number;
  /** The depth the damage curve was read at: the deepest water at the site under the mode in force. */
  depthM: number;
  /** Which reading gave the depth used. "dry" when all are zero. "buffer" and "overload" appear only with all loss drivers. */
  depthFrom: "terrain" | "buffer" | "drainage" | "overload" | "dry";
  /** The depth on the curve after the class's fragility multiplier: depth × fragility. */
  effectiveDepthM: number;
  /** The damage the curve gives at that depth, before the class's cap. */
  curveDamage: number;
  /** The structure's damage ratio: the curve's damage, or the cap where that is lower. */
  damageRatio: number;
  /** True when the cap, not the curve, set the damage ratio. */
  capped: boolean;
  /** Each driver's ground-up loss for this building. With Depth only, drivers 3 to 6 are zero. */
  byDriverKes: Record<DriverId, number>;
  /** Ground-up loss of the building: the drivers added up. With Depth only this is damage ratio × insured value. */
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
 * A loss curve and the figures read off it: for the followed building, or for the whole offer.
 * The average annual loss is the area under the curve, worked out as the portfolio's is, and the
 * rates are pure rates: average annual loss ÷ insured value. The flood premium, with its capital
 * load and minimum rate, is in OfferFocus.drivers.premium.
 */
export interface LossFigures {
  /** The insured value the losses and rates are measured against. */
  tivKes: number;
  /** One point per modelled return period, most frequent first. */
  curve: (OfferScenario & { groundUpKes: number; grossKes: number })[];
  /** The curve read at 10, 25, 50, 100 and 250 years, interpolated the way the portfolio's standard losses are. null where the return period is more frequent than anything modelled. */
  standard: { returnPeriod: number; groundUpKes: number | null; grossKes: number | null; extrapolated: boolean }[];
  /** Average annual loss before any terms. */
  aalGroundUpKes: number;
  /** Average annual loss after the deductible and the limit. */
  aalGrossKes: number;
  /** Pure flood rate, ground-up: average annual loss ÷ insured value × 1000. Before the capital load, the minimum rate, expenses and profit. */
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

/** The followed building under the mode in force: the trace from the map cell to the gross loss. */
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
  /** True when the terrain map is dry at the point in every return period. Water within the buffer, ponding or drain overload may still reach the site. */
  dryOnEveryTerrainMap: boolean;
  /** True when the terrain map and the drainage ponding are both zero at the point in every return period: what Depth only prices at zero. */
  dryAtPointEveryReturnPeriod: boolean;
  /** True when the depth used is zero at every return period, under the mode in force. */
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
 * The portfolio is run in the mode in force: with all loss drivers its buildings carry drivers 1
 * to 3 (they have no basement data, so drivers 4 and 5 stay off for them). The offer is added
 * with its own ground-up loss at each return period, all of its drivers summed.
 */
export interface FocusPortfolio {
  /** The portfolio as loaded, under the assumptions, the flood source and the mode in force. */
  without: PortfolioFigures;
  /** The same portfolio with the offer added: its ground-up loss at each return period on top of the portfolio's own. */
  with: PortfolioFigures;
  /** True when "without" is exactly the portfolio the rest of the app shows (the figures in the header in Portfolio mode). */
  sameAsPortfolioView: boolean;
  /** What the offer adds to the portfolio's 1-in-100 ground-up loss: its own 1-in-100 loss. null when either side is not modelled. The capital load is not worked out from this but from the gross change (gross.change100Kes), like every other line of the premium. */
  loss100ChangeKes: number | null;
  /** The same as a fraction of the portfolio's 1-in-100 before the offer: 0.004 is 0.4%. null as above, or when that loss is zero. */
  loss100ChangeShare: number | null;
  /** What the offer adds to the portfolio's ground-up average annual loss. */
  aalChangeKes: number;
  /** The same as a fraction of the portfolio's average annual loss before the offer. null when that is zero. */
  aalChangeShare: number | null;
  /** The same two changes with the offer priced on Depth only, whatever the mode in force. */
  depthOnly: { loss100ChangeKes: number | null; aalChangeKes: number };
  /** The offer's insured value as a share of the portfolio's with the offer in it: 0.06 is 6%. */
  tivShare: number;
  /** The largest single insured value in the portfolio before the offer. */
  largestTivKes: number;
  /** The offer's insured value as a multiple of that largest one. null when the portfolio is empty. */
  timesLargest: number | null;
  /**
   * The same comparison after policy terms: the portfolio's gross 1-in-100 and average annual loss
   * without and with the offer. The portfolio's buildings are on the panel's example terms, the
   * offer on its own. null only when the portfolio's scenarios do not line up with the offer's.
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
 * The offer priced under one set of assumptions, in the mode in force. The rows are the same; what
 * differs is the model's parameters and, when the agents argued the offer, the judgement figures.
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
   * The judgement figures this set was priced with: this set's own where the agents gave them for
   * the offer, otherwise the reference values. A figure the underwriter typed replaces that figure
   * in every set, and a figure the document states is used in every set, so the sets stay comparable.
   */
  judgement: OfferJudgement;
  /** True when the agents gave this set its own judgement figures for the offer. */
  judgementFromAgents: boolean;
  /** Whole offer, gross loss in a 1-in-100 flood. null when 100 years is more frequent than anything modelled under this set. */
  loss100GrossKes: number | null;
  /** Whole offer, ground-up loss in a 1-in-100 flood. */
  loss100GroundUpKes: number | null;
  /** True when those two are held flat beyond the rarest modelled flood. */
  loss100Extrapolated: boolean;
  /** Whole offer, average annual loss, gross. */
  aalGrossKes: number;
  /** Whole offer, average annual loss, ground-up. */
  aalGroundUpKes: number;
  /** Whole offer, pure rate per mille, gross: average annual loss ÷ insured value. */
  ratePerMilleGross: number;
  /** Whole offer, gross average annual loss by driver under this set. */
  aalGrossByDriverKes: Record<DriverId, number>;
  /** The flood premium under this set: modelled loss, uncertainty and capital load, or the minimum where that is larger. */
  floodPremiumKes: number;
  /** The same per mille of the insured value. */
  floodRatePerMille: number;
  /** Which of the two set the flood premium under this set. */
  premiumSetBy: "modelled" | "minimum rate";
  /** The same set with Depth only, whatever the mode in force: the point pricing as the engine gives it. */
  depthOnly: { loss100GrossKes: number | null; loss100GroundUpKes: number | null; loss100Extrapolated: boolean; aalGrossKes: number; aalGroundUpKes: number; ratePerMilleGross: number };
  /** The followed building under this set, one point per return period, most frequent first: for its points on the class curve. */
  building: { id: string; returnPeriod: number; depthM: number; effectiveDepthM: number; damageRatio: number; capped: boolean; groundUpKes: number; grossKes: number }[];
}

/** Who set a judgement figure. */
export type JudgementSetter = "offer" | "agents" | "typed" | "reference";

/** The judgement figures behind the loss drivers and the premium, and who set each one. */
export interface FocusJudgement {
  /**
   * The figures the offer is priced with. Where the document itself states a figure (setBy "offer":
   * the drain design return period, the value below ground, a year's rent or revenue) that figure
   * is here in place of the assumption, the last two as a share of the insured value.
   */
  inForce: OfferJudgement;
  /**
   * The assumptions alone, each inside its allowed range: the reference values, the agents' agreed
   * figures while "Agreed by agents" is on, and anything the underwriter typed. The portfolio's
   * buildings are run with these, and they stand behind every figure the document does not state.
   */
  assumed: OfferJudgement;
  /** The reference values. */
  reference: OfferJudgement;
  /** The figures the agents agreed when they ran with this offer: the ones they may argue, kept in range. null when they have not. */
  agreed: Partial<OfferJudgement> | null;
  /** The figures the underwriter typed, as used. Empty when none is typed. */
  typed: Partial<OfferJudgement>;
  /**
   * Who set each figure in force:
   *   "offer"      read from the document, with its sentence in `fromOffer`
   *   "typed"      the underwriter typed over it
   *   "agents"     the set the agents agreed for this offer, while "Agreed by agents" is on
   *   "reference"  the reference value: no agent has argued this offer, or "Reference, no AI" is on
   * A rung of a ladder that code raised to keep the ladder rising is marked with whoever set the
   * rung that pushed it up, never "reference" beside a figure that is not the reference value:
   * `raised` says so.
   */
  setBy: Record<keyof OfferJudgement, JudgementSetter>;
  /**
   * The ladder rungs code raised to keep a ladder rising with rarity: the value the rung's own
   * setter gave it, the value in force, and who set the more frequent rung that pushed it up.
   * Empty when none was raised.
   */
  raised: Partial<Record<keyof OfferJudgement, { from: number; to: number; by: "typed" | "agents"; reason: string }>>;
  /** The figures the document states itself, each with its sentence. `value` is in the judgement figure's own unit. */
  fromOffer: Partial<Record<keyof OfferJudgement, { value: number; what: string; quote: string }>>;
  /**
   * Whether the agents have argued the judgement figures:
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
  /** The building the steps follow, the first priced one, under the mode in force: the trace from the map cell to the gross loss. */
  building: FocusBuildingPrice;
  /** The headline figures under the mode in force, for every priced building of the offer together: the drivers summed at each return period. */
  total: LossFigures;
  /** The same offer with Depth only, whatever the mode in force: the engine's point pricing. With "depth_only" in force it equals `total`. */
  depthOnly: LossFigures;
  /** What the offer does to the portfolio. */
  portfolio: FocusPortfolio;
  /** The offer priced on the reference assumptions, and on the Optimist's, the Cautious and the agreed set once the agents have run. */
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
  /** Every value as a flat list, in the order shown: each building's values, the flood terms, the site facts, the notes, then the document's own loss history. */
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
  /** The mode the figures are in: "depth_only" (the point and ponding alone) or "all_drivers". */
  mode: LossMode;
  /** The deductible and the limit in force and where each came from. */
  terms: FocusTerms;

  // --- the price --------------------------------------------------------------------------------
  /** The judgement figures behind the loss drivers and the premium, and who set each one. Present whether or not the offer is priced. */
  judgement: FocusJudgement;
  /**
   * The loss drivers under the mode and the judgement in force: the water at the site and each
   * driver's loss per return period with its source, the building as components, average annual
   * loss by driver and the premium build-up. null unless status is "priced": outside the maps, or
   * while a value waits, there is no figure.
   */
  drivers: OfferDrivers | null;
  /** Depth, damage, loss, the portfolio effect and the price under each set of assumptions. null unless status is "priced". */
  price: FocusPrice | null;
  /** Distances to rivers and drains, drainage stress and the portfolio around the site. null when the followed building has no location or is outside the maps. */
  site: FocusSite | null;

  // --- for the underwriter ----------------------------------------------------------------------
  /** What to ask the broker: one plain question for each value that matters to the price and is not stated. Never a guess. */
  questions: BrokerQuestion[];
  /**
   * Every check on the offer, in one list: what was read and where the building is, then, once the
   * offer is priced, the three checks on its loss drivers (OFFER_DRIVER_CHECK_IDS in checks.ts).
   * While pricing waits, only the check on the values themselves. Read this list as it is: nothing
   * is to be added to it.
   */
  checks: Check[];
  /** Points to weigh, worst first: every check that did not pass, and the flags below, each with a document quote or a model figure. */
  flags: Flag[];
  /**
   * What suggestedConditions needs, filled from the document and the price. The six facts behind
   * the loss drivers (equipment below ground, the drain design, pump backup, barriers, valves,
   * interruption cover) are filled from the document's usable values once the offer is priced, and
   * left out before that, when no price rests on them.
   */
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
export type PricedFocus = OfferFocus & { status: "priced"; price: FocusPrice; drivers: OfferDrivers; building: FocusBuilding; site: FocusSite };

/** True when the offer is priced: the price, its drivers, the building and the site facts are all there. */
export const isPriced = (focus: OfferFocus | null | undefined): focus is PricedFocus =>
  !!focus && focus.status === "priced" && focus.price !== null && focus.drivers !== null && focus.building !== null && focus.site !== null;

/** The props every step of the walkthrough receives. Add them to a step's Props as they are, all optional. */
export interface OfferFocusProps {
  /** The priced offer while the header switch is on "Offer". null in Portfolio mode and whenever no offer is priced. */
  focus?: PricedFocus | null;
  /** The offer whatever the switch says, priced or not. null when no offer has been read. */
  offerFocus?: OfferFocus | null;
  /** "depth_only" or "all_drivers", as the header switch says. The portfolio is run in the same mode. */
  mode?: LossMode;
  /**
   * The judgement figures in force and who set each: offerFocus.judgement, or the same block for
   * the portfolio alone (portfolioJudgement) when no offer has been read. null only before the model has loaded.
   */
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
  /** Each set holds the figures the agents may argue (AGENT_JUDGEMENT_KEYS). null when that reply did not arrive. */
  optimist: Partial<OfferJudgement> | null;
  cautious: Partial<OfferJudgement> | null;
  final: Partial<OfferJudgement> | null;
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
  /**
   * The assumptions in force and the portfolio's result under them. The result is used as it is
   * when it was run in the mode in force and, with all loss drivers, on the same buffer and drain
   * assumptions as the offer's (ModelResult.mode and .judgement say so). Otherwise the portfolio is
   * run again here, so the offer is always compared with a portfolio measured the same way.
   */
  active: { source: "ai" | "reference"; params: ModelParams; result: ModelResult };
  /** The drainage state when drainage is switched on, otherwise null. */
  drainage: DrainageState | null;
  /** The policy terms of the Insurance terms panel, used for whatever the document does not state, and for the portfolio's gross figures. */
  policyDefaults: PolicyDefaults;
  /**
   * The agents' deliberation when there is one. The three parameter sets are read, and
   * offerJudgement when the agents ran with an offer loaded: its figures are used only when the
   * brief it carries is for the offer now on screen.
   */
  deliberation: (Pick<Deliberation, "optimist" | "cautious" | "final"> & { offerJudgement?: AgentsJudgement | null }) | null;
  /** "depth_only" or "all_drivers", as the header switch says. All loss drivers when left out. */
  mode?: LossMode;
  /** Judgement figures the underwriter typed. Each one replaces that figure whoever proposed it; code keeps it in its range. */
  judgement?: Partial<OfferJudgement>;
  /** The ward map and the waterways once loadGeo has answered: each null when its file is missing. Pass null while they are still loading. */
  layers: { wards: GeoCollection<WardProps> | null; waterways: GeoCollection<WaterwayProps> | null } | null;
}

// ---------------------------------------------------------------------------------------------
// The document and its fields
// ---------------------------------------------------------------------------------------------

type PricedRow = Extract<RowPricing, { status: "priced" }>;

/**
 * Where a value came from, and the mark its sentence carries in the document, from what code
 * decided about it and which path read it. The one rule for every value on every screen:
 *
 *   missing                       "not stated", no mark
 *   confirmed, edited             the underwriter's word, whichever path read it
 *   read by the fixed rules       "rules"; its mark is "unverified" when its check failed
 *   read by the model             "AI, verified" or "AI, unverified"
 */
export function originOf(status: ValueStatus, path: ExtractionPath): { origin: FieldOrigin; mark: QuoteMark | null } {
  if (status === "missing") return { origin: "not stated", mark: null };
  if (status === "confirmed") return { origin: "confirmed", mark: "confirmed" };
  if (status === "edited") return { origin: "edited", mark: "edited" };
  if (path === "rules") return { origin: "rules", mark: status === "unverified" ? "unverified" : "rules" };
  return status === "verified" ? { origin: "AI, verified", mark: "verified" } : { origin: "AI, unverified", mark: "unverified" };
}

/** The offer-level values that describe the site and the building, not the cover: shown under "site" in the list of fields. */
const SITE_KEYS: ReadonlySet<string> = new Set(["basements", "occupancy", "placeName", "riverName", "riverDistanceM", "basementDepthM", "drainDesignRp", "sumpPumpCapacity", "sumpPumpBackup", "floodBarriers", "nonReturnValves"]);

const NOT_STATED: Quoted<never> = { value: null, quote: "", status: "missing", reason: null };

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
  // What the loss drivers read: optional on the terms, so an extraction made before they existed has them as not stated.
  for (const f of DRIVER_FIELDS) {
    const quoted: Quoted<string | number> = extraction.terms[f.key] ?? NOT_STATED;
    add(`terms:${f.key}`, { scope: "terms", key: f.key }, SITE_KEYS.has(f.key) ? "site" : "terms", null, fieldLabel(f), fieldText(quoted.value, f), quoted, path);
  }
  (extraction.equipmentBelowGround ?? []).forEach((e, index) => add(`equipment:${index}`, { scope: "equipment", index }, "site", null, equipmentLabel(index), e.item.value ?? "", e.item, path));
  extraction.notes.forEach((n, index) => add(`note:${index}`, { scope: "note", index }, "note", null, NOTE_LABELS[n.kind], n.value ?? "", n, path));
  // The document's own loss history: the years it covers, then each past flood loss, under the same rule as every other value.
  const listed = new Set(out.map((f) => f.id));
  for (const h of historyFields(extraction)) if (!listed.has(h.id)) add(h.id, h.ref, "terms", null, h.label, h.value, h.quoted, path);
  return out;
}

/** The id of a value, the same one the tables of fields use: "row:0:tivKes", "terms:floodLimitKes", "note:2", "loss:0:amountKes", "equipment:1". */
const refId = (ref: ValueRef): string =>
  ref.scope === "row" ? `row:${ref.row}:${ref.key}` : ref.scope === "terms" ? `terms:${ref.key}` : ref.scope === "loss" ? `loss:${ref.index}:${ref.key}` : ref.scope === "equipment" ? `equipment:${ref.index}` : `note:${ref.index}`;

function waitingList(extraction: OfferExtraction, mode: LossMode): FocusWaiting[] {
  return waitingValues(extraction, mode).map((w): FocusWaiting => {
    const { ref } = w;
    const field: FieldDef<string> | undefined = (ref.scope === "row" ? ROW_FIELDS.find((f) => f.key === ref.key) : ref.scope === "terms" ? (TERM_FIELDS.find((f) => f.key === ref.key) ?? DRIVER_FIELDS.find((f) => f.key === ref.key)) : undefined) ?? historyFieldDef(ref) ?? undefined;
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

function buildingOf(row: PricingRow, rows: PricingRow[], extraction: OfferExtraction, priced: RowPricing | undefined, wards: GeoCollection<WardProps> | null): FocusBuilding {
  const { location } = row;
  const located = location.kind !== "none";
  const status = priced?.status ?? "not_ready";
  // The same figure the under-insurance check reads: the building's own value where the offer states it.
  const perM2 = valuePerM2Of(row, rows, extraction);
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
    valuePerM2Kes: perM2.kes,
    valuePerM2From: perM2.from,
    valuePerM2How: perM2.how,
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

const ASSUMPTION_LABELS: Record<AssumptionPrice["id"], string> = { reference: "Reference, no AI", optimist: "Optimist", cautious: "Cautious", agreed: "Agreed by agents" };

/** The curve of a set of drivers in the shape every step reads: all the drivers summed at each return period. */
const driverFigures = (d: OfferDrivers): LossFigures =>
  lossFigures(d.tivKes, d.perReturnPeriod.map((r) => ({ id: r.id, label: r.label, returnPeriod: r.returnPeriod, groundUpKes: r.groundUpTotalKes, grossKes: r.grossKes })));

// ---------------------------------------------------------------------------------------------
// The maps and the portfolio the offer is measured against
// ---------------------------------------------------------------------------------------------

/** The drainage grid of a drainage state for a list of scenarios, worked out once: it does not depend on the buildings. */
const drainageInfoCache = new WeakMap<DrainageState, { scenarios: Dataset["scenarios"]; info: NonNullable<Dataset["drainage"]> }>();

/**
 * The data set the drivers read their maps from. Like priceOffer, the drainage argument alone
 * decides whether ponding is read: drainage the data set arrived with is used when it is
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

/** The portfolio's own data set under the same rule: every building with its ponding when drainage is on. */
const portfolioDataCache = new WeakMap<DrainageState, WeakMap<Dataset, Dataset>>();
function portfolioData(dataset: Dataset, drainage: DrainageState | null): Dataset {
  if (!drainage) return dataset.drainage ? { ...dataset, drainage: undefined } : dataset;
  if (dataset.drainage) return dataset;
  let byDataset = portfolioDataCache.get(drainage);
  if (!byDataset) portfolioDataCache.set(drainage, (byDataset = new WeakMap()));
  let found = byDataset.get(dataset);
  if (!found) byDataset.set(dataset, (found = withDrainage(dataset, drainage)));
  return found;
}

/** The judgement figures that reach a portfolio building: drivers 1 to 3 read these and no others. */
export const PORTFOLIO_KEYS: (keyof OfferJudgement)[] = ["bufferRadiusM", "drainDesignRp", "drainOverloadDepthM"];

/**
 * The portfolio measured the way the offer is: in the mode in force and, with all loss drivers, on
 * the same buffer and drain assumptions. The result handed in is used when it was run that way;
 * otherwise the portfolio is run again here.
 */
function portfolioRun(input: OfferFocusInput, mode: LossMode, assumed: OfferJudgement): ModelResult {
  const given = input.active.result;
  const data = portfolioData(input.session.dataset, input.drainage);
  const sameData = given.buildingCount === data.buildings.length && given.scenarios.length === data.scenarios.length;
  const sameMode = (given.mode ?? "depth_only") === mode;
  const ran = given.judgement ?? REFERENCE_JUDGEMENT;
  const sameJudgement = mode === "depth_only" || PORTFOLIO_KEYS.every((key) => ran[key] === assumed[key]);
  if (sameData && sameMode && sameJudgement) return given;
  return runModel(data, input.active.params, { mode, judgement: assumed });
}

/** The portfolio's gross loss per scenario under the panel's policy terms, worked out once per result and set of terms. */
const portfolioGrossCache = new WeakMap<ModelResult, Map<string, number[]>>();
function portfolioGross(result: ModelResult, buildings: Building[], defaults: PolicyDefaults): number[] | null {
  if (result.buildings.length !== buildings.length) return null;
  const terms = sanitiseTerms({ ...DEFAULT_TERMS, deductibleShare: defaults.deductibleShare, deductibleMinKes: defaults.deductibleMinKes, limitShare: defaults.limitShare });
  const key = `${terms.deductibleShare}|${terms.deductibleMinKes}|${terms.limitShare}`;
  let byTerms = portfolioGrossCache.get(result);
  if (!byTerms) portfolioGrossCache.set(result, (byTerms = new Map()));
  let gross = byTerms.get(key);
  if (!gross) {
    gross = result.scenarios.map((_, k) => result.buildings.reduce((t, b, i) => t + policyLoss(b.perScenario[k].lossKes, buildings[i].tivKes, terms).grossKes, 0));
    byTerms.set(key, gross);
  }
  return gross;
}

// ---------------------------------------------------------------------------------------------
// The judgement figures in force
// ---------------------------------------------------------------------------------------------

/** The figures the underwriter typed, out of whatever was handed in: finite numbers only. */
function typedFigures(given: Partial<OfferJudgement> | undefined): Partial<OfferJudgement> {
  const out: Partial<OfferJudgement> = {};
  for (const key of JUDGEMENT_KEYS) {
    const v = given?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** The figures an agent set may hold: the ones the agents argue, finite numbers only. Anything else in the set is left out. */
function agentFigures(set: Partial<OfferJudgement> | null | undefined): Partial<OfferJudgement> | null {
  if (!set) return null;
  const out: Partial<OfferJudgement> = {};
  for (const key of AGENT_JUDGEMENT_KEYS) {
    const v = set[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** The reference values with one agent set and the typed figures over them, each inside its allowed range and each ladder rising. */
const judgementWith = (own: Partial<OfferJudgement> | null, typed: Partial<OfferJudgement>): OfferJudgement => enforceJudgement({ ...REFERENCE_JUDGEMENT, ...(own ?? {}), ...typed }).judgement;

/** The figures of one agent set as they are used, in range: only the ones the set holds. */
function inRange(own: Partial<OfferJudgement> | null): Partial<OfferJudgement> | null {
  if (!own) return null;
  const enforced = judgementWith(own, {});
  const out: Partial<OfferJudgement> = {};
  for (const key of AGENT_JUDGEMENT_KEYS) if (key in own) out[key] = enforced[key];
  return out;
}

/**
 * The judgement in force and who set each figure: the document where it states the figure itself,
 * then what the underwriter typed, then the agents' agreed set when they ran with this offer and
 * "Agreed by agents" is on, otherwise the reference value.
 */
function judgementOf(source: "ai" | "reference", given: Partial<OfferJudgement> | undefined, agents: AgentsJudgement | null, ran: FocusJudgement["agents"], stated: OfferStated | null, tivKes: number | null): FocusJudgement {
  // tivKes is the whole offer's insured value, priced or not: the document's amounts are for the whole offer.
  const agreed = inRange(agentFigures(agents?.final));
  const useAgents = source === "ai" && agreed !== null;
  const asked = typedFigures(given);
  const assumed = judgementWith(useAgents ? agreed : null, asked);
  const typed: Partial<OfferJudgement> = {};
  for (const key of JUDGEMENT_KEYS) if (key in asked) typed[key] = assumed[key];

  // What the document states itself takes the place of the assumption for the offer.
  const fromOffer: FocusJudgement["fromOffer"] = {};
  if (stated?.drainDesignRp) fromOffer.drainDesignRp = { value: stated.drainDesignRp.value, what: "Drain design return period stated in the offer (years)", quote: stated.drainDesignRp.quote };
  if (tivKes !== null && tivKes > 0) {
    if (stated?.valueBelowGroundKes) fromOffer.belowGroundShare = { value: Math.min(1, stated.valueBelowGroundKes.value / tivKes), what: "Value below ground stated in the offer, as a share of the insured value", quote: stated.valueBelowGroundKes.quote };
    if (stated?.annualRentKes) fromOffer.annualRentShare = { value: stated.annualRentKes.value / tivKes, what: "A year's rent or revenue stated in the offer, as a share of the insured value", quote: stated.annualRentKes.quote };
  }
  // Who gave each figure its own value, before a ladder was made to rise.
  const giver = (key: keyof OfferJudgement): "typed" | "agents" | "reference" => (key in typed ? "typed" : useAgents && key in agreed ? "agents" : "reference");
  // A rung code raised is set by whoever set the more frequent rung that pushed it up: its value is no longer its giver's.
  const raised: FocusJudgement["raised"] = {};
  for (const ladder of [BASEMENT_LADDER, OUTAGE_LADDER]) {
    ladder.forEach((key, i) => {
      const who = giver(key);
      if (who === "typed") return;
      const own = who === "agents" ? (agreed?.[key] ?? REFERENCE_JUDGEMENT[key]) : REFERENCE_JUDGEMENT[key];
      if (assumed[key] === own) return;
      // The nearest more frequent rung that stands at its giver's own value is the one that pushed.
      let by: "typed" | "agents" = "typed";
      for (let j = i - 1; j >= 0; j--) {
        const before = giver(ladder[j]);
        if (before !== "reference" && !(ladder[j] in raised)) {
          by = before;
          break;
        }
      }
      raised[key] = { from: own, to: assumed[key], by, reason: `Raised by code to keep the ladder rising: a more frequent rung was ${by === "typed" ? "typed" : "agreed by the agents"} higher.` };
    });
  }
  const inForce = { ...assumed };
  const setBy = {} as FocusJudgement["setBy"];
  for (const key of JUDGEMENT_KEYS) {
    const offer = fromOffer[key];
    if (offer) inForce[key] = offer.value;
    setBy[key] = offer ? "offer" : (raised[key]?.by ?? giver(key));
  }
  return { inForce, assumed, reference: { ...REFERENCE_JUDGEMENT }, agreed, typed, setBy, raised, fromOffer, agents: ran };
}

/**
 * Who set a group of judgement figures, every setter among them, in the one order used everywhere
 * (offer, agents, typed, reference). The one rule for naming the setter of a figure that rests on
 * several: a screen lists all of them and never only the first.
 */
export function settersOf(judgement: Pick<FocusJudgement, "setBy"> | null | undefined, keys: readonly (keyof OfferJudgement)[]): JudgementSetter[] {
  if (!judgement) return [];
  const found = new Set(keys.map((key) => judgement.setBy[key]));
  return SETTER_ORDER.filter((who): who is JudgementSetter => found.has(who as JudgementSetter));
}

/** The same in words, for after "Set by:": "agreed by the agents and the reference value". "" when there is none. */
export function settersText(judgement: Pick<FocusJudgement, "setBy"> | null | undefined, keys: readonly (keyof OfferJudgement)[]): string {
  const words = settersOf(judgement, keys).map((who) => SETTER_WORDS[who].sentence);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The same block for the portfolio alone, when no offer is read: the reference values with what the
 * underwriter typed over them. The agents argue these figures for an offer, so with none on screen
 * theirs are not used.
 */
export function portfolioJudgement(typed?: Partial<OfferJudgement>): FocusJudgement {
  return judgementOf("reference", typed, null, "none", null, null);
}

/**
 * The assumptions alone, in range: the reference values, an agreed set over them when one is
 * given, and the typed figures over both. buildOfferFocus works out the same figures as
 * judgement.assumed; this is for running the portfolio before the focus exists.
 */
export function assumedJudgement(agreed: Partial<OfferJudgement> | null | undefined, typed?: Partial<OfferJudgement>): OfferJudgement {
  return judgementWith(inRange(agentFigures(agreed)), typedFigures(typed));
}

// ---------------------------------------------------------------------------------------------
// What the agents are told about the offer
// ---------------------------------------------------------------------------------------------

/** A sentence as it is sent: one line, cut at the brief's limit. */
const briefLine = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, BRIEF_QUOTE_MAX_CHARS);

/** The part of the brief that comes from the document and the location alone: it does not change with the flood source, the mode or the assumptions. */
type BriefFacts = Omit<OfferBrief, "bufferRadiusM" | "depthsByTier" | "nearestMappedWaterM" | "wetShareWidestTier">;

function briefFacts(extraction: OfferExtraction, building: FocusBuilding | null, site: FocusSite | null): BriefFacts {
  const stated = statedValues(extraction);
  const drains = drainageFact(extraction);
  const history = statedFloodHistory(extraction);
  // Only sentences already shown on screen, and only those behind a usable value.
  const candidates: [string, string | undefined][] = [
    ["basements", stated.basements?.quote],
    ["basement depth", stated.basementDepthM?.quote],
    ["basement plant", stated.basementPlant?.quote],
    ...stated.equipmentBelowGround.slice(0, 3).map((e): [string, string] => ["equipment below ground", e.quote]),
    ["value below ground", stated.valueBelowGroundKes?.quote],
    ["drainage", drains.quote],
    ["drain design", stated.drainDesignRp?.quote],
    ["sump pump", stated.sumpPumpCapacity?.quote || stated.sumpPumpBackup?.quote],
    ["flood barriers", stated.floodBarriers?.quote],
    ["non-return valves", stated.nonReturnValves?.quote],
    ["business interruption", stated.biCovered?.quote],
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
    occupancy: usableValue(extraction.terms.occupancy),
    insuredValueKes: building?.tivKes ?? null,
    floorAreaM2: building?.floorAreaM2 ?? null,
    locationApproximate: building?.approximate ?? false,
    basements: stated.basements?.value ?? null,
    basementDepthM: stated.basementDepthM?.value ?? null,
    criticalPlantInBasement: stated.basementPlant !== null,
    equipmentBelowGroundCount: stated.equipmentBelowGround.length,
    valueBelowGroundKes: stated.valueBelowGroundKes?.value ?? null,
    drainageCondition: briefLine(drains.condition) || null,
    drainDesignRp: stated.drainDesignRp?.value ?? null,
    sumpPumpCapacity: briefLine(stated.sumpPumpCapacity?.value) || null,
    sumpPumpBackup: stated.sumpPumpBackup?.value ?? null,
    floodBarriers: stated.floodBarriers?.value ?? null,
    nonReturnValves: stated.nonReturnValves?.value ?? null,
    biCovered: stated.biCovered?.value ?? null,
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
 * moves with the flood source switch, the mode and the assumptions, and not with the offer.
 */
export function sameOffer(a: BriefFacts, b: BriefFacts): boolean {
  const whole = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v));
  const key = (x: BriefFacts) =>
    JSON.stringify([
      x.housingClass,
      x.occupancy ?? null,
      whole(x.insuredValueKes),
      whole(x.floorAreaM2),
      x.locationApproximate ?? false,
      x.basements,
      x.basementDepthM ?? null,
      x.criticalPlantInBasement,
      x.equipmentBelowGroundCount ?? 0,
      whole(x.valueBelowGroundKes),
      x.drainageCondition,
      x.drainDesignRp ?? null,
      x.sumpPumpCapacity ?? null,
      x.sumpPumpBackup ?? null,
      x.floodBarriers ?? null,
      x.nonReturnValves ?? null,
      x.biCovered ?? null,
      x.floodLossCount,
      whole(x.floodLossTotalKes),
      x.floodHistoryYears,
      whole(x.nearestRiverM),
      whole(x.nearestDrainM),
      x.quotes.map((q) => q.quote),
    ]);
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
  return {
    ...briefFacts(focus.extraction, focus.building, focus.site),
    bufferRadiusM: focus.judgement.inForce.bufferRadiusM,
    depthsByTier: trace.map((r) => ({ tier: r.id, returnPeriod: r.returnPeriod, pointM: r.terrainM, bufferM: r.bufferM, pondingM: r.drainageM, overloaded: r.overloaded })),
    nearestMappedWaterM: widest ? (widest.hazard > 0 ? 0 : widest.nearestWetM) : null,
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

function siteOf(building: FocusBuilding, input: OfferFocusInput, extraction: OfferExtraction, priced: PricedRow | null): FocusSite | null {
  if (building.lat === null || building.lon === null || building.status === "outside") return null;
  const point = { lat: building.lat, lon: building.lon };
  const { dataset } = input.session;

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
    neighbours: { radiusM: NEIGHBOUR_RADIUS_M, count: inside.length, tivKes: inside.reduce((t, n) => t + n.tivKes, 0), nearestM: near[0]?.m ?? null, indices: inside.map((n) => n.index) },
    wardPortfolio,
  };
}

const share = (change: number | null, base: number | null): number | null => (change !== null && base !== null && base > 0 ? change / base : null);

function portfolioFigures(result: ModelResult): PortfolioFigures {
  const at100 = result.standardLosses.find((s) => s.returnPeriod === 100);
  return { buildings: result.buildingCount, totalTivKes: result.totalTivKes, loss100Kes: at100?.lossKes ?? null, loss100Extrapolated: at100?.extrapolated ?? false, aalKes: result.aalKes };
}

function portfolioOf(input: OfferFocusInput, own: ModelResult, total: LossFigures, depthOnly: LossFigures, pricedCount: number, building: FocusBuilding, housingClass: HousingClass): FocusPortfolio {
  const { dataset } = input.session;
  const a = portfolioFigures(own);
  // The offer's ground-up loss on top of the portfolio's own, return period by return period. Reading a
  // curve at a return period and taking the area under it are both sums over its points, so the
  // portfolio's figure plus the offer's is exactly the figure of the two curves added together.
  const added100 = total.loss100GroundUpKes;
  const b: PortfolioFigures = {
    buildings: a.buildings + pricedCount,
    totalTivKes: a.totalTivKes + total.tivKes,
    loss100Kes: a.loss100Kes !== null && added100 !== null ? a.loss100Kes + added100 : null,
    loss100Extrapolated: a.loss100Extrapolated,
    aalKes: a.aalKes + total.aalGroundUpKes,
  };
  const loss100ChangeKes = a.loss100Kes !== null && added100 !== null ? added100 : null;
  const largestTivKes = dataset.buildings.reduce((m, x) => Math.max(m, x.tivKes), 0);
  const aligned = own.scenarios.length === total.curve.length && own.scenarios.every((s, k) => s.id === total.curve[k].id);

  // The portfolio after policy terms, with the offer's own gross loss added event by event.
  let gross: FocusPortfolio["gross"] = null;
  const portfolioGrossKes = aligned ? portfolioGross(own, dataset.buildings, input.policyDefaults) : null;
  if (portfolioGrossKes) {
    const without: CurvePoint[] = own.scenarios.map((s, k) => ({ returnPeriod: s.returnPeriod, lossKes: portfolioGrossKes[k] }));
    const withOffer: CurvePoint[] = without.map((p, k) => ({ returnPeriod: p.returnPeriod, lossKes: p.lossKes + total.curve[k].grossKes }));
    const without100Kes = lossAtReturnPeriod(without, 100).lossKes;
    const with100Kes = lossAtReturnPeriod(withOffer, 100).lossKes;
    const change100Kes = without100Kes !== null && with100Kes !== null ? with100Kes - without100Kes : null;
    gross = { without100Kes, with100Kes, change100Kes, change100Share: share(change100Kes, without100Kes), aalWithoutKes: averageAnnualLoss(without), aalWithKes: averageAnnualLoss(withOffer) };
  }

  // The class in the portfolio, flood by flood, matched by scenario id.
  const classContext: FocusPortfolio["classContext"] = {
    housingClass,
    buildings: own.scenarios[0]?.byClass[housingClass].count ?? 0,
    tivKes: own.scenarios[0]?.byClass[housingClass].tivKes ?? 0,
    perReturnPeriod: total.curve.flatMap((s) => {
      const c = own.scenarios.find((x) => x.id === s.id)?.byClass[housingClass];
      return c ? [{ id: s.id, returnPeriod: s.returnPeriod, flooded: c.affected, meanDamageRatio: c.tivKes > 0 ? c.lossKes / c.tivKes : 0, meanDamageRatioFlooded: c.tivExposedKes > 0 ? c.lossKes / c.tivExposedKes : null }] : [];
    }),
  };

  return {
    without: a,
    with: b,
    sameAsPortfolioView: own === input.active.result,
    loss100ChangeKes,
    loss100ChangeShare: share(loss100ChangeKes, a.loss100Kes),
    aalChangeKes: total.aalGroundUpKes,
    aalChangeShare: share(total.aalGroundUpKes, a.aalKes),
    depthOnly: { loss100ChangeKes: a.loss100Kes !== null ? depthOnly.loss100GroundUpKes : null, aalChangeKes: depthOnly.aalGroundUpKes },
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
function checkAsFlag(check: Check, extraction: OfferExtraction, rows: PricingRow[], pricing: OfferPricing, counts: Record<ValueStatus, number>): CheckInput {
  const [base, locId] = check.id.split(":");
  const row = rows.find((r) => r.locId === locId) ?? rows[0];
  const source = row ? extraction.rows[row.index] : undefined;
  const priced = pricing.rows.find((r) => r.locId === row?.locId);
  let title = check.title;
  const detail = check.detail;
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
      ? "Value per m² is below the portfolio's range for its class: possible under-insurance"
      : /above the highest/.test(check.detail)
        ? "Value per m² is above the portfolio's range for its class"
        : "Value per m² could not be compared with the portfolio";
  } else if (base === "offer-basements") {
    // Raised as a point only while Basement ingress is off: with the driver on, the one point on the basement is "basement-ingress".
    title = "Basements are not in the modelled loss";
    evidence = quoteOr(extraction.terms.basements.quote || usableNotes(extraction, "basement_plant")[0]?.quote, check.detail);
  } else if (base === "offer-flood-history") {
    title = "Flood history and the hazard maps disagree";
    evidence = quoteOr(usableNotes(extraction, "past_flood")[0]?.quote, check.detail);
  } else if (base === "offer-curve") {
    title = "A residential damage curve is used for a building that is not residential";
    evidence = quoteOr(extraction.terms.occupancy.quote, check.detail);
  } else if (base === "offer-drivers-add-up") {
    title = "The offer's loss drivers do not add up to its loss";
  } else if (base === "offer-buffer-ge-point") {
    title = "The offer's depth within the buffer is below its depth at the point";
  } else if (base === "offer-depth-only-point") {
    title = check.status === "warn" ? "Depth only could not be compared with the point reading" : "Depth only does not reproduce the point reading for the offer";
  }
  return { id: check.id, status: check.status, title, detail, evidence };
}

/**
 * The points raised from the price and the document. The questions for the broker are not among
 * them: they have their own list (focus.questions), and a point that repeated them would say each
 * one twice on the same page.
 */
function ownFlags(input: OfferFocusInput, extraction: OfferExtraction, terms: FocusTerms, building: FocusBuilding, price: FocusPrice, drivers: OfferDrivers): Flag[] {
  const flags: Flag[] = [];
  const add = (id: string, severity: Severity, title: string, detail: string, evidence: FlagEvidence) => flags.push({ id, severity, title, detail, evidence });
  const b = price.building;
  const { total, portfolio } = price;
  const all = drivers.mode === "all_drivers";
  const rows = drivers.perReturnPeriod;
  const first = drivers.firstReturnPeriod;
  const { judgement, premium } = drivers;
  const isScore = input.session.dataset.hazardKind === "score";
  const perRp = (pick: (r: DriverReturnPeriod) => string) => rows.map((r) => `${rpLabel(r.returnPeriod)} ${pick(r)}`).join(", ");
  const sourceEvidence = (quote: string, fallback: string) => quoteOr(quote, fallback);

  // Water the maps and the drainage layer put at the point itself, and how often.
  const firstAtPoint = b.perReturnPeriod.find((r) => Math.max(r.terrainM, r.drainageM) > 0)?.returnPeriod ?? null;
  if (firstAtPoint !== null) {
    const frequent = firstAtPoint <= FREQUENT_FLOOD_RP;
    add(
      "flood-depth",
      frequent ? "high" : "medium",
      `Water reaches the building from the ${rpLabel(firstAtPoint)} flood`,
      `The maps or the drainage ponding put water at the stated point from the ${rpLabel(firstAtPoint)} flood onwards. A flood of ${rpLabel(FREQUENT_FLOOD_RP)} or more frequent is marked high.`,
      figure(`Depth at the point: ${b.perReturnPeriod.map((r) => `${rpLabel(r.returnPeriod)} ${depthText(Math.max(r.terrainM, r.drainageM))}`).join(", ")}.`),
    );
  } else if (all && first.wetInBuffer !== null) {
    // Dry at the point, but the buffer around the building holds mapped water: that water is in the price.
    add(
      "dry-point-wet-buffer",
      "medium",
      `Dry at the point, but wet within the ${fmtInt(drivers.bufferRadiusM)} m buffer from the ${rpLabel(first.wetInBuffer)} flood`,
      "Read at the point alone, the maps give no loss. With all loss drivers the highest map depth within the buffer is used, so the building's footprint and a small error in the coordinates do not decide the answer. The buffer is an assumption.",
      figure(
        `At the point: dry at every return period. Within the buffer: ${perRp((r) => depthText(r.depths.bufferM))}${b.nearestWetM !== null ? `; the nearest wet map cell is ${fmtDistance(b.nearestWetM)} from the point` : ""}. ${DRIVER_LABELS.surrounding}, average annual loss, ground-up: ${kes1(drivers.aal.groundUpKes.surrounding)}.`,
      ),
    );
  } else if (b.nearestWetM !== null && b.nearestWetM <= NEAR_WET_CELL_M) {
    add(
      "near-water",
      "medium",
      `Dry on every map, but ${fmtDistance(b.nearestWetM)} from mapped flood water`,
      all
        ? `The maps are dry at the point and within the ${fmtInt(drivers.bufferRadiusM)} m buffer, so this water is not in the price. A wider buffer, which is a judgement figure, would count it; so would a small error in the coordinates or in the map.`
        : "Depth only reads the maps at the point alone, so this water is not in the price. A small error in the coordinates or in the map would put it there.",
      figure(`Nearest wet cell on any terrain map: ${fmtDistance(b.nearestWetM)} from the point (${building.approximate ? "approximate location" : "stated coordinates"}).`),
    );
  }

  // The drivers that act where the maps are dry.
  if (all && first.overloaded !== null && judgement.drainOverloadDepthM > 0) {
    const design = drivers.drainDesign;
    const fromOffer = design.source.kind === "offer";
    const designQuote = design.source.kind === "offer" ? design.source.quote : "";
    add(
      "drain-overload",
      "medium",
      `Drains are overloaded from the ${rpLabel(first.overloaded)} flood`,
      `An event rarer than the ${rpLabel(design.returnPeriod)} event the drains ${fromOffer ? "are stated to be" : "are taken to be"} designed for puts at least ${depthText(judgement.drainOverloadDepthM)} of water at the site, even where the maps are dry. ${fromOffer ? "The depth is an assumption." : "The design return period and the depth are both assumptions."}`,
      sourceEvidence(
        designQuote,
        `Drains overloaded: ${perRp((r) => (r.depths.overloaded ? "yes" : "no"))}. ${DRIVER_LABELS.overload}, ground-up: ${perRp((r) => kes1(r.groundUpKes.overload))}; average annual loss ${kes1(drivers.aal.groundUpKes.overload)}.`,
      ),
    );
  }
  // One point for the basement while Basement ingress is on: the flood that first reaches the threshold, the value
  // at risk and that the ratios are assumptions, with the document's sentence on the plant as its evidence. It
  // stands in for the check on basements and the note of critical plant, and keeps the highest of their severities.
  const plant = usableNotes(extraction, "basement_plant")[0];
  const basementPriced = all && (drivers.lines.find((l) => l.id === "basement")?.on ?? false);
  if (basementPriced) {
    const below = drivers.components.find((c) => c.id === "below_ground");
    const valueFrom = below?.valueSource.kind === "offer" ? "as the document states" : "assumed, as the document does not state it";
    const takes = first.basement !== null;
    const sentence = (plant?.quote || drivers.basement.quote).trim();
    const losses = `${DRIVER_LABELS.basement}, ground-up: ${perRp((r) => kes1(r.groundUpKes.basement))}; average annual loss ${kes1(drivers.aal.groundUpKes.basement)}.`;
    add(
      "basement-ingress",
      (plant && (takes || firstAtPoint !== null)) || (first.basement !== null && first.basement <= FREQUENT_FLOOD_RP) ? "high" : "medium",
      takes ? `The basement takes water from the ${rpLabel(first.basement!)} flood` : "The basement takes no water in the floods modelled",
      `${
        takes
          ? `Water at the site reaches the ${depthText(judgement.ingressThresholdM)} threshold from that flood onwards.`
          : `No water reaches the ${depthText(judgement.ingressThresholdM)} ingress threshold at the site in the floods modelled, so the value below ground loses only the share the damage curve gives the structure at the same water.`
      } Value at risk below ground: ${kes1(below?.valueKes ?? 0)} (${valueFrom}). The threshold and the basement damage ratios are assumptions, not a survey.${plant ? " The document places critical plant there." : ""}${sentence ? ` ${losses}` : ""}`,
      // The document's sentence on the plant where there is one; the figures are then in the detail, and never said twice.
      sourceEvidence(sentence, losses),
    );
  }
  if (all && premium.setBy === "minimum rate") {
    add(
      "minimum-rate",
      "medium",
      "The flood premium is the minimum rate, not a modelled loss",
      "The modelled loss, the uncertainty loading and the capital load come to less than the minimum flood rate, so the minimum is the premium. It is an assumption that no risk inside the mapped area is priced below it, not a measurement of this risk.",
      figure(`Technical flood premium ${kes1(premium.technicalKes)} (${perMille((premium.technicalKes / drivers.tivKes) * 1000)}), against the minimum of ${perMille(judgement.minimumRatePerMille)}: ${kes1(premium.floodPremiumKes)} a year on a sum insured of ${kes1(drivers.tivKes)}.`),
    );
  }

  // The size of the 1-in-100 loss against the sum insured.
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

  // What the document itself reports. Plant below ground is its own point only while Basement ingress is off.
  if (plant && !basementPriced) {
    add(
      "critical-plant",
      firstAtPoint !== null ? "high" : "medium",
      "Critical plant is kept below ground",
      `Water entering a basement is not in the ${all ? "price: the Basement ingress driver is off" : `${LOSS_MODE_LABELS.depth_only} figures`}.${firstAtPoint !== null ? " The maps show water at the building." : ""}`,
      quoteOr(plant.quote, plant.value ?? NOTE_LABELS.basement_plant),
    );
  }
  const past = usableNotes(extraction, "past_flood")[0];
  if (past) {
    const h = premium.history;
    const beside =
      h.lossPerYearKes !== null
        ? `The document's own losses come to ${kes1(h.lossPerYearKes)} a year, against a modelled average annual loss of ${kes1(h.modelledAalKes)} gross. The two are shown side by side as a sense check; the history is not blended into the price.`
        : `Its losses cannot be set beside the modelled loss. ${h.why ?? ""} Ask for the loss history: the years it covers and the amounts paid.`;
    add("past-flood-loss", "medium", "The document reports a past flood or water damage", `A site that has flooded before is likely to flood again. ${beside}`, quoteOr(past.quote, past.value ?? NOTE_LABELS.past_flood));
  }
  const drains = drainageFact(extraction);
  if (drains.poor) {
    add(
      "drainage-condition",
      "medium",
      "The document reports poor drainage at the site",
      `Blocked or undersized drains flood a site that the terrain maps show as dry. ${all ? `The ${DRIVER_LABELS.overload} driver and the ${DRIVER_LABELS.uncertainty.toLowerCase()} stand for this; neither is a measurement of these drains.` : "Depth only prices none of it."}`,
      quoteOr(drains.quote, drains.condition ?? NOTE_LABELS.drainage_condition),
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
      "The maps are shallower here than the ponding assumed near drains and informal settlements, so the loss rests on that assumption.",
      figure(`Ponding against depth at the point: ${ponding.map((r) => `${rpLabel(r.returnPeriod)} ${depthText(r.drainageM)} against ${depthText(r.terrainM)}`).join(", ")}.`),
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
      `The Cautious agent's assumptions give ${optimist.aalGrossKes > 0 ? `${fmtNum(cautious.aalGrossKes / optimist.aalGrossKes, 1)} times` : "a loss where"} the Optimist's ${optimist.aalGrossKes > 0 ? "average annual loss" : "give none"} for the same building.`,
      figure(`Average annual loss, gross: ${price.assumptions.map((a) => `${a.label} ${kes1(a.aalGrossKes)}`).join(", ")}.`),
    );
  }
  return flags;
}

/**
 * What the suggested conditions rest on, from the document's usable values and the price: never
 * from the wording of a flag. `stated` is given once the offer is priced, and the six facts behind
 * the loss drivers are filled from it; before that they are left out, so nothing is suggested on them.
 */
function factsOf(extraction: OfferExtraction, counts: Record<ValueStatus, number>, building: FocusBuilding | null, price: FocusPrice | null, stated: OfferStated | null): OfferFacts {
  const occupancy = usableValue(extraction.terms.occupancy);
  // null says the document does not say. A value that was read but is not usable yet is left out: it is the underwriter's to settle.
  const said = <T,>(value: StatedValue<T> | null, key: keyof OfferTerms): T | null | undefined => (value ? value.value : (extraction.terms[key]?.status ?? "missing") === "missing" ? null : undefined);
  const beyondDepth: Partial<OfferFacts> = stated
    ? {
        equipmentBelowGround: stated.equipmentBelowGround.length,
        drainDesignStated: stated.drainDesignRp !== null,
        sumpPumpBackup: said(stated.sumpPumpBackup, "sumpPumpBackup"),
        floodBarriers: said(stated.floodBarriers, "floodBarriers"),
        nonReturnValves: said(stated.nonReturnValves, "nonReturnValves"),
        interruptionCover: said(stated.biCovered, "biCovered"),
      }
    : {};
  return {
    ...beyondDepth,
    basements: usableValue(extraction.terms.basements),
    criticalPlantInBasement: usableNotes(extraction, "basement_plant").length > 0,
    pastFloodLoss: usableNotes(extraction, "past_flood").length > 0,
    // Said of the maps and the ponding at the point, whatever the drivers add around it.
    dryInEveryTier: price?.building.dryAtPointEveryReturnPeriod ?? false,
    nearestWetCellM: price?.building.nearestWetM ?? null,
    approximateLocation: building?.approximate ?? false,
    unverifiedValues: counts.unverified,
    underInsured: price?.portfolio.classRange?.position === "below",
    commercialOnResidentialCurve: occupancy !== null && occupancy !== "residential",
    // A report of poor drainage in the document's own notes, as drainageFact reads them.
    drainagePoor: drainageFact(extraction).poor,
    grossLoss100Kes: price?.total.loss100GrossKes ?? null,
    tivKes: price?.total.tivKes ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// The focus
// ---------------------------------------------------------------------------------------------

const DEPTH_FROM: Record<DriverReturnPeriod["surfaceFrom"], FocusReturnPeriod["depthFrom"]> = { point: "terrain", buffer: "buffer", ponding: "drainage", overload: "overload", dry: "dry" };

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
  const mode: LossMode = input.mode ?? "all_drivers";

  // With all loss drivers the values that switch a driver on or set its size hold pricing too, when one is unverified.
  const waiting = waitingList(extraction, mode);
  const held = waiting.length > 0;
  const counts = statusCounts(extraction);
  const policy = policyTerms(extraction.terms, input.policyDefaults);
  const terms = termsUsed(policy, extraction.terms);
  const stated = statedValues(extraction);
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
    mode,
    terms,
  };
  const summary = (loss100Kes: number | null, aalKes: number | null, outside: boolean): FocusSummary => ({ name: document.name, fieldsRead, fieldsVerified: counts.verified, loss100Kes, aalKes, outside });

  // The ward map decides where a place name is and which ward a point falls in: nothing is placed without it.
  if (!layers) {
    const judgement = judgementOf(input.active.source, input.judgement, null, "none", stated, null);
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
      judgement,
      drivers: null,
      price: null,
      site: null,
      questions: brokerQuestions(extraction, judgement.assumed),
      checks: [],
      flags: [],
      facts: factsOf(extraction, counts, null, null, null),
      conditions: [],
      summary: summary(null, null, false),
      rows: [],
      pricing: null,
    };
  }

  // Code only from here on. The rows hold usable values and nothing else: an unverified value is
  // left out and blocks the row it belongs to, so nothing is priced around it.
  const rows = pricingRows(extraction, layers.wards, dataset.hotspots);
  // The engine's own pricing: where each building is, whether it is inside the maps, and the
  // reading at its point. Depth only is exactly this.
  const pricing = priceOffer({ dataset, params: input.active.params, drainage: input.drainage, rows, terms: policy, wards: layers.wards });
  const allChecks = offerChecks({ extraction, rows, pricing, dataset, waterways: layers.waterways });
  // While pricing waits, the checks that rest on a price or a location wait with it.
  const readChecks = held ? allChecks.filter((c) => c.id === "offer-values") : allChecks;

  const buildings = rows.map((row, i) => buildingOf(row, rows, extraction, pricing.rows[i], layers.wards));
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
  const site = followed ? siteOf(followed, input, extraction, followedPriced) : null;

  // The judgement in force. The agents' figures count only when they argued the offer now on screen.
  const argued = input.deliberation?.offerJudgement ?? null;
  const ran: FocusJudgement["agents"] = !argued ? "none" : !argued.brief || sameOffer(argued.brief, briefFacts(extraction, followed, site)) ? "this_offer" : "another_offer";
  const agents = ran === "this_offer" ? argued : null;
  // The insured value the document's own amounts are set against: the whole offer's, every building with a usable
  // value, priced or not. A stated value below ground, rent or premium is for all of them.
  const insuredKes = rows.reduce((t, r) => t + (r.tivKes ?? 0), 0);
  const judgement = judgementOf(input.active.source, input.judgement, agents, ran, stated, insuredKes > 0 ? insuredKes : null);
  const questions = brokerQuestions(extraction, judgement.assumed);

  // The loss drivers: the maps at and around each building, the drains, the basement, interruption
  // and the uncertainty loading, by code. Outside the maps there is no figure at all.
  const maps = mapsFor(dataset, input.drainage);
  let drivers: OfferDrivers | null = null;
  let driversWith: ((params: ModelParams, figures: OfferJudgement, under: LossMode) => OfferDrivers | null) | null = null;
  if (status === "priced" && followedPriced) {
    // A priced row always has a location. Were one without, it has no point to read and no figure is given.
    const asBuilding = (r: PricedRow): DriverBuilding => ({
      lon: r.location.kind === "none" ? Number.NaN : r.location.lon,
      lat: r.location.kind === "none" ? Number.NaN : r.location.lat,
      housingClass: r.housingClass,
      tivKes: r.tivKes,
      name: rows.find((x) => x.locId === r.locId)?.name,
      // The ponding the engine worked out at this building, so both readings use the same figure.
      pondingM: Object.fromEntries(r.scenarios.map((s) => [s.id, s.drainageM])),
    });
    const building = asBuilding(followedPriced);
    const others = pricedRows.filter((r) => r !== followedPriced).map(asBuilding);
    driversWith = (params, figures, under) => offerDrivers({ dataset: maps, params, building, others, extraction, terms: policy, judgement: figures, mode: under, offerTivKes: insuredKes });
    drivers = driversWith(input.active.params, judgement.assumed, mode);
    // The engine has already found every building inside every map, so this does not happen. Were it to, no figure is shown.
    if (!drivers) status = "not_ready";
  }

  let price: FocusPrice | null = null;
  if (status === "priced" && followed && followedPriced && pricing.totals && drivers && driversWith) {
    const params = input.active.params;
    const cls = followedPriced.housingClass;
    const depthOnlyDrivers = mode === "depth_only" ? drivers : (driversWith(params, judgement.assumed, "depth_only") ?? drivers);

    const perReturnPeriod: FocusReturnPeriod[] = drivers.perReturnPeriod.map((r) => {
      const s = followedPriced.scenarios.find((x) => x.id === r.id);
      const d = damageDetail(r.depths.surfaceM, cls, params);
      return {
        id: r.id,
        label: r.label,
        returnPeriod: r.returnPeriod,
        hazard: s?.hazard ?? 0,
        terrainM: r.depths.pointM,
        bufferM: r.depths.bufferM,
        drainageM: r.depths.pondingM,
        overloaded: r.depths.overloaded,
        overloadM: r.depths.overloadM,
        depthM: r.depths.surfaceM,
        depthFrom: DEPTH_FROM[r.surfaceFrom],
        effectiveDepthM: d.effectiveDepthM,
        curveDamage: d.curveDamage,
        damageRatio: r.building.damageRatio,
        capped: r.building.capped,
        byDriverKes: r.building.groundUpKes,
        groundUpKes: r.building.groundUpTotalKes,
        deductibleKes: r.building.deductibleKes,
        overLimitKes: r.building.overLimitKes,
        grossKes: r.building.grossKes,
        nearestWetM: s?.nearestWetM ?? null,
      };
    });
    const wetDistances = followedPriced.scenarios.map((s) => (s.hazard > 0 ? 0 : s.nearestWetM)).filter((m): m is number => m !== null);
    const firstWet = perReturnPeriod.find((r) => r.depthM > 0);
    const building: FocusBuildingPrice = {
      ...lossFigures(followedPriced.tivKes, perReturnPeriod.map((r) => ({ id: r.id, label: r.label, returnPeriod: r.returnPeriod, groundUpKes: r.groundUpKes, grossKes: r.grossKes }))),
      locId: followedPriced.locId,
      housingClass: cls,
      fragility: params.fragility[cls],
      cap: params.cap[cls],
      perReturnPeriod,
      dryOnEveryTerrainMap: followedPriced.dryInEveryTier,
      dryAtPointEveryReturnPeriod: perReturnPeriod.every((r) => !(Math.max(r.terrainM, r.drainageM) > 0)),
      dryAtEveryReturnPeriod: !firstWet,
      firstWetReturnPeriod: firstWet?.returnPeriod ?? null,
      nearestWetM: wetDistances.length > 0 ? Math.min(...wetDistances) : null,
    };
    const total = driverFigures(drivers);
    const depthOnly = depthOnlyDrivers === drivers ? total : driverFigures(depthOnlyDrivers);

    // The same rows under each set of assumptions: that set's parameters, and its own judgement
    // figures when the agents argued this offer. What the underwriter typed goes over every set.
    const d = input.deliberation;
    const sets: { id: AssumptionPrice["id"]; params: ModelParams; own: Partial<OfferJudgement> | null }[] = [
      { id: "reference", params: REFERENCE_PARAMS, own: null },
      ...(d?.optimist ? [{ id: "optimist" as const, params: d.optimist.params, own: agents?.optimist ?? null }] : []),
      ...(d?.cautious ? [{ id: "cautious" as const, params: d.cautious.params, own: agents?.cautious ?? null }] : []),
      ...(d?.final ? [{ id: "agreed" as const, params: d.final.params, own: agents?.final ?? null }] : []),
    ];
    const inForceId: AssumptionPrice["id"] = input.active.source === "ai" && d?.final ? "agreed" : "reference";
    const stays = Object.fromEntries(Object.entries(judgement.fromOffer).map(([key, v]) => [key, v.value])) as Partial<OfferJudgement>;
    const assumptions = sets.map((set): AssumptionPrice => {
      const inForce = set.id === inForceId;
      const own = inRange(agentFigures(set.own));
      // The set in force takes the figures already worked out.
      const figures = inForce ? judgement.assumed : judgementWith(own, judgement.typed);
      const priced = inForce ? drivers! : (driversWith!(set.params, figures, mode) ?? drivers!);
      const point = inForce ? depthOnlyDrivers : mode === "depth_only" ? priced : (driversWith!(set.params, figures, "depth_only") ?? depthOnlyDrivers);
      const headline = inForce ? total : driverFigures(priced);
      const pointFigures = inForce ? depthOnly : point === priced ? headline : driverFigures(point);
      return {
        id: set.id,
        label: ASSUMPTION_LABELS[set.id],
        inForce,
        params: set.params,
        judgement: { ...figures, ...stays },
        judgementFromAgents: own !== null && Object.keys(own).length > 0,
        loss100GrossKes: headline.loss100GrossKes,
        loss100GroundUpKes: headline.loss100GroundUpKes,
        loss100Extrapolated: headline.loss100Extrapolated,
        aalGrossKes: headline.aalGrossKes,
        aalGroundUpKes: headline.aalGroundUpKes,
        ratePerMilleGross: headline.ratePerMilleGross,
        aalGrossByDriverKes: priced.aal.grossKes,
        floodPremiumKes: priced.premium.floodPremiumKes,
        floodRatePerMille: priced.premium.floodRatePerMille,
        premiumSetBy: priced.premium.setBy,
        depthOnly: {
          loss100GrossKes: pointFigures.loss100GrossKes,
          loss100GroundUpKes: pointFigures.loss100GroundUpKes,
          loss100Extrapolated: pointFigures.loss100Extrapolated,
          aalGrossKes: pointFigures.aalGrossKes,
          aalGroundUpKes: pointFigures.aalGroundUpKes,
          ratePerMilleGross: pointFigures.ratePerMilleGross,
        },
        building: priced.perReturnPeriod.map((r) => ({
          id: r.id,
          returnPeriod: r.returnPeriod,
          depthM: r.depths.surfaceM,
          effectiveDepthM: damageDetail(r.depths.surfaceM, cls, set.params).effectiveDepthM,
          damageRatio: r.building.damageRatio,
          capped: r.building.capped,
          groundUpKes: r.building.groundUpTotalKes,
          grossKes: r.building.grossKes,
        })),
      };
    });

    price = {
      scenarios: pricing.scenarios,
      pricedCount: pricedRows.length,
      building,
      total,
      depthOnly,
      portfolio: portfolioOf(input, portfolioRun(input, mode, judgement.assumed), total, depthOnly, pricedRows.length, followed, cls),
      assumptions,
    };
  }
  if (!price) drivers = null;

  // One list of checks for every screen and both exports: the three on the loss drivers join it once there is a price.
  const checks = price && drivers ? [...readChecks, ...offerDriverChecks({ drivers, total: price.total, depthOnly: price.depthOnly, point: pricing.totals })] : readChecks;

  // With Basement ingress on, the check on basements is not raised as a point of its own: "basement-ingress" carries it.
  const basementPriced = drivers?.lines.find((l) => l.id === "basement")?.on ?? false;
  const fromChecks = checks.filter((c) => c.status !== "pass" && !(basementPriced && c.id === "offer-basements")).map((c) => checkAsFlag(c, extraction, rows, pricing, counts));
  const flags = flagsFromChecks(fromChecks, price && followed && drivers ? ownFlags(input, extraction, terms, followed, price, drivers) : []);
  const facts = factsOf(extraction, counts, followed, price, drivers ? stated : null);

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
    drivers,
    price,
    site,
    questions,
    checks,
    flags,
    facts,
    conditions: suggestedConditions(flags, facts),
    summary: summary(price?.total.loss100GrossKes ?? null, price?.total.aalGrossKes ?? null, outside),
    rows,
    pricing,
  };
}
