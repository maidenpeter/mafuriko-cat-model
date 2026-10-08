import { fmtInt, fmtNum, fmtPct } from "../format";
import { sampleGrid } from "../geo/drainage";
import { cleanValue } from "../ingest/raster";
import { kes1 } from "../labels";
import { averageAnnualLoss, lossAtReturnPeriod, type CurvePoint } from "../model/financial";
import { tierSlopes } from "../model/hazard";
import { hazardToDepth, scenarioReturnPeriods } from "../model/pipeline";
import type { Dataset, HousingClass, ModelParams, Raster } from "../model/types";
import { damageDetail } from "../model/vulnerability";
import { enforceJudgement, type OfferJudgement } from "./judgement";
import { termsSplit } from "./terms";
import type { NoteKind, OfferExtraction, OfferScenario, PolicyTerms, Quoted } from "./types";
import { usableValue } from "./verify";

/**
 * The technical price of one offer, worked out by code from all the evidence. The method is
 * written out at the top of judgement.ts; this file is that method and nothing else:
 *
 *   1. the model at the stated point          one map cell, as every portfolio building is read
 *   2. the model around the site              the damage ratio averaged over the cells within the radius
 *   3. story loadings                         basements and poor drainage, as the document reports them
 *   4. the document's own flood loss history  stated losses ÷ years, blended in with a weight
 *   5. the minimum rate                       no risk inside the mapped area is priced at zero
 *
 *   loaded loss per return period = insured value × site-averaged damage ratio × (1 + loadings)
 *   gross per return period       = that loss through the offer's deductible and limit
 *   model AAL                     = area under the loaded curve, as for the portfolio
 *   blended AAL                   = (1 - w) × model AAL + w × loss history AAL
 *   indicated AAL                 = the larger of the blended AAL and minimum rate × insured value
 *   indicated pure rate           = indicated AAL ÷ insured value × 1000, per mille
 *
 * Code only: nothing here reaches a language model. The five judgement figures are assumptions;
 * a model may argue them, and enforceJudgement keeps them inside their allowed ranges.
 *
 * The portfolio's own buildings keep their point reading. Only an offer is priced this way.
 *
 * Units: KES, metres, damage ratios and shares as fractions, return periods in years.
 * null always means "not known" or "does not apply", never zero.
 */

// Metres per degree, the same figures the drainage grid and the distance checks use.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320;

// ---------------------------------------------------------------------------------------------
// What the document says, as plain facts
// ---------------------------------------------------------------------------------------------

/** The document's own flood loss history, usable values only. */
export interface StatedFloodHistory {
  /** The number of years the loss history covers. null when not stated, not usable or not above zero. */
  years: number | null;
  /** Each stated past flood or water loss with a usable amount above zero. year is null when it is not stated or not usable. */
  losses: { year: number | null; amountKes: number; quote: string }[];
  /** True when a period and at least one loss amount are stated and every one of them is verified, confirmed or edited. */
  usable: boolean;
  /**
   * Why it cannot be used. null when it can.
   *   no_history_period  the document states no period for its loss history
   *   no_loss_amounts    it states no flood loss with an amount
   *   unverified         a stated amount or the period failed its check and waits for the underwriter
   */
  reason: "no_history_period" | "no_loss_amounts" | "unverified" | null;
  /** The sentence the period rests on. "" when there is none. */
  yearsQuote: string;
}

type MaybeQuoted = Quoted<number> | undefined;
/** The loss history as it sits in the extraction once the reader fills it. Read defensively: an older extraction has neither field. */
type WithHistory = { terms?: { floodHistoryYears?: MaybeQuoted }; floodLosses?: { year?: MaybeQuoted; amountKes?: MaybeQuoted }[] };

const positive = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The stated flood loss history, counting only values whose status is verified, confirmed or
 * edited. One unverified amount, or an unverified period, makes the whole history unusable:
 * a burning cost with a loss left out would read lower than the document says.
 */
export function statedFloodHistory(extraction: OfferExtraction): StatedFloodHistory {
  const source = extraction as unknown as WithHistory;
  const yearsQ = source.terms?.floodHistoryYears;
  const years = yearsQ ? positive(usableValue(yearsQ)) : null;
  const entries = Array.isArray(source.floodLosses) ? source.floodLosses : [];

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
  return { years, losses, usable: reason === null, reason, yearsQuote: yearsQ?.quote?.trim() ?? "" };
}

