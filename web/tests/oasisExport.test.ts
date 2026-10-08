import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import type { LossMode } from "../src/lib/model/drivers";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { resultFingerprint, runModel } from "../src/lib/model/pipeline";
import type { Dataset, ModelResult } from "../src/lib/model/types";
import { REFERENCE_JUDGEMENT } from "../src/lib/offer/judgement";
import {
  buildingExport,
  buildingExportCsv,
  buildingExportViewJson,
  EXPORT_COLUMNS,
  EXPORT_VIEW_PREFIX,
  OASIS_COVERED_LINE,
  OASIS_NOT_CHECKED,
  OASIS_RUNS,
  oasisChecked,
  oasisRunFor,
  oasisSettings,
  type ExportView,
  type FloodSource,
  type OasisRunFile,
} from "../src/lib/oasisExport";

// Nothing here prints a row of the starter kit: only counts, totals and fingerprints are compared.

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

const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;

/** A portfolio small enough to check by hand: no maps, so with all loss drivers only drain overload adds water. */
const toy: Dataset = {
  name: "toy",
  hazardKind: "score",
  scenarios: [
    { id: "extreme", label: "extreme" },
    { id: "common", label: "common" },
  ],
  hotspots: [],
  rasters: [],
  buildings: [
    { locId: "A", lat: 0, lon: 0, housingClassRaw: "informal_iron_sheet", housingClass: "informal_iron_sheet", floorAreaM2: null, costPerM2Kes: null, tivKes: 1000, synthetic: true, hazard: [0, 0.25] },
    { locId: 'B, "the second"', lat: 0, lon: 0, housingClassRaw: "concrete_rcc", housingClass: "concrete_rcc", floorAreaM2: null, costPerM2Kes: null, tivKes: 100000, synthetic: true, hazard: [0.25, 1] },
    { locId: "C", lat: 0, lon: 0, housingClassRaw: "permanent_masonry", housingClass: "permanent_masonry", floorAreaM2: null, costPerM2Kes: null, tivKes: 0, synthetic: true, hazard: [1, 1] },
  ],
};

