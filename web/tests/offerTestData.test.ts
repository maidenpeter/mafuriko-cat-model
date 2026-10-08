import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GeoCollection, WardProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { cleanValue } from "../src/lib/ingest/raster";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { DEFAULT_TERMS, policyLoss } from "../src/lib/model/terms";
import type { Dataset, Raster } from "../src/lib/model/types";
import { extractOffer } from "../src/lib/offer/client";
import { docxToText } from "../src/lib/offer/docx";
import { priceOffer, pricingRows } from "../src/lib/offer/price";
import { policyTerms } from "../src/lib/offer/terms";
import { OUTSIDE_MAPS_MESSAGE, type ExtractionRun, type OfferPricing, type PricingRow } from "../src/lib/offer/types";
import { waitingValues } from "../src/lib/offer/verify";

/**
 * The two test offers and the typed example, end to end on the rules path: read, checked,
 * located and priced against the Nairobi starter kit. No network and no model.
 *
 * Nothing here prints or holds any of the documents' text: only what was derived from them.
 */

const KIT = join(__dirname, "..", "..", "data", "data");
const TEST_DATA = join(__dirname, "..", "..", "data", "test-data");

// The hackathon starter kit, read straight from disk the way tests/starterKit.test.ts reads it.
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

const wards = JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", "wards.geojson"), "utf8")) as GeoCollection<WardProps>;

interface Priced {
  run: ExtractionRun;
  rows: PricingRow[];
  pricing: OfferPricing;
}

