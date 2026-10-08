import type { Raster, ScoreTier } from "../model/types";
import type { GeoCollection, Position, SettlementProps, WaterwayProps } from "./layers";
import { geometryBBox, geometryContains } from "./spatial";

/**
 * Drainage-driven flooding.
 *
 * The supplied hazard proxy is built from terrain and river distance, so it cannot see
 * flooding caused by drains that overflow or by dense settlements that shed water onto
 * paths. This module adds that as a second, explicit hazard: shallow ponding within a set
 * reach of mapped drains, ditches and canals, and inside informal settlements, fading to
 * nothing at the edge of the reach. The model then uses whichever is deeper at each
 * building: the terrain depth or the drainage ponding.
 *
 * Inputs are open data (OpenStreetMap drains and settlement outlines). The reach and the
 * ponding depths are stated assumptions, shown on screen with a sensitivity table.
 */

export interface Grid {
  width: number;
  height: number;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
}

export interface DrainageDistances {
  grid: Grid;
  /** Metres from each cell centre to the nearest mapped drain, ditch or canal. */
  toDrain: Float32Array;
  /** Metres to the nearest informal settlement; 0 inside one. */
  toSettlement: Float32Array;
  cellAreaKm2: number;
}

export const DRAIN_KINDS: ReadonlySet<string> = new Set(["drain", "ditch", "canal"]);

/** Stated assumptions. Ponding depth rises with the rarity of the event. */
export const DRAINAGE_DEFAULTS: { reachM: number; depthM: Record<ScoreTier, number> } = {
  reachM: 300,
  depthM: { extreme: 0.15, severe: 0.25, moderate: 0.35, occasional: 0.45, common: 0.6 },
};

export const SENSITIVITY_REACHES = [100, 200, 300, 400, 500];

const BIG = 1e20;

/** Exact 1D squared distance transform (Felzenszwalb and Huttenlocher), with cell spacing in metres. */
function edt1d(f: Float64Array, n: number, spacing: number, out: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const xq = q * spacing;
    let s = (f[q] + xq * xq - (f[v[k]] + v[k] * spacing * v[k] * spacing)) / (2 * (xq - v[k] * spacing));
    while (s <= z[k]) {
      k--;
      s = (f[q] + xq * xq - (f[v[k]] + v[k] * spacing * v[k] * spacing)) / (2 * (xq - v[k] * spacing));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    const xq = q * spacing;
    while (z[k + 1] < xq) k++;
    const dx = xq - v[k] * spacing;
    out[q] = dx * dx + f[v[k]];
  }
}

/** Euclidean distance in metres from every cell to the nearest marked cell. Cells with no mark anywhere get a very large value. */
export function distanceTransform(mask: Uint8Array, width: number, height: number, cellX: number, cellY: number): Float32Array {
  const g = new Float64Array(width * height);
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) f[c] = mask[r * width + c] ? 0 : BIG;
    edt1d(f, width, cellX, d, v, z);
    for (let c = 0; c < width; c++) g[r * width + c] = d[c];
  }
  const out = new Float32Array(width * height);
  for (let c = 0; c < width; c++) {
    for (let r = 0; r < height; r++) f[r] = g[r * width + c];
    edt1d(f, height, cellY, d, v, z);
    for (let r = 0; r < height; r++) out[r * width + c] = Math.sqrt(d[r]);
  }
  return out;
}

export function cellSizeM(grid: Grid): { x: number; y: number } {
  const [minLon, minLat, maxLon, maxLat] = grid.bbox;
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  return {
    x: ((maxLon - minLon) / grid.width) * 111320 * Math.cos(midLat),
    y: ((maxLat - minLat) / grid.height) * 110574,
  };
}

function cellOf(grid: Grid, lon: number, lat: number): [number, number] {
  const [minLon, minLat, maxLon, maxLat] = grid.bbox;
  return [Math.floor(((maxLat - lat) / (maxLat - minLat)) * grid.height), Math.floor(((lon - minLon) / (maxLon - minLon)) * grid.width)];
}

