/**
 * Browser side of the model data that stays in place on this machine, by version.
 *
 * How to use it, on first load (the version aware way):
 *   const loaded = await loadVersion(null);          // the default version: the newest approved one for Nairobi
 *   loaded.dataset, loaded.report, loaded.files     // what loadDataset gives, ready for the session
 *   loaded.version                                   // the manifest: id, status, files with hashes, area
 *   loaded.area                                      // the area facts: name, centre, zoom, hazard kind, return periods
 *   loaded.loadedFrom                                // "cache" when the browser's copy was reused, else "disk"
 *   modelDataHeader(loaded.version.id, loaded.loadedFrom)   // "Model data: <id>, loaded from cache"
 *
 *   const listing = await listVersions();            // for a picker: every version, the default and why
 *   await loadVersion(id)                            // the version the user picked
 *   await loadVersion(id, { reload: true })          // "Reload model data": skips the cache and overwrites it
 *
 * loadVersion throws, with a message fit for the screen, when the folder cannot be listed, the
 * version is not there or cannot be served, or no data set can be read from it. The old entry
 * point loadModelFiles stays for the sample fallback and the upload path:
 *
 *   const loaded = await loadModelFiles();
 *   const { candidates, files } = await detectDatasets(loaded.files, loaded.folderName);
 *   const candidate = pickNairobi(candidates);
 *   if (candidate) await loadDataset(candidate, files, onProgress);
 *
 *   loaded.source      "folder" when the files come from the model data folder,
 *                      "sample" when the bundled sample-data.zip had to be used instead
 *   loaded.reason      empty for "folder"; for "sample", a sentence saying why the folder
 *                      was not used, ready to show on the screen
 *   loaded.folderName  the folder's own name, or "sample-data"
 *   loaded.version     the default version's manifest, null for the sample
 *
 * loadModelFiles throws only when neither the folder nor the sample zip can be read. The
 * message of that error names both problems and is fit for the screen.
 *
 * Nothing is downloaded until detectDatasets or loadDataset asks for a file. The listing goes
 * out with cache: "no-store"; a version's files are immutable and the server says so, so the
 * browser's own HTTP cache may keep them. The browser never hashes a file: it trusts the manifest.
 */
import { detectDatasets, loadDataset, type FileInfo, type FileSource, type IngestProgress, type IngestReport } from "../ingest";
import { filesFromZip } from "../ingest/zip";
import type { Dataset } from "../model/types";
import { CACHE_FORMAT, cacheKey, indexedDbStore, readCached, writeCached, type CacheStore } from "./cache";
import type { ModelDataLayout } from "./server";
import { modelDataHeader, type ListedVersion, type ModelDataArea, type ModelDataVersion } from "./version";

export { modelDataHeader };
export type { ListedVersion, ModelDataArea, ModelDataVersion };

export const MODEL_DATA_URL = "/api/model-data";
export const SAMPLE_ZIP_URL = "/sample-data.zip";

export type ModelDataSource = "folder" | "sample";
export type LoadedFrom = "cache" | "disk";

export interface LoadedModelFiles {
  files: FileSource[];
  source: ModelDataSource;
  /** Name to show for where the data came from. Also a good second argument for detectDatasets. */
  folderName: string;
  /** Why the sample was used. Empty when the folder was read. */
  reason: string;
  /** The version the files belong to: the default one. Null for the sample. */
  version: ModelDataVersion | null;
  /** Every version in the folder. Empty for the sample. */
  versions: ListedVersion[];
  /** Why that version is the default. Empty for the sample. */
  why: string;
}

export interface LoadModelFilesOptions {
  /** Stand-in for fetch, for tests. Defaults to the browser's own. */
  fetchImpl?: typeof fetch;
}

