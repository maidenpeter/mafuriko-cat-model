import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Papa from "papaparse";
import { beforeAll, describe, expect, it } from "vitest";
import { cellSizeM, DRAINAGE_DEFAULTS, drainageDistances, drainageSensitivity } from "../src/lib/geo/drainage";
import { withDrainage, type DrainageState } from "../src/lib/geo/drainageView";
import type { GeoCollection, WardProps, WaterwayProps } from "../src/lib/geo/layers";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { cleanValue, sampleRaster } from "../src/lib/ingest/raster";
import { averageAnnualLoss } from "../src/lib/model/financial";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import { runModel } from "../src/lib/model/pipeline";
import { DEFAULT_TERMS, policyLoss } from "../src/lib/model/terms";
import type { Building, Dataset, HazardKind, Hotspot, Raster } from "../src/lib/model/types";
import { offerChecks } from "../src/lib/offer/checks";
import { offerCsv } from "../src/lib/offer/csv";
import { locateByName, nearestWetCellM, riverDistanceM, wardOf } from "../src/lib/offer/locate";
import { priceOffer, pricingRows } from "../src/lib/offer/price";
import { describeTerms, grossLoss, grossLosses, policyTerms } from "../src/lib/offer/terms";
import {
  OFFER_CHECK_IDS,
  OFFER_CSV_COLUMNS,
  OUTSIDE_MAPS_MESSAGE,
  type CoordinateReading,
  type OfferExtraction,
  type OfferNote,
  type OfferRow,
  type OfferTerms,
  type PolicyTerms,
  type Quoted,
} from "../src/lib/offer/types";
import { waitingValues } from "../src/lib/offer/verify";

// --- invented offers ---------------------------------------------------------------------------

const stated = <T,>(value: T): Quoted<T> => ({ value, quote: "an invented sentence", status: "verified", reason: null });
const missing = <T,>(): Quoted<T> => ({ value: null, quote: "", status: "missing", reason: null });

const row = (values: Partial<OfferRow> = {}): OfferRow => ({
  name: missing(),
  lat: missing(),
  lon: missing(),
  housingClass: missing(),
  floorAreaM2: missing(),
  costPerM2Kes: missing(),
  tivKes: missing(),
  path: "rules",
  coordinates: null,
  ...values,
});

const terms = (values: Partial<OfferTerms> = {}): OfferTerms => ({
  basements: missing(),
  occupancy: missing(),
  floodDeductiblePct: missing(),
  floodDeductibleMinKes: missing(),
  floodDeductibleBasis: missing(),
  floodLimitKes: missing(),
  policyPeriod: missing(),
  floodCover: missing(),
  placeName: missing(),
  riverName: missing(),
  riverDistanceM: missing(),
  ...values,
});

const note = (kind: OfferNote["kind"], value: string): OfferNote => ({ ...stated(value), kind });

/** Terms as an offer states them: a percentage of each loss, a KES minimum and a limit for one flood. */
const fromDocument = (pct: number | null, minKes: number | null, limitKes: number): PolicyTerms => ({
  deductible: { source: "document", pct, minKes, basis: "percent_of_loss" },
  limit: { source: "document", kes: limitKes },
});
/** The panel's example terms, as they stand by default: 2% of insured value, at least KES 50,000, limit the whole insured value. */
const EXAMPLE_TERMS: PolicyTerms = { deductible: { source: "example", share: 0.02, minKes: 50_000 }, limit: { source: "example", share: 1 } };
/** Example terms that take nothing off, for the tests that are about something else. */
const NO_TERMS: PolicyTerms = { deductible: { source: "example", share: 0, minKes: 0 }, limit: { source: "example", share: 1 } };

const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

// --- a small map of two return periods, just south of the equator, inside Kenya ----------------

// Four by four cells of 0.01 degrees. Row 0 is the northern edge.
const BBOX: [number, number, number, number] = [36.8, -1.34, 36.84, -1.3];
const cell = (r: number, c: number) => ({ lon: BBOX[0] + (c + 0.5) * 0.01, lat: BBOX[3] - (r + 0.5) * 0.01 });
const grid = (scenarioId: string, fill: number, set: [number, number, number][]): Raster => {
  const data = new Float32Array(16).fill(fill);
  for (const [r, c, v] of set) data[r * 4 + c] = v;
  return { scenarioId, fileName: `${scenarioId}.tif`, width: 4, height: 4, bbox: BBOX, data, noData: null };
};

function toyDataset(kind: HazardKind, rasters: Raster[], scenarios: Dataset["scenarios"]): Dataset {
  const building = (locId: string, r: number, c: number): Building => {
    const p = cell(r, c);
    return {
      locId,
      ...p,
      housingClassRaw: "permanent_masonry",
      housingClass: "permanent_masonry",
      floorAreaM2: 100,
      costPerM2Kes: 50_000,
      tivKes: 5_000_000,
      synthetic: true,
      hazard: rasters.map((m) => sampleRaster(m, p.lon, p.lat, kind).value),
    };
  };
  return { name: "toy", hazardKind: kind, scenarios, rasters, hotspots: [], buildings: [building("A", 0, 3), building("B", 3, 0)] };
}

// Depth maps: the 1-in-10 map has water in the north-east corner only; the 1-in-100 map has
// 1 m everywhere but the south-west corner.
const depthDataset = toyDataset(
  "depth_m",
  [grid("rp10y", 0, [[0, 3, 0.5]]), grid("rp100y", 1, [[3, 0, 0]])],
  [
    { id: "rp10y", label: "1 in 10 years", fixedReturnPeriod: 10 },
    { id: "rp100y", label: "1 in 100 years", fixedReturnPeriod: 100 },
  ],
);

const SITE = cell(2, 1);
const siteRow = (values: Partial<OfferRow> = {}) =>
  row({ name: stated("Invented House"), lat: stated(SITE.lat), lon: stated(SITE.lon), housingClass: stated("permanent_masonry"), floorAreaM2: stated(1000), tivKes: stated(10_000_000), ...values });

const extraction = (rows: OfferRow[], t: Partial<OfferTerms> = {}, notes: OfferNote[] = []): OfferExtraction => ({ rows, terms: terms(t), notes });

// --- deductible and limit ----------------------------------------------------------------------

