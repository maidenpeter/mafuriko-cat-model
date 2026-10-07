import { averageAnnualLoss, lossAtReturnPeriod, STANDARD_RETURN_PERIODS, type CurvePoint } from "./financial";
import {
  HOUSING_CLASSES,
  type BuildingResult,
  type ClassBreakdown,
  type Dataset,
  type HousingClass,
  type ModelParams,
  type ModelResult,
  type ScenarioResult,
  type ScoreTier,
} from "./types";
import { damageDetail } from "./vulnerability";

/** Hazard value to flood depth in metres. Scores use the assumed depth scale; depths pass through. */
export function hazardToDepth(hazard: number, dataset: Pick<Dataset, "hazardKind">, params: ModelParams): number {
  if (!(hazard > 0)) return 0;
  return dataset.hazardKind === "score" ? hazard * params.depthScaleM : hazard;
}

/** Return period for each dataset scenario: taken from the data when it has one, otherwise from the assumptions. */
export function scenarioReturnPeriods(dataset: Dataset, params: ModelParams): number[] {
  return dataset.scenarios.map((s) => s.fixedReturnPeriod ?? params.returnPeriods[s.id as ScoreTier]);
}

const emptyBreakdown = (): ClassBreakdown => ({ count: 0, tivKes: 0, affected: 0, tivExposedKes: 0, lossKes: 0 });

export function runModel(dataset: Dataset, params: ModelParams): ModelResult {
  const rps = scenarioReturnPeriods(dataset, params);
  // Scenario order in the result: most frequent first.
  const order = dataset.scenarios.map((_, i) => i).sort((a, b) => rps[a] - rps[b]);

  const scenarios: ScenarioResult[] = order.map((i) => ({
    id: dataset.scenarios[i].id,
    label: dataset.scenarios[i].label,
    returnPeriod: rps[i],
    lossKes: 0,
    affected: 0,
    tivExposedKes: 0,
    byClass: Object.fromEntries(HOUSING_CLASSES.map((c) => [c, emptyBreakdown()])) as Record<HousingClass, ClassBreakdown>,
  }));

  let totalTivKes = 0;
  const buildings: BuildingResult[] = dataset.buildings.map((b) => {
    totalTivKes += b.tivKes;
    const perScenario = order.map((srcIndex, k) => {
      const hazard = b.hazard[srcIndex] ?? 0;
      const depthM = hazardToDepth(hazard, dataset, params);
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

      return { hazard, depthM, ...d, lossKes };
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
