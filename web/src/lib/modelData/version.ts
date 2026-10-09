/**
 * A model data version: one dated folder of input files with its manifest.json, never edited in
 * place (a change is a new dated folder). This file holds the manifest's shape and the pure
 * helpers that both the server (Node) and the browser use. Nothing here reads the disk or the
 * network.
 *
 * For a screen:
 *   version.id                the folder name, "<YYYY-MM-DD>_<short-label>": what the header shows
 *   version.status            "draft" | "approved" | "retired"
 *   version.area              the area facts the map and the model read (see ModelDataArea)
 *   version.files             one entry per input file: role, provenance, sha256, size, counts
 *   hashesOf(version)         16 hex characters made from the file hashes, for trace blocks and cache keys
 *   chooseDefault(versions)   which version opens by default, and a sentence saying why
 *   modelDataHeader(id, from) the header line: "Model data: <id>, loaded from cache"
 *
 * The layout on disk, read by server.ts and written by scripts/make-version.mjs:
 *   <MODEL_DATA_DIR>/<YYYY-MM-DD>_<short-label>/manifest.json
 *   <MODEL_DATA_DIR>/<YYYY-MM-DD>_<short-label>/<the input files, at any depth>
 */
import { SCORE_TIERS, type HazardKind, type ScoreTier } from "../model/types";

/** The manifest's file name inside a version folder. */
export const MANIFEST_FILE = "manifest.json";

/** The id the server gives a folder that holds the files directly, with no manifest (the starter kit as it came). */
export const UNVERSIONED_ID = "unversioned";

/** A version id is its folder name: the date, an underscore, and a short lower-case label. */
export const VERSION_ID = /^(\d{4}-\d{2}-\d{2})_([a-z0-9][a-z0-9-]*)$/;