describe("deductible and limit", () => {
  const percentWithMinimum = fromDocument(5, 2_000_000, 500_000_000);
  const unverified = <T,>(value: T): Quoted<T> => ({ value, quote: "an invented sentence", status: "unverified", reason: "the number is not in the sentence" });

  it("takes a percentage of the loss when that is more than the minimum", () => {
    // 5% of 100m is 5m, above the 2m minimum.
    expect(grossLoss(100_000_000, percentWithMinimum, 4_000_000_000)).toBe(95_000_000);
  });

  it("takes the KES minimum when the percentage would be less", () => {
    // 5% of 10m is 0.5m, so the 2m minimum applies.
    expect(grossLoss(10_000_000, percentWithMinimum, 4_000_000_000)).toBe(8_000_000);
  });

  it("never goes below zero when the loss is smaller than the deductible", () => {
    expect(grossLoss(1_500_000, percentWithMinimum, 4_000_000_000)).toBe(0);
  });

  it("caps what is left at the limit, after the deductible", () => {
    // 1bn less 5% is 950m, capped at 500m.
    expect(grossLoss(1_000_000_000, percentWithMinimum, 4_000_000_000)).toBe(500_000_000);
    // The limit is applied after the deductible, not before: 510m less 25.5m is 484.5m, under the limit.
    expect(grossLoss(510_000_000, percentWithMinimum, 4_000_000_000)).toBe(484_500_000);
  });

  it("charges no deductible on no loss", () => {
    expect(grossLoss(0, percentWithMinimum, 4_000_000_000)).toBe(0);
    expect(grossLoss(Number.NaN, percentWithMinimum, 4_000_000_000)).toBe(0);
    expect(grossLoss(0, EXAMPLE_TERMS, 4_000_000_000)).toBe(0);
  });

  it("reads a flat amount as the whole deductible", () => {
    const flat = fromDocument(null, 5_000_000, 1_000_000_000);
    expect(grossLoss(30_000_000, flat, 1_000_000_000)).toBe(25_000_000);
    expect(describeTerms(flat).deductible).toContain("flat KES 5.0m");
  });

  it("takes the percentage of the insured value only when the text says so", () => {
    const ofValue: PolicyTerms = { deductible: { source: "document", pct: 2, minKes: null, basis: "percent_of_sum_insured" }, limit: { source: "document", kes: 1_000_000_000 } };
    // 2% of a 1bn insured value is 20m, whatever the size of the loss.
    expect(grossLoss(50_000_000, ofValue, 1_000_000_000)).toBe(30_000_000);
    expect(grossLoss(50_000_000, { ...ofValue, deductible: { ...ofValue.deductible, basis: "percent_of_loss" } as PolicyTerms["deductible"] }, 1_000_000_000)).toBe(49_000_000);
    expect(describeTerms(ofValue).deductible).toContain("of the insured value");
  });

  it("says how each term was read", () => {
    const stated = describeTerms(percentWithMinimum);
    expect(stated.deductible).toContain("5% of each loss");
    expect(stated.deductible).toContain("minimum of KES 2.0m");
    expect(stated.limit).toContain("KES 500.0m");
    const example = describeTerms(EXAMPLE_TERMS);
    expect(example.deductible).toContain("2% of the building's insured value");
    expect(example.deductible).toContain("KES 50,000");
    expect(example.limit).toContain("100% of the building's insured value");
  });

  it("uses the panel's example terms through policyLoss when the document states none", () => {
    const none = policyTerms(terms(), DEFAULT_TERMS);
    expect(none).toEqual(EXAMPLE_TERMS);
    // 2% of 10m is 200,000; of 1m it is 20,000, so the KES 50,000 minimum applies; a loss under the deductible pays nothing.
    for (const [groundUp, tiv, gross] of [
      [3_800_000, 10_000_000, 3_600_000],
      [600_000, 1_000_000, 550_000],
      [40_000, 1_000_000, 0],
    ]) {
      expect(grossLoss(groundUp, none, tiv)).toBe(gross);
      expect(grossLoss(groundUp, none, tiv)).toBe(policyLoss(groundUp, tiv, DEFAULT_TERMS).grossKes);
    }
    // Building by building, exactly as the portfolio is treated.
    expect(grossLosses([3_800_000, 0, 40_000], [10_000_000, 5_000_000, 1_000_000], none)).toEqual([3_600_000, 0, 0]);
    // A panel limit of half the insured value caps what is left.
    expect(grossLoss(8_000_000, policyTerms(terms(), { ...DEFAULT_TERMS, limitShare: 0.5 }), 10_000_000)).toBe(5_000_000);
  });

  it("takes each term from the document when it is stated there, and says which is which", () => {
    const onlyDeductible = policyTerms(terms({ floodDeductiblePct: stated(5), floodDeductibleMinKes: stated(2_000_000) }), DEFAULT_TERMS);
    expect(onlyDeductible.deductible).toEqual({ source: "document", pct: 5, minKes: 2_000_000, basis: "percent_of_loss" });
    expect(onlyDeductible.limit).toEqual({ source: "example", share: 1 });
    // 5% of 100m is 5m; the example limit is the whole insured value of 60m.
    expect(grossLoss(100_000_000, onlyDeductible, 60_000_000)).toBe(60_000_000);

    const onlyLimit = policyTerms(terms({ floodLimitKes: { ...stated(2_000_000), status: "confirmed" } }), DEFAULT_TERMS);
    expect(onlyLimit.deductible).toEqual({ source: "example", share: 0.02, minKes: 50_000 });
    expect(onlyLimit.limit).toEqual({ source: "document", kes: 2_000_000 });
    // The example deductible is 2% of 10m, and the 3.6m left is capped at the document's 2m.
    expect(grossLoss(3_800_000, onlyLimit, 10_000_000)).toBe(2_000_000);
    expect(grossLoss(1_200_000, onlyLimit, 10_000_000)).toBe(1_000_000);
  });

  it("never lets the gross loss go above the ground-up loss or below zero", () => {
    const sets = [EXAMPLE_TERMS, NO_TERMS, percentWithMinimum, fromDocument(null, 0, 0), policyTerms(terms({ floodLimitKes: stated(1) }), DEFAULT_TERMS), policyTerms(terms(), { deductibleShare: -1, deductibleMinKes: Number.NaN, limitShare: 7 })];
    for (const set of sets) {
      const groundUp = [0, 1, 49_999, 3_800_000, 2_000_000_000];
      const gross = grossLosses(groundUp, groundUp.map(() => 2_000_000_000), set);
      gross.forEach((g, i) => {
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(groundUp[i]);
      });
    }
  });

  it("does not fall back to the example terms while a stated term waits to be confirmed", () => {
    const waiting = terms({ floodDeductiblePct: stated(5), floodDeductibleMinKes: unverified(2_000_000), floodLimitKes: unverified(500_000_000) });
    // The unverified figures are not used as they stand...
    expect(policyTerms(waiting, DEFAULT_TERMS)).toEqual({ deductible: { source: "document", pct: 5, minKes: null, basis: "percent_of_loss" }, limit: { source: "example", share: 1 } });
    // ...and the row is held back, so no price is worked out around them.
    const e = extraction([siteRow()], waiting);
    expect(waitingValues(e).map((w) => w.label)).toEqual(["Deductible minimum", "Flood limit"]);
    const rows = pricingRows(e, null, []);
    expect(rows[0].blockers).toEqual(["Deductible minimum is not verified. Confirm it, edit it or clear it.", "Flood limit is not verified. Confirm it, edit it or clear it."]);
    const pricing = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: policyTerms(waiting, DEFAULT_TERMS), wards: null });
    expect(pricing.rows[0].status).toBe("not_ready");
    expect(pricing.totals).toBeNull();
    // Confirmed, the limit is the document's.
    const settled = policyTerms({ ...waiting, floodLimitKes: { ...waiting.floodLimitKes, status: "confirmed", reason: null } }, DEFAULT_TERMS);
    expect(settled.limit).toEqual({ source: "document", kes: 500_000_000 });
  });
});

// --- nearest wet cell --------------------------------------------------------------------------

