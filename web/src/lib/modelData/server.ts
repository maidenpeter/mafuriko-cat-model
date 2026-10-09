/**
 * Model input files that stay in place on this machine, served by version. Node only: never import
 * this from a component, it reads the disk.
 *
 * Two layouts of MODEL_DATA_DIR are understood:
 *   versions   a folder of dated version folders, each holding its input files and manifest.json
 *              (the shape is in version.ts; scripts/make-version.mjs writes one):
 *              ../data/model-data/2026-10-09_nairobi-starter-kit/manifest.json
 *   flat       the files directly inside, with no manifest (the starter kit as it came). They are
 *              presented as one version with the id "unversioned", status "draft", the role and
 *              provenance of each file read from its name, and hashes computed here on the fly.
 *
 * How to use it
 *   const listing = await listModelFiles();
 *   if (listing.ok) listing.versions          // every version found; one with a problem cannot be served
 *   if (listing.ok) listing.defaultId         // the version that opens by default; listing.why says why
 *   if (listing.ok) listing.files             // [{ path: "<version id>/<file name>", size }] of the default version
 *   else listing.reason                       // a sentence the screen can show as it is
 *
 *   const found = await resolveListed("2026-10-09_nairobi-starter-kit/team_a_nairobi/exposure.csv");
 *   if (found) found.file                     // absolute path, safe to open
 *   if (found) found.immutable                // true for a version's file: cache it for good, found.sha256 is its ETag
 *
 * A version is immutable. Each time it is listed, every file is checked against the size and
 * sha256 in its manifest (hashes are kept in memory per file and recomputed only when the file's
 * size or modification time changes). A version whose files no longer match is listed with the
 * problem "Changed since approval" and none of its files is served. Nothing here writes into a
 * version folder.
 *
 * The folder is MODEL_DATA_DIR when that is set (a relative value is taken from the web folder),
 * otherwise ../data/data beside the web folder. Nothing here ever returns or prints the full
 * path of the folder: a listing carries the folder's own name only, so the browser learns nothing
 * about the machine's layout.
 */
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fromFile } from "geotiff";
import { areaFromFiles, csvColumns, knownAreaIn, roleFor, sourceFor } from "./area";
import { chooseDefault, MANIFEST_FILE, parseManifest, UNVERSIONED_ID, type Extent, type ListedVersion, type ModelDataFile, type ModelDataVersion } from "./version";

/** Where the starter kit sits when MODEL_DATA_DIR is left empty, relative to the web folder. */
export const DEFAULT_MODEL_DATA_DIR = "../data/data";

/** Extensions that count as model inputs in a folder with no manifest, and the type each is served with. */
const CONTENT_TYPES: Record<string, string> = {
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".csv": "text/csv; charset=utf-8",
  ".geojson": "application/geo+json",
};

/** Folders that hold the kit's own test fixtures, not model inputs. */
const SKIPPED_FOLDERS = new Set(["test-data"]);

export type ModelDataLayout = "versions" | "flat";

export interface ModelFile {
  /** Path as the browser requests it, with forward slashes on every platform: "<version id>/<file name>" in the versions layout. */
  path: string;
  /** Size in bytes. */
  size: number;
}

export type ModelListing =
  | {
      ok: true;
      folderName: string;
      layout: ModelDataLayout;
      /** The files of the default version. Empty when no version can be served. */
      files: ModelFile[];
      versions: ListedVersion[];
      defaultId: string | null;
      /** Why that version is the default, or why there is none. */
      why: string;
    }
  | { ok: false; folderName: string; reason: string };

export interface ListedFile {
  /** Absolute path on disk, links already followed. */
  file: string;
  size: number;
  contentType: string;
  /** True for a file of a manifest-backed version: it never changes, so the browser may cache it for good. */
  immutable: boolean;
  /** The file's sha256 from its manifest; null in the flat layout, where a file can change. */
  sha256: string | null;
}

const setting = () => (process.env.MODEL_DATA_DIR ?? "").trim();

/** The folder the model inputs are read from. For this module and its tests: do not send it to the browser. */
export function modelDataDir(): string {
  return path.resolve(process.cwd(), setting() || DEFAULT_MODEL_DATA_DIR);
}

/** The content type for a model input, or null when the name is not one. */
export function contentTypeFor(name: string): string | null {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? null;
}

