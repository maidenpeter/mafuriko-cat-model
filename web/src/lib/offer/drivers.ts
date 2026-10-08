import { fmtInt, fmtNum } from "../format";
import { kes1, LOSS_MODE_LABELS, rpLabel, shareText } from "../labels";
import { siteDepths, structureLoss, type LossMode, type SiteDepths } from "../model/drivers";
import { averageAnnualLoss, lossAtReturnPeriod, type CurvePoint } from "../model/financial";
import { scenarioReturnPeriods } from "../model/pipeline";
import type { Dataset, HousingClass, ModelParams } from "../model/types";
import { JRC_AFRICA_RESIDENTIAL } from "../model/vulnerability";
import { BASEMENT_LADDER, enforceJudgement, ladderValue, OUTAGE_LADDER, type OfferJudgement } from "./judgement";
import { termsSplit } from "./terms";
import { USABLE_STATUSES, type FloodLoss, type NoteKind, type OfferExtraction, type OfferScenario, type PolicyTerms, type Quoted } from "./types";
import { usableValue } from "./verify";

/**
 * The six loss drivers of one offer, and the premium they build up to. The method is written out
 * at the top of judgement.ts; this file is that method for an offer and nothing else.
 *
 * At each return period, for each insured building:
 *
 *   1. Surrounding flooding   the structure's loss at the depth at the point, plus what the highest
 *                             depth within the buffer adds
 *   2. Drainage ponding       what ponding adds when it is deeper still
 *   3. Drain overload         what the shallow water of overloaded drains adds when the rest is drier
 *   4. Basement ingress       value below ground x the basement damage ratio, once water at the site
 *                             reaches the ingress threshold and the building has basements; never a
 *                             smaller share than the damage curve gives the structure at the same water
 *   5. Business interruption  outage days x a day's rent or revenue, when the offer says it is
 *                             covered and water reaches the site
 *   6. Uncertainty loading    a stated share of drivers 1 to 5, always its own line
 *
 *   ground-up = the six added up       gross = ground-up less the deductible, capped at the limit
 *
 * Drivers 1 to 3 put water at the same building, so the structure's loss is read once on the
 * damage curve, at the deepest of the three, and each is credited with what it adds (structureLoss
 * in model/drivers.ts). The structure's value is the insured value less the value below ground, so
 * no part of the insured value is counted twice. The value below ground is taken off the curve and
 * given the basement ladder, but it never loses a smaller share than the curve would have given it,
 * so all loss drivers never price a building below Depth only.
 *
 * Amounts the document states for the whole offer (the value below ground, a year's rent, the
 * premium) are set against the whole offer's insured value, priced or not, so a building left out
 * of the price never hands its share to the ones that are priced.
 *
 * With mode "depth_only" drivers 3 to 6 are zero, the buffer is not read and the result is the
 * point pricing of priceOffer to the last decimal.
 *
 * Code only: nothing here reaches a language model. Every figure names where it came from: the
 * offer, with the sentence it rests on, or an assumption, with the judgement figure it used.
 *
 * Units: KES, metres, damage ratios and shares as fractions, return periods in years.
 * null always means "not known" or "does not apply", never zero.
 */

// ---------------------------------------------------------------------------------------------
// The drivers and their names
// ---------------------------------------------------------------------------------------------

/** The six drivers, in the order they are added up and shown. */
export const DRIVER_IDS = ["surrounding", "ponding", "overload", "basement", "interruption", "uncertainty"] as const;
export type DriverId = (typeof DRIVER_IDS)[number];

/** The drivers that are modelled causes of loss. Uncertainty loading is a share on top of these five. */
export const MODELLED_DRIVER_IDS = ["surrounding", "ponding", "overload", "basement", "interruption"] as const satisfies readonly DriverId[];

/** The names shown on screen, word for word. With Depth only the first one reads differently: see driverName. */
export const DRIVER_LABELS: Record<DriverId, string> = {
  surrounding: "Surrounding flooding",
  ponding: "Drainage ponding",
  overload: "Drain overload",
  basement: "Basement ingress",
  interruption: "Business interruption",
  uncertainty: "Uncertainty loading",
};

/** With Depth only the first line is the loss at the point alone: no surroundings are read, so it is not called Surrounding flooding. */
export const POINT_ONLY_LABEL = "Depth at the point";

/** A driver's name under a mode. The one place the Depth only name of the first line is decided: every line's `label` comes from here. */
export const driverName = (id: DriverId, mode: LossMode): string => (id === "surrounding" && mode === "depth_only" ? POINT_ONLY_LABEL : DRIVER_LABELS[id]);

/**
 * Where one input of a figure came from.
 *   offer       read from the document: `quote` is its sentence, "" when the underwriter typed the value
 *   assumption  a stated assumption: `keys` are the judgement figures it used (see judgement.ts), empty
 *               for an assumption kept elsewhere, such as the reach and depths of drainage ponding
 *   data        the loaded data: the hazard maps, the drainage layer, the published damage curve
 */
export type DriverSource =
  | { kind: "offer"; what: string; quote: string }
  | { kind: "assumption"; what: string; keys: (keyof OfferJudgement)[] }
  | { kind: "data"; what: string };

/** One driver as a line of the build-up: whether it applies, why, and what it rests on. */
export interface DriverLine {
  id: DriverId;
  /** driverName(id, mode): DRIVER_LABELS[id], except that with Depth only the first line is "Depth at the point". Every screen and record reads this. */
  label: string;
  /** False when the driver takes no part in this price: switched off by the mode, not covered, or not applicable to the building. */
  on: boolean;
  /** One plain sentence: how the driver is worked out when it is on, or why it is off. */
  text: string;
  /** Everything the driver's figures rest on. Never empty: an off driver still names what switched it off. */
  sources: DriverSource[];
}

// ---------------------------------------------------------------------------------------------
// What the document states, as plain values
// ---------------------------------------------------------------------------------------------

/** One stated value that may be used: its status is verified, confirmed or edited. */
export interface StatedValue<T> {
  value: T;
  /** The document's sentence. "" when the underwriter typed the value. */
  quote: string;
  /** True when the underwriter typed it over what was read. */
  typed: boolean;
}

/** The stated values the drivers and the premium read. Each is null when the document does not state it or its check failed. */
export interface OfferStated {
  /** Basement levels. 0 when the document says there are none. */
  basements: StatedValue<number> | null;
  /** Total depth below ground, in metres. */
  basementDepthM: StatedValue<number> | null;
  /** The return period the site's drains were designed for, in years. */
  drainDesignRp: StatedValue<number> | null;
  /** Sump pump capacity, as the document words it. */
  sumpPumpCapacity: StatedValue<string> | null;
  /** Whether the sump pumps have backup power. */
  sumpPumpBackup: StatedValue<"yes" | "no"> | null;
  floodBarriers: StatedValue<"present" | "absent"> | null;
  nonReturnValves: StatedValue<"present" | "absent"> | null;
  /** The stated split of the insured value. */
  valueBuildingKes: StatedValue<number> | null;
  valueMachineryKes: StatedValue<number> | null;
  valueContentsKes: StatedValue<number> | null;
  /** Machinery and contents the document places below ground, in KES. */
  valueBelowGroundKes: StatedValue<number> | null;
  /** Rent or revenue for a year, in KES. */
  annualRentKes: StatedValue<number> | null;
  /** Whether business interruption is covered. */
  biCovered: StatedValue<"covered" | "excluded"> | null;
  /** The offer's own annual premium, all risks, in KES. */
  premiumKes: StatedValue<number> | null;
  /** Each item of equipment the document places below ground. */
  equipmentBelowGround: StatedValue<string>[];
  /** The first note of critical plant kept in a basement. */
  basementPlant: StatedValue<string> | null;
}