/** The facts of the document's flood story that carry a loading, each with the sentence it rests on. */
export interface FloodFacts {
  /** Basement levels as stated. 0 when the document says there are none; null when it does not say. */
  basements: number | null;
  /** The sentence that states the basements. "" when there is none. */
  basementsQuote: string;
  /** True when the document puts critical plant (generators, switchgear, pumps) in a basement. */
  criticalPlantInBasement: boolean;
  /** The sentence that says so. "" when there is none. */
  criticalPlantQuote: string;
  /** True when the document reports poor, blocked or silted drainage at the site. */
  drainagePoor: boolean;
  /** The sentence that says so. "" when there is none. */
  drainageQuote: string;
  /** The state of the drains as the document reports it, in one line, good or bad. null when it says nothing. */
  drainageCondition: string | null;
}

/**
 * Words in a note on the drains that say they are in a poor state. A plain word test, so it can
 * miss a report or catch a harmless one: the note's own sentence is always shown as the evidence.
 */
const POOR_DRAINS = /\b(block(ed|age|ages)?|clog(ged|s)?|silt(ed|ation)?|poor(ly)?|inadequate|insufficient|overflow(s|ed|ing)?|back(s|ed|ing)? up|undersized|broken|collapsed|damaged|choked|no (storm ?water )?drain(s|age)?)\b/i;
const DRAINS_FINE = /\b(not|never|no longer|without|free of|free from|cleared of)\s+(\w+\s+){0,2}(block|clog|silt|overflow|back)/i;

/** The usable notes of one kind: verified, confirmed or edited, in the document's order. */
export const usableNotes = (extraction: OfferExtraction, kind: NoteKind) => extraction.notes.filter((n) => n.kind === kind && usableValue(n) !== null);

/** The flood facts of an extraction. Usable values only: an unverified note carries no loading. */
export function floodFactsOf(extraction: OfferExtraction): FloodFacts {
  const plant = usableNotes(extraction, "basement_plant")[0];
  const drainNotes = usableNotes(extraction, "drainage_condition");
  const poor = drainNotes.find((n) => {
    const words = `${n.value ?? ""} ${n.quote}`;
    return POOR_DRAINS.test(words) && !DRAINS_FINE.test(words);
  });
  const basements = usableValue(extraction.terms.basements);
  return {
    basements: basements !== null && Number.isFinite(basements) && basements >= 0 ? basements : null,
    basementsQuote: basements !== null ? extraction.terms.basements.quote.trim() : "",
    criticalPlantInBasement: plant !== undefined,
    criticalPlantQuote: plant?.quote.trim() ?? "",
    drainagePoor: poor !== undefined,
    drainageQuote: poor?.quote.trim() ?? "",
    drainageCondition: (poor ?? drainNotes[0])?.value?.trim() || null,
  };
}

// ---------------------------------------------------------------------------------------------
// The input and the result
// ---------------------------------------------------------------------------------------------

/** One insured building, as the price needs it. */
export interface TechnicalBuilding {
  /** Decimal degrees, west negative. */
  lon: number;
  /** Decimal degrees, south negative. */
  lat: number;
  /** The class whose damage curve is read. */
  housingClass: HousingClass;
  /** The insured value in KES. */
  tivKes: number;
}

export interface TechnicalInput {
  /**
   * The loaded data set as the view shows it: the hazard maps, the hazard kind and, when
   * drainage is switched on, dataset.drainage with its grid of ponding stress. With no
   * dataset.drainage the terrain maps alone are read.
   */
  dataset: Dataset;
  /** The model's assumptions in force: depth scale, fragility, caps and return periods. */
  params: ModelParams;
  /** The building the steps follow. The surroundings reported in aroundSite are this building's. */
  building: TechnicalBuilding;
  /** The offer's other priced buildings, when it lists several. Each is read around its own point the same way and the losses are added. */
  others?: TechnicalBuilding[];
  /** The offer's deductible and limit, applied exactly as for the reading at the point. */
  terms: PolicyTerms;
  /** The document's own flood loss history: statedFloodHistory(extraction). */
  history: StatedFloodHistory;
  /** The document's flood story: floodFactsOf(extraction). */
  facts: FloodFacts;
  /** The five judgement figures. Put through enforceJudgement here, so nothing out of range is ever used. */
  judgement: OfferJudgement;
}

/** One loading on the flood loss, with what it rests on. */
export interface TechnicalLoading {
  /** Which loading: critical plant in a basement, basements with no plant stated, or poor drainage. */
  id: "basement_plant" | "basements" | "drainage";
  /** Plain name of the loading: "Critical plant in a basement". */
  label: string;
  /** The share added to the flood loss: 0.25 is +25%. */
  share: number;
  /** The fact of the document it rests on, in a few plain words. */
  fact: string;
  /** The document's sentence for that fact. "" when the value was typed and has no sentence. */
  quote: string;
}

/** Which line of the build-up a figure is. */
export type BuildUpId = "at_point" | "around_site" | "with_loadings" | "loss_history" | "blended" | "minimum_rate" | "indicated";