/** Every cell measured in turn: the slow, obviously right answer the ring search must match. */
function nearestWetSlow(raster: Raster, lon: number, lat: number, kind: HazardKind): number | null {
  const size = cellSizeM(raster);
  const [minLon, , maxLon, maxLat] = raster.bbox;
  const minLat = raster.bbox[1];
  const x = ((lon - minLon) / (maxLon - minLon)) * raster.width;
  const y = ((maxLat - lat) / (maxLat - minLat)) * raster.height;
  let best = Infinity;
  for (let r = 0; r < raster.height; r++) {
    for (let c = 0; c < raster.width; c++) {
      if (cleanValue(raster.data[r * raster.width + c], raster, kind) > 0) best = Math.min(best, Math.hypot((c + 0.5 - x) * size.x, (r + 0.5 - y) * size.y));
    }
  }
  return Number.isFinite(best) ? best : null;
}

describe("nearest wet cell", () => {
  const map = grid("rp10y", 0, [[0, 3, 0.5]]);
  const size = cellSizeM(map);

  it("measures from the point to the centre of the nearest cell with water", () => {
    // From the centre of row 2, column 1 to the centre of row 0, column 3: two cells east, two north.
    expect(nearestWetCellM(map, SITE.lon, SITE.lat, "depth_m")).toBeCloseTo(Math.hypot(2 * size.x, 2 * size.y), 3);
    expect(nearestWetCellM(map, cell(0, 2).lon, cell(0, 2).lat, "depth_m")).toBeCloseTo(size.x, 3);
  });

  it("is zero in a wet cell, and null off the map or on a map with no water", () => {
    expect(nearestWetCellM(map, cell(0, 3).lon, cell(0, 3).lat, "depth_m")).toBe(0);
    expect(nearestWetCellM(map, 36.9, -1.32, "depth_m")).toBeNull();
    expect(nearestWetCellM(grid("rp10y", 0, []), SITE.lon, SITE.lat, "depth_m")).toBeNull();
  });

  it("does not count empty cells as water", () => {
    const withGaps: Raster = { ...grid("rp10y", -9999, [[3, 3, 0.2]]), noData: -9999 };
    expect(nearestWetCellM(withGaps, cell(3, 0).lon, cell(3, 0).lat, "depth_m")).toBeCloseTo(3 * size.x, 3);
  });

  it("agrees with a cell by cell search on a scattered map", () => {
    const width = 60;
    const height = 45;
    const data = new Float32Array(width * height);
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < data.length; i++) data[i] = next() < 0.01 ? 0.4 : 0;
    const scattered: Raster = { scenarioId: "common", fileName: "common.tif", width, height, bbox: [36.6, -1.45, 37.1, -1.15], data, noData: null };
    for (let i = 0; i < 200; i++) {
      const lon = 36.6 + next() * 0.5;
      const lat = -1.45 + next() * 0.3;
      const slow = nearestWetSlow(scattered, lon, lat, "score");
      const here = sampleRaster(scattered, lon, lat, "score").value > 0;
      expect(nearestWetCellM(scattered, lon, lat, "score")).toBeCloseTo(here ? 0 : (slow as number), 6);
    }
  });
});

// --- place names, wards and rivers -------------------------------------------------------------

describe("place names", () => {
  const wards: GeoCollection<WardProps> = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "Mto Mdogo", subcounty: "East" }, geometry: { type: "Polygon", coordinates: [square(36.8, -1.3, 36.82, -1.28)] } },
      { type: "Feature", properties: { name: "Mto Mdogo North", subcounty: "East" }, geometry: { type: "Polygon", coordinates: [square(36.8, -1.28, 36.82, -1.26)] } },
      { type: "Feature", properties: { name: "Bonde/Kilima", subcounty: "West" }, geometry: { type: "Polygon", coordinates: [square(36.7, -1.3, 36.72, -1.28)] } },
      { type: "Feature", properties: { name: "Hospital", subcounty: "West" }, geometry: { type: "Polygon", coordinates: [square(36.6, -1.3, 36.62, -1.28)] } },
      // An L shape: its centroid falls in the notch, outside the ward itself.
      { type: "Feature", properties: { name: "Pembe", subcounty: "West" }, geometry: { type: "Polygon", coordinates: [[[36.5, -1.3], [36.56, -1.3], [36.56, -1.29], [36.51, -1.29], [36.51, -1.24], [36.5, -1.24], [36.5, -1.3]]] } },
    ],
  };
  const hotspots: Hotspot[] = [
    { name: "Soko Kuu", lat: -1.31, lon: 36.79 },
    { name: "Lang'ata Chini", lat: -1.32, lon: 36.78 },
  ];

  it("ignores case and punctuation, and uses the centre of the ward", () => {
    const found = locateByName("MTO-MDOGO.", wards, hotspots);
    expect(found).toMatchObject({ source: "ward", matchedName: "Mto Mdogo" });
    expect(found?.lon).toBeCloseTo(36.81, 6);
    expect(found?.lat).toBeCloseTo(-1.29, 6);
  });

  it("finds a known name inside a longer place name, as whole words only", () => {
    expect(locateByName("a shop in Soko Kuu, Nairobi", wards, hotspots)).toEqual({ lat: -1.31, lon: 36.79, source: "hotspot", matchedName: "Soko Kuu" });
    expect(locateByName("Soko Kuukuu", wards, hotspots)).toBeNull();
    expect(locateByName("Langata Chini", wards, hotspots)?.matchedName).toBe("Lang'ata Chini");
  });

  it("lets the longest known name win", () => {
    expect(locateByName("Mto Mdogo North estate", wards, hotspots)?.matchedName).toBe("Mto Mdogo North");
  });

  it("matches either side of a slash in a ward name", () => {
    expect(locateByName("Kilima", wards, hotspots)?.matchedName).toBe("Bonde/Kilima");
  });

  it("does not place an offer by an everyday word, or guess at an unknown place", () => {
    expect(locateByName("next to the hospital", wards, hotspots)).toBeNull();
    expect(locateByName("Hospital", wards, hotspots)?.matchedName).toBe("Hospital");
    expect(locateByName("Mahali Pengine", wards, hotspots)).toBeNull();
    expect(locateByName("  ", wards, hotspots)).toBeNull();
    expect(locateByName("Soko Kuu", null, [])).toBeNull();
  });

  it("keeps the stand-in point inside a ward whose centroid is outside it", () => {
    const found = locateByName("Pembe", wards, hotspots);
    expect(found).not.toBeNull();
    expect(wardOf(found!, wards)?.name).toBe("Pembe");
  });

  it("names the ward a point falls in", () => {
    expect(wardOf({ lat: -1.27, lon: 36.81 }, wards)).toEqual({ index: 1, name: "Mto Mdogo North", subcounty: "East" });
    expect(wardOf({ lat: 0, lon: 0 }, wards)).toBeNull();
    expect(wardOf({ lat: -1.27, lon: 36.81 }, null)).toBeNull();
  });
});