/**
 * One value out of an extraction, counted only when its status is verified, confirmed or edited.
 * Read by name and without trusting the shape, so an extraction made before a value existed, or
 * one built by hand, simply has it as not stated.
 */
function statedIn<T>(holder: unknown, key: string): StatedValue<T> | null {
  const quoted = (holder as Record<string, Partial<Quoted<T>> | undefined> | null | undefined)?.[key];
  if (!quoted || typeof quoted !== "object") return null;
  if (!(USABLE_STATUSES as readonly unknown[]).includes(quoted.status)) return null;
  if (quoted.value === null || quoted.value === undefined) return null;
  const typed = quoted.status === "edited";
  return { value: quoted.value, quote: typed ? "" : typeof quoted.quote === "string" ? quoted.quote.trim() : "", typed };
}

const amount = (v: StatedValue<number> | null, min = 0): StatedValue<number> | null => (v !== null && typeof v.value === "number" && Number.isFinite(v.value) && v.value >= min ? v : null);
const above = (v: StatedValue<number> | null): StatedValue<number> | null => (v !== null && typeof v.value === "number" && Number.isFinite(v.value) && v.value > 0 ? v : null);
const oneOf = <T extends string>(v: StatedValue<string> | null, allowed: readonly T[]): StatedValue<T> | null => (v !== null && (allowed as readonly string[]).includes(v.value) ? (v as StatedValue<T>) : null);

/** The usable notes of one kind: verified, confirmed or edited, in the document's order. */
export const usableNotes = (extraction: OfferExtraction, kind: NoteKind) => extraction.notes.filter((n) => n.kind === kind && usableValue(n) !== null);

/** The stated values of an extraction that the drivers and the premium use. Usable values only. */
export function statedValues(extraction: OfferExtraction): OfferStated {
  const t = extraction.terms;
  const num = (key: string) => statedIn<number>(t, key);
  const text = (key: string) => statedIn<string>(t, key);
  const equipment: unknown[] = Array.isArray((extraction as { equipmentBelowGround?: unknown }).equipmentBelowGround) ? (extraction as { equipmentBelowGround: unknown[] }).equipmentBelowGround : [];
  const plant = usableNotes(extraction, "basement_plant")[0];
  return {
    basements: amount(num("basements")),
    basementDepthM: above(num("basementDepthM")),
    drainDesignRp: above(num("drainDesignRp")),
    sumpPumpCapacity: text("sumpPumpCapacity"),
    sumpPumpBackup: oneOf(text("sumpPumpBackup"), ["yes", "no"]),
    floodBarriers: oneOf(text("floodBarriers"), ["present", "absent"]),
    nonReturnValves: oneOf(text("nonReturnValves"), ["present", "absent"]),
    valueBuildingKes: above(num("valueBuildingKes")),
    valueMachineryKes: above(num("valueMachineryKes")),
    valueContentsKes: above(num("valueContentsKes")),
    valueBelowGroundKes: above(num("valueBelowGroundKes")),
    annualRentKes: above(num("annualRentKes")),
    biCovered: oneOf(text("biCovered"), ["covered", "excluded"]),
    premiumKes: above(num("premiumKes")),
    equipmentBelowGround: equipment.flatMap((e) => {
      const item = statedIn<string>(e, "item");
      return item && typeof item.value === "string" && item.value.trim() ? [item] : [];
    }),
    basementPlant: plant ? { value: plant.value ?? "", quote: plant.status === "edited" ? "" : plant.quote.trim(), typed: plant.status === "edited" } : null,
  };
}

/** Whether the building has a basement, as far as the document says, and the sentence that says so. */
export interface BasementFact {
  /** true: it has. false: the document says there are none. null: the document does not say. */
  present: boolean | null;
  /** What that rests on, in a few plain words. */
  what: string;
  /** The document's sentence. "" when there is none. */
  quote: string;
}

/**
 * A building has a basement when the document states one or more basement levels, or places
 * equipment, plant or value below ground. It has none when the document says so. Otherwise it is
 * not known, and a basement is never assumed.
 */
export function basementFact(stated: OfferStated): BasementFact {
  const levels = stated.basements;
  if (levels && levels.value > 0) return { present: true, what: `${fmtInt(levels.value)} basement ${levels.value === 1 ? "level" : "levels"} stated`, quote: levels.quote };
  if (stated.valueBelowGroundKes) return { present: true, what: "Value below ground stated", quote: stated.valueBelowGroundKes.quote };
  if (stated.equipmentBelowGround.length > 0) return { present: true, what: "Equipment below ground stated", quote: stated.equipmentBelowGround[0].quote };
  if (stated.basementPlant) return { present: true, what: "Plant kept in a basement", quote: stated.basementPlant.quote };
  if (stated.basementDepthM) return { present: true, what: `Basement depth of ${fmtNum(stated.basementDepthM.value, 1)} m stated`, quote: stated.basementDepthM.quote };
  if (levels && levels.value === 0) return { present: false, what: "The document says there are no basements", quote: levels.quote };
  return { present: null, what: "The document does not say whether there are basements", quote: "" };
}

/** The document's own flood loss history, usable values only. */
export interface StatedFloodHistory {
  /** The number of years the loss history covers. null when not stated, not usable or not above zero. */
  years: number | null;
  /** Each stated past flood or water loss with a usable amount above zero. year is null when it is not stated or not usable. */
  losses: { year: number | null; amountKes: number; quote: string }[];
  /** True when a period and at least one loss amount are stated and every one of them is verified, confirmed or edited. */
  usable: boolean;
  /**
   * Why a loss per year cannot be worked out. null when it can.
   *   no_history_period  the document states no period for its loss history
   *   no_loss_amounts    it states no flood loss with an amount
   *   unverified         a stated amount or the period failed its check and waits for the underwriter
   */
  reason: "no_history_period" | "no_loss_amounts" | "unverified" | null;
  /** The sentence the period rests on. "" when there is none, or when the period is not usable. */
  yearsQuote: string;
}

const positive = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The stated flood loss history, counting only values whose status is verified, confirmed or
 * edited. One unverified amount, or an unverified period, makes the whole history unusable:
 * a loss per year with a loss left out would read lower than the document says.
 */
export function statedFloodHistory(extraction: OfferExtraction): StatedFloodHistory {
  // Both are optional in the type: an extraction built before the loss history was read has neither.
  const yearsQ: Quoted<number> | undefined = extraction.terms.floodHistoryYears;
  const years = yearsQ ? positive(usableValue(yearsQ)) : null;
  const entries: Partial<FloodLoss>[] = Array.isArray(extraction.floodLosses) ? extraction.floodLosses : [];

  let stated = 0;
  let unverified = yearsQ?.status === "unverified" ? 1 : 0;
  const losses: StatedFloodHistory["losses"] = [];
  for (const entry of entries) {
    const amountQ = entry?.amountKes;
    if (!amountQ || amountQ.status === "missing") continue;
    stated += 1;
    if (amountQ.status === "unverified") {
      unverified += 1;
      continue;
    }
    const amountKes = positive(usableValue(amountQ));
    if (amountKes === null) continue;
    const yearQ = entry.year;
    const year = yearQ ? usableValue(yearQ) : null;
    losses.push({ year: typeof year === "number" && Number.isFinite(year) ? year : null, amountKes, quote: amountQ.quote?.trim() ?? "" });
  }

  const reason: StatedFloodHistory["reason"] =
    yearsQ?.status === "unverified" ? "unverified" : years === null ? "no_history_period" : stated === 0 ? "no_loss_amounts" : unverified > 0 ? "unverified" : losses.length === 0 ? "no_loss_amounts" : null;
  return { years, losses, usable: reason === null, reason, yearsQuote: years !== null ? (yearsQ?.quote?.trim() ?? "") : "" };
}

