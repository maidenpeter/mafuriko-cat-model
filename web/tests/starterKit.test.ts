import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dataChecks, financialChecks, hazardChecks, vulnerabilityChecks } from "../src/lib/checks";
import { drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage } from "../src/lib/geo/drainageView";
import type { GeoCollection, SettlementProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource, type IngestReport } from "../src/lib/ingest";
import { tierSlopes } from "../src/lib/model/hazard";
import { hotspotHits } from "../src/lib/model/hotspots";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { resultFingerprint, runModel } from "../src/lib/model/pipeline";
import type { Dataset, ModelResult } from "../src/lib/model/types";

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

describe.skipIf(!existsSync(KIT))("starter kit", () => {
  const loaded: Record<string, { dataset: Dataset; report: IngestReport; result: ModelResult }> = {};

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    for (const c of candidates) {
      const { dataset, report } = await loadDataset(c, files);
      loaded[c.name] = { dataset, report, result: runModel(dataset, REFERENCE_PARAMS) };
    }
  }, 120_000);

  it("finds both datasets in the folder", () => {
    expect(Object.keys(loaded).sort()).toEqual(["team_a_nairobi", "team_b_nzoia"]);
  });

  describe("Team A, Nairobi", () => {
    it("reads every building and every hazard map", () => {
      const { dataset, report } = loaded.team_a_nairobi;
      expect(dataset.hazardKind).toBe("score");
      expect(dataset.scenarios.map((s) => s.id)).toEqual(["extreme", "severe", "moderate", "occasional", "common"]);
      expect(report.rowsInFile).toBe(600);
      expect(report.rowsParsed).toBe(600);
      expect(report.hazardSource).toBe("rasters");
      expect(dataset.rasters).toHaveLength(5);
    });

    it("reproduces the hazard columns shipped in the file from the rasters", () => {
      const { report } = loaded.team_a_nairobi;
      expect(report.attached?.compared).toBe(3000);
      expect(report.attached?.matched).toBe(3000);
    });

    it("matches the documented counts of affected buildings", () => {
      const { result } = loaded.team_a_nairobi;
      expect(result.scenarios.map((s) => s.affected)).toEqual([32, 51, 110, 174, 259]);
    });

    it("is the depth-only model, with the same fingerprint as before the loss drivers were added", () => {
      const { result } = loaded.team_a_nairobi;
      expect(result.mode).toBe("depth_only");
      expect(resultFingerprint(result)).toBe("bdc87191");
    });

    it("puts every tier back on one scale, so depth grows with rarity", () => {
      const { dataset, result } = loaded.team_a_nairobi;
      // Fitted from the five maps. The narrowest tier peaks at about 63% of the widest tier's depth.
      const slopes = tierSlopes(dataset);
      [0.626, 0.72, 0.827, 0.914, 1].forEach((v, k) => expect(slopes[k]).toBeCloseTo(v, 2));
      expect(result.scenarios.map((s) => s.tierSlope)).toEqual(slopes);
      for (const b of result.buildings) {
        const depths = b.perScenario.map((p) => p.depthM);
        depths.slice(1).forEach((d, i) => expect(d).toBeGreaterThanOrEqual(depths[i]));
      }
    });

    it("flags 12 of the 24 named flood areas, as the starter kit says", () => {
      const hits = hotspotHits(loaded.team_a_nairobi.dataset);
      expect(hits).toHaveLength(24);
      expect(hits.filter((h) => h.hit)).toHaveLength(12);
    });

    it("adds drainage-driven flooding from open map data: 16 of 24 named areas at a 300 m reach", () => {
      const { dataset, report } = loaded.team_a_nairobi;
      const geo = <P,>(f: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", f), "utf8")) as GeoCollection<P>;
      const widest = dataset.rasters.find((r) => r.scenarioId === "common")!;
      const distances = drainageDistances({ width: widest.width, height: widest.height, bbox: widest.bbox }, geo<WaterwayProps>("waterways.geojson"), geo<SettlementProps>("informal-settlements.geojson"));
      const sensitivity = drainageSensitivity(distances, widest, dataset.hotspots);
      expect(sensitivity.baseHits).toBe(12);
      const used = sensitivity.rows.find((x) => x.reachM === 300)!;
      expect(used.hits).toBe(16);
      expect([...used.newlyFlagged].sort()).toEqual(["Kangemi", "Kibera", "Lang'ata", "Parklands"]);
      expect(used.wetShare - sensitivity.baseWetShare).toBeLessThan(0.01);

      const drained = withDrainage(dataset, { distances, sensitivity });
      expect(hotspotHits(drained).filter((h) => h.hit)).toHaveLength(16);
      const result = runModel(drained, REFERENCE_PARAMS);
      expect(resultFingerprint(result)).toBe("b6cc5322");
      const losses = result.scenarios.map((x) => x.lossKes);
      expect([...losses].sort((a, b) => a - b)).toEqual(losses);
      const terrain = runModel(dataset, REFERENCE_PARAMS);
      result.scenarios.forEach((x, k) => expect(x.lossKes).toBeGreaterThanOrEqual(terrain.scenarios[k].lossKes));
      const checks = [...hazardChecks(drained, report), ...financialChecks(drained, result)];
      expect(checks.filter((c) => c.status === "fail")).toEqual([]);
      console.log(
        "Nairobi with drainage, reference assumptions:\n" +
          result.scenarios.map((x, k) => `  ${String(x.returnPeriod).padStart(4)}y affected ${terrain.scenarios[k].affected} to ${x.affected}  loss KES ${(terrain.scenarios[k].lossKes / 1e9).toFixed(3)}bn to ${(x.lossKes / 1e9).toFixed(3)}bn`).join("\n") +
          `\n  AAL KES ${(terrain.aalKes / 1e6).toFixed(1)}m to ${(result.aalKes / 1e6).toFixed(1)}m`,
      );
    });

    it("detects that insured values are ten times the documented formula", () => {
      const { report, result } = loaded.team_a_nairobi;
      expect(report.tivRatio?.median).toBeCloseTo(10, 1);
      expect(result.totalTivKes).toBe(63_635_075_000);
    });

    it("produces a loss curve that rises with rarity, with no failed checks", () => {
      const { dataset, report, result } = loaded.team_a_nairobi;
      const losses = result.scenarios.map((s) => s.lossKes);
      expect([...losses].sort((a, b) => a - b)).toEqual(losses);
      expect(losses[0]).toBeGreaterThan(0);
      const checks = [...dataChecks(dataset, report), ...hazardChecks(dataset, report), ...vulnerabilityChecks(result.params), ...financialChecks(dataset, result)];
      expect(checks.filter((c) => c.status === "fail")).toEqual([]);
      console.log(
        "Nairobi, reference assumptions:\n" +
          result.scenarios.map((s) => `  ${String(s.returnPeriod).padStart(4)}y  ${s.id.padEnd(10)} affected ${String(s.affected).padStart(3)}  loss KES ${(s.lossKes / 1e9).toFixed(3)}bn`).join("\n") +
          `\n  AAL KES ${(result.aalKes / 1e6).toFixed(1)}m of TIV KES ${(result.totalTivKes / 1e9).toFixed(1)}bn`,
      );
      console.log(checks.map((c) => `  [${c.status}] ${c.title}: ${c.detail}`).join("\n"));
    });
  });

  describe("Team B, Nzoia (depth maps with their own return periods)", () => {
    it("runs through the same engine", () => {
      const { dataset, report, result } = loaded.team_b_nzoia;
      expect(dataset.hazardKind).toBe("depth_m");
      expect(report.rowsParsed).toBe(500);
      expect(result.scenarios.map((s) => s.returnPeriod)).toEqual([10, 20, 50, 100, 200, 500]);
      expect(resultFingerprint(result)).toBe("09e0a862");
      for (const s of result.scenarios) {
        expect(s.affected).toBeGreaterThanOrEqual(46);
        expect(s.affected).toBeLessThanOrEqual(48);
      }
      const checks = [...dataChecks(dataset, report), ...hazardChecks(dataset, report), ...financialChecks(dataset, result)];
      expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    });
  });
});
