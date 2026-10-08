import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { driverChecks, financialChecks } from "../src/lib/checks";
import { drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { buildingDepths, highestWithin, siteDepths, structureLoss, type SiteDepths } from "../src/lib/model/drivers";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { resultFingerprint, runModel } from "../src/lib/model/pipeline";
import type { Building, Dataset, ModelResult, Raster } from "../src/lib/model/types";
import { REFERENCE_JUDGEMENT, type OfferJudgement } from "../src/lib/offer/judgement";

// A 5 x 5 map on the equator: each cell is 0.001 degrees, about 111 m east to west and 111 m north to south.
// Row 0 is the northern edge. The middle cell is row 2, column 2.
const BBOX: [number, number, number, number] = [0, 0, 0.005, 0.005];
const map = (scenarioId: string, wet: [row: number, col: number, value: number][], bbox = BBOX, noData: number | null = null): Raster => {
  const data = new Float32Array(25);
  for (const [row, col, value] of wet) data[row * 5 + col] = value;
  return { scenarioId, fileName: `${scenarioId}.tif`, width: 5, height: 5, bbox, data, noData };
};
/** The centre of a cell of the map above. */
const at = (row: number, col: number) => ({ lon: (col + 0.5) * 0.001, lat: 0.005 - (row + 0.5) * 0.001 });
const MIDDLE = at(2, 2);
const CORNER = at(0, 0);

const building = (locId: string, where: { lon: number; lat: number }, hazard: number[], more: Partial<Building> = {}): Building => ({
  locId,
  ...where,
  housingClassRaw: "permanent_masonry",
  housingClass: "permanent_masonry",
  floorAreaM2: null,
  costPerM2Kes: null,
  tivKes: 1_000_000,
  synthetic: true,
  hazard,
  ...more,
});

// Depth maps with their own return periods. In the 1-in-25 the middle is dry and a cell two to the
// east (223 m away) holds 0.5 m. In the 1-in-50 the middle holds 0.25 m and that cell 1 m.
const depthDataset = (): Dataset => ({
  name: "toy",
  hazardKind: "depth_m",
  scenarios: [
    { id: "rp25", label: "25 years", fixedReturnPeriod: 25 },
    { id: "rp50", label: "50 years", fixedReturnPeriod: 50 },
  ],
  hotspots: [],
  rasters: [map("rp25", [[2, 4, 0.5]]), map("rp50", [[2, 2, 0.25], [2, 4, 1]])],
  buildings: [building("A", MIDDLE, [0, 0.25]), building("B", CORNER, [0, 0]), building("C", { lon: 1, lat: 1 }, [0, 0])],
});

const J = REFERENCE_JUDGEMENT;
const judge = (more: Partial<OfferJudgement>): OfferJudgement => ({ ...J, ...more });
const ALL = { mode: "all_drivers" } as const;

describe("highest value within the buffer", () => {
  it("counts a wet cell whose centre is inside the radius and leaves out one outside it", () => {
    const raster = map("x", [[2, 4, 0.5]]);
    expect(highestWithin(raster, MIDDLE.lon, MIDDLE.lat, 250, "depth_m")).toBe(0.5);
    expect(highestWithin(raster, MIDDLE.lon, MIDDLE.lat, 200, "depth_m")).toBe(0);
  });

  it("gives the value at the point itself when the radius is 0", () => {
    const raster = map("x", [[2, 2, 0.25], [2, 3, 2]]);
    expect(highestWithin(raster, MIDDLE.lon, MIDDLE.lat, 0, "depth_m")).toBe(0.25);
    expect(highestWithin(raster, MIDDLE.lon, MIDDLE.lat, 120, "depth_m")).toBe(2);
  });

  it("measures from the point, not from the middle of its cell", () => {
    // The wet cell's centre is 223 m east of the middle cell's centre. From the east edge of that
    // cell it is 167 m, from the west edge 278 m.
    const raster = map("x", [[2, 4, 0.5]]);
    expect(highestWithin(raster, 0.00299, MIDDLE.lat, 200, "depth_m")).toBe(0.5);
    expect(highestWithin(raster, 0.00201, MIDDLE.lat, 250, "depth_m")).toBe(0);
  });

  it("measures the radius in metres, where a cell is not square on the ground", () => {
    // At 60 degrees north a cell is about 56 m east to west and 111 m north to south.
    const north: [number, number, number, number] = [0, 59.9975, 0.005, 60.0025];
    const here = { lon: 0.0025, lat: 60 };
    // Two cells east is 111 m away; two cells north is 221 m away.
    expect(highestWithin(map("x", [[2, 4, 0.5]], north), here.lon, here.lat, 200, "depth_m")).toBe(0.5);
    expect(highestWithin(map("x", [[0, 2, 0.5]], north), here.lon, here.lat, 200, "depth_m")).toBe(0);
    expect(highestWithin(map("x", [[0, 2, 0.5]], north), here.lon, here.lat, 250, "depth_m")).toBe(0.5);
  });

  it("is null outside the map, and reads no-data cells as dry", () => {
    expect(highestWithin(map("x", [[2, 2, 1]]), 1, 1, 250, "depth_m")).toBeNull();
    expect(highestWithin(map("x", [[2, 2, 1]]), Number.NaN, 0.0025, 250, "depth_m")).toBeNull();
    expect(highestWithin(map("x", [[2, 3, -9999]], BBOX, -9999), MIDDLE.lon, MIDDLE.lat, 250, "depth_m")).toBe(0);
  });

  it("remembers each answer per radius without mixing radii up", () => {
    const raster = map("x", [[2, 3, 0.5], [2, 4, 1]]);
    const read = (radius: number) => highestWithin(raster, MIDDLE.lon, MIDDLE.lat, radius, "depth_m");
    // More radii than are kept at once, each asked twice.
    for (const [radius, expected] of [[0, 0], [150, 0.5], [250, 1], [0, 0], [10, 0], [20, 0], [30, 0], [150, 0.5], [250, 1]]) {
      expect(read(radius)).toBe(expected);
      expect(read(radius)).toBe(expected);
    }
  });
});

describe("depths at a site", () => {
  const dataset = depthDataset();
  const site = (k: number, judgement = J, options: Parameters<typeof siteDepths>[6] = ALL, where = MIDDLE) => siteDepths(dataset, where.lon, where.lat, k, REFERENCE_PARAMS, judgement, options)!;

  it("finds water within the buffer of a point that is dry", () => {
    expect(site(0)).toEqual({ pointM: 0, bufferM: 0.5, pondingM: 0, overloaded: false, overloadM: 0, surfaceM: 0.5, mode: "all_drivers" });
    // With a 200 m buffer the wet cell is out of reach.
    expect(site(0, judge({ bufferRadiusM: 200 })).bufferM).toBe(0);
    expect(site(0, judge({ bufferRadiusM: 200 })).surfaceM).toBe(0);
  });

  it("never reports a buffer depth below the point depth, and a radius of 0 gives the point depth", () => {
    expect(site(1)).toMatchObject({ pointM: 0.25, bufferM: 1, surfaceM: 1 });
    expect(site(1, judge({ bufferRadiusM: 200 }))).toMatchObject({ pointM: 0.25, bufferM: 0.25 });
    expect(site(1, judge({ bufferRadiusM: 0 }))).toMatchObject({ pointM: 0.25, bufferM: 0.25 });
  });

  it("switches drain overload on only when the event is rarer than the design return period", () => {
    // Reference design: 1-in-25. The 1-in-25 event is not rarer than that; the 1-in-50 is.
    expect(site(0, J, ALL, CORNER)).toMatchObject({ overloaded: false, overloadM: 0, surfaceM: 0 });
    expect(site(1, J, ALL, CORNER)).toMatchObject({ pointM: 0, bufferM: 0, overloaded: true, overloadM: 0.1, surfaceM: 0.1 });
    // A design return period stated in the offer replaces the assumption.
    expect(site(1, J, { ...ALL, drainDesignRp: 50 }, CORNER)).toMatchObject({ overloaded: false, surfaceM: 0 });
    expect(site(1, J, { ...ALL, drainDesignRp: 49 }, CORNER)).toMatchObject({ overloaded: true, surfaceM: 0.1 });
    expect(site(0, J, { ...ALL, drainDesignRp: 10 }, CORNER)).toMatchObject({ overloaded: true, surfaceM: 0.1 });
    // One that is not a usable number does not.
    expect(site(1, J, { ...ALL, drainDesignRp: Number.NaN }, CORNER).overloaded).toBe(true);
    expect(site(1, judge({ drainDesignRp: 100 }), ALL, CORNER).overloaded).toBe(false);
    expect(site(1, judge({ drainOverloadDepthM: 0.3 }), ALL, CORNER).surfaceM).toBe(0.3);
  });

  it("takes ponding where it is deeper than the buffer depth", () => {
    expect(site(1, J, { ...ALL, pondingM: 1.5 })).toMatchObject({ bufferM: 1, pondingM: 1.5, surfaceM: 1.5 });
    expect(site(1, J, { ...ALL, pondingM: 0.4 })).toMatchObject({ pondingM: 0.4, surfaceM: 1 });
    // Read from the dataset's drainage layer when the caller does not give it: stress 0.5 x 0.6 m.
    const stress = new Float32Array(25);
    stress[2 * 5 + 2] = 0.5;
    const drained: Dataset = { ...dataset, drainage: { reachM: 300, depthM: [0.2, 0.6], buildingStress: [0.5, 0, 0], grid: { width: 5, height: 5, bbox: BBOX, stress } } };
    expect(siteDepths(drained, MIDDLE.lon, MIDDLE.lat, 1, REFERENCE_PARAMS, J, ALL)!.pondingM).toBeCloseTo(0.3);
    expect(siteDepths(drained, CORNER.lon, CORNER.lat, 1, REFERENCE_PARAMS, J, ALL)!.pondingM).toBe(0);
  });

  it("in depth-only mode uses the deeper of the point and the ponding, and still reports the rest", () => {
    const facts = { pointM: 0.25, bufferM: 1, pondingM: 0, overloaded: true, overloadM: 0.1, surfaceM: 0.25, mode: "depth_only" };
    expect(site(1, J, { mode: "depth_only" })).toEqual(facts);
    // Depth only is also what a call without a mode gives, as in runModel.
    expect(siteDepths(dataset, MIDDLE.lon, MIDDLE.lat, 1, REFERENCE_PARAMS, J)).toEqual(facts);
    expect(siteDepths(dataset, MIDDLE.lon, MIDDLE.lat, 1, REFERENCE_PARAMS, J, { pondingM: 0.4 })!.surfaceM).toBe(0.4);
    expect(site(1, J, { mode: "depth_only", pondingM: 0.4 }).surfaceM).toBe(0.4);
    expect(site(0, J, { mode: "depth_only" }).surfaceM).toBe(0);
  });

  it("is null outside the map, without a map for the scenario, and for a point that is not a number", () => {
    expect(siteDepths(dataset, 1, 1, 0, REFERENCE_PARAMS, J, ALL)).toBeNull();
    expect(siteDepths(dataset, Number.NaN, MIDDLE.lat, 0, REFERENCE_PARAMS, J, ALL)).toBeNull();
    expect(siteDepths({ ...dataset, rasters: [dataset.rasters[0]] }, MIDDLE.lon, MIDDLE.lat, 1, REFERENCE_PARAMS, J, ALL)).toBeNull();
    expect(siteDepths(dataset, MIDDLE.lon, MIDDLE.lat, 7, REFERENCE_PARAMS, J, ALL)).toBeNull();
  });

  it("turns scores into depth with the tier slope and the depth scale, as at the point", () => {
    // Where both tiers are wet, widest = 0.3 + 0.5 x narrowest, so the narrowest tier's slope is 0.5.
    const scores: Dataset = {
      name: "scores",
      hazardKind: "score",
      scenarios: [
        { id: "extreme", label: "extreme" },
        { id: "common", label: "common" },
      ],
      hotspots: [],
      rasters: [map("extreme", [[0, 0, 0.25], [0, 1, 0.5], [2, 4, 1]]), map("common", [[0, 0, 0.425], [0, 1, 0.55], [2, 4, 0.8], [2, 2, 0.25]])],
      buildings: [],
    };
    const depths = (k: number) => siteDepths(scores, MIDDLE.lon, MIDDLE.lat, k, REFERENCE_PARAMS, J, ALL)!;
    // extreme (1-in-10): score 1 x slope 0.5 x 4 m within the buffer; not rarer than the 1-in-25 design.
    expect(depths(0).pointM).toBe(0);
    expect(depths(0).bufferM).toBeCloseTo(2, 5);
    expect(depths(0).overloaded).toBe(false);
    // common (1-in-250): 0.25 x 4 m at the point, 0.8 x 4 m within the buffer.
    expect(depths(1).pointM).toBeCloseTo(1, 5);
    expect(depths(1).bufferM).toBeCloseTo(3.2, 5);
    expect(depths(1).overloaded).toBe(true);
  });
});

describe("structure loss split by driver", () => {
  const depths = (pointM: number, bufferM: number, pondingM: number, overloadM: number, mode: SiteDepths["mode"] = "all_drivers"): SiteDepths => ({
    pointM,
    bufferM,
    pondingM,
    overloaded: overloadM > 0,
    overloadM,
    surfaceM: mode === "depth_only" ? Math.max(pointM, pondingM) : Math.max(bufferM, pondingM, overloadM),
    mode,
  });
  const split = (d: SiteDepths, cls: Building["housingClass"] = "permanent_masonry") => structureLoss(d, cls, 1_000_000, REFERENCE_PARAMS);
  const sum = (s: ReturnType<typeof split>) => s.pointKes + s.surroundingKes + s.pondingKes + s.overloadKes;

  it("reads the curve once at the deepest water and credits each driver with what it adds", () => {
    // Masonry: 0.25 m gives 0.11, 0.5 m gives 0.22, 0.75 m gives 0.30. Overload at 0.1 m adds nothing.
    const s = split(depths(0.25, 0.5, 0.75, 0.1));
    expect(s.pointKes).toBeCloseTo(110_000, 6);
    expect(s.surroundingKes).toBeCloseTo(110_000, 6);
    expect(s.pondingKes).toBeCloseTo(80_000, 6);
    expect(s.overloadKes).toBe(0);
    expect(s.totalKes).toBeCloseTo(300_000, 6);
    expect(s.damageRatio).toBeCloseTo(0.3);
    expect(sum(s)).toBeCloseTo(s.totalKes, 6);
  });

  it("credits a driver nothing when an earlier one is already deeper", () => {
    // Ponding at 0.3 m is below the buffer depth of 0.5 m.
    const s = split(depths(0, 0.5, 0.3, 0.1));
    expect(s).toMatchObject({ pointKes: 0, pondingKes: 0, overloadKes: 0 });
    expect(s.surroundingKes).toBeCloseTo(220_000, 6);
  });

  it("prices drain overload on a site the maps leave dry", () => {
    const s = split(depths(0, 0, 0, 0.1));
    expect(s).toMatchObject({ pointKes: 0, surroundingKes: 0, pondingKes: 0, capped: false });
    expect(s.overloadKes).toBeCloseTo(44_000, 6);
    expect(s.totalKes).toBe(s.overloadKes);
  });

  it("stops at the class cap, and shares the capped loss between the drivers", () => {
    // Informal: fragility 1.5, cap 0.95. 1 m gives 0.53; 10 m is over the cap.
    const s = split(depths(1, 10, 0.5, 0.1), "informal_iron_sheet");
    expect(s.capped).toBe(true);
    expect(s.damageRatio).toBe(0.95);
    expect(s.totalKes).toBe(950_000);
    expect(s.pointKes).toBeCloseTo(530_000, 6);
    expect(s.surroundingKes).toBeCloseTo(420_000, 6);
    expect(s.pondingKes).toBe(0);
    expect(s.overloadKes).toBe(0);
    // Already over the cap at the point: nothing is left for the others.
    expect(split(depths(10, 12, 11, 0.1), "informal_iron_sheet")).toMatchObject({ pointKes: 950_000, surroundingKes: 0, pondingKes: 0, overloadKes: 0, totalKes: 950_000 });
  });

  it("adds up to the total for any mix of depths", () => {
    const steps = [0, 0.05, 0.1, 0.3, 0.8, 1.7, 4, 9];
    for (const cls of ["informal_iron_sheet", "concrete_rcc"] as const) {
      for (const p of steps) for (const b of steps) for (const d of steps) for (const o of [0, 0.1, 0.5]) {
        const s = split(depths(p, Math.max(p, b), d, o), cls);
        expect(Math.abs(sum(s) - s.totalKes)).toBeLessThanOrEqual(1e-9 * Math.max(1, s.totalKes));
        for (const part of [s.pointKes, s.surroundingKes, s.pondingKes, s.overloadKes]) expect(part).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it("in depth-only mode credits the surroundings and drain overload nothing", () => {
    const s = split(depths(0.25, 0.5, 0.75, 0.1, "depth_only"));
    expect(s.pointKes).toBeCloseTo(110_000, 6);
    expect(s.surroundingKes).toBe(0);
    expect(s.pondingKes).toBeCloseTo(190_000, 6);
    expect(s.overloadKes).toBe(0);
    expect(s.totalKes).toBeCloseTo(300_000, 6);
    // Dry at the point with no ponding: no loss, whatever the buffer and the drains say.
    expect(split(depths(0, 2, 0, 0.1, "depth_only"))).toMatchObject({ pointKes: 0, surroundingKes: 0, pondingKes: 0, overloadKes: 0, totalKes: 0 });
  });
});

describe("model run with all loss drivers", () => {
  const dataset = depthDataset();
  const depthOnly = runModel(dataset, REFERENCE_PARAMS);
  const all = runModel(dataset, REFERENCE_PARAMS, ALL);

  it("is the depth-only model when no mode is given, and carries no split", () => {
    expect(depthOnly.mode).toBe("depth_only");
    expect(runModel(dataset, REFERENCE_PARAMS, { mode: "depth_only", judgement: judge({ bufferRadiusM: 500, drainDesignRp: 2 }) })).toEqual(depthOnly);
    expect(depthOnly.scenarios.map((s) => s.lossKes)).toEqual([0, 0.11 * 1_000_000]);
    expect(depthOnly.scenarios.every((s) => !("byDriver" in s))).toBe(true);
    expect(depthOnly.buildings.every((b) => b.perScenario.every((p) => !("drivers" in p)))).toBe(true);
    expect("judgement" in depthOnly).toBe(false);
    expect(driverChecks(dataset, depthOnly)).toEqual([]);
  });

  it("prices a building that is dry at its point from the water around it and from drain overload", () => {
    expect(all.mode).toBe("all_drivers");
    expect(all.judgement).toEqual(J);
    const [a, b, c] = all.buildings.map((x) => x.perScenario);
    // A, 1-in-25: dry at the point, 0.5 m within the buffer. 0.22 of 1,000,000.
    expect(a[0].drivers).toMatchObject({ pointM: 0, bufferM: 0.5, overloaded: false, surfaceM: 0.5, pointKes: 0, pondingKes: 0, overloadKes: 0 });
    expect(a[0].lossKes).toBeCloseTo(220_000, 6);
    expect(a[0].depthM).toBe(0.5);
    // A, 1-in-50: 0.25 m at the point (0.11), 1 m within the buffer (0.38).
    expect(a[1].drivers!.pointKes).toBeCloseTo(110_000, 6);
    expect(a[1].drivers!.surroundingKes).toBeCloseTo(270_000, 6);
    expect(a[1].lossKes).toBeCloseTo(380_000, 6);
    // B: no water within reach. Dry until the drains are overloaded, then 0.1 m (0.044).
    expect(b[0].lossKes).toBe(0);
    expect(b[1].drivers).toMatchObject({ pointM: 0, bufferM: 0, overloaded: true, overloadM: 0.1, surfaceM: 0.1 });
    expect(b[1].lossKes).toBeCloseTo(44_000, 6);
    // C is outside the maps: it keeps its point reading and no driver is added.
    expect(c.map((x) => x.lossKes)).toEqual([0, 0]);
    expect(c[1].drivers).toMatchObject({ overloaded: false, overloadM: 0, surfaceM: 0 });
  });

  it("adds the split up per scenario, and counts every building with water as affected", () => {
    expect(all.scenarios.map((s) => s.affected)).toEqual([1, 2]);
    expect(all.scenarios[0].lossKes).toBeCloseTo(220_000, 6);
    expect(all.scenarios[1].lossKes).toBeCloseTo(424_000, 6);
    const d = all.scenarios[1].byDriver!;
    expect(d.pointKes).toBeCloseTo(110_000, 6);
    expect(d.surroundingKes).toBeCloseTo(270_000, 6);
    expect(d.pondingKes).toBe(0);
    expect(d.overloadKes).toBeCloseTo(44_000, 6);
    for (const s of all.scenarios) expect(s.byDriver!.pointKes + s.byDriver!.surroundingKes + s.byDriver!.pondingKes + s.byDriver!.overloadKes).toBeCloseTo(s.lossKes, 6);
    // The point part is the depth-only loss when drainage is off.
    all.scenarios.forEach((s, k) => expect(s.byDriver!.pointKes).toBe(depthOnly.scenarios[k].lossKes));
  });

  it("credits ponding with what it adds beyond the buffer, and overload with nothing where ponding is deeper", () => {
    const stress = new Float32Array(25);
    const drained: Dataset = { ...dataset, drainage: { reachM: 300, depthM: [0.2, 0.6], buildingStress: [0.5, 1, 0], grid: { width: 5, height: 5, bbox: BBOX, stress } } };
    const r = runModel(drained, REFERENCE_PARAMS, ALL);
    const [a, b] = r.buildings.map((x) => x.perScenario);
    // A: ponding of 0.1 m and 0.3 m stays below the buffer depths of 0.5 m and 1 m.
    expect(a[0].drivers).toMatchObject({ pondingM: 0.1, pondingKes: 0 });
    expect(a[1].lossKes).toBeCloseTo(380_000, 6);
    // B, 1-in-25: 0.2 m of ponding (0.088). 1-in-50: 0.6 m (0.252), deeper than the 0.1 m of overload.
    expect(b[0].drivers!.pondingKes).toBeCloseTo(88_000, 6);
    expect(b[1].drivers!.pondingKes).toBeCloseTo(252_000, 6);
    expect(b[1].drivers).toMatchObject({ overloaded: true, overloadKes: 0, surfaceM: 0.6 });
    expect(b[1].drainageM).toBe(0.6);
    const checks = financialChecks(drained, r);
    expect(checks.filter((c) => c.status !== "pass")).toEqual([]);
  });

  it("with a radius of 0 and drains that are never overloaded, gives the depth-only figures exactly", () => {
    const off = runModel(dataset, REFERENCE_PARAMS, { mode: "all_drivers", judgement: judge({ bufferRadiusM: 0, drainDesignRp: 1000 }) });
    expect(resultFingerprint(off)).toBe(resultFingerprint(depthOnly));
    expect(off.scenarios.map((s) => s.lossKes)).toEqual(depthOnly.scenarios.map((s) => s.lossKes));
    expect(off.scenarios.map((s) => s.byDriver!.surroundingKes + s.byDriver!.overloadKes)).toEqual([0, 0]);
  });

  it("where the hazard came from columns in the file, has no buffer to read and adds drain overload only", () => {
    const columns: Dataset = { ...dataset, rasters: [], buildings: dataset.buildings.slice(0, 2) };
    const r = runModel(columns, REFERENCE_PARAMS, ALL);
    const [a, b] = r.buildings.map((x) => x.perScenario);
    expect(a[0].drivers).toMatchObject({ pointM: 0, bufferM: 0, surfaceM: 0 });
    expect(a[1].drivers).toMatchObject({ pointM: 0.25, bufferM: 0.25, overloaded: true, surfaceM: 0.25, overloadKes: 0 });
    expect(b[1].lossKes).toBeCloseTo(44_000, 6);
    expect(financialChecks(columns, r).filter((c) => c.status !== "pass")).toEqual([]);
  });

  it("reads a building as the model does: buildingDepths is the depth the loss was priced at", () => {
    all.buildings.forEach((b, i) => b.perScenario.forEach((p, k) => {
      expect(buildingDepths(dataset, i, k, REFERENCE_PARAMS, J, 1, all.scenarios[k].returnPeriod).surfaceM).toBe(p.depthM);
    }));
  });

  it("passes the financial checks, which then include the checks on the drivers", () => {
    const ids = ["drivers-add-up", "buffer-ge-point", "depth-only-le-all"];
    const checks = financialChecks(dataset, all);
    expect(checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(checks.filter((c) => ids.includes(c.id)).map((c) => c.id)).toEqual(ids);
    expect(driverChecks(dataset, all).map((c) => c.id)).toEqual(ids);
    expect(financialChecks(dataset, depthOnly).filter((c) => ids.includes(c.id))).toEqual([]);
    // The detail says how many buildings each driver wets: in the 1-in-50, one at the point, one within
    // the buffer, none by ponding, two by drain overload, one of them by drain overload alone.
    const detail = checks.find((c) => c.id === "buffer-ge-point")!.detail;
    expect(detail).toContain("1-in-25: 0 at the point, 1 within the buffer, 0 by drainage ponding, 0 by drain overload (0 by drain overload alone)");
    expect(detail).toContain("1-in-50: 1 at the point, 1 within the buffer, 0 by drainage ponding, 2 by drain overload (1 by drain overload alone)");
    expect(detail).toContain("buffer 250 m");
    expect(detail).toContain("1-in-25 (4% a year)");
  });

  it("fails its checks when a result is tampered with", () => {
    const broken: ModelResult = JSON.parse(JSON.stringify(all));
    broken.buildings[0].perScenario[1].drivers!.surroundingKes += 5;
    broken.buildings[0].perScenario[1].drivers!.bufferM = 0.1;
    const checks = driverChecks(dataset, broken);
    expect(checks.find((c) => c.id === "drivers-add-up")!.status).toBe("fail");
    expect(checks.find((c) => c.id === "buffer-ge-point")!.status).toBe("fail");
    const lower: ModelResult = JSON.parse(JSON.stringify(all));
    lower.scenarios[1].lossKes = 1;
    expect(driverChecks(dataset, lower).find((c) => c.id === "depth-only-le-all")!.status).toBe("fail");
    expect(financialChecks(dataset, lower).find((c) => c.id === "sum-buildings")!.status).toBe("fail");
  });
});

// The hackathon starter kit, read straight from disk the way the browser reads it from a zip.
const KIT = join(__dirname, "..", "..", "data", "data");

function filesUnder(root: string): FileSource[] {
  const out: FileSource[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        out.push({
          path: relative(root, full).replaceAll("\\", "/"),
          size: statSync(full).size,
          text: async () => readFileSync(full, "utf8"),
          arrayBuffer: async () => {
            const b = readFileSync(full);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
          },
        });
      }
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!existsSync(KIT))("starter kit with all loss drivers", () => {
  let nairobi: Dataset;
  let drained: Dataset;
  let nzoia: Dataset;

  // Fingerprints of the model as it stood before the loss drivers were added, at reference assumptions.
  const BEFORE = { nairobi: "bdc87191", nairobiWithDrainage: "b6cc5322", nzoia: "09e0a862" };

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    const load = async (name: string) => (await loadDataset(candidates.find((c) => c.name === name)!, files)).dataset;
    nairobi = await load("team_a_nairobi");
    nzoia = await load("team_b_nzoia");
    const geo = <P,>(f: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", f), "utf8")) as GeoCollection<P>;
    const widest = nairobi.rasters.find((r) => r.scenarioId === "common")!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, geo<WaterwayProps>("waterways.geojson"), geo<SettlementProps>("informal-settlements.geojson"));
    drained = withDrainage(nairobi, { distances, sensitivity: drainageSensitivity(distances, widest, nairobi.hotspots) });
  }, 120_000);

  it("depth only reproduces the figures from before the drivers, with and without drainage", () => {
    const other = judge({ bufferRadiusM: 500, drainDesignRp: 2, drainOverloadDepthM: 0.5 });
    for (const options of [undefined, { mode: "depth_only" } as const, { mode: "depth_only", judgement: other } as const]) {
      expect(resultFingerprint(runModel(nairobi, REFERENCE_PARAMS, options))).toBe(BEFORE.nairobi);
      expect(resultFingerprint(runModel(drained, REFERENCE_PARAMS, options))).toBe(BEFORE.nairobiWithDrainage);
      expect(resultFingerprint(runModel(nzoia, REFERENCE_PARAMS, options))).toBe(BEFORE.nzoia);
    }
    // To the last decimal, as printed before the change.
    expect(runModel(nairobi, REFERENCE_PARAMS).scenarios.map((s) => s.lossKes)).toEqual([380527456.61527574, 739364954.9007337, 1952414103.531654, 3581174278.0674586, 5945505626.312082]);
    expect(runModel(drained, REFERENCE_PARAMS).scenarios.map((s) => s.lossKes)).toEqual([592233279.4265198, 1062456260.2646208, 2399524294.86634, 4044755943.6941547, 6471817611.03932]);
    expect(runModel(nairobi, REFERENCE_PARAMS).aalKes).toBe(140544567.05618668);
    expect(runModel(drained, REFERENCE_PARAMS).aalKes).toBe(173918884.04320398);
    expect(runModel(drained, REFERENCE_PARAMS).scenarios.map((s) => s.affected)).toEqual([86, 103, 155, 207, 280]);
  });

  it("all loss drivers switched off by their own assumptions give the depth-only figures exactly", () => {
    const off = { mode: "all_drivers", judgement: judge({ bufferRadiusM: 0, drainDesignRp: 100_000 }) } as const;
    expect(resultFingerprint(runModel(nairobi, REFERENCE_PARAMS, off))).toBe(BEFORE.nairobi);
    expect(resultFingerprint(runModel(drained, REFERENCE_PARAMS, off))).toBe(BEFORE.nairobiWithDrainage);
    expect(resultFingerprint(runModel(nzoia, REFERENCE_PARAMS, off))).toBe(BEFORE.nzoia);
  });

  it("all loss drivers never give less than depth only, for any building in any scenario", () => {
    for (const dataset of [nairobi, drained, nzoia]) {
      const before = runModel(dataset, REFERENCE_PARAMS);
      const after = runModel(dataset, REFERENCE_PARAMS, ALL);
      after.scenarios.forEach((s, k) => expect(s.lossKes).toBeGreaterThanOrEqual(before.scenarios[k].lossKes));
      after.buildings.forEach((b, i) => b.perScenario.forEach((p, k) => {
        expect(p.lossKes).toBeGreaterThanOrEqual(before.buildings[i].perScenario[k].lossKes);
        expect(p.lossKes).toBeLessThanOrEqual(dataset.buildings[i].tivKes);
      }));
      const losses = after.scenarios.map((s) => s.lossKes);
      expect([...losses].sort((a, b) => a - b)).toEqual(losses);
      expect(financialChecks(dataset, after).filter((c) => c.status === "fail")).toEqual([]);
    }
  });

  it("reads any point the way it reads a building of the portfolio at the same place", () => {
    for (const dataset of [nairobi, drained, nzoia]) {
      const result = runModel(dataset, REFERENCE_PARAMS, ALL);
      let outside = 0;
      dataset.buildings.forEach((b, i) => dataset.scenarios.forEach((s, k) => {
        const inModel = result.buildings[i].perScenario[result.scenarios.findIndex((x) => x.id === s.id)].drivers!;
        const site = siteDepths(dataset, b.lon, b.lat, k, REFERENCE_PARAMS, J, ALL);
        if (site === null) {
          // Outside the map: the building keeps its point reading and no driver is added.
          outside += 1;
          expect(inModel).toMatchObject({ bufferM: inModel.pointM, overloaded: false, overloadM: 0 });
          return;
        }
        expect(inModel).toMatchObject({ pointM: site.pointM, bufferM: site.bufferM, pondingM: site.pondingM, overloaded: site.overloaded, overloadM: site.overloadM, surfaceM: site.surfaceM });
      }));
      if (dataset !== nzoia) expect(outside).toBe(0);
    }
  });

  it("reads a 500 m buffer on the Nairobi maps without holding the page up", () => {
    const wide = { mode: "all_drivers", judgement: judge({ bufferRadiusM: 500 }) } as const;
    let t = performance.now();
    const first = runModel(drained, REFERENCE_PARAMS, wide);
    const cold = performance.now() - t;
    t = performance.now();
    const again = runModel(drained, REFERENCE_PARAMS, wide);
    const warm = performance.now() - t;
    expect(resultFingerprint(again)).toBe(resultFingerprint(first));
    // 600 buildings x 5 maps, about 850 cells each. Generous limits: a slow machine still passes.
    expect(cold).toBeLessThan(1500);
    expect(warm).toBeLessThan(500);
    const cell = nairobi.rasters[0];
    const time = (run: () => unknown) => {
      const from = performance.now();
      for (let i = 0; i < 20; i++) run();
      return (performance.now() - from) / 20;
    };
    console.log(
      `500 m buffer, ${cell.width} x ${cell.height} cells, ${drained.buildings.length} buildings x ${drained.scenarios.length} maps: first run ${cold.toFixed(1)} ms, repeat run ${warm.toFixed(1)} ms. ` +
        `Average of 20 runs: depth only ${time(() => runModel(drained, REFERENCE_PARAMS)).toFixed(1)} ms, all loss drivers ${time(() => runModel(drained, REFERENCE_PARAMS, wide)).toFixed(1)} ms`,
    );
  });

  it("reports how far the portfolio moves, at reference assumptions with drainage on", () => {
    const before = runModel(drained, REFERENCE_PARAMS);
    const after = runModel(drained, REFERENCE_PARAMS, ALL);
    const bn = (v: number) => (v / 1e9).toFixed(3);
    const wet = (k: number, test: (d: NonNullable<ModelResult["buildings"][number]["perScenario"][number]["drivers"]>) => boolean) => after.buildings.filter((b) => test(b.perScenario[k].drivers!)).length;
    console.log(
      `Nairobi, drainage on, reference assumptions (buffer ${J.bufferRadiusM} m, drains designed for 1-in-${J.drainDesignRp}, ${J.drainOverloadDepthM} m when overloaded):\n` +
        after.scenarios.map((s, k) => {
          const d = s.byDriver!;
          return (
            `  1-in-${String(s.returnPeriod).padEnd(3)} loss KES ${bn(before.scenarios[k].lossKes)}bn to ${bn(s.lossKes)}bn` +
            `  (at the point ${bn(d.pointKes)}, surroundings add ${bn(d.surroundingKes)}, ponding adds ${bn(d.pondingKes)}, drain overload adds ${bn(d.overloadKes)})` +
            `  buildings with water ${before.scenarios[k].affected} to ${s.affected}:` +
            ` at the point ${wet(k, (x) => x.pointM > 0)}, within the buffer ${wet(k, (x) => x.bufferM > 0)}, by ponding ${wet(k, (x) => x.pondingM > 0)},` +
            ` by drain overload ${wet(k, (x) => x.overloadM > 0)} (alone ${wet(k, (x) => x.overloadM > 0 && !(x.bufferM > 0) && !(x.pondingM > 0))})`
          );
        }).join("\n") +
        `\n  Average annual loss KES ${(before.aalKes / 1e6).toFixed(1)}m to ${(after.aalKes / 1e6).toFixed(1)}m of insured value KES ${(after.totalTivKes / 1e9).toFixed(1)}bn`,
    );
    for (const c of driverChecks(drained, after)) console.log(`  [${c.status}] ${c.title}: ${c.detail}`);

    // The same portfolio across the allowed range of the two assumptions that move it most.
    const at100 = (r: ModelResult) => r.standardLosses.find((x) => x.returnPeriod === 100)!.lossKes!;
    const line = (label: string, r: ModelResult) => `  ${label.padEnd(44)} 1-in-100 KES ${bn(at100(r))}bn  average annual loss KES ${(r.aalKes / 1e6).toFixed(1)}m`;
    const radii = [0, 50, 100, 250, 500].map((bufferRadiusM) => runModel(drained, REFERENCE_PARAMS, { mode: "all_drivers", judgement: judge({ bufferRadiusM }) }));
    const noOverload = runModel(drained, REFERENCE_PARAMS, { mode: "all_drivers", judgement: judge({ drainDesignRp: 100_000 }) });
    console.log(
      [
        line("Depth only", before),
        ...[0, 50, 100, 250, 500].map((m, i) => line(`All loss drivers, buffer ${m} m${m === 0 ? " (drain overload only)" : ""}`, radii[i])),
        line("All loss drivers, buffer 250 m, no drain overload", noOverload),
      ].join("\n"),
    );
    // A wider buffer can only find deeper water.
    radii.slice(1).forEach((r, i) => r.scenarios.forEach((x, k) => expect(x.lossKes).toBeGreaterThanOrEqual(radii[i].scenarios[k].lossKes)));
    expect(noOverload.scenarios.every((x) => x.byDriver!.overloadKes === 0)).toBe(true);
    expect(after.aalKes).toBeGreaterThan(before.aalKes);
    // Once the drains are overloaded every building inside the maps has water.
    expect(after.scenarios.filter((s) => s.returnPeriod > J.drainDesignRp).every((s) => s.affected === after.buildingCount)).toBe(true);
  });
});