describe("distance to a named river", () => {
  const waterways: GeoCollection<WaterwayProps> = {
    type: "FeatureCollection",
    features: [
      // Runs north to south along longitude 36.82.
      { type: "Feature", properties: { kind: "river", name: "Maji River" }, geometry: { type: "LineString", coordinates: [[36.82, -1.4], [36.82, -1.2]] } },
      { type: "Feature", properties: { kind: "stream", name: "Mto Maji" }, geometry: { type: "LineString", coordinates: [[36.9, -1.4], [36.9, -1.39]] } },
      { type: "Feature", properties: { kind: "drain", name: null }, geometry: { type: "LineString", coordinates: [[36.81, -1.4], [36.81, -1.2]] } },
    ],
  };
  const point = { lat: -1.3, lon: 36.81 };
  const expected = 0.01 * 111320 * Math.cos((1.3 * Math.PI) / 180);

  it("measures to the nearest stretch, however the name is written", () => {
    for (const name of ["Maji River", "maji river", "River Maji", "the Maji"]) {
      const found = riverDistanceM(point, name, waterways);
      expect(found?.distanceM).toBeCloseTo(expected, 3);
      expect(found?.matchedName).toBe("Maji River");
    }
  });

  it("measures to the end of a stretch when the point is past it", () => {
    const south = riverDistanceM({ lat: -1.41, lon: 36.82 }, "Maji River", waterways);
    expect(south?.distanceM).toBeCloseTo(0.01 * 110574, 3);
  });

  it("returns nothing for a river that is not mapped, or with no layer", () => {
    expect(riverDistanceM(point, "Nzoia River", waterways)).toBeNull();
    expect(riverDistanceM(point, "River", waterways)).toBeNull();
    expect(riverDistanceM(point, "Maji River", null)).toBeNull();
  });
});

// --- rows for the engine -----------------------------------------------------------------------

describe("rows for the engine", () => {
  const hotspots: Hotspot[] = [{ name: "Soko Kuu", lat: SITE.lat, lon: SITE.lon }];

  it("uses only values that passed the checks, and never invents a class", () => {
    const unverified: Quoted<number> = { value: 9_000_000, quote: "an invented sentence", status: "unverified", reason: "the number is not in the sentence" };
    const [first, second] = pricingRows(
      extraction([siteRow({ tivKes: unverified, costPerM2Kes: stated(20_000) }), row({ lat: stated(SITE.lat), lon: stated(SITE.lon) })]),
      null,
      [],
    );
    // The unverified value is not used, and nothing is priced around it: the row waits for the underwriter.
    expect(first).toMatchObject({ index: 0, locId: "OFFER-1", name: "Invented House", tivKes: 20_000_000, tivFrom: "area_times_cost", blockers: ["Insured value is not verified. Confirm it, edit it or clear it."] });
    expect(first.location.kind).toBe("exact");
    // Cleared, floor area times cost per m² stands in for it; confirmed, the stated value is used.
    const cleared = pricingRows(extraction([siteRow({ tivKes: missing(), costPerM2Kes: stated(20_000) })]), null, [])[0];
    expect(cleared).toMatchObject({ tivKes: 20_000_000, tivFrom: "area_times_cost", blockers: [] });
    const confirmed = pricingRows(extraction([siteRow({ tivKes: { ...unverified, status: "confirmed", reason: null }, costPerM2Kes: stated(20_000) })]), null, [])[0];
    expect(confirmed).toMatchObject({ tivKes: 9_000_000, tivFrom: "stated", blockers: [] });
    expect(second).toMatchObject({ locId: "OFFER-2", name: "Building 2", housingClass: null, tivKes: null, tivFrom: null });
    expect(second.blockers).toHaveLength(2);
  });

  it("falls back to the place name, labelled approximate, when there are no coordinates", () => {
    const [found] = pricingRows(extraction([row({ housingClass: stated("permanent_masonry"), tivKes: stated(8_000_000) })], { placeName: stated("Soko Kuu") }), null, hotspots);
    expect(found.location).toEqual({ kind: "approximate", lat: SITE.lat, lon: SITE.lon, source: "hotspot", matchedName: "Soko Kuu", placeName: "Soko Kuu" });
    expect(found.blockers).toEqual([]);
  });

  it("rejects a point outside Kenya, and says when a place is not known", () => {
    const [abroad, nowhere, unknown] = [
      pricingRows(extraction([row({ lat: stated(51.5), lon: stated(-0.12) })]), null, hotspots)[0],
      pricingRows(extraction([row()]), null, hotspots)[0],
      pricingRows(extraction([row()], { placeName: stated("Mahali Pengine") }), null, hotspots)[0],
    ];
    expect(abroad.location).toMatchObject({ kind: "none" });
    expect(abroad.location.kind === "none" && abroad.location.reason).toContain("outside Kenya");
    expect(nowhere.location).toEqual({ kind: "none", reason: "No usable coordinates and no place name." });
    expect(unknown.location.kind === "none" && unknown.location.reason).toContain("Mahali Pengine");
  });

  it("never lets a place name stand in for coordinates that are stated but unverified", () => {
    const doubted: Quoted<number> = { value: SITE.lat, quote: "an invented sentence", status: "unverified", reason: "the sign and the letter disagree" };
    const e = extraction([row({ lat: doubted, lon: stated(SITE.lon), housingClass: stated("permanent_masonry"), tivKes: stated(8_000_000) })], { placeName: stated("Soko Kuu") });
    const [held] = pricingRows(e, null, hotspots);
    expect(held.location).toEqual({ kind: "none", reason: "The coordinates are not verified: confirm, edit or clear them." });
    expect(held.blockers).toHaveLength(2);
    expect(priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows: [held], terms: NO_TERMS, wards: null }).rows[0].status).toBe("not_ready");
    // An unverified place name blocks a row that has nothing else to go by, and no other.
    const place: Quoted<string> = { value: "Soko Kuu", quote: "an invented sentence", status: "unverified", reason: "the name is not in the sentence" };
    expect(pricingRows(extraction([row({ housingClass: stated("permanent_masonry"), tivKes: stated(8_000_000) })], { placeName: place }), null, hotspots)[0].blockers).toContain("Place name is not verified. Confirm it, edit it or clear it.");
    expect(pricingRows(extraction([siteRow()], { placeName: place }), null, hotspots)[0].blockers).toEqual([]);
  });

  it("drops the reading once the underwriter has typed the coordinates", () => {
    const reading: CoordinateReading = { lat: SITE.lat, lon: SITE.lon, latHow: "both_agree", lonHow: "hemisphere", raw: "an invented pair", writtenBothWays: true, conflict: false };
    const read = pricingRows(extraction([siteRow({ coordinates: reading })]), null, [])[0];
    expect(read.location).toMatchObject({ kind: "exact", reading });
    const typed = pricingRows(extraction([siteRow({ coordinates: reading, lat: { ...stated(SITE.lat), status: "edited" } })]), null, [])[0];
    expect(typed.location).toMatchObject({ kind: "exact", reading: null });
  });
});

// --- pricing -----------------------------------------------------------------------------------