const HISTORY_WHY: Record<NonNullable<StatedFloodHistory["reason"]>, string> = {
  no_history_period: "The document states no period for its loss history.",
  no_loss_amounts: "The document states no flood loss with an amount.",
  unverified: "A stated loss or the history period is not verified against the document yet.",
};

/** What the document says about the state of the site's drains, with the sentence it rests on. */
export interface DrainageFact {
  /** True when the document reports poor, blocked or silted drainage at the site. */
  poor: boolean;
  /** The sentence that says so. "" when there is none. */
  quote: string;
  /** The state of the drains as the document reports it, in one line, good or bad. null when it says nothing. */
  condition: string | null;
}

/**
 * Words in a note on the drains that say they are in a poor state. A plain word test, so it can
 * miss a report or catch a harmless one: the note's own sentence is always shown as the evidence.
 */
const POOR_DRAINS = /\b(block(ed|age|ages)?|clog(ged|s)?|silt(ed|ation)?|poor(ly)?|inadequate|insufficient|overflow(s|ed|ing)?|back(s|ed|ing)? up|undersized|broken|collapsed|damaged|choked|no (storm ?water )?drain(s|age)?)\b/i;
const DRAINS_FINE = /\b(not|never|no longer|without|free of|free from|cleared of)\s+(\w+\s+){0,2}(block|clog|silt|overflow|back)/i;

/** The state of the drains as the document's usable notes report it. */
export function drainageFact(extraction: OfferExtraction): DrainageFact {
  const notes = usableNotes(extraction, "drainage_condition");
  const poor = notes.find((n) => {
    const words = `${n.value ?? ""} ${n.quote}`;
    return POOR_DRAINS.test(words) && !DRAINS_FINE.test(words);
  });
  return { poor: poor !== undefined, quote: (poor ?? notes[0])?.quote.trim() ?? "", condition: (poor ?? notes[0])?.value?.trim() || null };
}

// ---------------------------------------------------------------------------------------------
// The input and the result
// ---------------------------------------------------------------------------------------------

/** One insured building, as the drivers need it. */
export interface DriverBuilding {
  /** Decimal degrees, west negative. */
  lon: number;
  /** Decimal degrees, south negative. */
  lat: number;
  /** The class whose damage curve is read. */
  housingClass: HousingClass;
  /** The insured value in KES. */
  tivKes: number;
  /** The building's name, for saying whose depths are shown when the offer lists several. Read by nothing else. */
  name?: string;
  /**
   * Drainage ponding at the building per scenario id, in metres, when the engine has already
   * worked it out (priceOffer's drainageM). Left out, it is read from the data set's drainage layer.
   */
  pondingM?: Record<string, number>;
}

export interface OfferDriversInput {
  /**
   * The loaded data set as the view shows it: the hazard maps, the hazard kind and, when the
   * Flood source switch has drainage on, dataset.drainage. Its buildings are not read.
   */
  dataset: Dataset;
  /** The model's assumptions in force: depth scale, fragility, caps and return periods. */
  params: ModelParams;
  /** The building the steps follow. The depths and the components reported are this building's. */
  building: DriverBuilding;
  /** The offer's other priced buildings, when it lists several. Each is read at its own point and the losses are added. */
  others?: DriverBuilding[];
  /** What was read from the document. Only values whose status is verified, confirmed or edited are counted. */
  extraction: OfferExtraction;
  /** The offer's deductible and limit, applied to the sum of the six drivers. */
  terms: PolicyTerms;
  /** The judgement figures in force. Put through enforceJudgement here, so nothing out of range is ever used. */
  judgement: OfferJudgement;
  /** "depth_only" for the point pricing as it was; "all_drivers" for the six drivers. */
  mode: LossMode;
  /**
   * The insured value of the whole offer in KES: every building with a usable value, priced or
   * not. What the document states for the whole offer (the value below ground, a year's rent, the
   * premium) is set against this. Left out, or below the priced buildings' own total, the priced
   * buildings' total is used.
   */
  offerTivKes?: number;
  /**
   * The portfolio's 1-in-100 gross loss without the offer and with it, for the capital load.
   * `with` may be left out: the offer's own 1-in-100 gross loss is then what it adds, which is
   * the same figure, as both curves are read at the same return periods. Left out altogether, or
   * with `without` null, the offer's own 1-in-100 gross loss stands for what it adds.
   */
  portfolioLoss100Kes?: { without: number | null; with?: number | null } | null;
}

/** One return period: the water at the site, each driver's loss, and what the terms take off. */
export interface DriverReturnPeriod extends OfferScenario {
  /** The water at the followed building: at the point, within the buffer, ponding, drain overload, and the deepest of them under the mode in force. */
  depths: SiteDepths;
  /** Which reading gave the deepest water. "dry" when there is none. */
  surfaceFrom: "point" | "buffer" | "ponding" | "overload" | "dry";
  /** Ground-up loss of each driver, every priced building of the offer added up. */
  groundUpKes: Record<DriverId, number>;
  /** The part of Surrounding flooding that the depth at the point alone gives. */
  pointKes: number;
  /** The part of Surrounding flooding that the deeper water within the buffer adds. */
  bufferAddedKes: number;
  /** The structure's loss: drivers 1 to 3 together, read once on the damage curve at the deepest water. */
  structureKes: number;
  /** Drivers 1 to 5 added up: the modelled ground-up loss before the uncertainty loading. */
  modelledKes: number;
  /** All six added up: the ground-up loss the terms are applied to. */
  groundUpTotalKes: number;
  /** The part of the loss the policyholder keeps under the deductible. */
  deductibleKes: number;
  /** The part of the loss above the limit. */
  overLimitKes: number;
  /** Gross loss: ground-up less the deductible, capped at the limit. */
  grossKes: number;
  /** The gross loss shared between the drivers in proportion to their ground-up loss. Adds up to grossKes. */
  grossByDriverKes: Record<DriverId, number>;
  /** What happens at any priced building of the offer in this flood, not only the followed one. With one building these say the same as `depths` and `building`. */
  anyBuilding: {
    /** Water of any kind at a building's site. */
    wet: boolean;
    /** Water at a building's point itself. */
    wetAtPoint: boolean;
    /** Water within a building's buffer, deeper than at its point. */
    wetInBuffer: boolean;
    /** The drains are overloaded. */
    overloaded: boolean;
    /** A basement takes water. */
    basementTakesWater: boolean;
  };
  /** The followed building alone: with one building these are the figures above. */
  building: {
    /** The structure's damage ratio at the deepest water, and whether the class's cap set it. */
    damageRatio: number;
    capped: boolean;
    /** True when water at the site reaches the ingress threshold and the building has basements. */
    basementTakesWater: boolean;
    /** The basement damage ratio for this return period, off the ladder. Applied only when the basement takes water. */
    basementDamageRatio: number;
    /**
     * The share of the value below ground lost in this flood: the ladder's ratio once the basement
     * takes water, and never less than the structure's damage ratio at the same water. 0 when the
     * building has no basement in the price.
     */
    basementAppliedRatio: number;
    /** Outage days for this return period, off the ladder. Applied only when interruption is covered and water reaches the site. */
    outageDays: number;
    /** Each driver's ground-up loss for this building. */
    groundUpKes: Record<DriverId, number>;
    groundUpTotalKes: number;
    deductibleKes: number;
    overLimitKes: number;
    grossKes: number;
  };
}

