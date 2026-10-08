/**
 * Browser side of the model data that stays in place on this machine.
 *
 * How to use it, on first load:
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
 *
 * loadModelFiles throws only when neither the folder nor the sample zip can be read. The
 * message of that error names both problems and is fit for the screen.
 *
 * Nothing is downloaded until detectDatasets or loadDataset asks for a file. Every request
 * goes out with cache: "no-store", so a file changed on disk is picked up on the next load.
 */
import type { FileSource } from "../ingest";
import { filesFromZip } from "../ingest/zip";

export const MODEL_DATA_URL = "/api/model-data";
export const SAMPLE_ZIP_URL = "/sample-data.zip";

export type ModelDataSource = "folder" | "sample";

export interface LoadedModelFiles {
  files: FileSource[];
  source: ModelDataSource;
  /** Name to show for where the data came from. Also a good second argument for detectDatasets. */
  folderName: string;
  /** Why the sample was used. Empty when the folder was read. */
  reason: string;
}

export interface LoadModelFilesOptions {
  /** Stand-in for fetch, for tests. Defaults to the browser's own. */
  fetchImpl?: typeof fetch;
}

/** Address of one listed file. Each part is encoded on its own so the slashes between folders survive. */
export function modelFileUrl(path: string): string {
  return `${MODEL_DATA_URL}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

interface ListedEntry {
  path: string;
  size: number;
}

const isEntry = (v: unknown): v is ListedEntry =>
  typeof v === "object" && v !== null && typeof (v as ListedEntry).path === "string" && typeof (v as ListedEntry).size === "number";

function folderFile(entry: ListedEntry, fetchImpl: typeof fetch): FileSource {
  const get = async () => {
    const res = await fetchImpl(modelFileUrl(entry.path), { cache: "no-store" });
    if (!res.ok) throw new Error(`${entry.path} could not be read from the model data folder (status ${res.status}).`);
    return res;
  };
  // detectDatasets reads each CSV for its header and loadDataset reads it again in full.
  // The text is kept so that is one download, not two. Rasters are read once and are not kept.
  let text: Promise<string> | null = null;
  return {
    path: entry.path,
    size: entry.size,
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

/** The list from the folder, or the reason there is none. */
async function fromFolder(fetchImpl: typeof fetch): Promise<{ ok: true; folderName: string; files: FileSource[] } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetchImpl(MODEL_DATA_URL, { cache: "no-store" });
  } catch {
    return { ok: false, reason: "The list of model data files could not be fetched from this app's server." };
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; folderName?: unknown; files?: unknown; reason?: unknown } | null;
  if (!body || body.ok !== true || !Array.isArray(body.files)) {
    const reason = typeof body?.reason === "string" && body.reason ? body.reason : `The list of model data files could not be read (status ${res.status}).`;
    return { ok: false, reason };
  }
  const folderName = typeof body.folderName === "string" && body.folderName ? body.folderName : "model data";
  const entries = body.files.filter(isEntry);
  // A folder that is there but holds nothing usable would open the app with no model, so it falls back too.
  if (entries.length === 0) return { ok: false, reason: `The model data folder "${folderName}" holds no .tif or .csv files.` };
  return { ok: true, folderName, files: entries.map((e) => folderFile(e, fetchImpl)) };
}

/**
 * The model input files as FileSource[], ready for detectDatasets and loadDataset.
 * Read from the model data folder when it is there, otherwise from the bundled sample zip,
 * with the reason for the fallback.
 */
export async function loadModelFiles(options: LoadModelFilesOptions = {}): Promise<LoadedModelFiles> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const folder = await fromFolder(fetchImpl);
  if (folder.ok) return { files: folder.files, source: "folder", folderName: folder.folderName, reason: "" };

  let files: FileSource[];
  try {
    const res = await fetchImpl(SAMPLE_ZIP_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    files = await filesFromZip(await res.arrayBuffer());
  } catch {
    throw new Error(`${folder.reason} The bundled sample, sample-data.zip in web/public, could not be read either, so there is no model data to open.`);
  }
  return { files, source: "sample", folderName: "sample-data", reason: folder.reason };
}

/**
 * The Team A Nairobi dataset among what detectDatasets found, else the first, else null
 * when nothing was found. A candidate is named after its folder: team_a_nairobi in the kit.
 */
export function pickNairobi<T extends { name: string; dir: string }>(candidates: readonly T[]): T | null {
  const named = (test: (s: string) => boolean) => candidates.find((c) => test(c.name.toLowerCase()) || test(c.dir.toLowerCase()));
  return named((s) => s === "team_a_nairobi" || s.endsWith("/team_a_nairobi")) ?? named((s) => s.includes("nairobi")) ?? candidates[0] ?? null;
}