/** Address of one listed file. Each part is encoded on its own so the slashes between folders survive. */
export function modelFileUrl(path: string): string {
  return `${MODEL_DATA_URL}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Address of one file of a version: /api/model-data/<version id>/<file name>. */
export function versionFileUrl(versionId: string, name: string): string {
  return modelFileUrl(`${versionId}/${name}`);
}

interface ListedEntry {
  path: string;
  size: number;
}

const isEntry = (v: unknown): v is ListedEntry =>
  typeof v === "object" && v !== null && typeof (v as ListedEntry).path === "string" && typeof (v as ListedEntry).size === "number";

const isVersion = (v: unknown): v is ListedVersion =>
  typeof v === "object" && v !== null && typeof (v as ListedVersion).id === "string" && Array.isArray((v as ListedVersion).files) && typeof (v as ListedVersion).area === "object";

function folderFile(path: string, size: number, fetchImpl: typeof fetch): FileSource {
  const get = async () => {
    const res = await fetchImpl(modelFileUrl(path), { cache: "no-store" });
    if (!res.ok) throw new Error(`${path} could not be read from the model data folder (status ${res.status}).`);
    return res;
  };
  // detectDatasets reads each CSV for its header and loadDataset reads it again in full.
  // The text is kept so that is one download, not two. Rasters are read once and are not kept.
  let text: Promise<string> | null = null;
  return {
    path,
    size,
    text: () => {
      text ??= get()
        .then((res) => res.text())
        .catch((e) => {
          // A failed read is not remembered, so trying again asks the server again.
          text = null;
          throw e;
        });
      return text;
    },
    arrayBuffer: async () => (await get()).arrayBuffer(),
  };
}

/** What GET /api/model-data says, as the browser reads it. */
export type VersionListing =
  | { ok: true; folderName: string; layout: ModelDataLayout; versions: ListedVersion[]; defaultId: string | null; why: string; files: ListedEntry[] }
  | { ok: false; reason: string };

/**
 * The versions in the model data folder, the default one and why. For a picker. Never throws:
 * when the folder cannot be listed the result says why, in a sentence for the screen.
 */
export async function listVersions(options: LoadModelFilesOptions = {}): Promise<VersionListing> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await fetchImpl(MODEL_DATA_URL, { cache: "no-store" });
  } catch {
    return { ok: false, reason: "The list of model data files could not be fetched from this app's server." };
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; folderName?: unknown; layout?: unknown; files?: unknown; versions?: unknown; default?: unknown; why?: unknown; reason?: unknown } | null;
  if (!body || body.ok !== true || !Array.isArray(body.files)) {
    const reason = typeof body?.reason === "string" && body.reason ? body.reason : `The list of model data files could not be read (status ${res.status}).`;
    return { ok: false, reason };
  }
  const folderName = typeof body.folderName === "string" && body.folderName ? body.folderName : "model data";
  const versions = Array.isArray(body.versions) ? body.versions.filter(isVersion) : [];
  const defaultId = typeof body.default === "string" ? body.default : null;
  return {
    ok: true,
    folderName,
    layout: body.layout === "versions" ? "versions" : "flat",
    versions,
    defaultId,
    why: typeof body.why === "string" ? body.why : "",
    files: body.files.filter(isEntry),
  };
}

/** The list from the folder, or the reason there is none. */
async function fromFolder(fetchImpl: typeof fetch): Promise<{ ok: true; listing: VersionListing & { ok: true }; files: FileSource[] } | { ok: false; reason: string }> {
  const listing = await listVersions({ fetchImpl });
  if (!listing.ok) return listing;
  // A folder that is there but holds nothing usable would open the app with no model, so it falls back too.
  if (listing.files.length === 0) {
    const problems = listing.versions.flatMap((v) => (v.problem ? [`${v.id}: ${v.problem}`] : []));
    const reason =
      listing.versions.length > 0 && problems.length > 0
        ? `No model data version in "${listing.folderName}" can be loaded. ${problems.join(" ")}`
        : `The model data folder "${listing.folderName}" holds no .tif or .csv files.`;
    return { ok: false, reason };
  }
  return { ok: true, listing, files: listing.files.map((e) => folderFile(e.path, e.size, fetchImpl)) };
}

/**
 * The model input files of the default version as FileSource[], ready for detectDatasets and
 * loadDataset. Read from the model data folder when it is there, otherwise from the bundled
 * sample zip, with the reason for the fallback.
 */
export async function loadModelFiles(options: LoadModelFilesOptions = {}): Promise<LoadedModelFiles> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const folder = await fromFolder(fetchImpl);
  if (folder.ok) {
    const { listing } = folder;
    const version = listing.versions.find((v) => v.id === listing.defaultId) ?? null;
    return { files: folder.files, source: "folder", folderName: listing.folderName, reason: "", version, versions: listing.versions, why: listing.why };
  }

  let files: FileSource[];
  try {
    const res = await fetchImpl(SAMPLE_ZIP_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    files = await filesFromZip(await res.arrayBuffer());
  } catch {
    throw new Error(`${folder.reason} The bundled sample, sample-data.zip in web/public, could not be read either, so there is no model data to open.`);
  }
  return { files, source: "sample", folderName: "sample-data", reason: folder.reason, version: null, versions: [], why: "" };
}

/**
 * The Team A Nairobi dataset among what detectDatasets found, else the first, else null
 * when nothing was found. A candidate is named after its folder: team_a_nairobi in the kit.
 */
export function pickNairobi<T extends { name: string; dir: string }>(candidates: readonly T[]): T | null {
  const named = (test: (s: string) => boolean) => candidates.find((c) => test(c.name.toLowerCase()) || test(c.dir.toLowerCase()));
  return named((s) => s === "team_a_nairobi" || s.endsWith("/team_a_nairobi")) ?? named((s) => s.includes("nairobi")) ?? candidates[0] ?? null;
}

/**
 * The data set for an area among what detectDatasets found: the candidate whose folder name
 * holds the area id ("team_a_nairobi" for "nairobi"), else the first, else null.
 */
export function pickForArea<T extends { name: string; dir: string }>(candidates: readonly T[], areaId: string): T | null {
  const id = areaId.toLowerCase();
  return candidates.find((c) => c.name.toLowerCase().includes(id) || c.dir.toLowerCase().includes(id)) ?? candidates[0] ?? null;
}

export interface LoadVersionOptions extends LoadModelFilesOptions {
  /** True skips the cache and overwrites it: "Reload model data". */
  reload?: boolean;
  /** Where the parsed version is kept. Left out: the browser's IndexedDB. null: no cache at all. */
  store?: CacheStore | null;
  /** Told what is being read, as loadDataset tells it. */
  onProgress?: IngestProgress;
  /** A listing already fetched, so a picker that just listed does not list again. */
  listing?: VersionListing;
}

export interface LoadTiming {
  totalMs: number;
  /** Time spent asking the cache, hit or miss. */
  cacheReadMs: number;
  /** Time spent reading and parsing the files. 0 on a cache hit. */
  parseMs: number;
  /** Time spent storing into the cache. 0 when nothing was stored. */
  cacheWriteMs: number;
}

export interface LoadedVersion {
  dataset: Dataset;
  report: IngestReport;
  files: FileInfo[];
  version: ModelDataVersion;
  /** version.area, for the map and the model: name, centre, zoom, hazard kind, return periods, hotspots file. */
  area: ModelDataArea;
  /** "cache" when the browser's copy was reused, "disk" when the files were read. The header shows this word. */
  loadedFrom: LoadedFrom;
  /** True when the data set was stored in the cache on this load. */
  stored: boolean;
  cacheKey: string;
  timing: LoadTiming;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The manifest alone, as it is cached and handed on: the listing's `problem` is not part of it. */
function withoutProblem(v: ListedVersion): ModelDataVersion {
  return { id: v.id, date: v.date, label: v.label, description: v.description, area: v.area, status: v.status, files: v.files, sources: v.sources, notes: v.notes };
}

/**
 * One version, parsed: from the browser's cache when it holds this version with these file
 * hashes, else from the files, which are then cached. `id` null means the default version.
 * With reload: true the cache is skipped and overwritten. A cache that is missing, refused or
 * failing never surfaces: the load then simply comes from disk.
 */
export async function loadVersion(id: string | null, options: LoadVersionOptions = {}): Promise<LoadedVersion> {
  const started = now();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const listing = options.listing ?? (await listVersions({ fetchImpl }));
  if (!listing.ok) throw new Error(listing.reason);
  const wanted = id ?? listing.defaultId;
  if (wanted === null) throw new Error(`No model data version in "${listing.folderName}" can be loaded. ${listing.why}`);
  const version = listing.versions.find((v) => v.id === wanted);
  if (!version) throw new Error(`There is no model data version "${wanted}" in "${listing.folderName}".`);
  if (version.problem) throw new Error(`The model data version "${version.id}" cannot be loaded: ${version.problem}`);

  const store = options.store === undefined ? indexedDbStore() : options.store;
  const key = cacheKey(version);
  const timing: LoadTiming = { totalMs: 0, cacheReadMs: 0, parseMs: 0, cacheWriteMs: 0 };

  if (!options.reload) {
    const t = now();
    const hit = await readCached(key, store);
    timing.cacheReadMs = now() - t;
    if (hit) {
      timing.totalMs = now() - started;
      return { dataset: hit.dataset, report: hit.report, files: hit.files, version: hit.version, area: hit.version.area, loadedFrom: "cache", stored: false, cacheKey: key, timing };
    }
  }

  const t = now();
  const sources = version.files.map((f) => folderFile(`${version.id}/${f.name}`, f.bytes, fetchImpl));
  const found = await detectDatasets(sources, version.id);
  const candidate = pickForArea(found.candidates, version.area.id);
  if (!candidate) throw new Error(`No data set was found in the model data version "${version.id}". It needs an exposure CSV (with lat, lon and tiv_kes columns) and hazard maps named by tier or return period.`);
  const { dataset, report } = await loadDataset(candidate, found.files, options.onProgress);
  timing.parseMs = now() - t;

  const manifest = withoutProblem(version);
  const w = now();
  const stored = await writeCached({ key, format: CACHE_FORMAT, versionId: version.id, storedAt: Date.now(), version: manifest, dataset, report, files: found.files }, store);
  timing.cacheWriteMs = now() - w;
  timing.totalMs = now() - started;
  return { dataset, report, files: found.files, version: manifest, area: manifest.area, loadedFrom: "disk", stored, cacheKey: key, timing };
}
