import { describe, expect, it } from "vitest";
import { averageAnnualLoss, lossAtReturnPeriod } from "../src/lib/model/financial";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import { HOUSING_CLASSES, type Dataset } from "../src/lib/model/types";
import { compareVersions, figureChange, keyFigures } from "../src/lib/modelData/compare";
import { hashesOf, type ModelDataVersion } from "../src/lib/modelData/version";
import { REFERENCE_JUDGEMENT } from "../src/lib/offer/judgement";

// Two hand-made versions: the second has one building worth half as much again and one more, dry, building.
const version = (id: string, label: string, hash: string): ModelDataVersion => ({
  id,
  date: id.slice(0, 10),
  label,
  description: "",
  area: { id: "toy", name: "Toy town", centre: [0, 0], zoom: 10, hazardKind: "score" },
  status: "approved",
  files: [{ name: "exposure.csv", role: "exposure", provenance: "synthetic", sha256: hash.repeat(64), bytes: 100, rows: 2 }],
  sources: [],
  notes: [],
});

const building = (locId: string, housingClass: Dataset["buildings"][number]["housingClass"], tivKes: number, hazard: number[]): Dataset["buildings"][number] => ({
  locId,
  lat: 0,
  lon: 0,
  housingClassRaw: housingClass,
  housingClass,
  floorAreaM2: null,
  costPerM2Kes: null,
  tivKes,
  synthetic: true,
  hazard,
});

const scenarios = [
  { id: "extreme", label: "extreme" },
  { id: "common", label: "common" },
];
const datasetA: Dataset = { name: "toy a", hazardKind: "score", scenarios, hotspots: [], rasters: [], buildings: [building("A", "informal_iron_sheet", 1000, [0, 0.25]), building("B", "concrete_rcc", 100000, [0.25, 0.5])] };
const datasetB: Dataset = { name: "toy b", hazardKind: "score", scenarios, hotspots: [], rasters: [], buildings: [building("A", "informal_iron_sheet", 1000, [0, 0.25]), building("B", "concrete_rcc", 150000, [0.25, 0.5]), building("C", "permanent_masonry", 50000, [0, 0])] };
const a = { version: version("2026-10-01_first", "First", "a"), dataset: datasetA };
const b = { version: version("2026-10-09_second", "Second", "b"), dataset: datasetB };

describe("keyFigures", () => {
  it("reads the dashboard's figures off a result, with the same per class", () => {
    const result = runModel(datasetA, REFERENCE_PARAMS);
    const figures = keyFigures(result);
    expect(figures.buildings).toBe(2);
    expect(figures.totalTivKes).toBe(101000);
    // The hand-checked losses of model.test.ts: 28,400 at 1-in-10 and 50,530 at 1-in-250.
    const points = [
      { returnPeriod: 10, lossKes: 28400 },
      { returnPeriod: 250, lossKes: 50530 },
    ];
    expect(figures.loss100Kes).toBeCloseTo(lossAtReturnPeriod(points, 100).lossKes!, 0);
    expect(figures.loss100Extrapolated).toBe(false);
    expect(figures.loss250Kes).toBeCloseTo(50530, 0);
    expect(figures.loss250Extrapolated).toBe(false);
    expect(figures.aalKes).toBeCloseTo(averageAnnualLoss(points), 0);
    expect(figures.byClass.map((c) => c.housingClass)).toEqual(HOUSING_CLASSES);
    const concrete = figures.byClass.find((c) => c.housingClass === "concrete_rcc")!;
    expect(concrete).toMatchObject({ label: "Concrete / RCC", count: 1, tivKes: 100000 });
    expect(concrete.loss250Kes).toBeCloseTo(50000, 0);
    const informal = figures.byClass.find((c) => c.housingClass === "informal_iron_sheet")!;
    expect(informal.loss250Kes).toBeCloseTo(530, 0);
    // The class curves add up to the portfolio's.
    expect(figures.byClass.reduce((sum, c) => sum + c.aalKes, 0)).toBeCloseTo(figures.aalKes, 6);
    expect(figures.byClass.reduce((sum, c) => sum + (c.loss100Kes ?? 0), 0)).toBeCloseTo(figures.loss100Kes!, 6);
    const empty = figures.byClass.find((c) => c.housingClass === "semi_permanent")!;
    expect(empty).toMatchObject({ count: 0, tivKes: 0, loss100Kes: 0, loss250Kes: 0, aalKes: 0 });
  });

  it("has no loss figure when the return period is more frequent than anything modelled", () => {
    const rare: Dataset = { ...datasetA, scenarios: [{ id: "common", label: "common" }], buildings: datasetA.buildings.map((x) => ({ ...x, hazard: [x.hazard[1]] })) };
    const figures = keyFigures(runModel(rare, REFERENCE_PARAMS));
    expect(figures.loss100Kes).toBeNull();
    expect(figures.loss250Kes).toBeCloseTo(50530, 0);
    expect(figures.byClass.every((c) => c.loss100Kes === null)).toBe(true);
  });
});

describe("figureChange", () => {
  it("gives the difference and its share of the first side", () => {
    expect(figureChange(100, 125)).toEqual({ a: 100, b: 125, change: 25, share: 0.25 });
    expect(figureChange(100, 100)).toEqual({ a: 100, b: 100, change: 0, share: 0 });
    expect(figureChange(0, 10)).toEqual({ a: 0, b: 10, change: 10, share: null });
    expect(figureChange(null, 10)).toEqual({ a: null, b: 10, change: null, share: null });
    expect(figureChange(10, null)).toEqual({ a: 10, b: null, change: null, share: null });
  });
});

