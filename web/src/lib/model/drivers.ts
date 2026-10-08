import { cellSizeM, sampleGrid } from "../geo/drainage";
import { cleanValue, sampleRaster } from "../ingest/raster";
import type { OfferJudgement } from "../offer/judgement";
import { tierSlopes } from "./hazard";
import { depthAt, hazardToDepth, scenarioReturnPeriods } from "./pipeline";
import type { Dataset, HazardKind, HousingClass, ModelParams, Raster } from "./types";
import { damageDetail } from "./vulnerability";

/**
 * Loss drivers 1 to 3: the water at a site beyond the depth at its point.
 *
 *   1. Surrounding flooding  the highest map depth within the buffer around the site
 *   2. Drainage ponding      as the drainage layer gives it
 *   3. Drain overload        a shallow depth everywhere once the event is rarer than the drains' design
 *
 * All three put water at the same building, so its loss is read once on the damage curve, at the
 * deepest of them, and each driver is credited with what it adds beyond the ones before it
 * (see structureLoss). The assumptions are in lib/offer/judgement.ts.
 *
 * "depth_only" is the model as it was before these drivers: the deeper of the depth at the point
 * and the drainage ponding, nothing else.
 */
export type LossMode = "depth_only" | "all_drivers";

export interface SiteDepths {
  /** Terrain depth at the point, in metres. */
  pointM: number;
  /** Highest terrain depth within the buffer, in metres. Never below pointM. */
  bufferM: number;
  /** Drainage ponding at the point, in metres. 0 when drainage is off. */
  pondingM: number;
  /** True when the event's return period is greater than the one the drains were designed for. */
  overloaded: boolean;
  /** Surface water from drain overload, in metres: the assumed depth when overloaded, otherwise 0. */
  overloadM: number;
  /** The deepest water at the site under the mode in force. */
  surfaceM: number;
  /** The mode surfaceM was worked out under. siteDepths always sets it; depths written by hand without it are read as all drivers. */
  mode?: LossMode;
}

export interface StructureSplit {
  /** Loss from the depth at the point. */
  pointKes: number;
  /** What the surroundings add: the buffer depth above the point depth. */
  surroundingKes: number;
  /** What drainage ponding adds beyond both. */
  pondingKes: number;
  /** What drain overload adds beyond all three. */
  overloadKes: number;
  /** The structure's loss at the deepest water: the four parts added up. */
  totalKes: number;
  damageRatio: number;
  capped: boolean;
}

// Answers remembered per map: this many buffer radii (the oldest is dropped first), and this many points per radius.
const RADII_KEPT = 4;
const POINTS_KEPT = 50_000;
const withinCache = new WeakMap<Raster, Map<string, Map<string, number>>>();

/**
 * The highest hazard value over the cell that holds the point and every cell whose centre lies
 * within radiusM metres of it. Null when the point is outside the map.
 *
 * Distances are in metres along each axis, because a cell is not square on the ground. Each answer
 * is remembered per map, radius and point, so a model run reads the map once per building however
 * often it is repeated. A map's values are taken as fixed once it is loaded.
 */
export function highestWithin(raster: Raster, lon: number, lat: number, radiusM: number, kind: HazardKind): number | null {
  const { width, height, data } = raster;
  const [minLon, minLat, maxLon, maxLat] = raster.bbox;
  const x = ((lon - minLon) / (maxLon - minLon)) * width;
  const y = ((maxLat - lat) / (maxLat - minLat)) * height;
  if (!(x >= 0 && y >= 0 && x < width && y < height)) return null;
  const radius = radiusM > 0 && Number.isFinite(radiusM) ? radiusM : 0;

  let byRadius = withinCache.get(raster);
  if (!byRadius) withinCache.set(raster, (byRadius = new Map()));
  const radiusKey = `${kind}|${radius}`;
  let points = byRadius.get(radiusKey);
  if (!points) {
    if (byRadius.size >= RADII_KEPT) byRadius.delete(byRadius.keys().next().value as string);
    byRadius.set(radiusKey, (points = new Map()));
  }
  const pointKey = `${lon},${lat}`;
  const known = points.get(pointKey);
  if (known !== undefined) return known;

  let best = cleanValue(data[Math.floor(y) * width + Math.floor(x)], raster, kind);
  const size = cellSizeM(raster);
  if (radius > 0 && size.x > 0 && size.y > 0) {
    const rowFrom = Math.max(0, Math.ceil(y - radius / size.y - 0.5));
    const rowTo = Math.min(height - 1, Math.floor(y + radius / size.y - 0.5));
    const colFrom = Math.max(0, Math.ceil(x - radius / size.x - 0.5));
    const colTo = Math.min(width - 1, Math.floor(x + radius / size.x - 0.5));
    for (let row = rowFrom; row <= rowTo; row++) {
      const dy = (row + 0.5 - y) * size.y;
      for (let col = colFrom; col <= colTo; col++) {
        // Only a value above the best so far can change the answer, and most cells are dry.
        const raw = data[row * width + col];
        if (!(raw > best)) continue;
        const dx = (col + 0.5 - x) * size.x;
        if (dx * dx + dy * dy > radius * radius) continue;
        const value = cleanValue(raw, raster, kind);
        if (value > best) best = value;
      }
    }
  }

  if (points.size >= POINTS_KEPT) points.clear();
  points.set(pointKey, best);
  return best;
}

