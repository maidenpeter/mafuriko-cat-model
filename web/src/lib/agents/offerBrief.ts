import { HOUSING_CLASSES, type HousingClass } from "../model/types";
import { OCCUPANCIES, type Occupancy } from "../offer/types";

/**
 * What the agents are told about the offer being priced: plain facts worked out by code, and
 * the few short sentences of the document that are already quoted on screen. Nothing else of
 * the document reaches them: no names, no addresses, no contact details, no free text.
 *
 * Units: KES, metres, shares as fractions of 1. null always means "not known" or "the
 * document does not say", never zero.
 */
export interface OfferBrief {
  /** The construction class the building was read as, which picks its damage curve settings. */
  housingClass: HousingClass | null;
  /** What the building is used for, as the document states it. Left out or null when it does not say. The damage curve is a residential one, so this matters. */
  occupancy?: Occupancy | null;
  /** The insured value of the building, in KES. */
  insuredValueKes: number | null;
  /** Number of basement levels. 0 when the document says there are none. */
  basements: number | null;
  /** True when the document puts critical plant (generators, switchgear, pumps) in a basement. */
  criticalPlantInBasement: boolean;
  /** The state of the site's drains as the document reports it, in one line. null when it says nothing. */
  drainageCondition: string | null;
  /** How many past flood or water losses the document states with an amount that code verified. */
  floodLossCount: number;
  /** The total of those losses, in KES. null when none is stated with an amount. */
  floodLossTotalKes: number | null;
  /** The number of years the document's loss history covers. */
  floodHistoryYears: number | null;
  /** For each hazard tier, by the id used in the data profile, whether the stated point is dry in it. */
  pointDryByTier: { tier: string; dry: boolean }[];
  /** Distance from the stated point to the nearest map cell that is wet in the widest tier, in metres. 0 when the point itself is wet; null when no wet cell was found. */
  nearestMappedWaterM: number | null;
  /** The share of map cells around the stated point that are wet in the widest tier, at three distances. */
  wetShareWidestTier: {
    /** Within 100 m of the stated point. */
    within100m: number | null;
    /** Within 250 m of the stated point. */
    within250m: number | null;
    /** Within 500 m of the stated point. */
    within500m: number | null;
  };
  /** Distance from the stated point to the nearest mapped river, in metres. */
  nearestRiverM: number | null;
  /** Distance from the stated point to the nearest mapped drain, in metres. */
  nearestDrainM: number | null;
  /** The short sentences of the document these facts rest on, exactly as shown on screen. */
  quotes: OfferBriefQuote[];
}

/** One sentence of the document, with the fact it supports. */
export interface OfferBriefQuote {
  /** What the sentence is about, for example "basement plant" or "past flood". */
  about: string;
  /** The sentence itself. */
  quote: string;
}

/** A quoted sentence longer than this is cut, so no long passage of a document is ever sent. */
export const BRIEF_QUOTE_MAX_CHARS = 300;
/** No more than this many quoted sentences are sent. */
export const BRIEF_MAX_QUOTES = 8;
/** No more than this many tiers are read. The model has five. */
const BRIEF_MAX_TIERS = 12;

const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const distance = (v: unknown): number | null => {
  const n = number(v);
  return n === null || n < 0 ? null : n;
};
const share = (v: unknown): number | null => {
  const n = number(v);
  return n === null ? null : Math.min(1, Math.max(0, n));
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
  const wet = record(raw.wetShareWidestTier);
  return {
    housingClass: (HOUSING_CLASSES as readonly unknown[]).includes(raw.housingClass) ? (raw.housingClass as HousingClass) : null,
    occupancy: (OCCUPANCIES as readonly unknown[]).includes(raw.occupancy) ? (raw.occupancy as Occupancy) : null,
    insuredValueKes: distance(raw.insuredValueKes),
    basements: count(raw.basements),
    criticalPlantInBasement: raw.criticalPlantInBasement === true,
    drainageCondition: short(raw.drainageCondition),
    floodLossCount: count(raw.floodLossCount) ?? 0,
    floodLossTotalKes: distance(raw.floodLossTotalKes),
    floodHistoryYears: distance(raw.floodHistoryYears),
    pointDryByTier: list(raw.pointDryByTier)
      .slice(0, BRIEF_MAX_TIERS)
      .map(record)
      .flatMap((t) => {
        const tier = short(t.tier);
        return tier !== null && typeof t.dry === "boolean" ? [{ tier, dry: t.dry }] : [];
      }),
    nearestMappedWaterM: distance(raw.nearestMappedWaterM),
    wetShareWidestTier: { within100m: share(wet.within100m), within250m: share(wet.within250m), within500m: share(wet.within500m) },
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
