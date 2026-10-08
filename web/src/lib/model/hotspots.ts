import { sampleGrid } from "../geo/drainage";
import { sampleRaster } from "../ingest/raster";
import type { Dataset } from "./types";

export interface HotspotHit {
  name: string;
  lat: number;
  lon: number;
  inside: boolean;
  value: number;
  /** Drainage stress at the hotspot, 0 when drainage is off. */
  drainage: number;
  hit: boolean;
}

/**
 * Check each named flood area against the widest hazard footprint. A hotspot
 * counts as flagged when the cell at its coordinates has a value above zero, or,
 * with drainage switched on, when it sits inside the drainage zone.
 */
export function hotspotHits(dataset: Dataset): HotspotHit[] {
  // Score tiers are ordered narrowest first; depth maps by rising return period. The last one is the widest either way.
  const widest = dataset.scenarios[dataset.scenarios.length - 1];
  const raster = dataset.rasters.find((r) => r.scenarioId === widest?.id);
  if (!raster) return [];
  return dataset.hotspots.map((h) => {
    const s = sampleRaster(raster, h.lon, h.lat, dataset.hazardKind);
    const drainage = dataset.drainage ? sampleGrid(dataset.drainage.grid, dataset.drainage.grid.stress, h.lon, h.lat) : 0;
    return { ...h, inside: s.inside, value: s.value, drainage, hit: s.value > 0 || drainage > 0 };
  });
}
