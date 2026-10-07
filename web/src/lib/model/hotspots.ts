import { sampleRaster } from "../ingest/raster";
import type { Dataset } from "./types";

export interface HotspotHit {
  name: string;
  lat: number;
  lon: number;
  inside: boolean;
  value: number;
  hit: boolean;
}

/**
 * Check each named flood area against the widest hazard footprint. A hotspot
 * counts as flagged when the cell at its coordinates has a value above zero.
 */
export function hotspotHits(dataset: Dataset): HotspotHit[] {
  // Score tiers are ordered narrowest first; depth maps by rising return period. The last one is the widest either way.
  const widest = dataset.scenarios[dataset.scenarios.length - 1];
  const raster = dataset.rasters.find((r) => r.scenarioId === widest?.id);
  if (!raster) return [];
  return dataset.hotspots.map((h) => {
    const s = sampleRaster(raster, h.lon, h.lat, dataset.hazardKind);
    return { ...h, inside: s.inside, value: s.value, hit: s.value > 0 };
  });
}
