/**
 * Model input files that stay in place on this machine. Node only: never import this from a
 * component, it reads the disk.
 *
 * How to use it
 *   const listing = await listModelFiles();
 *   if (listing.ok) listing.files            // [{ path: "team_a_nairobi/exposure.csv", size: 1234 }, ...]
 *   else listing.reason                      // a sentence the screen can show as it is
 *
 *   const found = await resolveListed("team_a_nairobi/exposure.csv");
 *   if (found) found.file                    // absolute path, safe to open
 *
 * The folder is MODEL_DATA_DIR when that is set (a relative value is taken from the web
 * folder), otherwise ../data/data beside the web folder.
 *
 * Nothing here ever returns or prints the full path of the folder: a listing carries the
 * folder's own name only, so the browser learns nothing about the machine's layout.
 */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Where the starter kit sits when MODEL_DATA_DIR is left empty, relative to the web folder. */
export const DEFAULT_MODEL_DATA_DIR = "../data/data";

/** Extensions that count as model inputs, and the type each is served with. */
const CONTENT_TYPES: Record<string, string> = {
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".csv": "text/csv; charset=utf-8",
};

/** Folders that hold the kit's own test fixtures, not model inputs. */
const SKIPPED_FOLDERS = new Set(["test-data"]);

export interface ModelFile {
  /** Path inside the folder, with forward slashes on every platform. */
  path: string;
  /** Size in bytes. */
  size: number;
}

export type ModelListing =
  | { ok: true; folderName: string; files: ModelFile[] }
  | { ok: false; folderName: string; reason: string };

export interface ListedFile {
  /** Absolute path on disk, links already followed. */
  file: string;
  size: number;
  contentType: string;
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
      if (info.isFile()) out.set(rel, { file: real, size: info.size, contentType });
    } catch {
      // A link whose target has gone, or a file removed while we were looking: leave it out.
    }
  }
}

async function scan(): Promise<{ ok: true; folderName: string; listed: Map<string, ListedFile> } | { ok: false; folderName: string; reason: string }> {
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
  const listed = new Map<string, ListedFile>();
  try {
    await walk(realRoot, realRoot, "", listed);
  } catch (e) {
    return { ok: false, folderName, reason: missingReason(folderName, `could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown error"})`) };
  }
  return { ok: true, folderName, listed };
}

/**
 * Every model input under the folder: .tif, .tiff and .csv, at any depth, leaving out hidden
 * files and folders and anything under a folder named test-data. Sorted by path.
 * When the folder is missing the result says so in words fit for the screen.
 */
export async function listModelFiles(): Promise<ModelListing> {
  const found = await scan();
  if (!found.ok) return found;
  const files = [...found.listed].map(([p, f]) => ({ path: p, size: f.size })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: true, folderName: found.folderName, files };
}

/**
 * The file behind one listed path, or null.
 *
 * The request is never turned into a path on disk. It is compared, character for character,
 * with the paths the listing produced, so "..", absolute paths, drive letters, backslashes
 * and percent-encoded separators all fail simply by not being on the list. The listing in
 * turn only holds files whose real path is inside the folder's real path, which is what
 * keeps symbolic links and junctions from leading out. The real path is checked once more
 * here in case the file was swapped for a link between the listing and this call.
 */
export async function resolveListed(requested: string): Promise<ListedFile | null> {
  if (typeof requested !== "string" || requested === "") return null;
  const found = await scan();
  if (!found.ok) return null;
  const hit = found.listed.get(requested);
  if (!hit) return null;
  try {
    const [realRoot, real] = await Promise.all([realpath(modelDataDir()), realpath(hit.file)]);
    if (real !== hit.file || !isInside(realRoot, real)) return null;
    const info = await stat(real);
    return info.isFile() ? { file: real, size: info.size, contentType: hit.contentType } : null;
  } catch {
    return null;
  }
}