/** True when `inner` is `outer` itself or sits somewhere below it. Both must already be real paths. */
function isInside(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Says why the folder cannot be used, naming it without giving away where it is. */
function missingReason(folderName: string, what: string): string {
  return setting()
    ? `MODEL_DATA_DIR points at a folder named "${folderName}" that ${what}.`
    : `MODEL_DATA_DIR is not set, and the default folder ${DEFAULT_MODEL_DATA_DIR} ${what}.`;
}

const byPath = <T extends { path: string }>(a: T, b: T) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// ---- Looking inside one file: hash, size, rows, raster header ----

interface Inspected {
  sha256: string;
  bytes: number;
  /** Data rows of a CSV, the header not counted. */
  rows?: number;
  /** Its first line's columns, lower case, for telling an exposure file from a hotspots file. */
  columns?: string[];
  raster?: { width: number; height: number; extent: Extent | null };
}

/** What was found in each file, by real path, kept while the size and modification time stay the same. */
const inspected = new Map<string, { size: number; mtimeMs: number; value: Inspected }>();

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Width, height and extent from the raster's header only; null when the file is not a readable GeoTIFF. */
async function rasterHeader(file: string): Promise<Inspected["raster"] | null> {
  let tiff: Awaited<ReturnType<typeof fromFile>> | null = null;
  try {
    tiff = await fromFile(file);
    const image = await tiff.getImage();
    let extent: Extent | null = null;
    try {
      const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
      if ([minLon, minLat, maxLon, maxLat].every(Number.isFinite)) extent = [minLon, minLat, maxLon, maxLat];
    } catch {
      // No georeferencing: the size is still worth having.
    }
    return { width: image.getWidth(), height: image.getHeight(), extent };
  } catch {
    return null;
  } finally {
    try {
      await tiff?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

/**
 * Hash and size of a file, plus its row count and columns (a CSV) or raster size (a GeoTIFF).
 * Computed once and kept while the file's size and modification time do not change, so a listing
 * costs one stat per file after the first.
 */
async function inspect(real: string, info: Stats): Promise<Inspected> {
  const kept = inspected.get(real);
  if (kept && kept.size === info.size && kept.mtimeMs === info.mtimeMs) return kept.value;
  const value: Inspected = { sha256: await sha256Of(real), bytes: info.size };
  const ext = path.extname(real).toLowerCase();
  if (ext === ".csv") {
    const text = await readFile(real, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    value.rows = Math.max(0, lines.length - 1);
    value.columns = csvColumns(lines[0] ?? "");
  } else if (ext === ".tif" || ext === ".tiff") {
    const raster = await rasterHeader(real);
    if (raster) value.raster = raster;
  }
  inspected.set(real, { size: info.size, mtimeMs: info.mtimeMs, value });
  return value;
}

// ---- The flat layout: every input under the folder, no manifest ----

/**
 * Walk the folder and collect the model inputs. Links are never followed into another
 * folder, and a linked file is kept only when what it points at is still inside the root,
 * so the list cannot reach outside it.
 */
async function walk(realRoot: string, dir: string, prefix: string, out: Map<string, ListedFile>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name.toLowerCase())) await walk(realRoot, full, rel, out);
      continue;
    }
    const contentType = contentTypeFor(entry.name);
    if (!contentType) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    try {
      const real = await realpath(full);
      if (!isInside(realRoot, real)) continue;
      const info = await stat(real);
      if (info.isFile()) out.set(rel, { file: real, size: info.size, contentType, immutable: false, sha256: null });
    } catch {
      // A link whose target has gone, or a file removed while we were looking: leave it out.
    }
  }
}

interface Scanned {
  version: ListedVersion;
  /** By file name as the manifest (or the walk) names it. */
  files: Map<string, ListedFile>;
}

/** The folder's files as one draft version, "unversioned", with hashes, counts and roles worked out here. */
async function unversioned(realRoot: string, folderName: string): Promise<Scanned> {
  const listed = new Map<string, ListedFile>();
  await walk(realRoot, realRoot, "", listed);
  const names = [...listed.keys()].sort();
  const areaId = knownAreaIn(names);
  const files: ModelDataFile[] = [];
  const forArea: { name: string; role: ModelDataFile["role"]; extent?: Extent | null }[] = [];
  for (const name of names) {
    const entry = listed.get(name)!;
    const found = await inspect(entry.file, await stat(entry.file));
    const { role, provenance } = roleFor(name, found.columns ?? []);
    const file: ModelDataFile = { name, role, provenance, sha256: found.sha256, bytes: found.bytes };
    if (found.rows !== undefined) file.rows = found.rows;
    if (found.raster) file.raster = { width: found.raster.width, height: found.raster.height };
    const source = sourceFor(areaId, role);
    if (source) file.source = source;
    files.push(file);
    forArea.push({ name, role, extent: found.raster?.extent ?? null });
  }
  const { area, notes } = areaFromFiles(areaId, forArea, folderName);
  const date = (await stat(realRoot)).mtime.toISOString().slice(0, 10);
  const version: ListedVersion = {
    id: UNVERSIONED_ID,
    date,
    label: folderName,
    description: `The files in "${folderName}" as they are, with no manifest.`,
    area,
    status: "draft",
    files,
    sources: [...new Set(files.flatMap((f) => (f.source ? [f.source] : [])))],
    notes: [
      "No manifest: the hashes and counts are computed on each listing and the files can change. Make a dated version with scripts/make-version.mjs.",
      ...notes,
    ],
    problem: null,
  };
  return { version, files: listed };
}

// ---- The versions layout: one folder per version, each with a manifest ----

/** A version that cannot be read still gets a row in the listing, under its folder name, with the problem. */
function stub(folderName: string, problem: string): ListedVersion {
  const [date = "", label = folderName] = /^(\d{4}-\d{2}-\d{2})_(.+)$/.exec(folderName)?.slice(1) ?? [];
  return {
    id: folderName,
    date,
    label,
    description: "",
    area: { id: "unknown", name: "Unknown", centre: [0, 0], zoom: 0, hazardKind: "score" },
    status: "draft",
    files: [],
    sources: [],
    notes: [],
    problem,
  };
}

/** Reads one version folder and checks every file against its manifest. */
async function readVersion(realRoot: string, folderName: string): Promise<Scanned> {
  const files = new Map<string, ListedFile>();
  let dir: string;
  try {
    dir = await realpath(path.join(realRoot, folderName));
    if (!isInside(realRoot, dir)) return { version: stub(folderName, "The folder is a link to somewhere outside the model data folder."), files };
  } catch {
    return { version: stub(folderName, "The folder could not be opened."), files };
  }

  let json: unknown;
  try {
    json = JSON.parse((await readFile(path.join(dir, MANIFEST_FILE), "utf8")).replace(/^﻿/, ""));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { version: stub(folderName, `${MANIFEST_FILE} could not be read: ${code ?? "not valid JSON"}.`), files };
  }
  const parsed = parseManifest(json, folderName);
  if (!parsed.ok) return { version: stub(folderName, `${MANIFEST_FILE} is not a valid manifest: ${parsed.reason}.`), files };
  const version: ListedVersion = { ...parsed.version, problem: null };
  const changed = version.status === "approved" ? "Changed since approval" : "Changed since its manifest was written";

  for (const f of version.files) {
    let real: string;
    let info: Stats;
    try {
      real = await realpath(path.join(dir, ...f.name.split("/")));
      if (!isInside(dir, real)) return { version: { ...version, problem: `"${f.name}" is a link to somewhere outside the version folder.` }, files: new Map() };
      info = await stat(real);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      return { version: { ...version, problem: `${changed}: "${f.name}" is missing.` }, files: new Map() };
    }
    if (info.size !== f.bytes) return { version: { ...version, problem: `${changed}: "${f.name}" is ${info.size} bytes, the manifest says ${f.bytes}.` }, files: new Map() };
    const found = await inspect(real, info);
    if (found.sha256 !== f.sha256) return { version: { ...version, problem: `${changed}: "${f.name}" no longer matches its manifest hash.` }, files: new Map() };
    files.set(f.name, { file: real, size: info.size, contentType: contentTypeFor(f.name) ?? "application/octet-stream", immutable: true, sha256: f.sha256 });
  }
  return { version, files };
}

// ---- The folder as a whole ----

type Scan =
  | { ok: true; folderName: string; layout: ModelDataLayout; versions: Scanned[]; defaultId: string | null; why: string }
  | { ok: false; folderName: string; reason: string };

async function hasManifest(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, MANIFEST_FILE))).isFile();
  } catch {
    return false;
  }
}

