import type { Dataset, Raster } from "./types";

/**
 * Tier slopes for score datasets.
 *
 * The Nairobi score maps are nested cuts of one susceptibility surface, and each cut is
 * rescaled to run from 0 to 1. Read on its own, every tier peaks at a score of 1, so
 * "score × depth scale" would give the 1-in-10 and the 1-in-250 event the same deepest point.
 *
 * The slope puts each tier back on the widest tier's scale:
 *
 *   score in the widest tier = a + slope × score in this tier   (wherever both are above 0)
 *
 * For nested linear cuts the fit is exact. Depth = score × slope × depth scale then grows as the
 * event gets rarer, and the depth scale means the depth at the highest-scoring spot in the widest tier.
 *
 * Fitted on the hazard rasters when all of them are loaded on one grid, otherwise on the buildings.
 * Returns 1 for the widest tier, for depth maps, and wherever there is too little to fit.
 */

interface Source {
  size: number;
  value: (k: number, i: number) => number;
}

const fromRasters = new WeakMap<object, number[]>();

function rasterSource(dataset: Pick<Dataset, "scenarios" | "rasters">): Source | null {
  const found = dataset.scenarios.map((s) => dataset.rasters.find((r) => r.scenarioId === s.id));
  const first = found[0];
  if (!first) return null;
  const sameGrid = (r: Raster | undefined): r is Raster =>
    !!r && r.width === first.width && r.height === first.height && r.data.length === first.data.length && r.bbox.every((v, j) => Math.abs(v - first.bbox[j]) < 1e-9);
  if (!found.every(sameGrid)) return null;
  const grids = found as Raster[];
  return {
    size: first.data.length,
    value: (k, i) => {
      const v = grids[k].data[i];
      return v > 0 && v !== grids[k].noData ? v : 0;
    },
  };
}

export function tierSlopes(dataset: Pick<Dataset, "hazardKind" | "scenarios" | "buildings" | "rasters">): number[] {
  const n = dataset.scenarios.length;
  const ones = () => Array.from({ length: n }, () => 1);
  if (dataset.hazardKind !== "score" || n < 2) return ones();

  const cached = fromRasters.get(dataset);
  if (cached) return cached;

  const grid = rasterSource(dataset);
  const src: Source = grid ?? {
    size: dataset.buildings.length,
    value: (k, i) => {
      const v = dataset.buildings[i].hazard[k];
      return v > 0 ? v : 0;
    },
  };

  // The widest tier scores at least as high as every other tier everywhere.
  const totals = new Array<number>(n).fill(0);
  for (let i = 0; i < src.size; i++) for (let k = 0; k < n; k++) totals[k] += src.value(k, i);
  const widest = totals.indexOf(Math.max(...totals));

  const slopes = dataset.scenarios.map((_, k) => {
    if (k === widest) return 1;
    let m = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < src.size; i++) {
      const x = src.value(k, i);
      const y = src.value(widest, i);
      if (x > 0 && y > 0) {
        m += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
      }
    }
    if (m < 2) return 1;
    const varX = sxx - (sx * sx) / m;
    if (!(varX > 1e-12)) return 1;
    const slope = (sxy - (sx * sy) / m) / varX;
    return Number.isFinite(slope) && slope > 0 ? Math.min(1, slope) : 1;
  });

  if (grid) fromRasters.set(dataset, slopes);
  return slopes;
}
