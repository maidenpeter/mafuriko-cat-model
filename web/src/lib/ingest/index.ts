import Papa from "papaparse";
import {
  FALLBACK_CLASS,
  HOUSING_CLASSES,
  SCORE_TIERS,
  type Building,
  type Dataset,
  type HazardKind,
  type Hotspot,
  type HousingClass,
  type Raster,
  type ScenarioDef,
} from "../model/types";
import { inKenya, parseCoordinates } from "../offer/coords";
import { docxToText } from "../offer/docx";
import { readRaster, sampleRaster } from "./raster";

/** A file from the upload, however it was obtained (zip entry in the browser, disk in tests). */
export interface FileSource {
  path: string;
  size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FileKind = "exposure" | "hazard-raster" | "hotspots" | "offer" | "other";
export type Provenance = "real" | "proxy" | "synthetic" | "none";

export interface FileInfo {
  path: string;
  name: string;
  size: number;
  kind: FileKind;
  provenance: Provenance;
  note: string;
  used: boolean;
}

export interface DatasetCandidate {
  /** Folder the files sit in. */
  dir: string;
  name: string;
  hazardKind: HazardKind;
  exposure: FileSource;
  exposureHasHazardColumns: boolean;
  otherExposureFiles: string[];
  rasters: { file: FileSource; scenario: ScenarioDef }[];
  hotspots: FileSource | null;
}

export interface IngestReport {
  files: FileInfo[];
  exposureFile: string;
  hazardSource: "rasters" | "columns";
  rowsInFile: number;
  rowsParsed: number;
  rowsDropped: { row: number; reason: string }[];
  missingColumns: string[];
  unknownClasses: { value: string; count: number }[];
  syntheticColumnPresent: boolean;
  syntheticFlagged: number;
  /** tiv_kes ÷ (floor_area_m2 × cost_per_m2_kes) across rows that have all three. */
  tivRatio: { n: number; min: number; median: number; max: number } | null;
  /** Buildings that fall outside the hazard maps. */
  outsideRaster: number;
  /** Comparison of our raster lookup against hazard columns already in the file. */
  attached: { compared: number; matched: number; maxAbsDiff: number } | null;
  hotspotRows: number;
}

const REQUIRED_COLUMNS = ["loc_id", "lat", "lon", "housing_class", "tiv_kes"];
const TIER_PATTERN = new RegExp(`(?:^|[^a-z])(${SCORE_TIERS.join("|")})(?:[^a-z]|$)`);
const RP_PATTERN = /rp[_-]?(\d+)\s*y?/;

const baseName = (path: string) => path.split("/").pop() ?? path;
const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const isJunk = (path: string) => path.startsWith("__MACOSX/") || baseName(path).startsWith(".");

function scenarioFromFileName(name: string): { kind: HazardKind; scenario: ScenarioDef } | null {
  const lower = name.toLowerCase();
  const tier = lower.match(TIER_PATTERN);
  if (tier) return { kind: "score", scenario: { id: tier[1], label: tier[1] } };
  const rp = lower.match(RP_PATTERN);
  if (rp) {
    const years = Number(rp[1]);
    return { kind: "depth_m", scenario: { id: `rp${years}y`, label: `1 in ${years} years`, fixedReturnPeriod: years } };
  }
  return null;
}

// A file that describes the data or the task, whatever numbers it quotes: told by its name, its heading, or the column names it lists.
const DOCUMENTATION_NAME = /problem[\s_-]*statement|dictionary|metadata|read[\s_-]?me|guide|licen[cs]e/i;
const DOCUMENTATION_HEADING = /\b(?:problem\s+statement|data\s+dictionary|dataset\s+metadata)\b/i;
const COLUMN_NAMES = /\b(?:loc_id|tiv_kes|housing_class|floor_area_m2|cost_per_m2_kes)\b/;
// "Sum insured: KES 8,000,000", "TIV of KSh 4.2 billion", "total insured value (KES 950m)".
const SUM_INSURED = /\b(?:TIV|total\s+insured\s+value|(?:total\s+)?sums?\s+insured|insured\s+value)\b[^\n]{0,40}?\bK(?:ES|SHS?)\b\.?\s*\d/i;

/**
 * True when a document reads like an offer to price: it gives a position in Kenya, or a sum
 * insured in KES. A problem statement or a data dictionary is never an offer, even though it
 * may quote both.
 */
export function looksLikeOffer(name: string, text: string): boolean {
  if (DOCUMENTATION_NAME.test(name)) return false;
  if (DOCUMENTATION_HEADING.test(text.slice(0, 600)) || COLUMN_NAMES.test(text)) return false;
  if (SUM_INSURED.test(text)) return true;
  const point = parseCoordinates(text);
  return point !== null && inKenya(point.lat, point.lon);
}

/** The words of a .docx or .txt, or null when the file cannot be read as one. */
async function documentText(file: FileSource, lowerName: string): Promise<string | null> {
  try {
    return lowerName.endsWith(".docx") ? await docxToText(await file.arrayBuffer()) : await file.text();
  } catch {
    return null;
  }
}

async function csvHeader(file: FileSource): Promise<string[]> {
  const text = await file.text();
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  return (Papa.parse<string[]>(firstLine).data[0] ?? []).map((h) => h.trim().toLowerCase());
}

/**
 * Sort the uploaded files into datasets. A dataset is a folder holding an
 * exposure CSV, with whatever hazard rasters and hotspots sit beside it.
 * Offers found among the files (a .docx or .txt that reads like one) come back in `offers`,
 * in the order of the upload: they are not model inputs, they go to the offer step.
 */
export async function detectDatasets(files: FileSource[], uploadName = "upload"): Promise<{ candidates: DatasetCandidate[]; files: FileInfo[]; offers: FileSource[] }> {
  const usable = files.filter((f) => !isJunk(f.path));
  const infos: FileInfo[] = [];
  const offers: FileSource[] = [];
  const byDir = new Map<string, { exposures: { file: FileSource; hasHazard: boolean }[]; rasters: { file: FileSource; kind: HazardKind; scenario: ScenarioDef }[]; hotspots: FileSource | null }>();
  const group = (dir: string) => {
    if (!byDir.has(dir)) byDir.set(dir, { exposures: [], rasters: [], hotspots: null });
    return byDir.get(dir)!;
  };

  for (const file of usable) {
    const name = baseName(file.path);
    const lower = name.toLowerCase();
    const info: FileInfo = { path: file.path, name, size: file.size, kind: "other", provenance: "none", note: "Not a model input", used: false };

    if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
      const found = scenarioFromFileName(name);
      if (found) {
        group(dirName(file.path)).rasters.push({ file, ...found });
        info.kind = "hazard-raster";
        info.provenance = found.kind === "score" ? "proxy" : "real";
        info.note = found.kind === "score" ? `Susceptibility score 0 to 1, tier "${found.scenario.id}"` : `Flood depth in metres, ${found.scenario.label}`;
      } else {
        info.note = "Raster with no tier or return period in its name";
      }
    } else if (lower.endsWith(".csv")) {
      const header = await csvHeader(file);
      const has = (c: string) => header.includes(c);
      if (has("lat") && has("lon") && has("tiv_kes")) {
        const hasHazard = header.some((h) => h.startsWith("hazard_score_"));
        group(dirName(file.path)).exposures.push({ file, hasHazard });
        info.kind = "exposure";
        info.provenance = "synthetic";
        info.note = hasHazard ? "Buildings with hazard scores already attached" : "Buildings";
      } else if (has("name") && has("lat") && has("lon")) {
        group(dirName(file.path)).hotspots = file;
        info.kind = "hotspots";
        info.provenance = "real";
        info.note = "Named flood-prone areas, used to check the hazard layer";
      } else {
        info.note = "CSV with unrecognised columns";
      }
    } else if (/\.(docx|txt)$/.test(lower)) {
      const text = await documentText(file, lower);
      if (text !== null && looksLikeOffer(name, text)) {
        offers.push(file);
        info.kind = "offer";
        info.note = "An offer to price, opened in the offer step";
      } else {
        info.note = "Documentation";
      }
    } else if (/\.(md|pdf)$/.test(lower)) {
      info.note = "Documentation";
    }
    infos.push(info);
  }

