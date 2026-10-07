import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { detectDatasets, loadDataset } from "../src/lib/ingest";
import { filesFromZip } from "../src/lib/ingest/zip";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";

const SAMPLE = join(__dirname, "..", "public", "sample-data.zip");

describe.skipIf(!existsSync(SAMPLE))("zip upload", () => {
  it("reads the sample zip end to end, the way the browser does", async () => {
    const files = await filesFromZip(readFileSync(SAMPLE));
    const { candidates, files: infos } = await detectDatasets(files, "sample-data");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("team_a_nairobi");
    expect(infos.every((f) => !f.path.includes("\\"))).toBe(true);

    const { dataset, report } = await loadDataset(candidates[0], infos);
    expect(report.rowsParsed).toBe(600);
    expect(dataset.rasters).toHaveLength(5);
    expect(report.attached?.matched).toBe(3000);
    expect(runModel(dataset, REFERENCE_PARAMS).scenarios.map((s) => s.affected)).toEqual([32, 51, 110, 174, 259]);
  }, 120_000);

  it("accepts a zip whose entries use Windows backslashes and sit at the top level", async () => {
    const zip = new JSZip();
    zip.file("exposure.csv", "loc_id,lat,lon,housing_class,tiv_kes,hazard_score_extreme,hazard_score_common\nX-1,-1.25,36.85,concrete_rcc,1000000,0.1,0.4\n");
    zip.file("notes\\readme.md", "hello");
    const files = await filesFromZip(await zip.generateAsync({ type: "uint8array" }));
    const { candidates, files: infos } = await detectDatasets(files, "loose");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("loose");

    // No rasters in this upload, so the hazard columns in the file are used.
    const { dataset, report } = await loadDataset(candidates[0], infos);
    expect(report.hazardSource).toBe("columns");
    expect(dataset.scenarios.map((s) => s.id)).toEqual(["extreme", "common"]);
    expect(dataset.buildings[0].hazard).toEqual([0.1, 0.4]);
  });
});