describe("pricing an offer", () => {
  const offerTerms = fromDocument(10, 500_000, 2_000_000);
  const rows = pricingRows(
    extraction([
      siteRow(),
      // In Kenya, but far from the small map.
      siteRow({ name: stated("Far Mill"), lat: stated(0.5), lon: stated(34.5) }),
      // On the map, with nothing to say what it is built of.
      siteRow({ name: stated("No Class"), housingClass: missing() }),
      row({ name: stated("No Place"), housingClass: stated("permanent_masonry"), tivKes: stated(1_000_000) }),
    ]),
    null,
    [],
  );
  const pricing = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: offerTerms, wards: null });
  const own = runModel(depthDataset, REFERENCE_PARAMS);

  it("prices the row on the map through the engine, scenario by scenario", () => {
    const priced = pricing.rows[0];
    if (priced.status !== "priced") throw new Error("the first row should be priced");
    expect(pricing.scenarios.map((s) => s.returnPeriod)).toEqual([10, 100]);

    const [rp10, rp100] = priced.scenarios;
    // Dry in the 1-in-10 map: no depth, no damage, no loss, and the distance to the water in the corner.
    const size = cellSizeM(depthDataset.rasters[0]);
    expect(rp10).toMatchObject({ hazard: 0, terrainM: 0, drainageM: 0, depthM: 0, damageRatio: 0, groundUpKes: 0, grossKes: 0 });
    expect(rp10.nearestWetM).toBeCloseTo(Math.hypot(2 * size.x, 2 * size.y), 3);
    // 1 m of water in the 1-in-100 map: the reference curve gives 38% for permanent masonry.
    expect(rp100).toMatchObject({ hazard: 1, terrainM: 1, drainageM: 0, depthM: 1, nearestWetM: null });
    expect(rp100.damageRatio).toBeCloseTo(0.38, 10);
    expect(rp100.groundUpKes).toBeCloseTo(3_800_000, 4);
    // The 10% deductible would be 380,000, so the 500,000 minimum applies; 3.3m is then capped at 2m.
    expect(rp100.grossKes).toBeCloseTo(2_000_000, 4);

    const aal = averageAnnualLoss([
      { returnPeriod: 10, lossKes: 0 },
      { returnPeriod: 100, lossKes: 3_800_000 },
    ]);
    expect(priced.aalGroundUpKes).toBeCloseTo(aal, 4);
    expect(priced.aalGroundUpKes).toBeCloseTo(209_000, 4);
    expect(priced.ratePerMilleGroundUp).toBeCloseTo(20.9, 8);
    expect(priced.ratePerMilleGross).toBeCloseTo(((0.09 * 0.5 + 0.01) * 2_000_000) / 10_000_000 * 1000, 8);
    expect(priced.dryInEveryTier).toBe(false);
    expect(priced.ward).toBeNull();
  });

  it("gives a point outside the maps the exact sentence and no loss figures", () => {
    const outside = pricing.rows[1];
    expect(outside.status).toBe("outside");
    expect(Object.keys(outside).sort()).toEqual(["locId", "location", "message", "name", "status"]);
    expect(outside).toMatchObject({ locId: "OFFER-2", name: "Far Mill", message: "Outside the hazard maps loaded: flood cannot be priced here" });
    expect(OUTSIDE_MAPS_MESSAGE).toBe("Outside the hazard maps loaded: flood cannot be priced here");
    expect(JSON.stringify(outside)).not.toMatch(/Kes|damageRatio|scenarios/);
  });

  it("holds back a row with no class or no location, again with no loss figures", () => {
    expect(pricing.rows[2]).toMatchObject({ status: "not_ready", name: "No Class" });
    expect(pricing.rows[3]).toMatchObject({ status: "not_ready", name: "No Place" });
    for (const held of [pricing.rows[2], pricing.rows[3]]) {
      expect(Object.keys(held).sort()).toEqual(["blockers", "locId", "location", "name", "status"]);
      expect(held.status === "not_ready" && held.blockers.length).toBeGreaterThan(0);
    }
  });

  it("adds only the priced row to the run, and leaves the portfolio's own figures untouched", () => {
    const { portfolio, totals } = pricing;
    expect(totals).toMatchObject({ rows: 1, tivKes: 10_000_000 });
    expect(portfolio?.without).toEqual({ buildings: 2, totalTivKes: own.totalTivKes, loss100Kes: own.standardLosses.find((s) => s.returnPeriod === 100)!.lossKes, loss100Extrapolated: false, aalKes: own.aalKes });
    expect(portfolio?.with.buildings).toBe(3);
    expect(portfolio?.with.totalTivKes).toBe(own.totalTivKes + 10_000_000);
    expect(portfolio!.with.aalKes - portfolio!.without.aalKes).toBeCloseTo(209_000, 4);
    expect(portfolio!.with.loss100Kes! - portfolio!.without.loss100Kes!).toBeCloseTo(3_800_000, 4);
    // The loaded dataset itself is not changed.
    expect(depthDataset.buildings).toHaveLength(2);
  });

  it("returns no totals and no portfolio effect when nothing could be priced", () => {
    const none = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows: rows.slice(1), terms: offerTerms, wards: null });
    expect(none.rows.map((r) => r.status)).toEqual(["outside", "not_ready", "not_ready"]);
    expect(none.totals).toBeNull();
    expect(none.portfolio).toBeNull();
    expect(none.scenarios.map((s) => s.id)).toEqual(["rp10y", "rp100y"]);
  });

  it("treats a dataset with no hazard maps as outside, never as dry", () => {
    const noMaps = priceOffer({ dataset: { ...depthDataset, rasters: [] }, params: REFERENCE_PARAMS, drainage: null, rows: rows.slice(0, 1), terms: offerTerms, wards: null });
    expect(noMaps.rows[0]).toMatchObject({ status: "outside", message: OUTSIDE_MAPS_MESSAGE });
    expect(noMaps.totals).toBeNull();
  });

  it("applies the terms once to the whole offer and shares the result between its buildings", () => {
    const other = cell(1, 1);
    const two = pricingRows(extraction([siteRow(), siteRow({ name: stated("Second House"), lat: stated(other.lat), lon: stated(other.lon), tivKes: stated(30_000_000) })]), null, []);
    const both = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows: two, terms: offerTerms, wards: null });
    const [a, b] = both.rows;
    if (a.status !== "priced" || b.status !== "priced") throw new Error("both rows should be priced");
    // Ground-up 3.8m and 11.4m: together 15.2m, less 10% is 13.68m, capped at the 2m limit.
    expect(both.totals?.scenarios[1]).toMatchObject({ returnPeriod: 100 });
    expect(both.totals?.scenarios[1].grossKes).toBeCloseTo(2_000_000, 4);
    expect(both.totals?.scenarios[1].groundUpKes).toBeCloseTo(15_200_000, 4);
    expect(a.scenarios[1].grossKes).toBeCloseTo(500_000, 4);
    expect(b.scenarios[1].grossKes).toBeCloseTo(1_500_000, 4);
    expect(a.aalGrossKes + b.aalGrossKes).toBeCloseTo(both.totals!.aalGrossKes, 4);
    expect(both.totals!.ratePerMilleGroundUp).toBeCloseTo((both.totals!.aalGroundUpKes / 40_000_000) * 1000, 10);
    expect(both.portfolio?.with.buildings).toBe(4);
  });

  it("applies the example terms building by building when the document states none", () => {
    const other = cell(1, 1);
    const e = extraction([siteRow(), siteRow({ name: stated("Second House"), lat: stated(other.lat), lon: stated(other.lon), tivKes: stated(30_000_000) })]);
    const used = policyTerms(e.terms, DEFAULT_TERMS);
    const both = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows: pricingRows(e, null, []), terms: used, wards: null });
    const [a, b] = both.rows;
    if (a.status !== "priced" || b.status !== "priced") throw new Error("both rows should be priced");
    expect(both.terms).toEqual(EXAMPLE_TERMS);
    // Ground-up 3.8m on 10m and 11.4m on 30m: the 2% deductibles are 200,000 and 600,000.
    expect(a.scenarios[1].grossKes).toBeCloseTo(3_600_000, 4);
    expect(b.scenarios[1].grossKes).toBeCloseTo(10_800_000, 4);
    for (const priced of [a, b]) {
      for (const s of priced.scenarios) expect(s.grossKes).toBe(policyLoss(s.groundUpKes, priced.tivKes, DEFAULT_TERMS).grossKes);
      expect(priced.aalGrossKes).toBeLessThanOrEqual(priced.aalGroundUpKes);
    }
    expect(both.totals?.scenarios[1].grossKes).toBeCloseTo(14_400_000, 4);
    expect(both.totals!.aalGrossKes).toBeCloseTo(a.aalGrossKes + b.aalGrossKes, 4);
    // The portfolio comparison stays ground-up, whatever the terms.
    expect(both.portfolio!.with.loss100Kes! - both.portfolio!.without.loss100Kes!).toBeCloseTo(15_200_000, 4);
  });

  it("leaves the loss alone under terms that take nothing off", () => {
    const plain = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows: rows.slice(0, 1), terms: NO_TERMS, wards: null });
    const priced = plain.rows[0];
    if (priced.status !== "priced") throw new Error("the row should be priced");
    expect(priced.scenarios.map((s) => s.grossKes)).toEqual(priced.scenarios.map((s) => s.groundUpKes));
    expect(priced.aalGrossKes).toBe(priced.aalGroundUpKes);
    expect(priced.tivFrom).toBe("stated");
  });
});