/** One line of the build-up, ready for a table row. */
export interface BuildUpLine {
  id: BuildUpId;
  /** The line's name: "At the stated point", "Around the site", "With loadings" and so on. */
  label: string;
  /** Average annual loss before any terms. null when the line does not apply (no usable loss history). */
  aalGroundUpKes: number | null;
  /** Average annual loss after the deductible and the limit. null as above. */
  aalGrossKes: number | null;
  /** The ground-up figure as a pure rate, per mille of the insured value. null as above. */
  ratePerMilleGroundUp: number | null;
  /** The gross figure as a pure rate, per mille of the insured value. null as above. */
  ratePerMilleGross: number | null;
  /** One plain sentence on what the line is. */
  text: string;
}

export interface TechnicalPrice {
  /** The insured value every loss and rate here is measured against: every building priced, added up. */
  tivKes: number;
  /** How many buildings the figures cover. 1 unless the offer lists several. */
  buildings: number;
  /** The five judgement figures as used, after their allowed ranges were enforced. */
  judgement: OfferJudgement;

  /** The model at the stated point: one map cell, exactly as a portfolio building is read. One line of evidence, never the answer alone. */
  atPoint: {
    /** One row per modelled return period, most frequent first. */
    perReturnPeriod: (OfferScenario & {
      /** The depth used at the followed building's point: terrain or drainage ponding, whichever is deeper. */
      depthM: number;
      /** The damage ratio the curve gives at that depth for the followed building. */
      damageRatio: number;
      /** Ground-up loss at the point, every building of the offer added up. */
      groundUpKes: number;
      /** The same after the deductible and the limit. */
      grossKes: number;
    })[];
    /** Average annual loss at the point, before any terms. */
    aalGroundUpKes: number;
    /** Average annual loss at the point, after the deductible and the limit. */
    aalGrossKes: number;
    /** The ground-up figure as a pure rate, per mille. */
    ratePerMilleGroundUp: number;
    /** The gross figure as a pure rate, per mille. */
    ratePerMilleGross: number;
    /** True when the followed building's point is dry at every return period. */
    dryAtEveryReturnPeriod: boolean;
  };

  /** The model around the site: the followed building's surroundings on the same maps. */
  aroundSite: {
    /** The radius used, in metres, measured on the ground. */
    radiusM: number;
    /** How many map cells lie inside it: the point's own cell, and every cell whose centre is within the radius. */
    cells: number;
    /** The size of one map cell on the ground at this latitude, in metres: east to west, and north to south. */
    cellSizeM: { x: number; y: number };
    /** One row per modelled return period, most frequent first. */
    perReturnPeriod: (OfferScenario & {
      /** How many of those cells are wet: terrain depth or drainage ponding above zero. */
      wetCells: number;
      /** The same as a share of the cells: 0.12 is 12%. */
      wetShare: number;
      /** The average depth over the wet cells, in metres. null when none is wet. */
      meanWetDepthM: number | null;
      /** The damage ratio averaged over every cell, dry cells counted as zero. */
      damageRatio: number;
      /** Ground-up loss before loadings: insured value × that ratio, every building of the offer added up. */
      groundUpKes: number;
      /** The same after the deductible and the limit. */
      grossKes: number;
    })[];
    /** Average annual loss around the site before loadings and before terms. */
    aalGroundUpKes: number;
    /** The same after the deductible and the limit. */
    aalGrossKes: number;
  };

  /** The story loadings: what the document reports and the share each adds to the flood loss. */
  loadings: {
    /** Each loading that applies. Empty when none does. */
    applied: TechnicalLoading[];
    /** The shares added up: 0.35 is +35%. The loss is multiplied by 1 + this. */
    total: number;
  };

  /** The loaded loss at each modelled return period, most frequent first: the curve the model's part of the price rests on. */
  perReturnPeriod: (OfferScenario & {
    /** Loaded ground-up loss: insured value × site-averaged damage ratio × (1 + loadings), never above the insured value. */
    groundUpKes: number;
    /** The part of it the policyholder keeps under the deductible. */
    deductibleKes: number;
    /** The part of it above the limit. */
    overLimitKes: number;
    /** Gross loss: loaded ground-up less the deductible, capped at the limit. */
    grossKes: number;
    /** True when the loading would have taken a building's loss above its insured value and it was held there. */
    heldAtInsuredValue: boolean;
  })[];

  /** The model's part of the price: the area under the loaded curve, worked out as the portfolio's is. */
  model: {
    /** Average annual loss under the loaded curve, before any terms. */
    aalGroundUpKes: number;
    /** The same after the deductible and the limit. */
    aalGrossKes: number;
  };