export const VERSION_STATUSES = ["draft", "approved", "retired"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const FILE_ROLES = ["exposure", "hazard", "wards", "drainage", "hotspots", "other"] as const;
export type FileRole = (typeof FILE_ROLES)[number];

export const PROVENANCES = ["real", "proxy", "synthetic"] as const;
export type FileProvenance = (typeof PROVENANCES)[number];

/** "score": tiers of a 0 to 1 susceptibility score (Nairobi). "depth": flood depth maps with their own return periods. */
export const AREA_HAZARD_KINDS = ["score", "depth"] as const;
export type AreaHazardKind = (typeof AREA_HAZARD_KINDS)[number];

/** [minLon, minLat, maxLon, maxLat] */
export type Extent = [number, number, number, number];

/**
 * The area a version covers. A screen takes its map centre, zoom and names from here and never
 * from a constant of its own.
 */
export interface ModelDataArea {
  /** Short lower-case id: "nairobi". The default version is chosen by it. */
  id: string;
  /** The name a reader sees: "Nairobi". */
  name: string;
  /** Where the map opens: [longitude, latitude], the middle of the hazard maps' extent. */
  centre: [number, number];
  /** The zoom the map opens at, so that the hazard maps' extent fits. */
  zoom: number;
  hazardKind: AreaHazardKind;
  /** Return period in years per score tier (extreme, severe, moderate, occasional, common). Absent for depth maps. */
  returnPeriodsByTier?: Record<string, number>;
  /** The name of the file of named flood-prone areas, as listed in files. */
  hotspotsFile?: string;
  /** The hazard maps' extent, for a map that fits bounds rather than opening on centre and zoom. */
  extent?: Extent;
}

export interface ModelDataFile {
  /** Path inside the version folder, forward slashes: "team_a_nairobi/exposure.csv". */
  name: string;
  role: FileRole;
  provenance: FileProvenance;
  /** Lower-case hex, 64 characters. */
  sha256: string;
  bytes: number;
  /** Data rows of a CSV, the header line not counted. */
  rows?: number;
  raster?: { width: number; height: number };
  /** Where the file comes from, in words, with a link when there is one. */
  source?: string;
  /** Who approved this file for use. Real data needs one before the version can be approved. */
  approvedBy?: string;
}

export interface ModelDataVersion {
  /** The folder name: "<YYYY-MM-DD>_<short-label>", or "unversioned" for a folder with no manifest. */
  id: string;
  /** YYYY-MM-DD, the date part of the id. */
  date: string;
  /** The label part of the id. */
  label: string;
  description: string;
  area: ModelDataArea;
  status: VersionStatus;
  files: ModelDataFile[];
  /** The sources behind the files, one sentence each. */
  sources: string[];
  notes: string[];
}

/**
 * A version as the listing reports it. `problem` is null when the version can be served, else a
 * sentence saying why not ("Changed since approval: ...", "manifest.json could not be read: ...").
 * A version with a problem is listed so the picker can show it, but is never the default and
 * none of its files is served.
 */
export interface ListedVersion extends ModelDataVersion {
  problem: string | null;
}

/** FNV-1a over the text from one starting value, as eight hex digits. */
function fnv(text: string, start: number): string {
  let h = start;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A short, stable fingerprint of a version's file hashes: 16 hex characters, the same in Node and
 * in the browser, the same whatever the order of the files. For cache keys and trace blocks; the
 * full sha256 of each file stays in version.files. scripts/make-version.mjs prints the same value.
 */
export function hashesOf(v: Pick<ModelDataVersion, "files">): string {
  const lines = v.files
    .map((f) => `${f.name} ${f.sha256}`)
    .sort()
    .join("\n");
  return fnv(lines, 0x811c9dc5) + fnv(lines, 0x9747b28c);
}

/**
 * True when a manifest file name is a plain relative path: forward slashes only, no empty, "."
 * or ".." segments, no hidden parts, no drive letter and no null byte. The server joins only
 * such names onto a version folder.
 */
export function isSafeFileName(name: unknown): name is string {
  if (typeof name !== "string" || name === "" || name.length > 512) return false;
  if (name.includes("\\") || name.includes("\0") || name.includes(":")) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}

/** The app's hazard kind for an area's: the data model says "depth_m" where a manifest says "depth". */
export function appHazardKind(kind: AreaHazardKind): HazardKind {
  return kind === "depth" ? "depth_m" : "score";
}

/** The area's return periods as the model's parameters hold them, or null when a tier is missing or not a positive number. */
export function returnPeriodsOf(area: Pick<ModelDataArea, "returnPeriodsByTier">): Record<ScoreTier, number> | null {
  const given = area.returnPeriodsByTier;
  if (!given) return null;
  const out = {} as Record<ScoreTier, number>;
  for (const tier of SCORE_TIERS) {
    const v = given[tier];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
    out[tier] = v;
  }
  return out;
}

/** The header's line on the model data: "Model data: 2026-10-09_nairobi-starter-kit, loaded from cache". */
export function modelDataHeader(id: string, loadedFrom: "cache" | "disk"): string {
  return `Model data: ${id}, loaded from ${loadedFrom}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === "string" && (set as readonly string[]).includes(v);

type Parsed = { ok: true; version: ModelDataVersion } | { ok: false; reason: string };
const bad = (reason: string): Parsed => ({ ok: false, reason });

function parseArea(a: unknown): { ok: true; area: ModelDataArea } | { ok: false; reason: string } {
  if (!isRecord(a)) return { ok: false, reason: "area is missing" };
  if (!isText(a.id) || !/^[a-z0-9][a-z0-9-]*$/.test(a.id)) return { ok: false, reason: "area.id must be a short lower-case id such as \"nairobi\"" };
  if (!isText(a.name) || a.name.trim() === "") return { ok: false, reason: "area.name is missing" };
  const c = a.centre;
  if (!Array.isArray(c) || c.length !== 2 || !isNum(c[0]) || !isNum(c[1]) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) {
    return { ok: false, reason: "area.centre must be [longitude, latitude]" };
  }
  if (!isNum(a.zoom) || a.zoom < 0 || a.zoom > 24) return { ok: false, reason: "area.zoom must be a map zoom between 0 and 24" };
  if (!oneOf(AREA_HAZARD_KINDS, a.hazardKind)) return { ok: false, reason: `area.hazardKind must be one of ${AREA_HAZARD_KINDS.join(", ")}` };
  const area: ModelDataArea = { id: a.id, name: a.name, centre: [c[0], c[1]], zoom: a.zoom, hazardKind: a.hazardKind };
  if (a.returnPeriodsByTier !== undefined) {
    const rp = a.returnPeriodsByTier;
    if (!isRecord(rp) || !Object.values(rp).every((v) => isNum(v) && v > 0)) return { ok: false, reason: "area.returnPeriodsByTier must map each tier to a positive number of years" };
    area.returnPeriodsByTier = { ...(rp as Record<string, number>) };
  }
  if (a.hotspotsFile !== undefined) {
    if (!isSafeFileName(a.hotspotsFile)) return { ok: false, reason: "area.hotspotsFile must name a file of the version" };
    area.hotspotsFile = a.hotspotsFile;
  }
  if (a.extent !== undefined) {
    const e = a.extent;
    if (!Array.isArray(e) || e.length !== 4 || !e.every(isNum) || e[0] >= e[2] || e[1] >= e[3]) return { ok: false, reason: "area.extent must be [minLon, minLat, maxLon, maxLat]" };
    area.extent = [e[0], e[1], e[2], e[3]];
  }
  return { ok: true, area };
}

function parseFile(f: unknown, index: number): { ok: true; file: ModelDataFile } | { ok: false; reason: string } {
  const at = `files[${index}]`;
  if (!isRecord(f)) return { ok: false, reason: `${at} is not an object` };
  if (!isSafeFileName(f.name)) return { ok: false, reason: `${at}.name must be a plain relative path inside the version folder` };
  const name = f.name;
  if (name === MANIFEST_FILE) return { ok: false, reason: `${at}: the manifest does not list itself` };
  if (!oneOf(FILE_ROLES, f.role)) return { ok: false, reason: `"${name}": role must be one of ${FILE_ROLES.join(", ")}` };
  if (!oneOf(PROVENANCES, f.provenance)) return { ok: false, reason: `"${name}": provenance must be one of ${PROVENANCES.join(", ")}` };
  if (!isText(f.sha256) || !/^[0-9a-f]{64}$/.test(f.sha256)) return { ok: false, reason: `"${name}": sha256 must be 64 lower-case hex characters` };
  if (!isCount(f.bytes)) return { ok: false, reason: `"${name}": bytes must be a whole number` };
  const file: ModelDataFile = { name, role: f.role, provenance: f.provenance, sha256: f.sha256, bytes: f.bytes };
  if (f.rows !== undefined) {
    if (!isCount(f.rows)) return { ok: false, reason: `"${name}": rows must be a whole number` };
    file.rows = f.rows;
  }
  if (f.raster !== undefined) {
    const r = f.raster;
    if (!isRecord(r) || !isCount(r.width) || !isCount(r.height) || r.width === 0 || r.height === 0) return { ok: false, reason: `"${name}": raster must give width and height` };
    file.raster = { width: r.width, height: r.height };
  }
  if (f.source !== undefined) {
    if (!isText(f.source)) return { ok: false, reason: `"${name}": source must be text` };
    file.source = f.source;
  }
  if (f.approvedBy !== undefined) {
    if (!isText(f.approvedBy)) return { ok: false, reason: `"${name}": approvedBy must be text` };
    file.approvedBy = f.approvedBy;
  }
  return { ok: true, file };
}

/**
 * The manifest as a ModelDataVersion, or the first thing wrong with it in a sentence. `folderName`
 * is the folder the manifest sits in: the id must be that name, so a copied or renamed folder is
 * caught. An approved version may hold real data only when each real file names its source and
 * who approved it; otherwise the manifest is refused and must say "draft" until they are added.
 */
export function parseManifest(json: unknown, folderName?: string): Parsed {
  if (!isRecord(json)) return bad("the manifest is not a JSON object");
  if (!isText(json.id) || !VERSION_ID.test(json.id)) return bad('id must be "<YYYY-MM-DD>_<short-label>", the folder name');
  if (folderName !== undefined && json.id !== folderName) return bad(`id "${json.id}" is not the folder name "${folderName}"`);
  const [, date, label] = VERSION_ID.exec(json.id)!;
  if (json.date !== date) return bad(`date must be ${date}, the date part of the id`);
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return bad(`${date} is not a calendar date`);
  if (json.label !== label) return bad(`label must be "${label}", the label part of the id`);
  if (!isText(json.description)) return bad("description must be text (it may be empty)");
  if (!oneOf(VERSION_STATUSES, json.status)) return bad(`status must be one of ${VERSION_STATUSES.join(", ")}`);
  const area = parseArea(json.area);
  if (!area.ok) return bad(area.reason);
  if (!Array.isArray(json.files) || json.files.length === 0) return bad("files must list at least one file");
  const files: ModelDataFile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < json.files.length; i++) {
    const parsed = parseFile(json.files[i], i);
    if (!parsed.ok) return bad(parsed.reason);
    if (seen.has(parsed.file.name)) return bad(`"${parsed.file.name}" is listed twice`);
    seen.add(parsed.file.name);
    files.push(parsed.file);
  }
  if (area.area.hotspotsFile !== undefined && !seen.has(area.area.hotspotsFile)) return bad(`area.hotspotsFile "${area.area.hotspotsFile}" is not among the files`);
  if (!isTextList(json.sources)) return bad("sources must be a list of sentences");
  if (!isTextList(json.notes)) return bad("notes must be a list of sentences");
  if (json.status === "approved") {
    const unvouched = files.find((f) => f.provenance === "real" && (!f.source?.trim() || !f.approvedBy?.trim()));
    if (unvouched) return bad(`"${unvouched.name}" is real data without a source or an approver, so the version cannot be approved: set status to draft, or add source and approvedBy`);
  }
  return {
    ok: true,
    version: { id: json.id, date, label, description: json.description, area: area.area, status: json.status, files, sources: json.sources, notes: json.notes },
  };
}

/** Newest first: by date, then by id, so two versions of one day sort by their label. */
export function newestFirst<T extends Pick<ModelDataVersion, "id" | "date">>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Which version opens by default, and why, in a sentence for the screen: the newest approved
 * version for the preferred area, else the newest approved, else the newest that is not retired,
 * else the newest. A version with a problem is never chosen. `id` is null when nothing can be.
 */
export function chooseDefault(versions: readonly (ModelDataVersion & { problem?: string | null })[], preferredArea = "nairobi"): { id: string | null; why: string } {
  const usable = newestFirst(versions.filter((v) => !v.problem));
  if (usable.length === 0) return { id: null, why: versions.length === 0 ? "No model data version was found." : "No model data version can be served: every one has a problem." };
  const approvedHere = usable.find((v) => v.status === "approved" && v.area.id === preferredArea);
  if (approvedHere) return { id: approvedHere.id, why: `The newest approved version for ${approvedHere.area.name}.` };
  const approved = usable.find((v) => v.status === "approved");
  if (approved) return { id: approved.id, why: `No approved version covers the area "${preferredArea}": the newest approved version, for ${approved.area.name}.` };
  const live = usable.find((v) => v.status !== "retired") ?? usable[0];
  return { id: live.id, why: `No version is approved: the newest one, ${live.status === "draft" ? "a draft" : "retired"}, for ${live.area.name}.` };
}
