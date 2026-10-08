import { HOUSING_CLASSES, type HousingClass } from "../model/types";
import { OCCUPANCIES, type Occupancy } from "../offer/types";

/**
 * What the agents are told about the offer being priced: plain facts worked out by code, and
 * the few short sentences of the document that are already quoted on screen. Nothing else of
 * the document reaches them: no names, no addresses, no contact details, no free text.
 *
 * The facts are the ones the agents need to argue the assumptions behind the loss drivers
 * (see offer/judgement.ts): what the maps show at the point and within the buffer, whether the
 * drains are overloaded, what sits below ground and how it is protected, and what is covered.
 *
 * Units: KES, metres, years, shares as fractions of 1. null always means "not known" or "the
 * document does not say", never zero. A field marked optional may be left out by whoever builds
 * the brief; readOfferBrief then fills it with null, so a prompt always carries every field.
 */
export interface OfferBrief {
  /** The construction class the building was read as, which picks its damage curve settings. */
  housingClass: HousingClass | null;
  /** What the building is used for, as the document states it. Left out or null when it does not say. The damage curve is a residential one, so this matters. */
  occupancy?: Occupancy | null;
  /** The insured value of the building, in KES. */
  insuredValueKes: number | null;
  /** The building's floor area in m², for the size of its footprint against the buffer. */
  floorAreaM2?: number | null;
  /** True when a named place stands in for coordinates the document does not give, so the point itself is uncertain. */
  locationApproximate?: boolean;

  // --- below ground --------------------------------------------------------------------------
  /** Number of basement levels. 0 when the document says there are none. */
  basements: number | null;
  /** How far the basements go below ground in total, in metres, as the document states it. */
  basementDepthM?: number | null;
  /** True when the document puts critical plant (generators, switchgear, pumps) in a basement. */
  criticalPlantInBasement: boolean;
  /** How many items of equipment the document lists as below ground. 0 means it lists none, not that there is none. */
  equipmentBelowGroundCount?: number;
  /** The value of machinery and contents below ground, in KES, when the document states it. null means code uses the assumed share of the insured value. */
  valueBelowGroundKes?: number | null;

  // --- drains and protection -----------------------------------------------------------------
  /** The state of the site's drains as the document reports it, in one line. null when it says nothing. */
  drainageCondition: string | null;
  /** The return period, in years, the document says the site's drains were designed for. null means code uses the assumed one. */
  drainDesignRp?: number | null;
  /** The sump pump's capacity in the document's own words. null when it states none. */
  sumpPumpCapacity?: string | null;
  /** Whether the sump pump has a power backup: "yes" or "no" as the document states it. */
  sumpPumpBackup?: "yes" | "no" | null;
  /** Flood barriers at the entrances below ground: "present" or "absent" as the document states it. */
  floodBarriers?: "present" | "absent" | null;
  /** Non-return valves on the drains: "present" or "absent" as the document states it. */
  nonReturnValves?: "present" | "absent" | null;

  // --- cover and history ---------------------------------------------------------------------
  /** Whether the document says business interruption is covered. null means it does not say, and the driver stays off. */
  biCovered?: "covered" | "excluded" | null;
  /** How many past flood or water losses the document states with an amount that code verified. */
  floodLossCount: number;
  /** The total of those losses, in KES. null when none is stated with an amount. */
  floodLossTotalKes: number | null;
  /** The number of years the document's loss history covers. */
  floodHistoryYears: number | null;

  // --- what the maps show --------------------------------------------------------------------
  /** The buffer radius, in metres, the depths "within the buffer" below were read with. */
  bufferRadiusM?: number | null;
  /** One entry per hazard tier, most frequent first, by the id used in the data profile. */
  depthsByTier: OfferBriefTier[];
  /** Distance from the stated point to the nearest map cell that is wet in the widest tier, in metres. 0 when the point itself is wet; null when no wet cell was found. */
  nearestMappedWaterM: number | null;
  /** Distance from the stated point to the nearest mapped river, in metres. */
  nearestRiverM: number | null;
  /** Distance from the stated point to the nearest mapped drain, in metres. */
  nearestDrainM: number | null;

  /** The short sentences of the document these facts rest on, exactly as shown on screen. */
  quotes: OfferBriefQuote[];
}