describe("building-level export on a small portfolio", () => {
  const depthOnly = runModel(toy, REFERENCE_PARAMS);
  const allDrivers = runModel(toy, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT });

  it("gives one row per building and return period, most frequent first, with the depth the mode reads", () => {
    const { rows } = buildingExport(toy, depthOnly);
    expect(rows.map((r) => [r.building, r.scenario, r.returnPeriod])).toEqual([
      [1, "extreme", 10],
      [1, "common", 250],
      [2, "extreme", 10],
      [2, "common", 250],
      [3, "extreme", 10],
      [3, "common", 250],
    ]);
    // A dry: no depth, no damage. B at score 0.25 in the widest tier: 0.25 x 4 m = 1 m.
    expect(rows[0]).toMatchObject({ locId: "A", housingClass: "informal_iron_sheet", tivKes: 1000, depthM: 0, damageRatio: 0 });
    expect(rows[3].depthM).toBeCloseTo(4);
    rows.forEach((r, i) => expect(r.depthM).toBe(depthOnly.buildings[Math.floor(i / 2)].perScenario[i % 2].depthM));
  });

  it("the damage ratio is the loss over the insured value, and never above 1", () => {
    for (const result of [depthOnly, allDrivers]) {
      const { rows } = buildingExport(toy, result);
      rows.forEach((r, i) => {
        const p = result.buildings[Math.floor(i / 2)].perScenario[i % 2];
        if (r.tivKes > 0) expect(r.damageRatio).toBe(p.lossKes / r.tivKes);
        // A building with no insured value keeps the ratio the damage curve gave it.
        else expect(r.damageRatio).toBe(p.damageRatio);
        expect(r.damageRatio).toBeGreaterThanOrEqual(0);
        expect(r.damageRatio).toBeLessThanOrEqual(1);
      });
      // Ratio times insured value, added up, is each event's loss: what the Oasis run is fed.
      result.scenarios.forEach((s, k) => expect(rows.filter((r) => r.scenario === s.id).reduce((t, r) => t + r.damageRatio * r.tivKes, 0)).toBeCloseTo(result.scenarios[k].lossKes, 6));
    }
  });

  it("with all loss drivers the ratio is the final one: drain overload wets the dry building once the event is rarer than the drains' design", () => {
    const depth = buildingExport(toy, depthOnly).rows;
    const all = buildingExport(toy, allDrivers).rows;
    // Building A in the 1-in-250 flood sits at 0.25 x 4 m either way; in the 1-in-10 it stays dry (10 is not rarer than 25).
    expect(all[0].depthM).toBe(0);
    expect(all[0].damageRatio).toBe(0);
    all.forEach((r, i) => expect(r.damageRatio).toBeGreaterThanOrEqual(depth[i].damageRatio));
    expect(all.every((r, i) => r.depthM >= depth[i].depthM)).toBe(true);
  });

  it("the header names the view: flood source, losses from, the assumptions in force and the fingerprint", () => {
    const depth = buildingExport(toy, depthOnly).view;
    expect(depth).toMatchObject({ dataset: "toy", floodSource: "terrain", floodSourceLabel: "Terrain only", drainage: null, lossesFrom: "depth_only", lossesFromLabel: "Depth only", buildings: 3 });
    expect(depth.assumptions).toEqual({ set: "reference", params: REFERENCE_PARAMS, beyondDepth: null });
    expect(depth.fingerprint).toBe(resultFingerprint(depthOnly));
    expect(depth.scenarios.map((s) => s.lossKes)).toEqual(depthOnly.scenarios.map((s) => s.lossKes));

    const all = buildingExport(toy, allDrivers).view;
    expect(all.lossesFromLabel).toBe("All loss drivers");
    // Only the figures that reach the portfolio's buildings: the buffer and the two drain figures.
    expect(all.assumptions.beyondDepth).toEqual({ bufferRadiusM: REFERENCE_JUDGEMENT.bufferRadiusM, drainDesignRp: REFERENCE_JUDGEMENT.drainDesignRp, drainOverloadDepthM: REFERENCE_JUDGEMENT.drainOverloadDepthM });
    expect(all.fingerprint).toBe(resultFingerprint(allDrivers));
  });

  it("marks the assumptions as agreed when the agents set them, a parameter moved or a figure that reaches the portfolio was typed", () => {
    expect(buildingExport(toy, depthOnly, "ai").view.assumptions.set).toBe("agreed");
    const moved = runModel(toy, { ...REFERENCE_PARAMS, depthScaleM: 3 });
    expect(buildingExport(toy, moved).view.assumptions.set).toBe("agreed");
    expect(buildingExport(toy, moved).view.assumptions.params.depthScaleM).toBe(3);
    const typed = runModel(toy, REFERENCE_PARAMS, { mode: "all_drivers", judgement: { ...REFERENCE_JUDGEMENT, drainDesignRp: 5 } });
    expect(buildingExport(toy, typed).view.assumptions).toMatchObject({ set: "agreed", beyondDepth: { drainDesignRp: 5 } });
    // A figure the portfolio never reads (the minimum rate) does not change what was run.
    const other = runModel(toy, REFERENCE_PARAMS, { mode: "all_drivers", judgement: { ...REFERENCE_JUDGEMENT, minimumRatePerMille: 1 } });
    expect(buildingExport(toy, other).view.assumptions.set).toBe("reference");
    // With Depth only no figure beyond flood depth is read at all.
    expect(oasisSettings(toy, runModel(toy, REFERENCE_PARAMS, { mode: "depth_only", judgement: { ...REFERENCE_JUDGEMENT, drainDesignRp: 5 } })).referenceAssumptions).toBe(true);
  });

  it("refuses a result that was not run on the data set", () => {
    expect(() => buildingExport({ ...toy, buildings: toy.buildings.slice(0, 2) }, depthOnly)).toThrow();
  });

  it("writes a CSV that carries its own view, quotes what needs it and keeps every figure in full", () => {
    const exported = buildingExport(toy, allDrivers);
    const lines = buildingExportCsv(exported).trimEnd().split("\n");
    expect(lines[0].startsWith("# ")).toBe(true);
    expect(lines[1].startsWith(EXPORT_VIEW_PREFIX)).toBe(true);
    expect(JSON.parse(lines[1].slice(EXPORT_VIEW_PREFIX.length))).toEqual(exported.view);
    expect(lines[2]).toBe(EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(3 + exported.rows.length);
    expect(lines[5]).toBe(`2,"B, ""the second""",concrete_rcc,100000,extreme,10,${exported.rows[2].depthM},${exported.rows[2].damageRatio}`);
    // The last two columns read back as exactly the figures the app used.
    lines.slice(3).forEach((line, i) => {
      const cells = line.split(",");
      expect(Number(cells[cells.length - 2])).toBe(exported.rows[i].depthM);
      expect(Number(cells[cells.length - 1])).toBe(exported.rows[i].damageRatio);
    });
    expect(JSON.parse(buildingExportViewJson(exported))).toEqual(exported.view);
  });
});