describe("pricing with drainage", () => {
  // Score maps on one grid: water in the north-east only, so the site is dry on the terrain maps.
  const scoreDataset = toyDataset(
    "score",
    [grid("extreme", 0, [[0, 3, 0.4], [0, 2, 0.2]]), grid("common", 0, [[0, 3, 1], [0, 2, 0.6], [1, 3, 0.3]])],
    [
      { id: "extreme", label: "extreme" },
      { id: "common", label: "common" },
    ],
  );
  // A drain running straight through the site's cell.
  const waterways: GeoCollection<WaterwayProps> = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { kind: "drain", name: null }, geometry: { type: "LineString", coordinates: [[SITE.lon, -1.34], [SITE.lon, -1.3]] } }],
  };
  const widest = scoreDataset.rasters[1];
  const distances = drainageDistances({ width: 4, height: 4, bbox: BBOX }, waterways, null);
  const state: DrainageState = { distances, sensitivity: drainageSensitivity(distances, widest, []) };
  const rows = pricingRows(extraction([siteRow()]), null, []);

  it("adds the ponding at the offer's point, and still calls the terrain dry", () => {
    const pricing = priceOffer({ dataset: scoreDataset, params: REFERENCE_PARAMS, drainage: state, rows, terms: NO_TERMS, wards: null });
    const priced = pricing.rows[0];
    if (priced.status !== "priced") throw new Error("the row should be priced");
    expect(pricing.drainageOn).toBe(true);
    expect(priced.scenarios.map((s) => s.terrainM)).toEqual([0, 0]);
    expect(priced.scenarios[0].drainageM).toBeCloseTo(DRAINAGE_DEFAULTS.depthM.extreme, 6);
    expect(priced.scenarios[1].drainageM).toBeCloseTo(DRAINAGE_DEFAULTS.depthM.common, 6);
    expect(priced.scenarios.map((s) => s.depthM)).toEqual(priced.scenarios.map((s) => s.drainageM));
    expect(priced.scenarios[1].groundUpKes).toBeGreaterThan(0);
    expect(priced.dryInEveryTier).toBe(true);
    expect(priced.scenarios.every((s) => s.nearestWetM !== null && s.nearestWetM > 0)).toBe(true);

    // The portfolio alone matches the app's own run with drainage on.
    const own = runModel(withDrainage(scoreDataset, state), REFERENCE_PARAMS);
    expect(pricing.portfolio?.without.aalKes).toBe(own.aalKes);
    expect(pricing.portfolio!.with.aalKes - own.aalKes).toBeCloseTo(priced.aalGroundUpKes, 4);
  });

  it("ignores drainage already on the dataset when the switch is off", () => {
    const pricing = priceOffer({ dataset: withDrainage(scoreDataset, state), params: REFERENCE_PARAMS, drainage: null, rows, terms: NO_TERMS, wards: null });
    const priced = pricing.rows[0];
    if (priced.status !== "priced") throw new Error("the row should be priced");
    expect(pricing.drainageOn).toBe(false);
    expect(priced.scenarios.map((s) => s.drainageM)).toEqual([0, 0]);
    expect(priced.aalGroundUpKes).toBe(0);
    expect(pricing.portfolio?.without.aalKes).toBe(runModel(scoreDataset, REFERENCE_PARAMS).aalKes);
  });
});

// --- checks ------------------------------------------------------------------------------------