/** What the maps and the drains give at the building in one tier. The depth names are those of SiteDepths in model/drivers.ts. */
export interface OfferBriefTier {
  /** The tier's id, as in the data profile: "extreme", "common", or a return period tag. */
  tier: string;
  /** The tier's return period in years, under the assumptions in force. */
  returnPeriod?: number | null;
  /** Map depth at the point, in metres. */
  pointM: number | null;
  /** The highest map depth within the buffer, in metres. */
  bufferM: number | null;
  /** Drainage ponding at the site, in metres. */
  pondingM?: number | null;
  /** True when the event is rarer than the drains were designed for. */
  overloaded: boolean | null;
}

/** One sentence of the document, with the fact it supports. */
export interface OfferBriefQuote {
  /** What the sentence is about, for example "equipment below ground" or "past flood". */
  about: string;
  /** The sentence itself. */
  quote: string;
}

/** A quoted sentence longer than this is cut, so no long passage of a document is ever sent. */
export const BRIEF_QUOTE_MAX_CHARS = 300;
/** No more than this many quoted sentences are sent. */
export const BRIEF_MAX_QUOTES = 12;
/** No more than this many tiers are read. The model has five. */
const BRIEF_MAX_TIERS = 12;

const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const distance = (v: unknown): number | null => {
  const n = number(v);
  return n === null || n < 0 ? null : n;
};
const count = (v: unknown): number | null => {
  const n = number(v);
  return n === null || n < 0 ? null : Math.round(n);
};
const short = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const text = v.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, BRIEF_QUOTE_MAX_CHARS) : null;
};
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const oneOf = <const T extends string>(v: unknown, words: readonly T[]): T | null => ((words as readonly unknown[]).includes(v) ? (v as T) : null);
const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The brief as it arrived in a request, cut back to the fields above. Anything else sent with
 * it is dropped, text is shortened, and a value of the wrong kind becomes "not known". Returns
 * null when no brief was sent, which means the agents run without an offer.
 */
export function readOfferBrief(input: unknown): OfferBrief | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  return {
    housingClass: oneOf(raw.housingClass, HOUSING_CLASSES),
    occupancy: oneOf(raw.occupancy, OCCUPANCIES),
    insuredValueKes: distance(raw.insuredValueKes),
    floorAreaM2: distance(raw.floorAreaM2),
    locationApproximate: raw.locationApproximate === true,
    basements: count(raw.basements),
    basementDepthM: distance(raw.basementDepthM),
    criticalPlantInBasement: raw.criticalPlantInBasement === true,
    equipmentBelowGroundCount: count(raw.equipmentBelowGroundCount) ?? 0,
    valueBelowGroundKes: distance(raw.valueBelowGroundKes),
    drainageCondition: short(raw.drainageCondition),
    drainDesignRp: distance(raw.drainDesignRp),
    sumpPumpCapacity: short(raw.sumpPumpCapacity),
    sumpPumpBackup: oneOf(raw.sumpPumpBackup, ["yes", "no"]),
    floodBarriers: oneOf(raw.floodBarriers, ["present", "absent"]),
    nonReturnValves: oneOf(raw.nonReturnValves, ["present", "absent"]),
    biCovered: oneOf(raw.biCovered, ["covered", "excluded"]),
    floodLossCount: count(raw.floodLossCount) ?? 0,
    floodLossTotalKes: distance(raw.floodLossTotalKes),
    floodHistoryYears: distance(raw.floodHistoryYears),
    bufferRadiusM: distance(raw.bufferRadiusM),
    depthsByTier: list(raw.depthsByTier)
      .slice(0, BRIEF_MAX_TIERS)
      .map(record)
      .flatMap((t) => {
        const tier = short(t.tier);
        return tier !== null ? [{ tier, returnPeriod: distance(t.returnPeriod), pointM: distance(t.pointM), bufferM: distance(t.bufferM), pondingM: distance(t.pondingM), overloaded: flag(t.overloaded) }] : [];
      }),
    nearestMappedWaterM: distance(raw.nearestMappedWaterM),
    nearestRiverM: distance(raw.nearestRiverM),
    nearestDrainM: distance(raw.nearestDrainM),
    quotes: list(raw.quotes)
      .map(record)
      .flatMap((q) => {
        const about = short(q.about);
        const quote = short(q.quote);
        return about !== null && quote !== null ? [{ about, quote }] : [];
      })
      .slice(0, BRIEF_MAX_QUOTES),
  };
}
