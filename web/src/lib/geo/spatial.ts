import { sampleRaster } from "../ingest/raster";
import { hazardToDepth } from "../model/pipeline";
import type { Dataset, ModelResult } from "../model/types";
import type { FacilityProps, GeoCollection, Geometry, Position, WardProps } from "./layers";

/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

function ringContains(ring: Position[], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polygonContains(rings: Position[][], lon: number, lat: number): boolean {
  if (!rings.length || !ringContains(rings[0], lon, lat)) return false;
  for (let h = 1; h < rings.length; h++) if (ringContains(rings[h], lon, lat)) return false;
  return true;
}

/** True when the point lies inside a Polygon or MultiPolygon (holes excluded). Other geometry types never contain points. */
export function geometryContains(g: Geometry, lon: number, lat: number): boolean {
  if (g.type === "Polygon") return polygonContains(g.coordinates, lon, lat);
  if (g.type === "MultiPolygon") return g.coordinates.some((p) => polygonContains(p, lon, lat));
  return false;
}

export function geometryBBox(g: Geometry): BBox {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as Position;
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  visit(g.coordinates);
  return box;
}

/** For each point, the index of the first polygon feature that contains it, or -1. */
export function assignPoints<P>(points: { lon: number; lat: number }[], polygons: GeoCollection<P>): number[] {
  const boxes = polygons.features.map((f) => geometryBBox(f.geometry));
  return points.map(({ lon, lat }) => {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (geometryContains(polygons.features[i].geometry, lon, lat)) return i;
    }
    return -1;
  });
}

export interface AreaRow {
  /** Index into the ward collection, or -1 for buildings outside every ward. */
  index: number;
  name: string;
  subcounty: string;
  buildings: number;
  tivKes: number;
  flooded: number;
  lossKes: number;
}

/**
 * Accumulation by ward for one scenario (index into result.scenarios). Rows cover every
 * ward, plus one row for buildings outside the ward map when there are any. Row totals
 * add up to the portfolio totals.
 */
export function wardAccumulation(dataset: Dataset, result: ModelResult, wardOf: number[], wards: GeoCollection<WardProps>, k: number): AreaRow[] {
  const rows: AreaRow[] = wards.features.map((f, index) => ({ index, name: f.properties.name, subcounty: f.properties.subcounty, buildings: 0, tivKes: 0, flooded: 0, lossKes: 0 }));
  const outside: AreaRow = { index: -1, name: "Outside the ward map", subcounty: "", buildings: 0, tivKes: 0, flooded: 0, lossKes: 0 };
  dataset.buildings.forEach((b, i) => {
    const row = wardOf[i] >= 0 ? rows[wardOf[i]] : outside;
    const p = result.buildings[i]?.perScenario[k];
    row.buildings += 1;
    row.tivKes += b.tivKes;
    if (p && p.depthM > 0) row.flooded += 1;
    row.lossKes += p?.lossKes ?? 0;
  });
  return outside.buildings > 0 ? [...rows, outside] : rows;
}

/**
 * Flood depth in metres at each facility, for every scenario in result order. Read from the
 * hazard maps with the same conversion the model uses for buildings. Zero where the maps
 * are missing or the facility is outside them.
 */
export function facilityDepths(dataset: Dataset, result: ModelResult, facilities: GeoCollection<FacilityProps>): number[][] {
  const perScenario = result.scenarios.map((s) => {
    const raster = dataset.rasters.find((r) => r.scenarioId === s.id);
    return facilities.features.map((f) => {
      if (!raster || f.geometry.type !== "Point") return 0;
      const [lon, lat] = f.geometry.coordinates;
      const sample = sampleRaster(raster, lon, lat, dataset.hazardKind);
      return sample.inside ? hazardToDepth(sample.value, dataset, result.params, s.tierSlope) : 0;
    });
  });
  return facilities.features.map((_, i) => perScenario.map((col) => col[i]));
}