  const candidates: DatasetCandidate[] = [];
  for (const [dir, g] of byDir) {
    if (g.exposures.length === 0) continue;
    // Prefer the file that carries hazard columns: same buildings, and it lets us cross-check the raster lookup.
    const chosen = g.exposures.find((e) => e.hasHazard) ?? g.exposures[0];
    const kind: HazardKind = g.rasters.length > 0 ? g.rasters[0].kind : "score";
    const rasters = g.rasters.filter((r) => r.kind === kind).map(({ file, scenario }) => ({ file, scenario }));
    if (rasters.length === 0 && !chosen.hasHazard) continue;
    candidates.push({
      dir,
      name: dir ? baseName(dir) : uploadName,
      hazardKind: kind,
      exposure: chosen.file,
      exposureHasHazardColumns: chosen.hasHazard,
      otherExposureFiles: g.exposures.filter((e) => e !== chosen).map((e) => e.file.path),
      rasters,
      hotspots: g.hotspots,
    });
  }
  return { candidates, files: infos, offers };
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  return s === "" ? NaN : Number(s);
};

const parseFlag = (v: unknown): boolean | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  return ["true", "1", "yes"].includes(String(v).trim().toLowerCase());
};

function parseCsv(text: string): { rows: Record<string, string>[]; header: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  return { rows: parsed.data, header: parsed.meta.fields ?? [] };
}

