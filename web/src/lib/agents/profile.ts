import type { Check } from "../checks";
import type { IngestReport } from "../ingest";
import { hotspotHits } from "../model/hotspots";
import { BOUNDS, REFERENCE_PARAMS } from "../model/params";
import { HOUSING_CLASSES, type Dataset, type ModelResult } from "../model/types";
import { JRC_AFRICA_RESIDENTIAL } from "../model/vulnerability";

const round = (v: number, digits = 3) => Number(v.toFixed(digits));
const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

/**
 * Everything the agents are allowed to know about the data, computed by code.
 * Agents never see individual rows.
 */
export function buildProfile(dataset: Dataset, report: IngestReport, reference: ModelResult, checks: Check[]) {
  const total = reference.totalTivKes;
  const widest = reference.scenarios[reference.scenarios.length - 1];
  const hits = hotspotHits(dataset);

  return {
    dataset: dataset.name,
    hazard: {
      kind: dataset.hazardKind,
      meaning:
        dataset.hazardKind === "score"
          ? "0–1 relative flood susceptibility built from terrain and river proximity. Not a measured depth. The five tiers are nested cuts of one score: 'common' keeps the top 40% of cells, 'extreme' the top 5%, each rescaled to 0–1. The widest footprint ('common') stands for the rarest event."
          : "Flood depth in metres from published return-period maps. Depth scale and tier return periods are not used for this dataset.",
      scenarios: dataset.scenarios.map((s, k) => {
        const wet = dataset.buildings.map((b) => b.hazard[k]).filter((v) => v > 0).sort((a, b) => a - b);
        const tivExposed = dataset.buildings.reduce((t, b) => t + (b.hazard[k] > 0 ? b.tivKes : 0), 0);
        return {
          id: s.id,
          fixedReturnPeriodYears: s.fixedReturnPeriod ?? null,
          buildingsAffected: wet.length,
          shareOfInsuredValueAffected: round(tivExposed / total),
          medianValueWhereAffected: round(quantile(wet, 0.5)),
          p90ValueWhereAffected: round(quantile(wet, 0.9)),
          highestValue: round(wet[wet.length - 1] ?? 0),
        };
      }),
      hotspotValidation: hits.length
        ? { namedFloodAreas: hits.length, flagged: hits.filter((h) => h.hit).length, missed: hits.filter((h) => !h.hit).map((h) => h.name) }
        : null,
    },
    portfolio: {
      synthetic: true,
      buildings: dataset.buildings.length,
      totalInsuredValueKes: Math.round(total),
      insuredValueOverDocumentedFormula: report.tivRatio ? round(report.tivRatio.median, 2) : null,
      byClass: HOUSING_CLASSES.map((c) => {
        const cls = widest.byClass[c];
        return {
          class: c,
          buildings: cls.count,
          shareOfBuildings: round(cls.count / dataset.buildings.length),
          shareOfInsuredValue: round(cls.tivKes / total),
          affectedInWidestScenario: cls.affected,
        };
      }),
    },
    dataWarnings: checks.filter((c) => c.status !== "pass").map((c) => ({ check: c.title, status: c.status, detail: c.detail })),
    model: {
      formulas: [
        "depth_m = score × depthScaleM (score datasets only)",
        "damage_ratio = min( jrc_curve( depth_m × fragility[class] ), cap[class] )",
        "building_loss = damage_ratio × insured_value",
        "portfolio loss per scenario = sum of building losses; each scenario is placed at its return period to form the loss curve",
      ],
      jrcCurve: { source: JRC_AFRICA_RESIDENTIAL.source, depthsM: JRC_AFRICA_RESIDENTIAL.depthsM, damage: JRC_AFRICA_RESIDENTIAL.damage },
      allowedRanges: BOUNDS,
      referenceParameters: REFERENCE_PARAMS,
      referenceOutcome: {
        lossByScenario: reference.scenarios.map((s) => ({ id: s.id, returnPeriodYears: s.returnPeriod, lossShareOfInsuredValue: round(s.lossKes / total, 4) })),
        averageAnnualLossShareOfInsuredValue: round(reference.aalKes / total, 5),
      },
    },
  };
}

export type DataProfile = ReturnType<typeof buildProfile>;

/** What a parameter set produced, in the compact form shown to the Chair. */
export function outcomeSummary(result: ModelResult) {
  return {
    lossByScenario: result.scenarios.map((s) => ({ id: s.id, returnPeriodYears: s.returnPeriod, lossShareOfInsuredValue: round(s.lossKes / result.totalTivKes, 4) })),
    averageAnnualLossShareOfInsuredValue: round(result.aalKes / result.totalTivKes, 5),
  };
}

export type OutcomeSummary = ReturnType<typeof outcomeSummary>;