describe("offer checks", () => {
  const waterways: GeoCollection<WaterwayProps> = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { kind: "river", name: "Maji River" }, geometry: { type: "LineString", coordinates: [[SITE.lon + 0.01, -1.4], [SITE.lon + 0.01, -1.2]] } }],
  };
  // About 1.1 km west of the mapped river.
  const mappedM = 0.01 * 111320 * Math.cos((SITE.lat * Math.PI) / 180);

  function run(e: OfferExtraction, layer: GeoCollection<WaterwayProps> | null = waterways) {
    const rows = pricingRows(e, null, []);
    const pricing = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: policyTerms(e.terms, DEFAULT_TERMS), wards: null });
    const checks = offerChecks({ extraction: e, rows, pricing, dataset: depthDataset, waterways: layer });
    return { checks, byId: (id: string) => checks.find((c) => c.id === id) };
  }

  it("uses the agreed ids and groups, one per row where the check is about a building", () => {
    const { checks } = run(
      extraction(
        [siteRow(), siteRow({ name: stated("Far Mill"), lat: stated(0.5), lon: stated(34.5) })],
        { basements: stated(2), occupancy: stated("commercial"), riverName: stated("Maji River"), riverDistanceM: stated(1100) },
        [note("past_flood", "water in the car park")],
      ),
    );
    const groups: Record<string, string> = { "offer-values": "ai", "offer-coordinates": "data", "offer-river": "hazard", "offer-value-per-m2": "data", "offer-basements": "hazard", "offer-flood-history": "hazard", "offer-curve": "vulnerability" };
    for (const c of checks) {
      const [id, locId] = c.id.split(":");
      expect(OFFER_CHECK_IDS as readonly string[]).toContain(id);
      expect(c.group).toBe(groups[id]);
      if (locId) expect(locId).toMatch(/^OFFER-\d+$/);
    }
    expect(checks.map((c) => c.id)).toEqual([
      "offer-values",
      "offer-coordinates:OFFER-1",
      "offer-coordinates:OFFER-2",
      "offer-river:OFFER-1",
      "offer-river:OFFER-2",
      "offer-value-per-m2:OFFER-1",
      "offer-value-per-m2:OFFER-2",
      "offer-basements",
      "offer-flood-history:OFFER-1",
      "offer-curve",
    ]);
  });

  it("says whether each point is inside the maps and how it was read", () => {
    const reading: CoordinateReading = { lat: SITE.lat, lon: SITE.lon, latHow: "both_agree", lonHow: "hemisphere", raw: "an invented pair", writtenBothWays: true, conflict: false };
    const { byId } = run(extraction([siteRow({ coordinates: reading }), siteRow({ lat: stated(0.5), lon: stated(34.5) }), siteRow({ lat: { ...stated(SITE.lat), status: "edited" } }), row()]));
    expect(byId("offer-coordinates:OFFER-1")).toMatchObject({ status: "warn" });
    expect(byId("offer-coordinates:OFFER-1")?.detail).toContain("both ways");
    expect(byId("offer-coordinates:OFFER-1")?.detail).toContain("inside the area covered by all 2 hazard maps");
    expect(byId("offer-coordinates:OFFER-2")).toMatchObject({ status: "fail" });
    expect(byId("offer-coordinates:OFFER-2")?.detail).toContain(OUTSIDE_MAPS_MESSAGE);
    expect(byId("offer-coordinates:OFFER-3")).toMatchObject({ status: "pass" });
    expect(byId("offer-coordinates:OFFER-3")?.detail).toContain("typed by the underwriter");
    expect(byId("offer-coordinates:OFFER-4")).toMatchObject({ status: "fail" });
  });

  it("flags an approximate location", () => {
    const e = extraction([row({ housingClass: stated("permanent_masonry"), tivKes: stated(8_000_000) })], { placeName: stated("Soko Kuu") });
    const rows = pricingRows(e, null, [{ name: "Soko Kuu", lat: SITE.lat, lon: SITE.lon }]);
    const pricing = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: NO_TERMS, wards: null });
    const found = offerChecks({ extraction: e, rows, pricing, dataset: depthDataset, waterways: null }).find((c) => c.id === "offer-coordinates:OFFER-1");
    expect(pricing.rows[0].status).toBe("priced");
    expect(found?.status).toBe("warn");
    expect(found?.detail).toContain("approximate");
  });

  it("warns when a named flood area is dry on the terrain maps", () => {
    const dry = cell(3, 0);
    const e = extraction([row({ housingClass: stated("permanent_masonry"), tivKes: stated(8_000_000) })], { placeName: stated("Soko Kuu") });
    const rows = pricingRows(e, null, [{ name: "Soko Kuu", lat: dry.lat, lon: dry.lon }]);
    const pricing = priceOffer({ dataset: depthDataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: NO_TERMS, wards: null });
    const found = offerChecks({ extraction: e, rows, pricing, dataset: depthDataset, waterways: null }).find((c) => c.id === "offer-flood-history:OFFER-1");
    expect(found?.status).toBe("warn");
    expect(found?.detail).toContain("named flood areas");
  });

  it("compares the stated river distance with the map", () => {
    const near = run(extraction([siteRow()], { riverName: stated("Maji River"), riverDistanceM: stated(Math.round(mappedM)) })).byId("offer-river:OFFER-1");
    expect(near?.status).toBe("pass");
    const far = run(extraction([siteRow()], { riverName: stated("River Maji"), riverDistanceM: stated(3000) })).byId("offer-river:OFFER-1");
    expect(far?.status).toBe("warn");
    expect(far?.detail).toContain("closer than stated");
    const unmapped = run(extraction([siteRow()], { riverName: stated("Nzoia River"), riverDistanceM: stated(1800) })).byId("offer-river:OFFER-1");
    expect(unmapped?.status).toBe("warn");
    expect(unmapped?.detail).toContain("not in the open waterways layer");
    expect(run(extraction([siteRow()], { riverName: stated("Maji River") }), null).byId("offer-river:OFFER-1")?.detail).toContain("not loaded");
    expect(run(extraction([siteRow()])).byId("offer-river:OFFER-1")).toBeUndefined();
  });

  it("flags possible under-insurance below the portfolio's cost per m² for the class", () => {
    // The toy portfolio's permanent masonry costs KES 50,000 per m².
    const low = run(extraction([siteRow()])).byId("offer-value-per-m2:OFFER-1"); // 10m over 1,000 m²
    expect(low?.status).toBe("warn");
    expect(low?.detail).toContain("possible under-insurance");
    const level = run(extraction([siteRow({ tivKes: stated(50_000_000) })])).byId("offer-value-per-m2:OFFER-1");
    expect(level?.status).toBe("pass");
    const high = run(extraction([siteRow({ tivKes: stated(90_000_000) })])).byId("offer-value-per-m2:OFFER-1");
    expect(high?.status).toBe("warn");
    expect(high?.detail).not.toContain("under-insurance");
    const otherClass = run(extraction([siteRow({ housingClass: stated("concrete_rcc") })])).byId("offer-value-per-m2:OFFER-1");
    expect(otherClass?.detail).toContain("no cost per m²");
  });

  it("states basements and a non-residential building as limits, not failures", () => {
    const { byId } = run(extraction([siteRow()], { basements: stated(3), occupancy: stated("commercial") }, [note("basement_plant", "generators below ground")]));
    expect(byId("offer-basements")).toMatchObject({ status: "warn", group: "hazard" });
    expect(byId("offer-basements")?.detail).toContain("water entering a basement is not read from them");
    expect(byId("offer-basements")?.detail).toContain("3 basement levels");
    expect(byId("offer-curve")).toMatchObject({ status: "warn", group: "vulnerability" });
    expect(byId("offer-curve")?.detail).toContain("commercial building");
    expect(byId("offer-curve")?.detail).toContain("limit of the model");

    const home = run(extraction([siteRow()], { basements: stated(0), occupancy: stated("residential") }));
    expect(home.byId("offer-basements")?.status).toBe("pass");
    expect(home.byId("offer-curve")?.status).toBe("pass");
    const silent = run(extraction([siteRow()]));
    expect(silent.byId("offer-basements")).toBeUndefined();
    expect(silent.byId("offer-curve")).toBeUndefined();
  });

  it("sets the reported flood history against the maps, both ways round", () => {
    const dry = cell(3, 0); // dry in both maps
    const dryRow = siteRow({ lat: stated(dry.lat), lon: stated(dry.lon) });
    const reportedButDry = run(extraction([dryRow], {}, [note("past_flood", "water in the car park")])).byId("offer-flood-history:OFFER-1");
    expect(reportedButDry?.status).toBe("warn");
    expect(reportedButDry?.detail).toContain("dry at this point in all 2 tiers");
    const wetButSilent = run(extraction([siteRow()])).byId("offer-flood-history:OFFER-1");
    expect(wetButSilent?.status).toBe("warn");
    expect(wetButSilent?.detail).toContain("1-in-100");
    expect(run(extraction([siteRow()], {}, [note("past_flood", "water in the car park")])).byId("offer-flood-history:OFFER-1")?.status).toBe("pass");
    expect(run(extraction([dryRow])).byId("offer-flood-history:OFFER-1")?.status).toBe("pass");
    // A note that failed its check does not count as a report.
    const unchecked: OfferNote = { ...note("past_flood", "water in the car park"), status: "unverified", reason: "the sentence is not in the document" };
    expect(run(extraction([dryRow], {}, [unchecked])).byId("offer-flood-history:OFFER-1")?.status).toBe("pass");
  });

  it("counts what was verified and what still needs the underwriter", () => {
    const unverified: Quoted<number> = { value: 5, quote: "an invented sentence", status: "unverified", reason: "the number is not in the sentence" };
    const flagged = run(extraction([siteRow()], { floodDeductiblePct: unverified })).byId("offer-values");
    expect(flagged?.status).toBe("warn");
    expect(flagged?.detail).toContain("1 unverified");
    expect(flagged?.detail).toContain("1 row read by the fixed rules");
    expect(run(extraction([siteRow()])).byId("offer-values")?.status).toBe("pass");
  });

  it("writes nothing with a long dash", () => {
    const { checks } = run(extraction([siteRow(), row()], { basements: stated(1), occupancy: stated("industrial"), riverName: stated("Maji River"), riverDistanceM: stated(200) }, [note("past_flood", "water in the car park")]));
    for (const c of checks) expect(`${c.title} ${c.detail}`).not.toMatch(/[\u2013\u2014]/);
  });
});

