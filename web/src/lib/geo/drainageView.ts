import type { Dataset, ScoreTier } from "../model/types";
import { DRAINAGE_DEFAULTS, drainageDistances, drainageSensitivity, sampleGrid, stressGrid, type DrainageDistances } from "./drainage";
import { loadGeo } from "./layers";

export interface DrainageState {
  distances: DrainageDistances;
  sensitivity: ReturnType<typeof drainageSensitivity>;
}

/**
 * Works out the distances to drains and settlements for a score dataset. Returns null when
 * the dataset is not a Nairobi-style score dataset or the open map layers are missing.
 */
export async function prepareDrainage(dataset: Dataset): Promise<DrainageState | null> {
  if (dataset.hazardKind !== "score") return null;
  const widestId = dataset.scenarios[dataset.scenarios.length - 1]?.id;
  const widest = dataset.rasters.find((r) => r.scenarioId === widestId);
  if (!widest) return null;
  const geo = await loadGeo();
  if (!geo.waterways) return null;
  // Let the page paint before the grid work starts.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, geo.waterways, geo.settlements);
  return { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) };
}

/** The same dataset with drainage-driven flooding switched on. Hazard maps and buildings are shared, not copied. */
export function withDrainage(dataset: Dataset, state: DrainageState, reachM = DRAINAGE_DEFAULTS.reachM): Dataset {
  const stress = stressGrid(state.distances, reachM);
  const grid = { ...state.distances.grid, stress };
  return {
    ...dataset,
    drainage: {
      reachM,
      depthM: dataset.scenarios.map((s) => DRAINAGE_DEFAULTS.depthM[s.id as ScoreTier] ?? 0),
      buildingStress: dataset.buildings.map((b) => sampleGrid(grid, stress, b.lon, b.lat)),
      grid,
    },
  };
}