const mapOf = (dataset: Dataset, k: number): Raster | undefined => dataset.rasters.find((r) => r.scenarioId === dataset.scenarios[k]?.id);

function depthsOf(pointM: number, bufferM: number, pondingM: number, overloaded: boolean, judgement: OfferJudgement, mode: LossMode): SiteDepths {
  const buffer = Math.max(pointM, bufferM);
  const overloadM = overloaded ? Math.max(0, judgement.drainOverloadDepthM) : 0;
  return {
    pointM,
    bufferM: buffer,
    pondingM,
    overloaded,
    overloadM,
    surfaceM: mode === "all_drivers" ? Math.max(buffer, pondingM, overloadM) : Math.max(pointM, pondingM),
    mode,
  };
}

export interface SiteOptions {
  /** The basis for surfaceM. "depth_only" when left out, as in runModel. The other depths are reported either way. */
  mode?: LossMode;
  /** The drains' design return period in years, when the offer states it. Otherwise the assumption is used. */
  drainDesignRp?: number;
  /** Drainage ponding in metres, when the caller already has it. Otherwise it is read from the dataset's drainage layer. */
  pondingM?: number;
}

/**
 * The water at any point in scenario k (index into Dataset.scenarios): at the point, within the
 * buffer, from drainage ponding and from drain overload. Null when there is no map for the
 * scenario or the point is outside it: the model says nothing about ground it has no map for.
 */
export function siteDepths(dataset: Dataset, lon: number, lat: number, k: number, params: ModelParams, judgement: OfferJudgement, options: SiteOptions = {}): SiteDepths | null {
  const map = mapOf(dataset, k);
  if (!map || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const highest = highestWithin(map, lon, lat, judgement.bufferRadiusM, dataset.hazardKind);
  if (highest === null) return null;

  const slope = tierSlopes(dataset)[k];
  const pointM = hazardToDepth(sampleRaster(map, lon, lat, dataset.hazardKind).value, dataset, params, slope);
  const d = dataset.drainage;
  const pondingM = options.pondingM ?? (d ? sampleGrid(d.grid, d.grid.stress, lon, lat) * (d.depthM[k] ?? 0) : 0);
  const stated = options.drainDesignRp;
  const designRp = stated !== undefined && stated > 0 && Number.isFinite(stated) ? stated : judgement.drainDesignRp;
  const overloaded = scenarioReturnPeriods(dataset, params)[k] > designRp;
  return depthsOf(pointM, hazardToDepth(highest, dataset, params, slope), pondingM, overloaded, judgement, options.mode ?? "depth_only");
}

/**
 * The same reading, with all loss drivers, for a building already in the dataset. Its depth at the
 * point and its ponding are the ones the depth-only model uses, so the two modes differ only by
 * what the drivers add. The drains are taken as designed for judgement.drainDesignRp.
 *
 * A building outside the map of the scenario keeps its point reading. Where the dataset has no
 * map for the scenario (hazard taken from columns in the file) there is no buffer to read, so
 * only drain overload is added.
 */
export function buildingDepths(dataset: Dataset, building: number, k: number, params: ModelParams, judgement: OfferJudgement, tierSlope: number, returnPeriod: number): SiteDepths {
  const b = dataset.buildings[building];
  const { terrainM, drainageM } = depthAt(dataset, building, k, params, tierSlope);
  const map = mapOf(dataset, k);
  const highest = map ? highestWithin(map, b.lon, b.lat, judgement.bufferRadiusM, dataset.hazardKind) : undefined;
  if (highest === null) return depthsOf(terrainM, terrainM, drainageM, false, judgement, "all_drivers");
  const bufferM = highest === undefined ? terrainM : hazardToDepth(highest, dataset, params, tierSlope);
  return depthsOf(terrainM, bufferM, drainageM, returnPeriod > judgement.drainDesignRp, judgement, "all_drivers");
}

/**
 * The structure's loss at a site, and which driver it comes from.
 *
 * The damage ratio is read once, at the deepest water (surfaceM). The split reads the same curve
 * at the running deepest water: the depth at the point, then within the buffer, then with ponding,
 * then with drain overload. Each driver is credited with the step it adds, so the four parts add
 * up to the total and no water is counted twice. In depth-only mode the surroundings and drain
 * overload are not in force and are credited nothing.
 */
export function structureLoss(depths: SiteDepths, housingClass: HousingClass, valueKes: number, params: ModelParams): StructureSplit {
  const all = depths.mode !== "depth_only";
  const lossAt = (depthM: number) => damageDetail(depthM, housingClass, params).damageRatio * valueKes;
  const atPoint = Math.min(depths.surfaceM, depths.pointM);
  const withBuffer = all ? Math.min(depths.surfaceM, Math.max(atPoint, depths.bufferM)) : atPoint;
  const withPonding = Math.min(depths.surfaceM, Math.max(withBuffer, depths.pondingM));

  const total = damageDetail(depths.surfaceM, housingClass, params);
  const totalKes = total.damageRatio * valueKes;
  const pointKes = lossAt(atPoint);
  const bufferKes = lossAt(withBuffer);
  const pondingKes = lossAt(withPonding);
  return {
    pointKes,
    surroundingKes: bufferKes - pointKes,
    pondingKes: pondingKes - bufferKes,
    overloadKes: totalKes - pondingKes,
    totalKes,
    damageRatio: total.damageRatio,
    capped: total.capped,
  };
}