describe("which Oasis run covers which settings", () => {
  const settings = (floodSource: FloodSource, lossesFrom: LossMode, referenceAssumptions = true) => ({ floodSource, lossesFrom, referenceAssumptions });

  it("picks the file made for exactly the combination in force", () => {
    expect(oasisRunFor(settings("terrain", "depth_only"))).toMatchObject({ file: "reference.json", mode: "depths" });
    expect(oasisRunFor(settings("terrain_drainage", "depth_only"))).toMatchObject({ file: "reference-drainage.json", mode: "depths" });
    expect(oasisRunFor(settings("terrain_drainage", "all_drivers"))).toMatchObject({ file: "reference-drivers.json", mode: "damage_ratios" });
  });

  it("has no file for any other combination", () => {
    // Terrain only with all loss drivers: no run was made for it.
    expect(oasisRunFor(settings("terrain", "all_drivers"))).toBeNull();
    // Agreed or typed assumptions, whatever the switches say.
    for (const floodSource of ["terrain", "terrain_drainage"] as const) for (const lossesFrom of ["depth_only", "all_drivers"] as const) expect(oasisRunFor(settings(floodSource, lossesFrom, false))).toBeNull();
    expect(OASIS_RUNS).toHaveLength(3);
    expect(new Set(OASIS_RUNS.map((r) => r.file)).size).toBe(3);
  });

  it("reads the settings from the data set, the result and where the assumptions came from", () => {
    const depthOnly = runModel(toy, REFERENCE_PARAMS);
    const allDrivers = runModel(toy, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT });
    const drained: Dataset = { ...toy, drainage: { reachM: 300, depthM: [0.15, 0.6], buildingStress: [0, 0, 0], grid: { width: 1, height: 1, bbox: [0, 0, 1, 1], stress: new Float32Array(1) } } };
    expect(oasisSettings(toy, depthOnly, "reference")).toEqual(settings("terrain", "depth_only"));
    expect(oasisSettings(drained, depthOnly, "reference")).toEqual(settings("terrain_drainage", "depth_only"));
    expect(oasisSettings(drained, allDrivers, "reference")).toEqual(settings("terrain_drainage", "all_drivers"));
    expect(oasisSettings(drained, allDrivers, "ai")).toEqual(settings("terrain_drainage", "all_drivers", false));
    expect(oasisRunFor(oasisSettings(toy, allDrivers, "reference"))).toBeNull();
    expect(buildingExport(drained, depthOnly).view.drainage).toEqual({ reachM: 300, pondingDepthM: { extreme: 0.15, common: 0.6 } });
  });

  it("counts a file as a check only when it was made for this very result", () => {
    const result = runModel(toy, REFERENCE_PARAMS);
    const run = oasisRunFor(oasisSettings(toy, result, "reference"))!;
    const view: ExportView = buildingExport(toy, result, "reference").view;
    const file = { dataset: "toy", mode: "depths", view } as OasisRunFile;
    expect(oasisChecked(run, file, toy, result)).toBe(true);
    // Never a stale match: another result, another data set, another view, a file fed differently, or one that names no view.
    expect(oasisChecked(run, file, toy, runModel(toy, { ...REFERENCE_PARAMS, depthScaleM: 3 }))).toBe(false);
    expect(oasisChecked(run, { ...file, view: { ...view, fingerprint: "00000000" } }, toy, result)).toBe(false);
    expect(oasisChecked(run, { ...file, dataset: "another" }, toy, result)).toBe(false);
    expect(oasisChecked(run, { ...file, view: { ...view, floodSource: "terrain_drainage" } }, toy, result)).toBe(false);
    expect(oasisChecked(run, { ...file, view: { ...view, lossesFrom: "all_drivers" } }, toy, result)).toBe(false);
    expect(oasisChecked(run, { ...file, view: { ...view, assumptions: { ...view.assumptions, set: "agreed" } } }, toy, result)).toBe(false);
    expect(oasisChecked(run, { ...file, mode: "damage_ratios" }, toy, result)).toBe(false);
    expect(oasisChecked(run, { ...file, mode: undefined }, toy, result)).toBe(false);
    expect(oasisChecked(run, { ...file, view: null }, toy, result)).toBe(false);
    expect(oasisChecked(run, null, toy, result)).toBe(false);
  });

  it("says so in the exact words, with the settings that are covered", () => {
    expect(OASIS_NOT_CHECKED).toBe("Not checked by Oasis for these settings");
    expect(OASIS_COVERED_LINE).toContain("Terrain only, Depth only; Terrain + drainage, Depth only; Terrain + drainage, All loss drivers");
  });
});

