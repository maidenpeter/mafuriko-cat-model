export const HOUSING_CLASSES = [
  "informal_iron_sheet",
  "semi_permanent",
  "permanent_masonry",
  "concrete_rcc",
] as const;

export type HousingClass = (typeof HOUSING_CLASSES)[number];

export const HOUSING_LABELS: Record<HousingClass, string> = {
  informal_iron_sheet: "Informal (iron sheet)",
  semi_permanent: "Semi-permanent",
  permanent_masonry: "Permanent masonry",
  concrete_rcc: "Concrete / RCC",
};

/** Class used for the damage curve when a row's housing class is not recognised. */
export const FALLBACK_CLASS: HousingClass = "permanent_masonry";

/** "score" = 0 to 1 susceptibility proxy (Nairobi). "depth_m" = flood depth in metres (Nzoia-style). */
export type HazardKind = "score" | "depth_m";

/** Score tiers from narrowest footprint (most frequent event) to widest (rarest). */
export const SCORE_TIERS = ["extreme", "severe", "moderate", "occasional", "common"] as const;
export type ScoreTier = (typeof SCORE_TIERS)[number];

export interface ScenarioDef {
  /** Tier name ("common") or return-period tag ("rp100y"). */
  id: string;
  label: string;
  /** Present when the data itself carries the return period (depth rasters). */
  fixedReturnPeriod?: number;
}

export interface Building {
  locId: string;
  lat: number;
  lon: number;
  /** Housing class exactly as written in the file. */
  housingClassRaw: string;
  /** Class whose damage curve is applied. */
  housingClass: HousingClass;
  floorAreaM2: number | null;
  costPerM2Kes: number | null;
  tivKes: number;
  synthetic: boolean | null;
  /** Hazard value per scenario, in the order of Dataset.scenarios. */
  hazard: number[];
}

export interface Hotspot {
  name: string;
  lat: number;
  lon: number;
}

export interface Raster {
  scenarioId: string;
  fileName: string;
  width: number;
  height: number;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  data: Float32Array;
  noData: number | null;
}

export interface DrainageInfo {
  /** Distance in metres over which ponding fades from full depth to nothing. */
  reachM: number;
  /** Ponding depth in metres at full drainage stress, per scenario, in the order of Dataset.scenarios. */
  depthM: number[];
  /** Drainage stress from 0 to 1 at each building, in the order of Dataset.buildings. */
  buildingStress: number[];
  /** Stress on the hazard grid, for the map and the hotspot test. */
  grid: { width: number; height: number; bbox: [number, number, number, number]; stress: Float32Array };
}

export interface Dataset {
  name: string;
  hazardKind: HazardKind;
  scenarios: ScenarioDef[];
  buildings: Building[];
  hotspots: Hotspot[];
  rasters: Raster[];
  /** Present when drainage-driven flooding is switched on (see lib/geo/drainage.ts). */
  drainage?: DrainageInfo;
}

export interface ModelParams {
  /** Assumed flood depth in metres at a susceptibility score of 1.0 in the widest tier. Unused for depth datasets. */
  depthScaleM: number;
  /** Multiplier on depth before the base curve is read. */
  fragility: Record<HousingClass, number>;
  /** Highest damage ratio the class can reach. */
  cap: Record<HousingClass, number>;
  /** Assumed return period in years for each score tier. Unused for depth datasets. */
  returnPeriods: Record<ScoreTier, number>;
}

export interface BuildingScenarioResult {
  hazard: number;
  /** Depth used: the terrain depth, or drainage ponding where that is deeper. */
  depthM: number;
  /** Drainage ponding at the building; 0 when drainage is off or the building is outside the zone. */
  drainageM: number;
  effectiveDepthM: number;
  curveDamage: number;
  damageRatio: number;
  capped: boolean;
  lossKes: number;
}

export interface BuildingResult {
  locId: string;
  /** One entry per scenario, in the order of ModelResult.scenarios. */
  perScenario: BuildingScenarioResult[];
}

export interface ClassBreakdown {
  count: number;
  tivKes: number;
  affected: number;
  tivExposedKes: number;
  lossKes: number;
}

export interface ScenarioResult {
  id: string;
  label: string;
  returnPeriod: number;
  /** Puts this tier's 0 to 1 score on the widest tier's scale before depth is worked out. 1 for depth maps. */
  tierSlope: number;
  lossKes: number;
  affected: number;
  tivExposedKes: number;
  byClass: Record<HousingClass, ClassBreakdown>;
}

export interface StandardLoss {
  returnPeriod: number;
  /** null when the return period is more frequent than anything modelled. */
  lossKes: number | null;
  /** True when the value is held flat beyond the rarest modelled scenario. */
  extrapolated: boolean;
}

export interface ModelResult {
  params: ModelParams;
  hazardKind: HazardKind;
  totalTivKes: number;
  buildingCount: number;
  /** Sorted from most frequent to rarest. */
  scenarios: ScenarioResult[];
  buildings: BuildingResult[];
  standardLosses: StandardLoss[];
  aalKes: number;
}