/** One part of the building, for the Vulnerability step: its value, where that came from, and its damage per return period. */
export interface DriverComponent {
  id: "structure" | "below_ground" | "interruption";
  /** "Structure", "Basement machinery and contents", "Business interruption". */
  label: string;
  /** False when the part takes no loss in this price: no basement, interruption not covered, or Depth only is selected. */
  on: boolean;
  /**
   * The value at risk, for the followed building. Structure: insured value less the value below
   * ground. Below ground: machinery and contents in the basement. Interruption: a year's rent or revenue.
   */
  valueKes: number;
  /** Where that value came from: the offer with its sentence, or an assumption with its judgement figure. */
  valueSource: DriverSource;
  /** What gives its damage: the published curve, the basement ladder or the outage ladder. */
  damageSource: DriverSource;
  /** One plain sentence on the part. */
  text: string;
  /** Most frequent first. */
  perReturnPeriod: {
    id: string;
    returnPeriod: number;
    /** The share of the value lost: the curve's damage ratio, the ladder's (never below the curve's at the same water), or outage days / 365. 0 when the part takes no loss at this return period. */
    damageRatio: number;
    /** Ground-up loss of the part. */
    lossKes: number;
    /** Outage days applied. Only for interruption; 0 when no water reaches the site. */
    days?: number;
  }[];
  /** A day's rent or revenue: valueKes / 365, what each day of outage costs. Only for interruption; 0 when it is off. */
  dailyKes?: number;
}

/** One part of the insured value as the offer states it. */
export interface StatedValuePart {
  id: "building" | "machinery" | "contents";
  /** "Building", "Plant and machinery", "Contents". */
  label: string;
  /** The stated amount in KES. null when the document does not state it or its check failed. */
  kes: number | null;
  /** The document's sentence. "" when there is none, or when the underwriter typed the amount. */
  quote: string;
  /** True when the underwriter typed the amount. */
  typed: boolean;
}

/** The split of the insured value as the offer states it, read against the insured value. Context: it changes no loss. */
export interface StatedValueSplit {
  /** Building, plant and machinery, contents, in that order, stated or not. */
  parts: StatedValuePart[];
  /** How many of the three the offer states. */
  statedCount: number;
  /** The stated parts added up, in KES. 0 when none is stated. */
  statedKes: number;
  /** True when all three are stated, so the total can be read against the insured value. */
  complete: boolean;
  /** Stated total less the insured value of every priced building, in KES. null unless all three are stated. */
  gapKes: number | null;
  /** True when the three stated parts add up to the insured value, to within one shilling. null unless all three are stated. */
  agrees: boolean | null;
}

/** One line of the premium build-up. */
export interface PremiumLine {
  /** A driver's modelled average annual loss, the capital load, the minimum rate, or one of the two totals. */
  id: DriverId | "capital_load" | "technical" | "minimum" | "flood_premium";
  label: string;
  /** KES a year. */
  kes: number;
  /** The same as a rate per mille of the insured value. */
  ratePerMille: number;
  /** One plain sentence on the line. */
  text: string;
  /** What the line rests on. */
  sources: DriverSource[];
}

export interface OfferDrivers {
  /** The mode these figures were worked out in. */
  mode: LossMode;
  /** The insured value every loss and rate here is measured against: every priced building added up. */
  tivKes: number;
  /** The insured value of the whole offer, priced or not: what the document's own amounts for the offer are set against. Equal to tivKes when every building is priced. */
  offerTivKes: number;
  /** How many buildings the figures cover. 1 unless the offer lists several. */
  buildings: number;
  /**
   * For an offer with several priced buildings, whose water is shown: the depths, the damage ratios
   * and the components are one building's, while the losses and the premium are all of them added
   * up. One sentence, ready to show. null when the figures cover one building.
   */
  depthsFor: string | null;
  /** The split of the insured value as the offer states it, with its total and whether that agrees with the insured value. */
  valueSplit: StatedValueSplit;
  /** The judgement figures as used, after their allowed ranges were enforced. */
  judgement: OfferJudgement;
  /** The buffer read around the building, in metres. 0 in "depth_only". */
  bufferRadiusM: number;
  /** The drain design return period used, in years, and whether the offer states it or it is the assumption. */
  drainDesign: { returnPeriod: number; source: DriverSource };
  /** Whether the building has a basement, as far as the document says. */
  basement: BasementFact;
  /** Whether business interruption is covered: "covered", "excluded", or null when the document does not say. Not priced unless covered. */
  interruptionCover: "covered" | "excluded" | null;
  /** The six drivers, in order: whether each applies and what it rests on. */
  lines: DriverLine[];
  /** One row per modelled return period, most frequent first. */
  perReturnPeriod: DriverReturnPeriod[];
  /** The followed building as parts, for the Vulnerability step. */
  components: DriverComponent[];
  /** Average annual loss by driver: the area under each driver's curve, worked out as the portfolio's is. */
  aal: {
    /** Before any terms. */
    groundUpKes: Record<DriverId, number>;
    /** After the deductible and the limit, shared between the drivers in proportion. */
    grossKes: Record<DriverId, number>;
    groundUpTotalKes: number;
    grossTotalKes: number;
  };
  /** The loss in a 1-in-100 flood, all six drivers, read off the curve. null when 100 years is more frequent than anything modelled. */
  loss100: { groundUpKes: number | null; grossKes: number | null; extrapolated: boolean };
  /** The first return period at which each thing happens at any priced building of the offer. null when it never does in the floods modelled. */
  firstReturnPeriod: {
    /** Water of any kind at the site. */
    wet: number | null;
    /** Water at the point itself. */
    wetAtPoint: number | null;
    /** Water within the buffer, deeper than at the point. */
    wetInBuffer: number | null;
    /** The drains are overloaded. */
    overloaded: number | null;
    /** The basement takes water. */
    basement: number | null;
  };
  /** The premium build-up: modelled average annual loss by driver, uncertainty, capital load, then the minimum rate as a floor. */
  premium: {
    /** In order: the five modelled drivers, uncertainty loading, capital load, the technical premium, the minimum, the flood premium. */
    lines: PremiumLine[];
    /** Gross average annual loss of drivers 1 to 5. */
    modelledAalKes: number;
    /** Gross average annual loss of the uncertainty loading. */
    uncertaintyAalKes: number;
    /** One sentence for the table's caption: each driver's line is gross, after the deductible and the limit. Said once, so no driver's row repeats it. */
    caption: string;
    /**
     * Cost of capital x what the offer adds to the portfolio's 1-in-100 gross loss: after its
     * deductible and its limit, like every other line of the premium. It can never exceed cost of
     * capital x the most the policy pays in one flood.
     */
    capitalLoadKes: number;
    /** What the capital load was worked out from: the gross figure. addedLoss100Kes is null when a 1-in-100 loss is not modelled. */
    capital: { addedLoss100Kes: number | null; costOfCapital: number; basis: "gross" };
    /** Modelled loss, uncertainty and capital load added up. */
    technicalKes: number;
    /** The minimum rate x insured value: the floor. 0 in "depth_only", where no floor is applied. */
    minimumKes: number;
    /** The larger of the technical premium and the minimum. */
    floodPremiumKes: number;
    /** The flood premium per mille of the insured value. */
    floodRatePerMille: number;
    /** Which of the two set the flood premium. */
    setBy: "modelled" | "minimum rate";
    /**
     * The offer's own premium and all-risks rate, when it states a premium. null when it does not.
     * The premium is for the whole offer, so its rate is taken on the whole offer's insured value
     * (onTivKes), priced or not. floodShareOfAllRisks is the flood rate as a share of that
     * all-risks rate (0.12 is 12%). partlyPriced is true when the flood rate covers fewer buildings
     * than the stated premium does, and `note` then says so in one sentence; null otherwise.
     */
    stated: { premiumKes: number; ratePerMille: number; quote: string; floodShareOfAllRisks: number; onTivKes: number; partlyPriced: boolean; note: string | null } | null;
    /** The document's own flood loss history as a loss per year: a sense check beside the modelled loss, never blended in. */
    history: {
      years: number | null;
      losses: { year: number | null; amountKes: number; quote: string }[];
      totalKes: number;
      /** Stated losses / years. null when the history cannot be used. */
      lossPerYearKes: number | null;
      /**
       * The modelled figure the loss per year is set beside, on every screen and in every record:
       * the average annual loss, gross, all drivers in force added up. Gross, because a loss history
       * is what was paid.
       */
      modelledAalKes: number;
      usable: boolean;
      /** Why not, as a sentence. null when it is usable. */
      why: string | null;
      /** The sentence the period rests on. "" when there is none. */
      yearsQuote: string;
    };
  };
}