describe("compareVersions", () => {
  it("runs both versions on the same parameters and gives the change in every key figure", () => {
    const c = compareVersions(a, b, REFERENCE_PARAMS);
    expect(c.settings).toEqual({ params: REFERENCE_PARAMS, mode: "depth_only", judgement: null });
    expect(c.same).toBe(false);
    expect(c.a.version).toEqual({ id: "2026-10-01_first", label: "First", date: "2026-10-01", status: "approved", area: "Toy town", hashes: hashesOf(a.version), datasetName: "toy a", hazardKind: "score" });
    expect(c.b.version.id).toBe("2026-10-09_second");
    expect(c.a.figures).toEqual(keyFigures(runModel(datasetA, REFERENCE_PARAMS)));
    expect(c.b.figures).toEqual(keyFigures(runModel(datasetB, REFERENCE_PARAMS)));
    expect(c.a.curve.map((p) => p.returnPeriod)).toEqual([10, 250]);

    expect(c.rows.map((r) => r.id)).toEqual(["tiv", "buildings", "loss100", "loss250", "aal"]);
    const byId = Object.fromEntries(c.rows.map((r) => [r.id, r]));
    expect(byId.tiv).toMatchObject({ label: "Total insured value", unit: "kes", a: 101000, b: 201000, change: 100000 });
    expect(byId.tiv.share).toBeCloseTo(100000 / 101000, 9);
    expect(byId.buildings).toMatchObject({ label: "Buildings", unit: "count", a: 2, b: 3, change: 1, share: 0.5 });
    // B's loss grows by half at every return period; A's and C's stay as they are.
    expect(byId.loss250.a).toBeCloseTo(50530, 0);
    expect(byId.loss250.b).toBeCloseTo(75530, 0);
    expect(byId.loss250.change).toBeCloseTo(25000, 0);
    expect(byId.loss250.extrapolated).toBe(false);
    expect(byId.loss100.change).toBeCloseTo(byId.loss100.b! - byId.loss100.a!, 6);
    expect(byId.loss100.extrapolated).toBe(false);
    expect(byId.aal.change).toBeCloseTo(c.b.figures.aalKes - c.a.figures.aalKes, 6);
    expect(byId.aal.share).toBeGreaterThan(0);
  });

  it("gives the same rows for every housing class", () => {
    const c = compareVersions(a, b, REFERENCE_PARAMS);
    expect(c.byClass.map((x) => x.housingClass)).toEqual(HOUSING_CLASSES);
    const concrete = c.byClass.find((x) => x.housingClass === "concrete_rcc")!;
    expect(concrete.label).toBe("Concrete / RCC");
    expect(concrete.rows.map((r) => r.id)).toEqual(["tiv", "buildings", "loss100", "loss250", "aal"]);
    expect(concrete.rows[0]).toMatchObject({ a: 100000, b: 150000, change: 50000, share: 0.5 });
    expect(concrete.rows[1]).toMatchObject({ a: 1, b: 1, change: 0, share: 0 });
    expect(concrete.rows[3].change).toBeCloseTo(25000, 0);
    const masonry = c.byClass.find((x) => x.housingClass === "permanent_masonry")!;
    expect(masonry.rows[0]).toMatchObject({ a: 0, b: 50000, change: 50000, share: null });
    expect(masonry.rows[1]).toMatchObject({ a: 0, b: 1, change: 1, share: null });
    expect(masonry.rows[4]).toMatchObject({ a: 0, b: 0, change: 0, share: null });
    const informal = c.byClass.find((x) => x.housingClass === "informal_iron_sheet")!;
    for (const r of informal.rows) expect(r.change).toBe(0);
  });

  it("is all zeros against itself, and says the sides are the same", () => {
    const c = compareVersions(a, a, REFERENCE_PARAMS);
    expect(c.same).toBe(true);
    for (const r of c.rows) expect(r.change).toBe(0);
    for (const cls of c.byClass) for (const r of cls.rows) expect(r.change).toBe(0);
    // The same folder with a changed file is another version, even under the same id.
    const changed = { ...a, version: { ...a.version, files: [{ ...a.version.files[0], sha256: "f".repeat(64) }] } };
    expect(compareVersions(a, changed, REFERENCE_PARAMS).same).toBe(false);
  });

  it("runs both sides on the basis given: all loss drivers with the figures beyond depth", () => {
    const judgement = { ...REFERENCE_JUDGEMENT, drainDesignRp: 5 };
    const c = compareVersions(a, b, REFERENCE_PARAMS, { mode: "all_drivers", judgement });
    expect(c.settings).toEqual({ params: REFERENCE_PARAMS, mode: "all_drivers", judgement });
    expect(c.a.figures).toEqual(keyFigures(runModel(datasetA, REFERENCE_PARAMS, { mode: "all_drivers", judgement })));
    // Drains designed for 1-in-5 put 0.1 m at every dry building in the 1-in-10: the loss at that flood rises on both sides.
    const depthOnly = compareVersions(a, b, REFERENCE_PARAMS);
    expect(c.a.curve[0].lossKes).toBeGreaterThan(depthOnly.a.curve[0].lossKes);
    expect(c.b.curve[0].lossKes).toBeGreaterThan(depthOnly.b.curve[0].lossKes);
  });

  it("leaves the datasets and the parameters as they were", () => {
    const beforeA = JSON.stringify(datasetA);
    const beforeParams = JSON.stringify(REFERENCE_PARAMS);
    compareVersions(a, b, REFERENCE_PARAMS, { mode: "all_drivers" });
    expect(JSON.stringify(datasetA)).toBe(beforeA);
    expect(JSON.stringify(REFERENCE_PARAMS)).toBe(beforeParams);
  });
});
