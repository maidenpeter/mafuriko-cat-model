import { REFERENCE_JUDGEMENT, type OfferJudgement } from "../offer/judgement";
import { buildingDepths, structureLoss, type LossMode } from "./drivers";
import { averageAnnualLoss, lossAtReturnPeriod, STANDARD_RETURN_PERIODS, type CurvePoint } from "./financial";
import {
  HOUSING_CLASSES,
  type BuildingResult,
  type BuildingScenarioResult,
  type ClassBreakdown,
  type Dataset,
  type HousingClass,
  type ModelParams,
  type ModelResult,
  type ScenarioResult,
  type ScoreTier,
} from "./types";
import { tierSlopes } from "./hazard";
import { damageDetail } from "./vulnerability";

/**
 * Hazard value to flood depth in metres. Depths pass through. Scores are first put back on the
 * widest tier's scale with the tier slope (see hazard.ts), then multiplied by the assumed depth scale.
 */
export function hazardToDepth(hazard: number, dataset: Pick<Dataset, "hazardKind">, params: ModelParams, tierSlope = 1): number {
  if (!(hazard > 0)) return 0;
  return dataset.hazardKind === "score" ? hazard * tierSlope * params.depthScaleM : hazard;
}

/**
 * Flood depth at one building in one scenario (index into Dataset.scenarios): the terrain depth,
 * or drainage ponding where that is deeper.
 */
export function depthAt(dataset: Dataset, building: number, scenario: number, params: ModelParams, tierSlope: number): { depthM: number; terrainM: number; drainageM: number } {
  const terrainM = hazardToDepth(dataset.buildings[building]?.hazard[scenario] ?? 0, dataset, params, tierSlope);
  const d = dataset.drainage;
  const drainageM = d ? (d.buildingStress[building] ?? 0) * (d.depthM[scenario] ?? 0) : 0;
  return { depthM: Math.max(terrainM, drainageM), terrainM, drainageM };
}

/** Return period for each dataset scenario: taken from the data when it has one, otherwise from the assumptions. */
export function scenarioReturnPeriods(dataset: Dataset, params: ModelParams): number[] {
  return dataset.scenarios.map((s) => s.fixedReturnPeriod ?? params.returnPeriods[s.id as ScoreTier]);
}

const emptyBreakdown = (): ClassBreakdown => ({ count: 0, tivKes: 0, affected: 0, tivExposedKes: 0, lossKes: 0 });

export interface RunOptions {
  /** "depth_only" when left out: depth at each building's point and drainage ponding, nothing else. */
  mode?: LossMode;
  /** The beyond-depth assumptions, used with all loss drivers. The reference set when left out. */
  judgement?: OfferJudgement;
}

/**
 * Runs the model on every building. With no options, or "depth_only", a building's loss comes from
 * the depth at its point and the drainage ponding. With "all_drivers" the depth is the deepest of
 * the point, the buffer around it, the ponding and drain overload (see drivers.ts), and every loss
 * also carries its split by driver.
 */
export function runModel(dataset: Dataset, params: ModelParams, options: RunOptions = {}): ModelResult {
  const mode: LossMode = options.mode ?? "depth_only";
  const allDrivers = mode === "all_drivers";
  const judgement = options.judgement ?? REFERENCE_JUDGEMENT;
  const rps = scenarioReturnPeriods(dataset, params);
  const slopes = tierSlopes(dataset);
  // Scenario order in the result: most frequent first.
  const order = dataset.scenarios.map((_, i) => i).sort((a, b) => rps[a] - rps[b]);

  const scenarios: ScenarioResult[] = order.map((i) => ({
    id: dataset.scenarios[i].id,
    label: dataset.scenarios[i].label,
    returnPeriod: rps[i],
    tierSlope: slopes[i],
    lossKes: 0,
    affected: 0,
    tivExposedKes: 0,
    byClass: Object.fromEntries(HOUSING_CLASSES.map((c) => [c, emptyBreakdown()])) as Record<HousingClass, ClassBreakdown>,
    ...(allDrivers ? { byDriver: { pointKes: 0, surroundingKes: 0, pondingKes: 0, overloadKes: 0 } } : {}),
  }));

  let totalTivKes = 0;
  const buildings: BuildingResult[] = dataset.buildings.map((b, bi) => {
    totalTivKes += b.tivKes;
    const perScenario = order.map((srcIndex, k): BuildingScenarioResult => {
      const hazard = b.hazard[srcIndex] ?? 0;
      const site = allDrivers ? buildingDepths(dataset, bi, srcIndex, params, judgement, slopes[srcIndex], rps[srcIndex]) : null;
      const { depthM, drainageM } = site ? { depthM: site.surfaceM, drainageM: site.pondingM } : depthAt(dataset, bi, srcIndex, params, slopes[srcIndex]);
      const d = damageDetail(depthM, b.housingClass, params);
      const lossKes = d.damageRatio * b.tivKes;

      const s = scenarios[k];
      const cls = s.byClass[b.housingClass];
      cls.count += 1;
      cls.tivKes += b.tivKes;
      if (depthM > 0) {
        s.affected += 1;
        s.tivExposedKes += b.tivKes;
        cls.affected += 1;
        cls.tivExposedKes += b.tivKes;
      }
      s.lossKes += lossKes;
      cls.lossKes += lossKes;

      if (!site || !s.byDriver) return { hazard, depthM, drainageM, ...d, lossKes };
      // The same loss, split by the driver that put the water there.
      const { pointKes, surroundingKes, pondingKes, overloadKes } = structureLoss(site, b.housingClass, b.tivKes, params);
      s.byDriver.pointKes += pointKes;
      s.byDriver.surroundingKes += surroundingKes;
      s.byDriver.pondingKes += pondingKes;
      s.byDriver.overloadKes += overloadKes;
      const { pointM, bufferM, pondingM, overloaded, overloadM, surfaceM } = site;
      return { hazard, depthM, drainageM, ...d, lossKes, drivers: { pointM, bufferM, pondingM, overloaded, overloadM, surfaceM, pointKes, surroundingKes, pondingKes, overloadKes } };
    });
    return { locId: b.locId, perScenario };
  });

  const points: CurvePoint[] = scenarios.map((s) => ({ returnPeriod: s.returnPeriod, lossKes: s.lossKes }));

  return {
    params,
    hazardKind: dataset.hazardKind,
    totalTivKes,
    buildingCount: dataset.buildings.length,
    scenarios,
    buildings,
    standardLosses: STANDARD_RETURN_PERIODS.map((rp) => ({ returnPeriod: rp, ...lossAtReturnPeriod(points, rp) })),
    aalKes: averageAnnualLoss(points),
    mode,
    ...(allDrivers ? { judgement } : {}),
  };
}

/** Short fingerprint of a result, used to prove a saved run reproduces exactly. */
export function resultFingerprint(r: ModelResult): string {
  const text = JSON.stringify([r.totalTivKes, r.aalKes, r.scenarios.map((s) => [s.id, s.returnPeriod, s.lossKes, s.affected])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
