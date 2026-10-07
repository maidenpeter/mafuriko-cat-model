import { describe, expect, it } from "vitest";
import { tierSlopes } from "../src/lib/model/hazard";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { hazardToDepth, runModel } from "../src/lib/model/pipeline";
import { SCORE_TIERS, type Building, type Dataset } from "../src/lib/model/types";

// One susceptibility surface cut at five thresholds, each cut rescaled to run 0 to 1, the way
// the Nairobi starter kit maps are built. Thresholds run from the narrowest tier to the widest.
const THRESHOLDS = [0.8, 0.7, 0.55, 0.4, 0.2];
const WIDEST = THRESHOLDS[THRESHOLDS.length - 1];
const cut = (raw: number, t: number) => (raw > t ? (raw - t) / (1 - t) : 0);

const building = (id: string, raw: number): Building => ({
  locId: id,
  lat: 0,
  lon: 0,
  housingClassRaw: "permanent_masonry",
  housingClass: "permanent_masonry",
  floorAreaM2: null,
  costPerM2Kes: null,
  tivKes: 1_000_000,
  synthetic: true,
  hazard: THRESHOLDS.map((t) => cut(raw, t)),
});

const raws = Array.from({ length: 41 }, (_, i) => 0.2 + (0.8 * i) / 40);
const dataset: Dataset = {
  name: "nested",
  hazardKind: "score",
  scenarios: SCORE_TIERS.map((id) => ({ id, label: id })),
  hotspots: [],
  rasters: [],
  buildings: raws.map((r, i) => building(`N-${i}`, r)),
};

describe("tier slopes", () => {
  it("recover how each tier was rescaled", () => {
    const slopes = tierSlopes(dataset);
    THRESHOLDS.forEach((t, k) => expect(slopes[k]).toBeCloseTo((1 - t) / (1 - WIDEST), 9));
  });

  it("stop every tier peaking at the same depth", () => {
    const slopes = tierSlopes(dataset);
    const top = dataset.buildings[dataset.buildings.length - 1]; // scores 1 in every tier
    const depths = top.hazard.map((s, k) => hazardToDepth(s, dataset, REFERENCE_PARAMS, slopes[k]));
    expect(depths[depths.length - 1]).toBeCloseTo(REFERENCE_PARAMS.depthScaleM, 9);
    expect(depths[0]).toBeCloseTo((REFERENCE_PARAMS.depthScaleM * (1 - 0.8)) / (1 - WIDEST), 9);
    depths.slice(1).forEach((d, i) => expect(d).toBeGreaterThan(depths[i]));
  });

  it("give each building the depth implied by one common scale", () => {
    const result = runModel(dataset, REFERENCE_PARAMS);
    result.buildings.forEach((b, i) => {
      result.scenarios.forEach((s, k) => {
        const t = THRESHOLDS[SCORE_TIERS.indexOf(s.id as (typeof SCORE_TIERS)[number])];
        const expected = (Math.max(0, raws[i] - t) / (1 - WIDEST)) * REFERENCE_PARAMS.depthScaleM;
        expect(b.perScenario[k].depthM).toBeCloseTo(expected, 9);
      });
    });
  });

  it("leave depth maps and thin data alone", () => {
    expect(tierSlopes({ ...dataset, hazardKind: "depth_m" })).toEqual([1, 1, 1, 1, 1]);
    expect(tierSlopes({ ...dataset, buildings: dataset.buildings.slice(-1) })).toEqual([1, 1, 1, 1, 1]);
  });
});