// --- CSV ---------------------------------------------------------------------------------------

describe("offer CSV", () => {
  const rows = pricingRows(extraction([siteRow({ costPerM2Kes: stated(10_000) }), row({ name: stated("No Place") })]), null, []);

  it("has the exposure file's columns in the starter kit's order", () => {
    expect([...OFFER_CSV_COLUMNS]).toEqual(["loc_id", "lat", "lon", "housing_class", "floor_area_m2", "cost_per_m2_kes", "tiv_kes", "synthetic", "source"]);
    const text = offerCsv(rows, "memo.docx");
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("loc_id,lat,lon,housing_class,floor_area_m2,cost_per_m2_kes,tiv_kes,synthetic,source");
    expect(lines[1]).toBe(`OFFER-1,${SITE.lat},${SITE.lon},permanent_masonry,1000,10000,10000000,false,offer:memo.docx`);
    // A row with nothing known is still written, with blanks and never a zero.
    expect(lines[2]).toBe("OFFER-2,,,,,,,false,offer:memo.docx");
  });

  it("escapes a file name that holds commas, quotes or line breaks", () => {
    const text = offerCsv(rows, 'Offer, "final"\nversion.docx');
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.meta.fields).toEqual([...OFFER_CSV_COLUMNS]);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].source).toBe('offer:Offer, "final" version.docx');
    expect(parsed.data[0].synthetic).toBe("false");
    expect(Number(parsed.data[0].lat)).toBe(SITE.lat);
  });

  it("writes a header alone for no rows, and names typed text as its source", () => {
    expect(offerCsv([], "memo.docx")).toBe(`${OFFER_CSV_COLUMNS.join(",")}\n`);
    expect(offerCsv(rows.slice(0, 1), "  ")).toContain("offer:typed text");
  });
});

// --- the starter kit's own maps ----------------------------------------------------------------

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

describe.skipIf(!existsSync(KIT))("an offer on the starter kit's Nairobi maps", () => {
  const geo = <P,>(file: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "geo", file), "utf8")) as GeoCollection<P>;
  const wards = geo<WardProps>("wards.geojson");
  const waterways = geo<WaterwayProps>("waterways.geojson");
  let dataset: Dataset;

  beforeAll(async () => {
    const { candidates, files } = await detectDatasets(filesUnder(KIT));
    dataset = (await loadDataset(candidates.find((c) => c.name === "team_a_nairobi")!, files)).dataset;
  }, 120_000);

  it("places a typed place name on a named flood area, approximately, and prices it", () => {
    const e = extraction([row({ housingClass: stated("permanent_masonry"), tivKes: stated(8_000_000) })], { placeName: stated("Kibera") });
    const rows = pricingRows(e, wards, dataset.hotspots);
    const at = rows[0].location;
    if (at.kind !== "approximate") throw new Error("the location should be approximate");
    expect(at).toMatchObject({ source: "hotspot", matchedName: "Kibera", placeName: "Kibera" });

    const pricing = priceOffer({ dataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: NO_TERMS, wards });
    const priced = pricing.rows[0];
    if (priced.status !== "priced") throw new Error("the row should be priced");
    expect(priced.scenarios.map((s) => s.returnPeriod)).toEqual([10, 25, 50, 100, 250]);
    expect(priced.ward).not.toBeNull();

    // The portfolio's own figures are exactly the app's, and the offer adds exactly its own loss:
    // the tier slopes did not move when a building was added.
    const own = runModel(dataset, REFERENCE_PARAMS);
    expect(pricing.portfolio?.without.aalKes).toBe(own.aalKes);
    expect(pricing.portfolio?.without.loss100Kes).toBe(own.standardLosses.find((s) => s.returnPeriod === 100)!.lossKes);
    expect(pricing.portfolio?.with.buildings).toBe(own.buildingCount + 1);
    expect(pricing.portfolio!.with.aalKes - own.aalKes).toBeCloseTo(priced.aalGroundUpKes, 2);
    expect(dataset.buildings).toHaveLength(own.buildingCount);

    // Where the terrain is dry, the distance to water matches a cell by cell search of the same map.
    for (const s of priced.scenarios) {
      const map = dataset.rasters.find((r) => r.scenarioId === s.id)!;
      if (s.hazard > 0) expect(s.nearestWetM).toBeNull();
      else expect(s.nearestWetM).toBeCloseTo(nearestWetSlow(map, at.lon, at.lat, "score") as number, 4);
    }
  });

  it("reports a point on the Nzoia as outside the Nairobi maps, with no loss", () => {
    const rows = pricingRows(extraction([siteRow({ lat: stated(0.12), lon: stated(34.1) })]), wards, dataset.hotspots);
    const pricing = priceOffer({ dataset, params: REFERENCE_PARAMS, drainage: null, rows, terms: NO_TERMS, wards });
    expect(pricing.rows[0]).toMatchObject({ status: "outside", message: OUTSIDE_MAPS_MESSAGE });
    expect(pricing.totals).toBeNull();
    expect(pricing.portfolio).toBeNull();
  });

  it("puts every ward's stand-in point inside that ward", () => {
    for (const f of wards.features) {
      const found = locateByName(f.properties.name, wards, []);
      expect(found?.matchedName).toBe(f.properties.name);
      expect(wardOf(found!, wards)?.name).toBe(f.properties.name);
    }
  });

  it("measures to a named river in the open waterways layer, and says nothing for one that is not there", () => {
    const centre = { lat: -1.2864, lon: 36.8172 };
    const found = riverDistanceM(centre, "River Nairobi", waterways);
    expect(found?.matchedName.toLowerCase()).toContain("nairobi");
    expect(found!.distanceM).toBeGreaterThan(0);
    expect(found!.distanceM).toBeLessThan(3000);
    expect(riverDistanceM(centre, "Nzoia River", waterways)).toBeNull();
  });

  it("finds the nearest wet cell on all five maps quickly enough for the browser", () => {
    const points = dataset.hotspots.slice(0, 12);
    const started = performance.now();
    for (const m of dataset.rasters) for (const p of points) nearestWetCellM(m, p.lon, p.lat, "score");
    const ms = performance.now() - started;
    console.log(`Nearest wet cell: ${points.length} points on ${dataset.rasters.length} maps of ${dataset.rasters[0].width} x ${dataset.rasters[0].height} cells in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