describe.skipIf(!existsSync(KIT))("building-level export on the Nairobi starter kit", () => {
  let dataset: Dataset;
  let drained: Dataset;
  const results = {} as Record<"terrain" | "drainage" | "drivers", ModelResult>;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const widest = dataset.rasters.find((r) => r.scenarioId === "common")!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, geo<WaterwayProps>("waterways.geojson"), geo<SettlementProps>("informal-settlements.geojson"));
    drained = withDrainage(dataset, { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) });
    results.terrain = runModel(dataset, REFERENCE_PARAMS);
    results.drainage = runModel(drained, REFERENCE_PARAMS);
    results.drivers = runModel(drained, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT });
  }, 120_000);

  it("Depth only: 3,000 rows and a header for each flood source, with the fingerprints the figures have always had", () => {
    const terrain = buildingExport(dataset, results.terrain, "reference");
    const drainage = buildingExport(drained, results.drainage, "reference");
    for (const exported of [terrain, drainage]) {
      expect(exported.rows).toHaveLength(600 * 5);
      expect(exported.view).toMatchObject({ dataset: "team_a_nairobi", hazardKind: "score", lossesFrom: "depth_only", lossesFromLabel: "Depth only", buildings: 600, totalInsuredValueKes: 63_635_075_000 });
      expect(exported.view.assumptions).toEqual({ set: "reference", params: REFERENCE_PARAMS, beyondDepth: null });
      expect(exported.view.scenarios.map((s) => [s.id, s.returnPeriod])).toEqual([["extreme", 10], ["severe", 25], ["moderate", 50], ["occasional", 100], ["common", 250]]);
    }
    expect(terrain.view).toMatchObject({ floodSource: "terrain", floodSourceLabel: "Terrain only", drainage: null, fingerprint: "bdc87191" });
    expect(drainage.view).toMatchObject({ floodSource: "terrain_drainage", floodSourceLabel: "Terrain + drainage", fingerprint: "b6cc5322" });
    expect(drainage.view.drainage).toEqual({ reachM: 300, pondingDepthM: { extreme: 0.15, severe: 0.25, moderate: 0.35, occasional: 0.45, common: 0.6 } });
    // Drainage only ever adds water.
    drainage.rows.forEach((r, i) => expect(r.depthM).toBeGreaterThanOrEqual(terrain.rows[i].depthM));
    expect(oasisRunFor(oasisSettings(dataset, results.terrain, "reference"))?.file).toBe("reference.json");
    expect(oasisRunFor(oasisSettings(drained, results.drainage, "reference"))?.file).toBe("reference-drainage.json");
  });

  it("All loss drivers: the same rows with the final damage ratio, and the three figures that reach the portfolio in the header", () => {
    const depth = buildingExport(drained, results.drainage, "reference");
    const all = buildingExport(drained, results.drivers, "reference");
    expect(all.rows).toHaveLength(600 * 5);
    expect(all.view).toMatchObject({ floodSource: "terrain_drainage", lossesFrom: "all_drivers", lossesFromLabel: "All loss drivers", fingerprint: resultFingerprint(results.drivers) });
    expect(all.view.assumptions).toEqual({ set: "reference", params: REFERENCE_PARAMS, beyondDepth: { bufferRadiusM: 250, drainDesignRp: 25, drainOverloadDepthM: 0.1 } });
    all.rows.forEach((r, i) => {
      expect(r.locId).toBe(depth.rows[i].locId);
      expect(r.scenario).toBe(depth.rows[i].scenario);
      expect(r.depthM).toBeGreaterThanOrEqual(depth.rows[i].depthM);
      expect(r.damageRatio).toBeGreaterThanOrEqual(depth.rows[i].damageRatio);
    });
    expect(oasisRunFor(oasisSettings(drained, results.drivers, "reference"))?.file).toBe("reference-drivers.json");
    expect(oasisRunFor(oasisSettings(dataset, runModel(dataset, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT }), "reference"))).toBeNull();
  });

  it("in both modes the damage ratio is the loss over the insured value, never above 1, and adds back up to each event's loss", () => {
    for (const [data, result] of [[dataset, results.terrain], [drained, results.drainage], [drained, results.drivers]] as const) {
      const { rows } = buildingExport(data, result, "reference");
      let worst = 0;
      rows.forEach((r, i) => {
        const b = Math.floor(i / 5);
        const p = result.buildings[b].perScenario[i % 5];
        worst = Math.max(worst, Math.abs(r.damageRatio - p.lossKes / data.buildings[b].tivKes), r.damageRatio - 1, -r.damageRatio, Math.abs(r.depthM - p.depthM));
      });
      expect(worst).toBe(0);
      result.scenarios.forEach((s) => {
        const sum = rows.filter((r) => r.scenario === s.id).reduce((t, r) => t + r.damageRatio * r.tivKes, 0);
        expect(Math.abs(sum - s.lossKes)).toBeLessThanOrEqual(1e-9 * s.lossKes);
      });
    }
  });

  // The files shipped with the app must be for these very results, or the screen would say "Not checked".
  it("the three Oasis files in public/oasis were made for these results", () => {
    const shipped = [
      { data: dataset, result: results.terrain },
      { data: drained, result: results.drainage },
      { data: drained, result: results.drivers },
    ];
    for (const { data, result } of shipped) {
      const run = oasisRunFor(oasisSettings(data, result, "reference"))!;
      const path = join(__dirname, "..", "public", "oasis", run.file);
      expect(existsSync(path), `${run.file} is missing: see oasis/README.md`).toBe(true);
      const file = JSON.parse(readFileSync(path, "utf8")) as OasisRunFile;
      expect(oasisChecked(run, file, data, result), `${run.file} was not made for the result the app gives now`).toBe(true);
      // Oasis within half a percent of the app at every event, and on the step average annual loss.
      for (const e of file.events) {
        const live = result.scenarios.find((s) => s.id === e.tier)!.lossKes;
        expect(Math.abs(e.oasisLossKes / live - 1)).toBeLessThan(0.005);
        expect(Math.abs(e.ourLossKes / live - 1)).toBeLessThan(1e-6);
      }
      expect(Math.abs(file.aal.oasisKes / file.aal.ourDiscreteKes - 1)).toBeLessThan(0.005);
    }
  });
});
