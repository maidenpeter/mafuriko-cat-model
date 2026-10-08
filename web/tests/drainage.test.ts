import { describe, expect, it } from "vitest";
import { financialChecks } from "../src/lib/checks";
import { distanceTransform, drainageDistances, sampleGrid, stressAt, stressGrid } from "../src/lib/geo/drainage";
import type { GeoCollection, SettlementProps, WaterwayProps } from "../src/lib/geo/layers";
import { hotspotHits } from "../src/lib/model/hotspots";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import type { Building, Dataset, Raster } from "../src/lib/model/types";

describe("distance transform", () => {
  it("gives exact Euclidean distances in metres", () => {
    const mask = new Uint8Array(25);
    mask[2 * 5 + 2] = 1; // centre of a 5 x 5 grid
    const d = distanceTransform(mask, 5, 5, 10, 10);
    expect(d[2 * 5 + 2]).toBe(0);
    expect(d[2 * 5 + 4]).toBeCloseTo(20, 6);
    expect(d[0]).toBeCloseTo(Math.hypot(20, 20), 6);
  });
  it("respects different cell sizes along each axis", () => {
    const mask = new Uint8Array(9);
    mask[0] = 1;
    const d = distanceTransform(mask, 3, 3, 30, 10);
    expect(d[2]).toBeCloseTo(60, 6); // two cells east
    expect(d[6]).toBeCloseTo(20, 6); // two cells south
  });
});

describe("drainage stress", () => {
  it("is full on a drain or inside a settlement and fades to nothing at the reach", () => {
    expect(stressAt(0, Infinity, 300)).toBe(1);
    expect(stressAt(150, Infinity, 300)).toBeCloseTo(0.5);
    expect(stressAt(Infinity, 0, 300)).toBe(1);
    expect(stressAt(400, 350, 300)).toBe(0);
  });

  it("is measured from mapped drains and settlement outlines on the grid", () => {
    const grid = { width: 10, height: 10, bbox: [0, 0, 0.01, 0.01] as [number, number, number, number] };
    const waterways: GeoCollection<WaterwayProps> = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { kind: "drain", name: null }, geometry: { type: "LineString", coordinates: [[0.0055, 0], [0.0055, 0.01]] } },
        { type: "Feature", properties: { kind: "river", name: "ignored" }, geometry: { type: "LineString", coordinates: [[0.0015, 0], [0.0015, 0.01]] } },
      ],
    };
    const settlements: GeoCollection<SettlementProps> = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "S" }, geometry: { type: "Polygon", coordinates: [[[0.008, 0.008], [0.01, 0.008], [0.01, 0.01], [0.008, 0.01], [0.008, 0.008]]] } }],
    };
    const d = drainageDistances(grid, waterways, settlements);
    expect(sampleGrid(grid, d.toDrain, 0.0055, 0.005)).toBe(0); // on the drain
    expect(sampleGrid(grid, d.toDrain, 0.0025, 0.005)).toBeGreaterThan(300); // rivers are not drains
    expect(sampleGrid(grid, d.toSettlement, 0.0095, 0.0095)).toBe(0); // inside the settlement
    const stress = stressGrid(d, 300);
    expect(sampleGrid(grid, stress, 0.0055, 0.002)).toBe(1);
    expect(sampleGrid(grid, stress, 0.0005, 0.0005)).toBe(0);
  });
});

describe("model with drainage", () => {
  const building = (id: string, lon: number, hazard: number[]): Building => ({
    locId: id,
    lat: 0.5,
    lon,
    housingClassRaw: "permanent_masonry",
    housingClass: "permanent_masonry",
    floorAreaM2: null,
    costPerM2Kes: null,
    tivKes: 1_000_000,
    synthetic: true,
    hazard,
  });
  const raster = (id: string): Raster => ({ scenarioId: id, fileName: `${id}.tif`, width: 2, height: 1, bbox: [0, 0, 2, 1], data: new Float32Array([0, 0.3]), noData: null });
  const base: Dataset = {
    name: "toy",
    hazardKind: "score",
    scenarios: [
      { id: "extreme", label: "extreme" },
      { id: "common", label: "common" },
    ],
    hotspots: [
      { name: "In the zone", lat: 0.5, lon: 0.5 },
      { name: "Outside", lat: 0.5, lon: 1.5 },
    ],
    rasters: [raster("extreme"), raster("common")],
    buildings: [building("A", 0.5, [0, 0]), building("B", 1.5, [0, 0.3])],
  };
  const drained: Dataset = {
    ...base,
    drainage: {
      reachM: 300,
      depthM: [0.2, 0.6],
      buildingStress: [0.5, 0],
      grid: { width: 2, height: 1, bbox: [0, 0, 2, 1], stress: new Float32Array([0.5, 0]) },
    },
  };

  it("floods a building the terrain leaves dry, and keeps the deeper of the two depths", () => {
    const r = runModel(drained, REFERENCE_PARAMS);
    const [extreme, common] = [0, 1];
    expect(r.buildings[0].perScenario[extreme].depthM).toBeCloseTo(0.1); // 0.5 stress x 0.2 m
    expect(r.buildings[0].perScenario[common].depthM).toBeCloseTo(0.3);
    expect(r.buildings[0].perScenario[common].drainageM).toBeCloseTo(0.3);
    expect(r.buildings[1].perScenario[common].depthM).toBeCloseTo(0.3 * REFERENCE_PARAMS.depthScaleM); // terrain is deeper
    expect(r.buildings[1].perScenario[common].drainageM).toBe(0);
    expect(r.scenarios[extreme].affected).toBe(1);
    expect(runModel(base, REFERENCE_PARAMS).scenarios[extreme].affected).toBe(0);
  });

  it("flags hotspots inside the drainage zone, and the financial checks still reconcile", () => {
    expect(hotspotHits(base).map((h) => h.hit)).toEqual([false, true]);
    expect(hotspotHits(drained).map((h) => h.hit)).toEqual([true, true]);
    const checks = financialChecks(drained, runModel(drained, REFERENCE_PARAMS));
    expect(checks.find((c) => c.id === "sum-buildings")?.status).toBe("pass");
  });
});