  /** The document's own flood loss history, as a burning cost. */
  experience: {
    /** The years the history covers. null when not stated or not usable. */
    years: number | null;
    /** The stated past losses that could be used. */
    losses: { year: number | null; amountKes: number }[];
    /** Those losses added up. 0 when there are none. */
    totalKes: number;
    /** Stated losses ÷ years: the loss a year the document's own history points to. null when the history is not usable. */
    burningCostKes: number | null;
    /** True when the history is blended in: a period and at least one amount are stated and all of them passed their checks. */
    usable: boolean;
    /** Why it is not used. null when it is. */
    reason: StatedFloodHistory["reason"];
    /** The same reason as a sentence. null when the history is used. */
    why: string | null;
    /** The weight the history was given in the blend: the judgement's weight when usable, otherwise 0. */
    weight: number;
    /**
     * How the stated losses were treated, as a sentence for the screen. They are taken as losses
     * the insurer paid, so they enter the gross figure as they are, and the same amount stands
     * for the ground-up figure: nothing is added back for a deductible the document does not give.
     */
    treatment: string;
  };

  /** The build-up, in order: at the stated point, around the site, with loadings, the document's loss history, blended, minimum rate, indicated. */
  buildUp: BuildUpLine[];

  /** The technical price's result. */
  indicated: {
    /** Indicated average annual loss before any terms: the larger of the blended figure and the minimum rate × insured value. */
    aalGroundUpKes: number;
    /** Indicated average annual loss after the deductible and the limit, by the same rule. */
    aalGrossKes: number;
    /** Indicated pure rate, ground-up: indicated average annual loss ÷ insured value × 1000. Before expense, profit and uncertainty loadings. */
    ratePerMilleGroundUp: number;
    /** Indicated pure rate, gross. */
    ratePerMilleGross: number;
    /** Which line set the gross figure, the one the offer is priced on: the blended line, or the minimum rate. */
    setBy: "blended" | "minimum rate";
    /** Which line set the ground-up figure. It can differ from setBy when the deductible takes most of a small loss. */
    setByGroundUp: "blended" | "minimum rate";
    /** The loaded ground-up loss in a 1-in-100 flood, read off the loaded curve. null when 100 years is more frequent than anything modelled. */
    loss100GroundUpKes: number | null;
    /** The loaded gross loss in a 1-in-100 flood. null as above. */
    loss100GrossKes: number | null;
    /** True when those two are held flat beyond the rarest modelled flood. */
    loss100Extrapolated: boolean;
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the maps around a point
// ---------------------------------------------------------------------------------------------

/** The map cells inside a radius of a point, on one grid. The point's own cell is always first. */
interface Disc {
  /** Index into the raster's data for each cell. */
  index: number[];
  /** The centre of each cell, for looking the same ground up on another grid. The first entry is the point itself. */
  lon: number[];
  lat: number[];
  /** One cell on the ground at this latitude, in metres. */
  cellSizeM: { x: number; y: number };
}

/**
 * The cells of a map within radiusM of a point: the cell the point is in, and every other cell
 * whose centre is within the radius. A degree of longitude is shorter than a degree of latitude
 * away from the equator, so the cells are not square on the ground: distance is measured in
 * metres, never in cells. null when the point is outside the map.
 */
function discOf(raster: Raster, lon: number, lat: number, radiusM: number): Disc | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const { width, height } = raster;
  const [minLon, minLat, maxLon, maxLat] = raster.bbox;
  // The same cell the engine reads for a building: see sampleRaster.
  const col = Math.floor(((lon - minLon) / (maxLon - minLon)) * width);
  const row = Math.floor(((maxLat - lat) / (maxLat - minLat)) * height);
  if (!(col >= 0 && row >= 0 && col < width && row < height)) return null;

  const dLon = (maxLon - minLon) / width;
  const dLat = (maxLat - minLat) / height;
  const mLon = M_PER_DEG_LON * Math.cos((lat * Math.PI) / 180);
  const cellSizeM = { x: dLon * mLon, y: dLat * M_PER_DEG_LAT };
  const disc: Disc = { index: [row * width + col], lon: [lon], lat: [lat], cellSizeM };

  const radius = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 0;
  if (!(radius > 0) || !(cellSizeM.x > 0) || !(cellSizeM.y > 0)) return disc;
  const reachX = Math.ceil(radius / cellSizeM.x);
  const reachY = Math.ceil(radius / cellSizeM.y);
  const limit = radius * radius;
  for (let r = Math.max(0, row - reachY); r <= Math.min(height - 1, row + reachY); r++) {
    const cellLat = maxLat - (r + 0.5) * dLat;
    const dy = (cellLat - lat) * M_PER_DEG_LAT;
    for (let c = Math.max(0, col - reachX); c <= Math.min(width - 1, col + reachX); c++) {
      if (r === row && c === col) continue;
      const cellLon = minLon + (c + 0.5) * dLon;
      const dx = (cellLon - lon) * mLon;
      if (dx * dx + dy * dy > limit) continue;
      disc.index.push(r * width + c);
      disc.lon.push(cellLon);
      disc.lat.push(cellLat);
    }
  }
  return disc;
}

const sameGrid = (a: Raster, b: Raster) => a.width === b.width && a.height === b.height && a.bbox.every((v, i) => v === b.bbox[i]);

/** The maps of a data set in the order of its scenarios, or null when a scenario has no map: nothing can then be read at a new point. */
function mapsOf(dataset: Dataset): Raster[] | null {
  const maps = dataset.scenarios.map((s) => dataset.rasters.find((r) => r.scenarioId === s.id));
  return maps.length > 0 && maps.every((m): m is Raster => m !== undefined) ? maps : null;
}

/** The discs of one point on every scenario's map. Maps on one grid share a disc. null when the point is outside any of them. */
function discsOf(maps: Raster[], lon: number, lat: number, radiusM: number): Disc[] | null {
  const discs: Disc[] = [];
  for (let i = 0; i < maps.length; i++) {
    const shared = i > 0 && sameGrid(maps[i], maps[0]) ? discs[0] : discOf(maps[i], lon, lat, radiusM);
    if (!shared) return null;
    discs.push(shared);
  }
  return discs;
}

/** Drainage stress, 0 to 1, at each cell of a disc. null when drainage is off. The point's own cell is read at the point, as the engine reads a building. */
function stressOf(dataset: Dataset, disc: Disc): Float64Array | null {
  const grid = dataset.drainage?.grid;
  if (!grid) return null;
  const out = new Float64Array(disc.index.length);
  for (let j = 0; j < out.length; j++) out[j] = sampleGrid(grid, grid.stress, disc.lon[j], disc.lat[j]) || 0;
  return out;
}

/** One building in one scenario: the reading at its point and the reading around it. */
interface SiteReading {
  /** At the point's own cell. */
  point: { depthM: number; damageRatio: number };
  cells: number;
  wetCells: number;
  /** Depth added up over the wet cells. */
  wetDepthM: number;
  /** The damage ratio averaged over every cell of the disc. */
  damageRatio: number;
}

/**
 * Every scenario of the data set (in its own order) read at and around one building. Each cell is
 * read exactly as the model reads a point: terrain depth from the map value with the tier slope
 * and the depth scale, or drainage ponding at that cell, whichever is deeper.
 *
 * What is averaged over the cells is the DAMAGE RATIO, not the depth. The damage curve is not a
 * straight line: it rises fastest in the first half metre and a class's cap cuts it off. So the
 * damage at the average depth is not the average damage. One cell in ten under a metre of water
 * is a tenth of that cell's damage, not the damage of ten centimetres of water everywhere.
 * Dry cells count as zero damage.
 */
function readSite(dataset: Dataset, maps: Raster[], slopes: number[], params: ModelParams, b: TechnicalBuilding, radiusM: number): { discs: Disc[]; perScenario: SiteReading[] } | null {
  const discs = discsOf(maps, b.lon, b.lat, radiusM);
  if (!discs) return null;
  const kind = dataset.hazardKind;
  const ponding = dataset.drainage?.depthM;
  const stressBy = new Map<Disc, Float64Array | null>();
  const perScenario = maps.map((map, si): SiteReading => {
    const disc = discs[si];
    if (!stressBy.has(disc)) stressBy.set(disc, stressOf(dataset, disc));
    const stress = stressBy.get(disc) ?? null;
    const full = ponding?.[si] ?? 0;
    let wetCells = 0;
    let wetDepthM = 0;
    let ratioSum = 0;
    let point = { depthM: 0, damageRatio: 0 };
    for (let j = 0; j < disc.index.length; j++) {
      const terrainM = hazardToDepth(cleanValue(map.data[disc.index[j]], map, kind), dataset, params, slopes[si]);
      const drainageM = stress ? stress[j] * full : 0;
      const depthM = Math.max(terrainM, drainageM);
      if (!(depthM > 0)) continue;
      const ratio = damageDetail(depthM, b.housingClass, params).damageRatio;
      wetCells += 1;
      wetDepthM += depthM;
      ratioSum += ratio;
      if (j === 0) point = { depthM, damageRatio: ratio };
    }
    return { point, cells: disc.index.length, wetCells, wetDepthM, damageRatio: ratioSum / disc.index.length };
  });
  return { discs, perScenario };
}

/**
 * How much of the ground around a point is wet on one scenario's map, at each radius asked for:
 * terrain water, or drainage ponding when the data set carries it. For the map and for the facts
 * the agents are given. null when the point is outside the map or the scenario has no map.
 */
export function wetShareAround(dataset: Dataset, lon: number, lat: number, scenarioIndex: number, radiiM: readonly number[]): { radiusM: number; cells: number; wetCells: number; wetShare: number }[] | null {
  const scenario = dataset.scenarios[scenarioIndex];
  const map = scenario ? dataset.rasters.find((r) => r.scenarioId === scenario.id) : undefined;
  if (!map) return null;
  const full = dataset.drainage?.depthM[scenarioIndex] ?? 0;
  const out: { radiusM: number; cells: number; wetCells: number; wetShare: number }[] = [];
  for (const radiusM of radiiM) {
    const disc = discOf(map, lon, lat, radiusM);
    if (!disc) return null;
    const stress = full > 0 ? stressOf(dataset, disc) : null;
    let wetCells = 0;
    for (let j = 0; j < disc.index.length; j++) {
      if (cleanValue(map.data[disc.index[j]], map, dataset.hazardKind) > 0 || (stress !== null && stress[j] * full > 0)) wetCells += 1;
    }
    out.push({ radiusM, cells: disc.index.length, wetCells, wetShare: wetCells / disc.index.length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The price
// ---------------------------------------------------------------------------------------------

const sum = (values: readonly number[]) => values.reduce((t, v) => t + v, 0);
const years = (n: number) => `${fmtNum(n, 1)} ${n === 1 ? "year" : "years"}`;
const plus = (share: number) => `+${fmtPct(share, 0)}`;

const BUILD_UP_LABELS: Record<BuildUpId, string> = {
  at_point: "At the stated point",
  around_site: "Around the site",
  with_loadings: "With loadings",
  loss_history: "The document's loss history",
  blended: "Blended",
  minimum_rate: "Minimum rate",
  indicated: "Indicated",
};

const HISTORY_WHY: Record<NonNullable<StatedFloodHistory["reason"]>, string> = {
  no_history_period: "The document states no period for its loss history.",
  no_loss_amounts: "The document states no flood loss with an amount.",
  unverified: "A stated loss or the history period is not verified against the document yet.",
};

const TREATMENT = "Stated past losses are taken as losses the insurer paid: they enter the gross figure as they are, and the same amount stands for the ground-up figure.";

/** The loadings the document's flood story carries under these judgement figures. Additive: the loss is multiplied by 1 + their total. */
function loadingsOf(facts: FloodFacts, judgement: OfferJudgement): TechnicalPrice["loadings"] {
  const applied: TechnicalLoading[] = [];
  if (facts.criticalPlantInBasement) {
    applied.push({ id: "basement_plant", label: "Critical plant in a basement", share: judgement.basementLoading, fact: "The document puts critical plant in a basement.", quote: facts.criticalPlantQuote });
  } else if (facts.basements !== null && facts.basements > 0) {
    // Basements with no plant stated in them: half the loading.
    const levels = `${fmtInt(facts.basements)} basement ${facts.basements === 1 ? "level" : "levels"}`;
    applied.push({ id: "basements", label: "Basements, no critical plant stated in them", share: judgement.basementLoading / 2, fact: `The document states ${levels} and no critical plant in them: half the basement loading.`, quote: facts.basementsQuote });
  }
  if (facts.drainagePoor) {
    applied.push({ id: "drainage", label: "Drainage reported as poor", share: judgement.drainageLoading, fact: "The document reports poor drainage at the site.", quote: facts.drainageQuote });
  }
  return { applied, total: sum(applied.map((l) => l.share)) };
}

/**
 * The technical price of an offer. Returns null, never a figure, when the price cannot be worked
 * out: a building outside any hazard map, a scenario with no map, or an insured value that is
 * not above zero. The caller says "Outside the hazard maps loaded: flood cannot be priced here".
 *
 * A radius of 0, or a radius that holds only the point's own cell, gives the reading at the
 * point to the last decimal. Quick enough to run on every keystroke of an edited figure.
 */
export function technicalPrice(input: TechnicalInput): TechnicalPrice | null {
  const { dataset, params, terms, history, facts } = input;
  const judgement = enforceJudgement(input.judgement).judgement;
  const buildings = [input.building, ...(input.others ?? [])];
  if (buildings.some((b) => !(Number.isFinite(b.tivKes) && b.tivKes > 0))) return null;
  const maps = mapsOf(dataset);
  if (!maps) return null;

  const slopes = tierSlopes(dataset);
  const rps = scenarioReturnPeriods(dataset, params);
  // Most frequent first, as in every result of the engine.
  const order = dataset.scenarios.map((_, i) => i).sort((a, b) => rps[a] - rps[b]);

  const sites: { discs: Disc[]; perScenario: SiteReading[] }[] = [];
  for (const b of buildings) {
    const site = readSite(dataset, maps, slopes, params, b, judgement.siteRadiusM);
    if (!site) return null;
    sites.push(site);
  }

  const tivs = buildings.map((b) => b.tivKes);
  const tivKes = sum(tivs);
  const loadings = loadingsOf(facts, judgement);
  const rate = (aalKes: number) => (aalKes / tivKes) * 1000;

  const rows = order.map((si) => {
    const scenario: OfferScenario = { id: dataset.scenarios[si].id, label: dataset.scenarios[si].label, returnPeriod: rps[si] };
    const point = sites.map((s, j) => s.perScenario[si].point.damageRatio * tivs[j]);
    const around = sites.map((s, j) => s.perScenario[si].damageRatio * tivs[j]);
    // A loss cannot pass the insured value, whatever the loading.
    const loaded = around.map((v, j) => Math.min(tivs[j], v * (1 + loadings.total)));
    const loadedSplit = termsSplit(loaded, tivs, terms);
    return {
      scenario,
      followed: sites[0].perScenario[si],
      pointKes: sum(point),
      pointGrossKes: sum(termsSplit(point, tivs, terms).map((x) => x.grossKes)),
      aroundKes: sum(around),
      aroundGrossKes: sum(termsSplit(around, tivs, terms).map((x) => x.grossKes)),
      loadedKes: sum(loaded),
      deductibleKes: sum(loadedSplit.map((x) => x.deductibleKes)),
      overLimitKes: sum(loadedSplit.map((x) => x.overLimitKes)),
      loadedGrossKes: sum(loadedSplit.map((x) => x.grossKes)),
      held: around.some((v, j) => v * (1 + loadings.total) > tivs[j]),
    };
  });
  const curve = (pick: (row: (typeof rows)[number]) => number): CurvePoint[] => rows.map((row) => ({ returnPeriod: row.scenario.returnPeriod, lossKes: pick(row) }));
  const aal = (pick: (row: (typeof rows)[number]) => number) => averageAnnualLoss(curve(pick));

  const atPoint = { groundUp: aal((r) => r.pointKes), gross: aal((r) => r.pointGrossKes) };
  const around = { groundUp: aal((r) => r.aroundKes), gross: aal((r) => r.aroundGrossKes) };
  const model = { groundUp: aal((r) => r.loadedKes), gross: aal((r) => r.loadedGrossKes) };

  // The document's own loss history, as a loss a year.
  const totalKes = sum(history.losses.map((l) => l.amountKes));
  const burningCostKes = history.usable && history.years !== null ? totalKes / history.years : null;
  const weight = burningCostKes !== null ? judgement.experienceWeight : 0;
  const blend = (modelKes: number) => (1 - weight) * modelKes + weight * (burningCostKes ?? 0);
  const blended = { groundUp: blend(model.groundUp), gross: blend(model.gross) };

  // No risk inside the mapped area is priced at zero.
  const floorKes = (judgement.minimumRatePerMille / 1000) * tivKes;
  const indicatedGroundUp = Math.max(blended.groundUp, floorKes);
  const indicatedGross = Math.max(blended.gross, floorKes);
  const setBy = blended.gross >= floorKes ? "blended" : "minimum rate";
  const setByGroundUp = blended.groundUp >= floorKes ? "blended" : "minimum rate";
  const at100 = lossAtReturnPeriod(curve((r) => r.loadedKes), 100);

  const disc = sites[0].discs[0];
  const pointOnly = disc.index.length === 1;
  const anyHeld = rows.some((r) => r.held);
  const line = (id: BuildUpId, groundUp: number | null, gross: number | null, text: string): BuildUpLine => ({
    id,
    label: BUILD_UP_LABELS[id],
    aalGroundUpKes: groundUp,
    aalGrossKes: gross,
    ratePerMilleGroundUp: groundUp === null ? null : rate(groundUp),
    ratePerMilleGross: gross === null ? null : rate(gross),
    text,
  });
  const dryAtPoint = rows.every((r) => !(r.followed.point.depthM > 0));
  const loadingWords = loadings.applied.map((l) => `${l.label.toLowerCase()} (${plus(l.share)})`).join(", ");
  const setWords = (by: "blended" | "minimum rate") => (by === "blended" ? "the blended line" : "the minimum rate");
  const buildUp: BuildUpLine[] = [
    line("at_point", atPoint.groundUp, atPoint.gross, `The flood maps read at the stated point alone, the way each building of the portfolio is read.${dryAtPoint ? " The point is dry at every return period." : ""}`),
    line(
      "around_site",
      around.groundUp,
      around.gross,
      pointOnly
        ? `A radius of ${fmtInt(judgement.siteRadiusM)} m holds only the stated point's own map cell, so this is the reading at the point.`
        : `The damage ratio averaged over the ${fmtInt(disc.index.length)} map cells within ${fmtInt(judgement.siteRadiusM)} m of the stated point, dry cells counted as zero.`,
    ),
    line(
      "with_loadings",
      model.groundUp,
      model.gross,
      loadings.applied.length > 0
        ? `The line above with ${plus(loadings.total)} for what the document reports: ${loadingWords}.${anyHeld ? " Held at the insured value where the loading would pass it." : ""}`
        : "No loading applies: the document reports no basement and no poor drainage.",
    ),
    line(
      "loss_history",
      burningCostKes,
      burningCostKes,
      burningCostKes !== null && history.years !== null
        ? `${kes1(totalKes)} of stated flood losses over ${years(history.years)}: ${kes1(burningCostKes)} a year. Taken as losses the insurer paid, so the same figure stands before and after terms.`
        : `Not used. ${HISTORY_WHY[history.reason ?? "no_loss_amounts"]}`,
    ),
    line(
      "blended",
      blended.groundUp,
      blended.gross,
      weight > 0
        ? `${fmtPct(1 - weight, 0)} of the line with loadings and ${fmtPct(weight, 0)} of the document's loss history.`
        : burningCostKes !== null
          ? "The line with loadings alone: the weight on the loss history is zero."
          : "The line with loadings alone: there is no usable loss history to blend in.",
    ),
    line("minimum_rate", floorKes, floorKes, `${fmtNum(judgement.minimumRatePerMille, 3)} per mille of the insured value: the lowest pure rate given to any risk inside the mapped area.`),
    line(
      "indicated",
      indicatedGroundUp,
      indicatedGross,
      setBy === setByGroundUp
        ? `The larger of the blended line and the minimum rate: set by ${setWords(setBy)}.`
        : `The larger of the blended line and the minimum rate: the gross figure is set by ${setWords(setBy)}, the ground-up figure by ${setWords(setByGroundUp)}.`,
    ),
  ];

  return {
    tivKes,
    buildings: buildings.length,
    judgement,
    atPoint: {
      perReturnPeriod: rows.map((r) => ({ ...r.scenario, depthM: r.followed.point.depthM, damageRatio: r.followed.point.damageRatio, groundUpKes: r.pointKes, grossKes: r.pointGrossKes })),
      aalGroundUpKes: atPoint.groundUp,
      aalGrossKes: atPoint.gross,
      ratePerMilleGroundUp: rate(atPoint.groundUp),
      ratePerMilleGross: rate(atPoint.gross),
      dryAtEveryReturnPeriod: dryAtPoint,
    },
    aroundSite: {
      radiusM: judgement.siteRadiusM,
      cells: disc.index.length,
      cellSizeM: disc.cellSizeM,
      perReturnPeriod: rows.map((r) => ({
        ...r.scenario,
        wetCells: r.followed.wetCells,
        wetShare: r.followed.wetCells / r.followed.cells,
        meanWetDepthM: r.followed.wetCells > 0 ? r.followed.wetDepthM / r.followed.wetCells : null,
        damageRatio: r.followed.damageRatio,
        groundUpKes: r.aroundKes,
        grossKes: r.aroundGrossKes,
      })),
      aalGroundUpKes: around.groundUp,
      aalGrossKes: around.gross,
    },
    loadings,
    perReturnPeriod: rows.map((r) => ({ ...r.scenario, groundUpKes: r.loadedKes, deductibleKes: r.deductibleKes, overLimitKes: r.overLimitKes, grossKes: r.loadedGrossKes, heldAtInsuredValue: r.held })),
    model: { aalGroundUpKes: model.groundUp, aalGrossKes: model.gross },
    experience: {
      years: history.years,
      losses: history.losses.map((l) => ({ year: l.year, amountKes: l.amountKes })),
      totalKes,
      burningCostKes,
      usable: burningCostKes !== null,
      reason: burningCostKes !== null ? null : (history.reason ?? "no_loss_amounts"),
      why: burningCostKes !== null ? null : HISTORY_WHY[history.reason ?? "no_loss_amounts"],
      weight,
      treatment: TREATMENT,
    },
    buildUp,
    indicated: {
      aalGroundUpKes: indicatedGroundUp,
      aalGrossKes: indicatedGross,
      ratePerMilleGroundUp: rate(indicatedGroundUp),
      ratePerMilleGross: rate(indicatedGross),
      setBy,
      setByGroundUp,
      loss100GroundUpKes: at100.lossKes,
      loss100GrossKes: lossAtReturnPeriod(curve((r) => r.loadedGrossKes), 100).lossKes,
      loss100Extrapolated: at100.extrapolated,
    },
  };
}