async function scan(): Promise<Scan> {
  const dir = modelDataDir();
  const folderName = path.basename(dir) || "folder";
  let realRoot: string;
  try {
    realRoot = await realpath(dir);
    if (!(await lstat(realRoot)).isDirectory()) return { ok: false, folderName, reason: missingReason(folderName, "is not a folder") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Only the error code is passed on: the message itself carries the full path.
    const what = code === "ENOENT" || code === "ENOTDIR" ? "does not exist" : `could not be opened (${code ?? "unknown error"})`;
    return { ok: false, folderName, reason: missingReason(folderName, what) };
  }

  let versions: Scanned[];
  try {
    const entries = await readdir(realRoot, { withFileTypes: true });
    const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED_FOLDERS.has(e.name.toLowerCase())).map((e) => e.name);
    const withManifest: string[] = [];
    for (const name of folders.sort()) if (await hasManifest(path.join(realRoot, name))) withManifest.push(name);

    if (withManifest.length > 0) {
      versions = [];
      for (const name of withManifest) versions.push(await readVersion(realRoot, name));
    } else if (await hasManifest(realRoot)) {
      // MODEL_DATA_DIR points straight at one version folder: its own name must be the id.
      versions = [await readVersion(path.dirname(realRoot), path.basename(realRoot))];
    } else {
      versions = [await unversioned(realRoot, folderName)];
    }
  } catch (e) {
    return { ok: false, folderName, reason: missingReason(folderName, `could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown error"})`) };
  }
  const layout: ModelDataLayout = versions[0]?.version.id === UNVERSIONED_ID ? "flat" : "versions";
  const { id, why } = chooseDefault(versions.map((v) => v.version));
  return { ok: true, folderName, layout, versions, defaultId: id, why };
}