/** Distances to drains and to settlements on the hazard grid. Runs once per dataset. */
export function drainageDistances(grid: Grid, waterways: GeoCollection<WaterwayProps>, settlements: GeoCollection<SettlementProps> | null): DrainageDistances {
  const { width, height, bbox } = grid;
  const size = cellSizeM(grid);
  const stepLon = (bbox[2] - bbox[0]) / width / 2;
  const stepLat = (bbox[3] - bbox[1]) / height / 2;

  const drains = new Uint8Array(width * height);
  const mark = ([lon, lat]: Position) => {
    const [r, c] = cellOf(grid, lon, lat);
    if (r >= 0 && c >= 0 && r < height && c < width) drains[r * width + c] = 1;
  };
  for (const f of waterways.features) {
    if (!DRAIN_KINDS.has(f.properties.kind)) continue;
    const g = f.geometry;
    const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [x0, y0] = line[i - 1];
        const [x1, y1] = line[i];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0) / stepLon, Math.abs(y1 - y0) / stepLat)));
        for (let s = 0; s <= steps; s++) mark([x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps]);
      }
    }
  }

  const inside = new Uint8Array(width * height);
  for (const f of settlements?.features ?? []) {
    const [x0, y0, x1, y1] = geometryBBox(f.geometry);
    const [r0, c0] = cellOf(grid, x0, y1);
    const [r1, c1] = cellOf(grid, x1, y0);
    for (let r = Math.max(0, r0); r <= Math.min(height - 1, r1); r++) {
      const lat = bbox[3] - ((r + 0.5) / height) * (bbox[3] - bbox[1]);
      for (let c = Math.max(0, c0); c <= Math.min(width - 1, c1); c++) {
        const lon = bbox[0] + ((c + 0.5) / width) * (bbox[2] - bbox[0]);
        if (!inside[r * width + c] && geometryContains(f.geometry, lon, lat)) inside[r * width + c] = 1;
      }
    }
  }

  return {
    grid,
    toDrain: distanceTransform(drains, width, height, size.x, size.y),
    toSettlement: distanceTransform(inside, width, height, size.x, size.y),
    cellAreaKm2: (size.x * size.y) / 1e6,
  };
}

/** Drainage stress from 0 to 1: 1 on a drain or inside a settlement, fading linearly to 0 at the reach. */
export const stressAt = (toDrain: number, toSettlement: number, reachM: number) =>
  Math.max(0, 1 - toDrain / reachM, 1 - toSettlement / reachM);

export function stressGrid(d: DrainageDistances, reachM: number): Float32Array {
  const out = new Float32Array(d.toDrain.length);
  for (let i = 0; i < out.length; i++) out[i] = stressAt(d.toDrain[i], d.toSettlement[i], reachM);
  return out;
}

export function sampleGrid(grid: Grid, values: ArrayLike<number>, lon: number, lat: number): number {
  const [r, c] = cellOf(grid, lon, lat);
  if (r < 0 || c < 0 || r >= grid.height || c >= grid.width) return 0;
  return values[r * grid.width + c];
}

export interface SensitivityRow {
  reachM: number;
  hits: number;
  newlyFlagged: string[];
  /** Area that is dry on the widest terrain map but inside the drainage zone. */
  addedAreaKm2: number;
  /** Share of the grid flooded in the rarest event, terrain plus drainage. */
  wetShare: number;
}

/**
 * How the drainage zone changes the hotspot test and the flood footprint for a range of
 * reaches. The widest (rarest) map is the reference, as in the starter kit's own test.
 */
export function drainageSensitivity(d: DrainageDistances, widest: Raster, hotspots: { name: string; lat: number; lon: number }[], reaches = SENSITIVITY_REACHES): { baseHits: number; baseWetShare: number; rows: SensitivityRow[] } {
  const wetTerrain = (i: number) => widest.data[i] > 0 && widest.data[i] !== widest.noData;
  let baseWet = 0;
  for (let i = 0; i < widest.data.length; i++) if (wetTerrain(i)) baseWet += 1;
  const atSpot = hotspots.map((h) => {
    const [r, c] = cellOf(d.grid, h.lon, h.lat);
    const i = r * d.grid.width + c;
    const ok = r >= 0 && c >= 0 && r < d.grid.height && c < d.grid.width;
    return { name: h.name, terrain: ok && wetTerrain(i), toDrain: ok ? d.toDrain[i] : Infinity, toSettlement: ok ? d.toSettlement[i] : Infinity };
  });
  const rows = reaches.map((reachM) => {
    let added = 0;
    for (let i = 0; i < d.toDrain.length; i++) if (!wetTerrain(i) && stressAt(d.toDrain[i], d.toSettlement[i], reachM) > 0) added += 1;
    const hit = atSpot.map((s) => s.terrain || stressAt(s.toDrain, s.toSettlement, reachM) > 0);
    return {
      reachM,
      hits: hit.filter(Boolean).length,
      newlyFlagged: atSpot.filter((s, i) => hit[i] && !s.terrain).map((s) => s.name),
      addedAreaKm2: added * d.cellAreaKm2,
      wetShare: (baseWet + added) / d.toDrain.length,
    };
  });
  return { baseHits: atSpot.filter((s) => s.terrain).length, baseWetShare: baseWet / d.toDrain.length, rows };
}
