import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GeoCollection, WardProps } from "../src/lib/geo/layers";
import { assignPoints, geometryBBox, geometryContains, wardAccumulation } from "../src/lib/geo/spatial";
import { bandedAal } from "../src/lib/model/financial";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import type { Building, Dataset } from "../src/lib/model/types";

const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

describe("point in polygon", () => {
  const donut = { type: "Polygon" as const, coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] };
  it("finds points inside the outer ring and outside the hole", () => {
    expect(geometryContains(donut, 1, 1)).toBe(true);
    expect(geometryContains(donut, 5, 5)).toBe(false);
    expect(geometryContains(donut, 11, 5)).toBe(false);
  });
  it("handles multipolygons and reports a bounding box", () => {
    const two = { type: "MultiPolygon" as const, coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] };
    expect(geometryContains(two, 5.5, 5.5)).toBe(true);
    expect(geometryContains(two, 3, 3)).toBe(false);
    expect(geometryBBox(two)).toEqual([0, 0, 6, 6]);
  });
});

describe("Nairobi wards", () => {
  const wards = JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", "wards.geojson"), "utf8")) as GeoCollection<WardProps>;

  it("has the 85 wards in 17 sub-counties", () => {
    expect(wards.features).toHaveLength(85);
    expect(new Set(wards.features.map((f) => f.properties.subcounty)).size).toBe(17);
  });

  it("puts known points in the right ward", () => {
    const at = assignPoints(
      [
        { lon: 36.81946, lat: -1.3178 },
        { lon: 36.78897, lat: -1.27587 },
        { lon: 36.92083, lat: -1.2678 },
        { lon: 36.5, lat: -1.0 },
      ],
      wards,
    );
    expect(at.slice(0, 3).map((i) => wards.features[i].properties.name)).toEqual(["Nairobi West", "Kileleshwa", "Kayole North"]);
    expect(at[3]).toBe(-1);
  });
});

describe("accumulation by ward", () => {
  const building = (id: string, lon: number, hazard: number[], tivKes: number): Building => ({
    locId: id,
    lat: 0.5,
    lon,
    housingClassRaw: "permanent_masonry",
    housingClass: "permanent_masonry",
    floorAreaM2: null,
    costPerM2Kes: null,
    tivKes,
    synthetic: true,
    hazard,
  });
  const dataset: Dataset = {
    name: "toy",
    hazardKind: "score",
    scenarios: [
      { id: "extreme", label: "extreme" },
      { id: "common", label: "common" },
    ],
    hotspots: [],
    rasters: [],
    buildings: [building("A", 0.5, [0, 0.3], 1000), building("B", 1.5, [0.2, 0.6], 5000), building("C", 9, [0.4, 0.8], 2000)],
  };
  const wards: GeoCollection<WardProps> = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "West", subcounty: "S" }, geometry: { type: "Polygon", coordinates: [square(0, 0, 1, 1)] } },
      { type: "Feature", properties: { name: "East", subcounty: "S" }, geometry: { type: "Polygon", coordinates: [square(1, 0, 2, 1)] } },
    ],
  };
  const result = runModel(dataset, REFERENCE_PARAMS);
  const wardOf = assignPoints(dataset.buildings, wards);

  it("adds up to the portfolio totals, with buildings outside every ward kept apart", () => {
    expect(wardOf).toEqual([0, 1, -1]);
    result.scenarios.forEach((s, k) => {
      const rows = wardAccumulation(dataset, result, wardOf, wards, k);
      expect(rows.map((r) => r.name)).toEqual(["West", "East", "Outside the ward map"]);
      expect(rows.reduce((t, r) => t + r.buildings, 0)).toBe(3);
      expect(rows.reduce((t, r) => t + r.tivKes, 0)).toBe(8000);
      expect(rows.reduce((t, r) => t + r.lossKes, 0)).toBeCloseTo(s.lossKes, 6);
      expect(rows.reduce((t, r) => t + r.flooded, 0)).toBe(s.affected);
    });
  });

  it("gives the step average annual loss Oasis uses", () => {
    const [frequent, rare] = result.scenarios;
    const expected = (1 / frequent.returnPeriod - 1 / rare.returnPeriod) * frequent.lossKes + (1 / rare.returnPeriod) * rare.lossKes;
    expect(bandedAal(result)).toBeCloseTo(expected, 6);
  });
});