const median = (sorted: number[]) => (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

export interface IngestProgress {
  (message: string): void;
}

/** Read one dataset fully: buildings, hazard values, hotspots, and a report of everything noticed on the way. */
export async function loadDataset(candidate: DatasetCandidate, allFiles: FileInfo[], onProgress: IngestProgress = () => {}): Promise<{ dataset: Dataset; report: IngestReport }> {
  const kind = candidate.hazardKind;

  onProgress(`Reading ${baseName(candidate.exposure.path)}`);
  const text = await candidate.exposure.text();
  // Counted independently of the parser, so "rows read = rows in file" is a real check.
  const rowsInFile = text.split(/\r?\n/).filter((line) => line.trim() !== "").length - 1;
  const { rows, header } = parseCsv(text);
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !header.includes(c));

  // Scenarios: score tiers in fixed order (narrowest footprint first), depth maps by rising return period.
  let scenarios: ScenarioDef[];
  if (candidate.rasters.length > 0) {
    scenarios = candidate.rasters.map((r) => r.scenario);
    scenarios.sort((a, b) => (kind === "score" ? SCORE_TIERS.indexOf(a.id as never) - SCORE_TIERS.indexOf(b.id as never) : a.fixedReturnPeriod! - b.fixedReturnPeriod!));
  } else {
    scenarios = SCORE_TIERS.filter((t) => header.includes(`hazard_score_${t}`)).map((t) => ({ id: t, label: t }));
  }

  const rasters: Raster[] = [];
  for (const s of scenarios) {
    const entry = candidate.rasters.find((r) => r.scenario.id === s.id);
    if (!entry) continue;
    onProgress(`Reading hazard map ${baseName(entry.file.path)}`);
    rasters.push(await readRaster(await entry.file.arrayBuffer(), s.id, baseName(entry.file.path)));
  }
  const hazardSource: IngestReport["hazardSource"] = rasters.length === scenarios.length && rasters.length > 0 ? "rasters" : "columns";

  onProgress("Looking up each building on the hazard maps");
  const buildings: Building[] = [];
  const rowsDropped: IngestReport["rowsDropped"] = [];
  const unknown = new Map<string, number>();
  const ratios: number[] = [];
  let syntheticFlagged = 0;
  let outsideRaster = 0;
  const attached = { compared: 0, matched: 0, maxAbsDiff: 0 };
  const hasAttached = kind === "score" && scenarios.every((s) => header.includes(`hazard_score_${s.id}`));

  rows.forEach((row, i) => {
    const lat = num(row.lat);
    const lon = num(row.lon);
    const tivKes = num(row.tiv_kes);
    const problems = [
      !Number.isFinite(lat) && "missing latitude",
      !Number.isFinite(lon) && "missing longitude",
      !(tivKes >= 0) && "missing or negative insured value",
    ].filter(Boolean);
    if (problems.length > 0) {
      rowsDropped.push({ row: i + 2, reason: problems.join(", ") });
      return;
    }

    const raw = (row.housing_class ?? "").trim();
    const known = (HOUSING_CLASSES as readonly string[]).includes(raw);
    if (!known) unknown.set(raw || "(blank)", (unknown.get(raw || "(blank)") ?? 0) + 1);

    const floorAreaM2 = num(row.floor_area_m2);
    const costPerM2Kes = num(row.cost_per_m2_kes);
    if (floorAreaM2 > 0 && costPerM2Kes > 0) ratios.push(tivKes / (floorAreaM2 * costPerM2Kes));

    const synthetic = parseFlag(row.synthetic);
    if (synthetic) syntheticFlagged += 1;

    let hazard: number[];
    if (hazardSource === "rasters") {
      const samples = rasters.map((r) => sampleRaster(r, lon, lat, kind));
      if (samples.some((s) => !s.inside)) outsideRaster += 1;
      hazard = samples.map((s) => s.value);
      if (hasAttached) {
        scenarios.forEach((s, k) => {
          const fromFile = num(row[`hazard_score_${s.id}`]);
          if (!Number.isFinite(fromFile)) return;
          const diff = Math.abs(fromFile - hazard[k]);
          attached.compared += 1;
          if (diff <= 1e-4) attached.matched += 1;
          attached.maxAbsDiff = Math.max(attached.maxAbsDiff, diff);
        });
      }
    } else {
      hazard = scenarios.map((s) => {
        const v = num(row[`hazard_score_${s.id}`]);
        return v > 0 ? v : 0;
      });
    }

    buildings.push({
      locId: row.loc_id?.trim() || `row-${i + 2}`,
      lat,
      lon,
      housingClassRaw: raw,
      housingClass: known ? (raw as HousingClass) : FALLBACK_CLASS,
      floorAreaM2: Number.isFinite(floorAreaM2) ? floorAreaM2 : null,
      costPerM2Kes: Number.isFinite(costPerM2Kes) ? costPerM2Kes : null,
      tivKes,
      synthetic,
      hazard,
    });
  });

  let hotspots: Hotspot[] = [];
  if (candidate.hotspots) {
    onProgress(`Reading ${baseName(candidate.hotspots.path)}`);
    hotspots = parseCsv(await candidate.hotspots.text())
      .rows.map((r) => ({ name: (r.name ?? "").trim(), lat: num(r.lat), lon: num(r.lon) }))
      .filter((h) => h.name && Number.isFinite(h.lat) && Number.isFinite(h.lon));
  }

  ratios.sort((a, b) => a - b);
  const usedPaths = new Set([candidate.exposure.path, ...candidate.rasters.map((r) => r.file.path), ...(candidate.hotspots ? [candidate.hotspots.path] : [])]);
  const files = allFiles.map((f) => ({
    ...f,
    used: usedPaths.has(f.path),
    note: candidate.otherExposureFiles.includes(f.path) ? "Same buildings without hazard columns; not needed" : f.note,
  }));

  return {
    dataset: { name: candidate.name, hazardKind: kind, scenarios, buildings, hotspots, rasters },
    report: {
      files,
      exposureFile: candidate.exposure.path,
      hazardSource,
      rowsInFile,
      rowsParsed: buildings.length,
      rowsDropped,
      missingColumns,
      unknownClasses: [...unknown].map(([value, count]) => ({ value, count })),
      syntheticColumnPresent: header.includes("synthetic"),
      syntheticFlagged,
      tivRatio: ratios.length ? { n: ratios.length, min: ratios[0], median: median(ratios), max: ratios[ratios.length - 1] } : null,
      outsideRaster,
      attached: hazardSource === "rasters" && hasAttached ? attached : null,
      hotspotRows: hotspots.length,
    },
  };
}
