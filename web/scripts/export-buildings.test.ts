import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import type { Dataset, ModelResult } from "../src/lib/model/types";
import { REFERENCE_JUDGEMENT } from "../src/lib/offer/judgement";
import { buildingExport, buildingExportCsv, buildingExportViewJson } from "../src/lib/oasisExport";

/**
 * Writes the building-level exports the three Oasis runs read (oasis/README.md), with the app's
 * own library on the Nairobi starter kit, the way the screen works them out:
 *
 *   terrain_depth-only        Terrain only, Depth only          read with --depths
 *   drainage_depth-only       Terrain + drainage, Depth only    read with --depths
 *   drainage_all-drivers      Terrain + drainage, All loss drivers, reference assumptions
 *                                                               read with --damage-ratios
 *
 * It runs only when OASIS_EXPORT_DIR names the folder to write to; scripts/export-buildings.mjs
 * sets it. The files hold one row per building, so the folder must stay out of git: the default,
 * oasis/runs/exports, is ignored.
 */

const OUT = process.env.OASIS_EXPORT_DIR;
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

describe.skipIf(!OUT || !existsSync(KIT))("building-level exports for the Oasis runs", () => {
  it("writes one export for each of the three settings", async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    const dataset: Dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
    const widest = dataset.rasters.find((r) => r.scenarioId === "common")!;
    const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, geo<WaterwayProps>("waterways.geojson"), geo<SettlementProps>("informal-settlements.geojson"));
    const drained = withDrainage(dataset, { distances, sensitivity: drainageSensitivity(distances, widest, dataset.hotspots) });

    const runs: { name: string; data: Dataset; result: ModelResult }[] = [
      { name: "terrain_depth-only", data: dataset, result: runModel(dataset, REFERENCE_PARAMS) },
      { name: "drainage_depth-only", data: drained, result: runModel(drained, REFERENCE_PARAMS) },
      { name: "drainage_all-drivers", data: drained, result: runModel(drained, REFERENCE_PARAMS, { mode: "all_drivers", judgement: REFERENCE_JUDGEMENT }) },
    ];

    const folder = OUT!;
    mkdirSync(folder, { recursive: true });
    for (const run of runs) {
      const exported = buildingExport(run.data, run.result, "reference");
      expect(exported.view.assumptions.set).toBe("reference");
      expect(exported.rows).toHaveLength(run.result.buildingCount * run.result.scenarios.length);
      const base = join(folder, `${dataset.name}_${run.name}`);
      writeFileSync(`${base}.csv`, buildingExportCsv(exported));
      writeFileSync(`${base}.view.json`, buildingExportViewJson(exported));
    }
  }, 120_000);
});