// ---------------------------------------------------------------------------------------------
// The drivers
// ---------------------------------------------------------------------------------------------

const zeroByDriver = (): Record<DriverId, number> => ({ surrounding: 0, ponding: 0, overload: 0, basement: 0, interruption: 0, uncertainty: 0 });
const sum = (values: readonly number[]) => values.reduce((t, v) => t + v, 0);
const offerSource = (what: string, stated: StatedValue<unknown>): DriverSource => ({ kind: "offer", what: stated.typed ? `${what}, typed by the underwriter` : what, quote: stated.quote });
const assumed = (what: string, ...keys: (keyof OfferJudgement)[]): DriverSource => ({ kind: "assumption", what, keys });
const fromData = (what: string): DriverSource => ({ kind: "data", what });
const depthWords = (m: number) => `${fmtNum(m, 2)} m`;

/**
 * The six drivers of an offer and the premium they build up to. Returns null, never a figure,
 * when the offer cannot be priced: a building outside any hazard map, a scenario with no map, or
 * an insured value that is not above zero. The caller then says "Outside the hazard maps loaded:
 * flood cannot be priced here" and shows no figure.
 *
 * Quick enough to run on every keystroke of an edited figure.
 */
export function offerDrivers(input: OfferDriversInput): OfferDrivers | null {
  const { dataset, params, terms, mode } = input;
  const all = mode === "all_drivers";
  const judgement = enforceJudgement(input.judgement).judgement;
  const buildings = [input.building, ...(input.others ?? [])];
  if (buildings.some((b) => !(Number.isFinite(b.tivKes) && b.tivKes > 0))) return null;
  if (dataset.scenarios.length === 0) return null;

  const stated = statedValues(input.extraction);
  const history = statedFloodHistory(input.extraction);
  const tivs = buildings.map((b) => b.tivKes);
  const tivKes = sum(tivs);
  // The whole offer's insured value, never below what is priced: what the document's own amounts are set against.
  const offerTivKes = typeof input.offerTivKes === "number" && Number.isFinite(input.offerTivKes) ? Math.max(tivKes, input.offerTivKes) : tivKes;
  const n = dataset.scenarios.length;
  const rps = scenarioReturnPeriods(dataset, params);
  // Most frequent first, as in every result of the engine.
  const order = dataset.scenarios.map((_, i) => i).sort((a, b) => rps[a] - rps[b]);

  // Driver 3: the design return period, from the offer when it states one.
  const drainDesignRp = stated.drainDesignRp?.value ?? judgement.drainDesignRp;
  const drainDesignSource: DriverSource = stated.drainDesignRp
    ? offerSource(`Drains designed for a ${rpLabel(drainDesignRp)} event`, stated.drainDesignRp)
    : assumed(`Drains taken as designed for a ${rpLabel(drainDesignRp)} event: the document states no design return period`, "drainDesignRp");

  // Driver 4: the value below ground, from the offer when it states it. The structure is the rest.
  const basement = basementFact(stated);
  const hasBasement = all && basement.present === true;
  const belowStated = stated.valueBelowGroundKes;
  // An assumed share cannot put more below ground than the plant, machinery and contents the offer states it holds.
  const movableStated = stated.valueMachineryKes && stated.valueContentsKes ? stated.valueMachineryKes.value + stated.valueContentsKes.value : null;
  const belowCapped = !belowStated && movableStated !== null && movableStated < judgement.belowGroundShare * offerTivKes;
  // A stated amount is for the whole offer, so its buildings share it by insured value, the ones not priced included.
  const belowOffer = belowStated ? belowStated.value : belowCapped ? movableStated! : judgement.belowGroundShare * offerTivKes;
  const belowGround = buildings.map((b) => (hasBasement ? Math.min(b.tivKes, belowOffer * (b.tivKes / offerTivKes)) : 0));
  const structureValue = buildings.map((b, j) => b.tivKes - belowGround[j]);
  const belowSource: DriverSource = belowStated
    ? offerSource("Machinery and contents below ground", belowStated)
    : belowCapped
      ? assumed(
          `All ${kes1(movableStated!)} of the plant, machinery and contents the offer states taken to be below ground: the document does not state the value below ground, and the assumed ${shareText(judgement.belowGroundShare)} of the insured value would be more than it states for them`,
          "belowGroundShare",
        )
      : assumed(`${shareText(judgement.belowGroundShare)} of the insured value taken to be below ground: the document does not state it`, "belowGroundShare");

  // Driver 5: only when the offer says interruption is covered.
  const interruptionCover = stated.biCovered?.value ?? null;
  const interruptionOn = all && interruptionCover === "covered";
  const rentStated = stated.annualRentKes;
  const annualRent = buildings.map((b) => (rentStated ? rentStated.value * (b.tivKes / offerTivKes) : judgement.annualRentShare * b.tivKes));
  const rentSource: DriverSource = rentStated
    ? offerSource("Rent or revenue for a year", rentStated)
    : assumed(`A year's rent or revenue taken as ${shareText(judgement.annualRentShare)} of the insured value: the document does not state it`, "annualRentShare");

  const uncertaintyShare = all ? judgement.uncertaintyLoading : 0;

  const rows: DriverReturnPeriod[] = [];
  for (let p = 0; p < order.length; p++) {
    const si = order[p];
    const scenario = dataset.scenarios[si];
    const basementRatio = ladderValue(judgement, BASEMENT_LADDER, p, n);
    const outageDays = ladderValue(judgement, OUTAGE_LADDER, p, n);

    const perBuilding: (DriverReturnPeriod["building"] & { depths: SiteDepths; pointKes: number; bufferAddedKes: number; structureKes: number })[] = [];
    for (let j = 0; j < buildings.length; j++) {
      const b = buildings[j];
      const depths = siteDepths(dataset, b.lon, b.lat, si, params, judgement, { mode, drainDesignRp, pondingM: b.pondingM?.[scenario.id] });
      // Outside a map there is no flood figure to give: no driver, no loading and no minimum.
      if (!depths) return null;
      const split = structureLoss(depths, b.housingClass, structureValue[j], params);
      const wet = depths.surfaceM > 0;
      const basementTakesWater = hasBasement && wet && depths.surfaceM >= judgement.ingressThresholdM;
      const groundUpKes = zeroByDriver();
      groundUpKes.surrounding = split.pointKes + split.surroundingKes;
      groundUpKes.ponding = split.pondingKes;
      groundUpKes.overload = split.overloadKes;
      // The value below ground never loses a smaller share than the curve gives the structure at the same water.
      const basementAppliedRatio = hasBasement ? Math.max(basementTakesWater ? basementRatio : 0, split.damageRatio) : 0;
      groundUpKes.basement = belowGround[j] * basementAppliedRatio;
      groundUpKes.interruption = interruptionOn && wet ? outageDays * (annualRent[j] / 365) : 0;
      // The structure is counted once, as the curve gives it at the deepest water: the three credits above are its parts.
      const modelledKes = split.totalKes + groundUpKes.basement + groundUpKes.interruption;
      groundUpKes.uncertainty = uncertaintyShare * modelledKes;
      perBuilding.push({
        depths,
        pointKes: split.pointKes,
        bufferAddedKes: split.surroundingKes,
        structureKes: split.totalKes,
        damageRatio: split.damageRatio,
        capped: split.capped,
        basementTakesWater,
        basementDamageRatio: basementRatio,
        basementAppliedRatio,
        outageDays,
        groundUpKes,
        groundUpTotalKes: modelledKes + groundUpKes.uncertainty,
        deductibleKes: 0,
        overLimitKes: 0,
        grossKes: 0,
      });
    }

    // The deductible and the limit act on the sum of the six, building by building, as the offer's terms say.
    const taken = termsSplit(perBuilding.map((x) => x.groundUpTotalKes), tivs, terms);
    const groundUpKes = zeroByDriver();
    const grossByDriverKes = zeroByDriver();
    perBuilding.forEach((x, j) => {
      x.deductibleKes = taken[j].deductibleKes;
      x.overLimitKes = taken[j].overLimitKes;
      x.grossKes = taken[j].grossKes;
      for (const id of DRIVER_IDS) {
        groundUpKes[id] += x.groundUpKes[id];
        if (x.groundUpTotalKes > 0) grossByDriverKes[id] += x.grossKes * (x.groundUpKes[id] / x.groundUpTotalKes);
      }
    });

    const followed = perBuilding[0];
    const d = followed.depths;
    const surfaceFrom: DriverReturnPeriod["surfaceFrom"] = !(d.surfaceM > 0)
      ? "dry"
      : d.pointM >= d.surfaceM
        ? "point"
        : all && d.bufferM >= d.surfaceM
          ? "buffer"
          : d.pondingM >= d.surfaceM
            ? "ponding"
            : all
              ? "overload"
              : "point";
    const structureKes = perBuilding.reduce((t, x) => t + x.structureKes, 0);
    rows.push({
      id: scenario.id,
      label: scenario.label,
      returnPeriod: rps[si],
      depths: d,
      surfaceFrom,
      groundUpKes,
      pointKes: perBuilding.reduce((t, x) => t + x.pointKes, 0),
      bufferAddedKes: perBuilding.reduce((t, x) => t + x.bufferAddedKes, 0),
      structureKes,
      modelledKes: structureKes + groundUpKes.basement + groundUpKes.interruption,
      groundUpTotalKes: perBuilding.reduce((t, x) => t + x.groundUpTotalKes, 0),
      deductibleKes: perBuilding.reduce((t, x) => t + x.deductibleKes, 0),
      overLimitKes: perBuilding.reduce((t, x) => t + x.overLimitKes, 0),
      grossKes: perBuilding.reduce((t, x) => t + x.grossKes, 0),
      grossByDriverKes,
      anyBuilding: {
        wet: perBuilding.some((x) => x.depths.surfaceM > 0),
        wetAtPoint: perBuilding.some((x) => x.depths.pointM > 0),
        wetInBuffer: all && perBuilding.some((x) => x.depths.bufferM > x.depths.pointM),
        overloaded: all && perBuilding.some((x) => x.depths.overloaded),
        basementTakesWater: perBuilding.some((x) => x.basementTakesWater),
      },
      building: {
        damageRatio: followed.damageRatio,
        capped: followed.capped,
        basementTakesWater: followed.basementTakesWater,
        basementDamageRatio: followed.basementDamageRatio,
        basementAppliedRatio: followed.basementAppliedRatio,
        outageDays: followed.outageDays,
        groundUpKes: followed.groundUpKes,
        groundUpTotalKes: followed.groundUpTotalKes,
        deductibleKes: followed.deductibleKes,
        overLimitKes: followed.overLimitKes,
        grossKes: followed.grossKes,
      },
    });
  }

  const curve = (pick: (row: DriverReturnPeriod) => number): CurvePoint[] => rows.map((row) => ({ returnPeriod: row.returnPeriod, lossKes: pick(row) }));
  const aalOf = (pick: (row: DriverReturnPeriod) => number) => averageAnnualLoss(curve(pick));
  const aalGroundUp = zeroByDriver();
  const aalGross = zeroByDriver();
  for (const id of DRIVER_IDS) {
    aalGroundUp[id] = aalOf((r) => r.groundUpKes[id]);
    aalGross[id] = aalOf((r) => r.grossByDriverKes[id]);
  }
  const groundUpTotalKes = aalOf((r) => r.groundUpTotalKes);
  const grossTotalKes = aalOf((r) => r.grossKes);
  const at100 = lossAtReturnPeriod(curve((r) => r.groundUpTotalKes), 100);
  const loss100 = { groundUpKes: at100.lossKes, grossKes: lossAtReturnPeriod(curve((r) => r.grossKes), 100).lossKes, extrapolated: at100.extrapolated };

  const first = (test: (row: DriverReturnPeriod) => boolean) => rows.find(test)?.returnPeriod ?? null;
  const firstReturnPeriod: OfferDrivers["firstReturnPeriod"] = {
    // Over every priced building: the losses quoted beside these are the whole offer's.
    wet: first((r) => r.anyBuilding.wet),
    wetAtPoint: first((r) => r.anyBuilding.wetAtPoint),
    wetInBuffer: all ? first((r) => r.anyBuilding.wetInBuffer) : null,
    overloaded: all ? first((r) => r.anyBuilding.overloaded) : null,
    basement: first((r) => r.anyBuilding.basementTakesWater),
  };

  // ------------------------------------------------------------------------------------------
  // Each driver as a line: whether it applies and what it rests on
  // ------------------------------------------------------------------------------------------

  const offNote = assumed(`Off: ${LOSS_MODE_LABELS.depth_only} is selected under "Losses from" in the bar above`);
  const curveSource = fromData(`Damage curve: ${JRC_AFRICA_RESIDENTIAL.source}, with the class's fragility and cap`);
  const mapsSource = fromData(dataset.hazardKind === "score" ? "Hazard maps loaded: a 0 to 1 susceptibility score turned into depth by the depth scale" : "Hazard maps loaded: flood depth in metres");
  const drainageOn = !!dataset.drainage;
  const lines: DriverLine[] = [
    {
      id: "surrounding",
      label: driverName("surrounding", mode),
      on: true,
      text: all
        ? `The structure's loss at the depth at the point, plus what the highest map depth within ${fmtInt(judgement.bufferRadiusM)} m of the building adds. The buffer stands for the building's footprint and the error in a stated coordinate.`
        : "The structure's loss at the depth at the point alone: the buffer is not read while Depth only is selected.",
      sources: all ? [mapsSource, assumed(`Buffer of ${fmtInt(judgement.bufferRadiusM)} m around the building`, "bufferRadiusM"), curveSource] : [mapsSource, curveSource],
    },
    {
      id: "ponding",
      label: DRIVER_LABELS.ponding,
      on: drainageOn,
      text: drainageOn
        ? "What shallow ponding near mapped drains and informal settlements adds when it is deeper than the map depth."
        : "Off: the Flood source switch is on Terrain only, or the data set has no drainage layer.",
      sources: drainageOn
        ? [fromData("Open map of drains, ditches, canals and informal settlements"), assumed(`Ponding within ${fmtInt(dataset.drainage?.reachM ?? 0)} m of them, with an assumed depth per return period (fixed in the model, shown on the Hazard map step)`), curveSource]
        : [assumed("Off: the Flood source switch decides whether ponding is read")],
    },
    {
      id: "overload",
      label: DRIVER_LABELS.overload,
      on: all,
      text: all
        ? `When the event is rarer than the ${rpLabel(drainDesignRp)} event the drains were designed for, the site is taken to be wet to at least ${depthWords(judgement.drainOverloadDepthM)}, even where the maps are dry.`
        : "Off: Depth only is selected.",
      sources: all ? [drainDesignSource, assumed(`Surface water of ${depthWords(judgement.drainOverloadDepthM)} when the drains are overloaded`, "drainOverloadDepthM"), curveSource] : [offNote],
    },
    {
      id: "basement",
      label: DRIVER_LABELS.basement,
      on: hasBasement,
      text: !all
        ? "Off: Depth only is selected."
        : basement.present === true
          ? `When water at the site reaches ${depthWords(judgement.ingressThresholdM)} the basement takes water: value below ground × the basement damage ratio for that event, and never a smaller share than the damage curve gives the structure at the same water.`
          : basement.present === false
            ? "Off: the document says there are no basements."
            : "Off: the document does not say whether there are basements. It is a question for the broker, not a guess.",
      sources: !all
        ? [offNote]
        : basement.present === true
          ? [
              { kind: "offer", what: basement.what, quote: basement.quote },
              belowSource,
              assumed(`Basement takes water once surface water reaches ${depthWords(judgement.ingressThresholdM)}`, "ingressThresholdM"),
              assumed("Basement damage ratio per return period", ...BASEMENT_LADDER),
            ]
          : basement.present === false
            ? [{ kind: "offer", what: basement.what, quote: basement.quote }]
            : [assumed("Not priced: no basement is assumed where the document states none")],
    },
    {
      id: "interruption",
      label: DRIVER_LABELS.interruption,
      on: interruptionOn,
      text: !all
        ? "Off: Depth only is selected."
        : interruptionCover === "covered"
          ? "At every return period where water reaches the site: outage days for that event × a day's rent or revenue."
          : interruptionCover === "excluded"
            ? "Off: the document says business interruption is not covered."
            : "Off: the document does not say whether business interruption is covered, so it is not priced. It is a question for the broker.",
      sources: !all
        ? [offNote]
        : interruptionCover !== null && stated.biCovered
          ? interruptionCover === "covered"
            ? [offerSource("Business interruption is covered", stated.biCovered), rentSource, assumed("Outage days per return period", ...OUTAGE_LADDER)]
            : [offerSource("Business interruption is not covered", stated.biCovered)]
          : [assumed("Not priced: cover is not assumed where the document does not state it")],
    },
    {
      id: "uncertainty",
      label: DRIVER_LABELS.uncertainty,
      on: all,
      text: all
        ? `${shareText(judgement.uncertaintyLoading)} on top of the five drivers above, for causes not modelled: seepage, blocked drains, pump failure. Always its own line.`
        : "Off: Depth only is selected.",
      sources: all ? [assumed(`${shareText(judgement.uncertaintyLoading)} of the modelled loss`, "uncertaintyLoading")] : [offNote],
    },
  ];
  const lineOf = (id: DriverId) => lines.find((l) => l.id === id)!;

  // ------------------------------------------------------------------------------------------
  // The followed building as parts
  // ------------------------------------------------------------------------------------------

  const components: DriverComponent[] = [
    {
      id: "structure",
      label: "Structure",
      on: true,
      valueKes: structureValue[0],
      valueSource:
        belowGround[0] > 0
          ? belowStated
            ? offerSource("Insured value less the stated value below ground", belowStated)
            : assumed("Insured value less the share taken to be below ground", "belowGroundShare")
          : fromData("The insured value: no part of it is taken to be below ground"),
      damageSource: curveSource,
      text: "Read once on the damage curve, at the deepest water drivers 1 to 3 put at the site.",
      perReturnPeriod: rows.map((r) => ({ id: r.id, returnPeriod: r.returnPeriod, damageRatio: r.building.damageRatio, lossKes: r.building.groundUpKes.surrounding + r.building.groundUpKes.ponding + r.building.groundUpKes.overload })),
    },
    {
      id: "below_ground",
      label: "Basement machinery and contents",
      on: hasBasement,
      valueKes: belowGround[0],
      valueSource: hasBasement ? belowSource : lineOf("basement").sources[0],
      damageSource: assumed("Basement damage ratio per return period", ...BASEMENT_LADDER),
      text: lineOf("basement").text,
      perReturnPeriod: rows.map((r) => ({ id: r.id, returnPeriod: r.returnPeriod, damageRatio: r.building.basementAppliedRatio, lossKes: r.building.groundUpKes.basement })),
    },
    {
      id: "interruption",
      label: "Business interruption",
      on: interruptionOn,
      valueKes: interruptionOn ? annualRent[0] : 0,
      dailyKes: (interruptionOn ? annualRent[0] : 0) / 365,
      valueSource: interruptionOn ? rentSource : lineOf("interruption").sources[0],
      damageSource: assumed("Outage days per return period", ...OUTAGE_LADDER),
      text: lineOf("interruption").text,
      perReturnPeriod: rows.map((r) => {
        const days = r.building.groundUpKes.interruption > 0 ? r.building.outageDays : 0;
        return { id: r.id, returnPeriod: r.returnPeriod, damageRatio: days / 365, lossKes: r.building.groundUpKes.interruption, days };
      }),
    },
  ];

  // ------------------------------------------------------------------------------------------
  // The premium build-up
  // ------------------------------------------------------------------------------------------

  const rate = (kes: number) => (kes / tivKes) * 1000;
  const modelledAalKes = sum(MODELLED_DRIVER_IDS.map((id) => aalGross[id]));
  const uncertaintyAalKes = aalGross.uncertainty;
  // What the offer adds to the portfolio's 1-in-100 gross loss: the difference when both sides are given, otherwise its own
  // 1-in-100 gross loss. Gross like every other line here, so no capital is charged on the deductible or on anything over the limit.
  const given = input.portfolioLoss100Kes;
  const addedLoss100Kes = given && given.without !== null && given.with !== null && given.with !== undefined ? given.with - given.without : loss100.grossKes;
  const capitalLoadKes = all && addedLoss100Kes !== null ? judgement.costOfCapital * Math.max(0, addedLoss100Kes) : 0;
  // In "depth_only" the premium is the modelled loss and nothing else, so the rate is the pure rate the model gave before.
  const technicalKes = all ? modelledAalKes + uncertaintyAalKes + capitalLoadKes : grossTotalKes;
  const minimumKes = all ? (judgement.minimumRatePerMille / 1000) * tivKes : 0;
  const floodPremiumKes = Math.max(technicalKes, minimumKes);
  const setBy: OfferDrivers["premium"]["setBy"] = technicalKes >= minimumKes ? "modelled" : "minimum rate";
  const premiumLine = (id: PremiumLine["id"], label: string, kes: number, text: string, sources: DriverSource[]): PremiumLine => ({ id, label, kes, ratePerMille: rate(kes), text, sources });
  const premiumLines: PremiumLine[] = [
    // A driver in force carries no sentence of its own: the caption says once that every one of these is gross.
    ...MODELLED_DRIVER_IDS.map((id) => premiumLine(id, lineOf(id).label, aalGross[id], lineOf(id).on ? "" : lineOf(id).text, lineOf(id).sources)),
    premiumLine("uncertainty", DRIVER_LABELS.uncertainty, uncertaintyAalKes, lineOf("uncertainty").text, lineOf("uncertainty").sources),
    premiumLine(
      "capital_load",
      "Capital load",
      capitalLoadKes,
      !all
        ? "Off: Depth only is selected."
        : addedLoss100Kes === null
          ? "None: a 1-in-100 loss is more frequent than anything modelled under these assumptions."
          : `${shareText(judgement.costOfCapital)} a year of the ${kes1(Math.max(0, addedLoss100Kes))} the offer adds to the portfolio's 1-in-100 gross loss.`,
      all ? [assumed(`Cost of capital of ${shareText(judgement.costOfCapital)} a year`, "costOfCapital"), fromData("The offer's 1-in-100 gross loss on top of the loaded portfolio's")] : [offNote],
    ),
    premiumLine("technical", "Technical flood premium", technicalKes, all ? "The modelled loss, the uncertainty loading and the capital load added up." : "The modelled average annual loss, gross.", [fromData("The lines above, added up")]),
    premiumLine(
      "minimum",
      "Minimum rate",
      minimumKes,
      all ? `${fmtNum(judgement.minimumRatePerMille, 3)} per mille of the insured value: the lowest flood rate given to any risk inside the mapped area.` : "Off: Depth only is selected.",
      all ? [assumed(`Minimum flood rate of ${fmtNum(judgement.minimumRatePerMille, 3)} per mille`, "minimumRatePerMille")] : [offNote],
    ),
    premiumLine(
      "flood_premium",
      "Flood premium",
      floodPremiumKes,
      setBy === "modelled" ? "The larger of the technical premium and the minimum: set by the technical premium." : "The larger of the technical premium and the minimum: set by the minimum rate, which is an assumption and not a measurement of this risk.",
      setBy === "modelled" ? [fromData("The technical flood premium above")] : [assumed(`Minimum flood rate of ${fmtNum(judgement.minimumRatePerMille, 3)} per mille`, "minimumRatePerMille")],
    ),
  ];

  // The split of the insured value as the offer states it. Context only: no loss is worked out from it.
  const splitPart = (id: StatedValuePart["id"], label: string, v: StatedValue<number> | null): StatedValuePart => ({ id, label, kes: v?.value ?? null, quote: v?.quote ?? "", typed: v?.typed ?? false });
  const splitParts = [splitPart("building", "Building", stated.valueBuildingKes), splitPart("machinery", "Plant and machinery", stated.valueMachineryKes), splitPart("contents", "Contents", stated.valueContentsKes)];
  const splitAmounts = splitParts.flatMap((part) => (part.kes !== null ? [part.kes] : []));
  const splitKes = sum(splitAmounts);
  const splitComplete = splitAmounts.length === splitParts.length;
  const valueSplit: StatedValueSplit = {
    parts: splitParts,
    statedCount: splitAmounts.length,
    statedKes: splitKes,
    complete: splitComplete,
    // The stated split is for the whole offer, so it is read against the whole offer's insured value.
    gapKes: splitComplete ? splitKes - offerTivKes : null,
    agrees: splitComplete ? Math.abs(splitKes - offerTivKes) < 1 : null,
  };

  const followedName = input.building.name?.trim() || "the first building listed";
  const depthsFor =
    buildings.length > 1
      ? `The depths, the damage ratios and the components are those of ${followedName}, one of the ${fmtInt(buildings.length)} buildings priced. The losses and the premium are all ${fmtInt(buildings.length)} added up.`
      : null;

  const historyTotalKes = sum(history.losses.map((l) => l.amountKes));
  const lossPerYearKes = history.usable && history.years !== null ? historyTotalKes / history.years : null;

  return {
    mode,
    tivKes,
    offerTivKes,
    buildings: buildings.length,
    depthsFor,
    valueSplit,
    judgement,
    bufferRadiusM: all ? judgement.bufferRadiusM : 0,
    drainDesign: { returnPeriod: drainDesignRp, source: drainDesignSource },
    basement,
    interruptionCover,
    lines,
    perReturnPeriod: rows,
    components,
    aal: { groundUpKes: aalGroundUp, grossKes: aalGross, groundUpTotalKes, grossTotalKes },
    loss100,
    firstReturnPeriod,
    premium: {
      lines: premiumLines,
      modelledAalKes,
      uncertaintyAalKes,
      caption: "Each driver's line is its modelled average annual loss, gross: after the deductible and the limit.",
      capitalLoadKes,
      capital: { addedLoss100Kes, costOfCapital: judgement.costOfCapital, basis: "gross" },
      technicalKes,
      minimumKes,
      floodPremiumKes,
      floodRatePerMille: rate(floodPremiumKes),
      setBy,
      // The stated premium is for the whole offer, so its rate is taken on the whole offer's insured value, priced or not.
      stated: stated.premiumKes
        ? {
            premiumKes: stated.premiumKes.value,
            ratePerMille: (stated.premiumKes.value / offerTivKes) * 1000,
            quote: stated.premiumKes.quote,
            // Rate against rate, so the comparison holds when not every building is priced.
            floodShareOfAllRisks: rate(floodPremiumKes) / ((stated.premiumKes.value / offerTivKes) * 1000),
            onTivKes: offerTivKes,
            partlyPriced: offerTivKes > tivKes + 0.5,
            note:
              offerTivKes > tivKes + 0.5
                ? `The stated premium covers the whole offer (sum insured ${kes1(offerTivKes)}), so its rate is taken on that. The flood rate is for the ${fmtInt(buildings.length)} ${buildings.length === 1 ? "building" : "buildings"} priced (${kes1(tivKes)}).`
                : null,
          }
        : null,
      history: {
        years: history.years,
        losses: history.losses,
        totalKes: historyTotalKes,
        lossPerYearKes,
        modelledAalKes: grossTotalKes,
        usable: lossPerYearKes !== null,
        why: lossPerYearKes !== null ? null : HISTORY_WHY[history.reason ?? "no_loss_amounts"],
        yearsQuote: history.yearsQuote,
      },
    },
  };
}