/** What the screen does with a text, in the same order, with the rules doing the reading. */
async function priceByRules(text: string, dataset: Dataset): Promise<Priced> {
  // The names the screen hands to the rules: each side of a ward name, and the named flood areas.
  const knownPlaces = [...wards.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
  const run = await extractOffer(text, { rulesOnly: true, knownPlaces });
  const rows = pricingRows(run.extraction, wards, dataset.hotspots);
  const pricing = priceOffer({ dataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: policyTerms(run.extraction.terms, DEFAULT_TERMS), wards });
  return { run, rows, pricing };
}

describe.skipIf(!existsSync(KIT))("offers on the Nairobi starter kit, by the rules alone", () => {
  let dataset: Dataset;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
  }, 120_000);

  describe("the typed example", () => {
    const TYPED = "two-storey masonry shop in Kibera worth KES 8 million";
    let typed: Priced;
    beforeAll(async () => {
      typed = await priceByRules(TYPED, dataset);
    });

    it("is read by the rules, with nothing sent anywhere and every value verified", () => {
      const { run } = typed;
      expect(run).toMatchObject({ path: "rules", sentToModel: false, documentText: TYPED });
      expect(run.extraction.rows).toHaveLength(1);
      const [row] = run.extraction.rows;
      expect(row.housingClass).toMatchObject({ value: "permanent_masonry", status: "verified", quote: TYPED });
      expect(row.tivKes).toMatchObject({ value: 8_000_000, status: "verified", quote: TYPED });
      expect(run.extraction.terms.placeName).toMatchObject({ value: "Kibera", status: "verified" });
      expect(row.lat.status).toBe("missing");
      expect(waitingValues(run.extraction)).toEqual([]);
    });

    it("is placed approximately, from the hotspot or ward list, and priced", () => {
      const [row] = typed.rows;
      expect(row).toMatchObject({ housingClass: "permanent_masonry", tivKes: 8_000_000, tivFrom: "stated", blockers: [] });
      const at = row.location;
      if (at.kind !== "approximate") throw new Error("the location should be approximate");
      expect(["hotspot", "ward"]).toContain(at.source);
      expect(at.placeName).toBe("Kibera");
      expect(at.matchedName.toLowerCase()).toContain("kibera");
      // The stand-in point is one the starter kit or the ward map gives, not one made up here.
      const known = at.source === "hotspot" ? dataset.hotspots.some((h) => h.name === at.matchedName && h.lat === at.lat && h.lon === at.lon) : wards.features.some((f) => f.properties.name === at.matchedName);
      expect(known).toBe(true);

      const priced = typed.pricing.rows[0];
      if (priced.status !== "priced") throw new Error("the row should be priced");
      expect(priced).toMatchObject({ housingClass: "permanent_masonry", tivKes: 8_000_000 });
      expect(priced.scenarios.map((s) => s.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
      expect(typed.pricing.totals).toMatchObject({ rows: 1, tivKes: 8_000_000 });
      expect(Number.isFinite(priced.aalGroundUpKes)).toBe(true);
    });

    it("uses the example terms, as the sentence states no deductible and no limit", () => {
      const { pricing } = typed;
      expect(pricing.terms).toEqual({ deductible: { source: "example", share: 0.02, minKes: 50_000 }, limit: { source: "example", share: 1 } });
      const priced = pricing.rows[0];
      if (priced.status !== "priced") throw new Error("the row should be priced");
      for (const s of priced.scenarios) {
        expect(s.grossKes).toBe(policyLoss(s.groundUpKes, 8_000_000, DEFAULT_TERMS).grossKes);
        expect(s.grossKes).toBeLessThanOrEqual(s.groundUpKes);
      }
      expect(priced.aalGrossKes).toBeLessThanOrEqual(priced.aalGroundUpKes);
    });
  });

  // The two memos are found by listing the folder. Their text is read through code and never shown.
  const memos = existsSync(TEST_DATA) ? readdirSync(TEST_DATA).filter((f) => f.toLowerCase().endsWith(".docx")) : [];
  const nairobiFile = memos.find((f) => f.toUpperCase().includes("NAIROBI"));
  const nzoiaFile = memos.find((f) => f.toUpperCase().includes("NZOIA"));

  describe.skipIf(!nairobiFile || !nzoiaFile)("the two test offers", () => {
    let nairobi: Priced;
    let nzoia: Priced;

    beforeAll(async () => {
      const read = async (file: string) => priceByRules(await docxToText(readFileSync(join(TEST_DATA, file))), dataset);
      nairobi = await read(nairobiFile!);
      nzoia = await read(nzoiaFile!);
    }, 120_000);

    it("reads both by the rules, sending nothing", () => {
      for (const { run } of [nairobi, nzoia]) {
        // Field by field, so a failure can never print the text of a memo.
        expect(run.path).toBe("rules");
        expect(run.sentToModel).toBe(false);
        expect(run.prompt).toBeNull();
        expect(run.model).toBeNull();
        expect(run.extraction.rows).toHaveLength(1);
        expect(run.documentText.length).toBeGreaterThan(1000);
      }
    });

    it("verifies what it reads against the words of each memo, and leaves nothing waiting", () => {
      for (const { run } of [nairobi, nzoia]) {
        const [row] = run.extraction.rows;
        for (const key of ["lat", "lon"] as const) expect({ key, status: row[key].status }).toEqual({ key, status: "verified" });
        // The rules never guess: anything they did read passed the checks, and the rest is left missing.
        for (const key of ["housingClass", "floorAreaM2", "costPerM2Kes", "tivKes"] as const) expect(["verified", "missing"]).toContain(row[key].status);
        expect(waitingValues(run.extraction).map((w) => w.label)).toEqual([]);
      }
    });

    it("lands the Nairobi offer inside the Nairobi maps, as reinforced concrete", () => {
      const [row] = nairobi.rows;
      expect(row.location.kind).toBe("exact");
      expect(row.housingClass).toBe("concrete_rcc");
      expect(row.tivFrom).toBe("stated");
      expect(row.blockers).toEqual([]);
      const [read] = nairobi.run.extraction.rows;
      expect(read.housingClass.status).toBe("verified");
      expect(read.tivKes.status).toBe("verified");
      const priced = nairobi.pricing.rows[0];
      expect(priced.status).toBe("priced");
      if (priced.status !== "priced") return;
      expect(priced.housingClass).toBe("concrete_rcc");
      expect(priced.ward).not.toBeNull();
      expect(priced.scenarios.map((s) => s.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    });

    it("finds the Nairobi offer dry in all five tiers, with water within 1 km in the widest", () => {
      const priced = nairobi.pricing.rows[0];
      if (priced.status !== "priced") throw new Error("the Nairobi offer should be priced");
      expect(priced.scenarios).toHaveLength(5);
      expect(priced.scenarios.map((s) => s.hazard)).toEqual([0, 0, 0, 0, 0]);
      expect(priced.dryInEveryTier).toBe(true);
      expect(priced.scenarios.map((s) => s.groundUpKes)).toEqual([0, 0, 0, 0, 0]);
      expect(priced.scenarios.map((s) => s.grossKes)).toEqual([0, 0, 0, 0, 0]);
      // The widest tier is the map with the most wet cells on it.
      const wetCells = (r: Raster) => r.data.reduce((n: number, v: number) => n + (cleanValue(v, r, dataset.hazardKind) > 0 ? 1 : 0), 0);
      const widestMap = [...dataset.rasters].sort((a, b) => wetCells(b) - wetCells(a))[0];
      const widest = priced.scenarios.find((s) => s.id === widestMap.scenarioId)!;
      expect(widest.nearestWetM).not.toBeNull();
      expect(widest.nearestWetM!).toBeGreaterThan(0);
      expect(widest.nearestWetM!).toBeLessThan(1000);
    });

    it("says where the Nairobi offer's deductible and limit came from", () => {
      const { terms } = nairobi.pricing;
      const stated = nairobi.run.extraction.terms;
      const usable = (status: string) => status === "verified";
      expect(terms.deductible.source).toBe(usable(stated.floodDeductiblePct.status) || usable(stated.floodDeductibleMinKes.status) ? "document" : "example");
      expect(terms.limit.source).toBe(usable(stated.floodLimitKes.status) ? "document" : "example");
    });

    it("reports the Nzoia offer as outside the Nairobi maps, with the exact sentence and no loss figures", () => {
      const [row] = nzoia.rows;
      expect(row.location.kind).toBe("exact");
      const outside = nzoia.pricing.rows[0];
      expect(outside.status).toBe("outside");
      expect(outside.status === "outside" && outside.message).toBe("Outside the hazard maps loaded: flood cannot be priced here");
      expect(OUTSIDE_MAPS_MESSAGE).toBe("Outside the hazard maps loaded: flood cannot be priced here");
      expect(Object.keys(outside).sort()).toEqual(["locId", "location", "message", "name", "status"]);
      expect(nzoia.pricing.totals).toBeNull();
      expect(nzoia.pricing.portfolio).toBeNull();
    });
  });
});