/** The path the browser requests for a file of a version: the version id in front, except in the flat layout, where the old paths stay. */
const servedPath = (layout: ModelDataLayout, versionId: string, name: string) => (layout === "flat" ? name : `${versionId}/${name}`);

/**
 * Every version under the folder, which one is the default and why, and the default version's
 * files: .tif, .tiff, .csv and .geojson as the manifest lists them (or, with no manifest, at any
 * depth, leaving out hidden files and folders and anything under a folder named test-data).
 * Files sorted by path. When the folder is missing the result says so in words fit for the screen.
 */
export async function listModelFiles(): Promise<ModelListing> {
  const found = await scan();
  if (!found.ok) return found;
  const chosen = found.versions.find((v) => v.version.id === found.defaultId);
  const files = chosen ? [...chosen.files].map(([name, f]) => ({ path: servedPath(found.layout, chosen.version.id, name), size: f.size })).sort(byPath) : [];
  return { ok: true, folderName: found.folderName, layout: found.layout, files, versions: found.versions.map((v) => v.version), defaultId: found.defaultId, why: found.why };
}

/**
 * The file behind one requested path, or null.
 *
 * The request is never turned into a path on disk. In the versions layout it is "<version id>/<file
 * name>" and both parts are compared, character for character, with the ids and names the
 * listing produced; in the flat layout it is the file's path as listed, with or without
 * "unversioned/" in front. So "..", absolute paths, drive letters, backslashes and percent-encoded
 * separators all fail simply by not being on the list. The listing in turn only holds files whose
 * real path is inside the folder's real path, which is what keeps symbolic links and junctions
 * from leading out. The real path is checked once more here in case the file was swapped for a
 * link between the listing and this call. A file of a version with a problem is never returned.
 */
export async function resolveListed(requested: string): Promise<ListedFile | null> {
  if (typeof requested !== "string" || requested === "") return null;
  const found = await scan();
  if (!found.ok) return null;

  let hit: ListedFile | undefined;
  if (found.layout === "flat") {
    const prefix = `${UNVERSIONED_ID}/`;
    hit = found.versions[0].files.get(requested.startsWith(prefix) ? requested.slice(prefix.length) : requested);
  } else {
    const slash = requested.indexOf("/");
    if (slash <= 0) return null;
    const version = found.versions.find((v) => v.version.id === requested.slice(0, slash));
    if (!version || version.version.problem) return null;
    hit = version.files.get(requested.slice(slash + 1));
  }
  if (!hit) return null;

  try {
    const [realRoot, real] = await Promise.all([realpath(modelDataDir()), realpath(hit.file)]);
    if (real !== hit.file || !isInside(realRoot, real)) return null;
    const info = await stat(real);
    return info.isFile() ? { ...hit, size: info.size } : null;
  } catch {
    return null;
  }
}
