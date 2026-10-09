/**
 * The browser's copy of a parsed model data version, in IndexedDB, so a refresh does not read and
 * parse the files again. One entry per version, under a key made of the version id, the
 * fingerprint of its file hashes (hashesOf) and this cache's format number, so a version whose
 * files changed, a different version, or an entry written by an older build of the app is a miss.
 * At most KEEP_VERSIONS entries are kept: storing one deletes the oldest beyond that.
 *
 * Every function here swallows storage trouble. No IndexedDB (Node, an old browser), a refused
 * open (a private window), a quota error or a broken record all read as "nothing cached" or
 * "not stored", never as an error, and the caller loads from disk as if there were no cache.
 *
 * For a screen: nothing here is called directly. loadVersion in client.ts reads and writes the
 * cache and reports loadedFrom "cache" or "disk"; a "Reload model data" button calls it with
 * reload: true. The storage sits behind CacheStore so the tests run with memoryStore() in Node.
 */
import type { FileInfo, IngestReport } from "../ingest";
import type { Dataset } from "../model/types";
import { hashesOf, type ModelDataVersion } from "./version";

/** Raise this when Dataset, IngestReport or FileInfo change shape: every older entry then misses. */
export const CACHE_FORMAT = 1;
/** How many versions stay cached. The one just stored is always among them. */
export const KEEP_VERSIONS = 2;
export const DB_NAME = "mafuriko-model-data";
const DB_VERSION = 1;
const STORE = "versions";
const BY_STORED_AT = "storedAt";

/** One cached version: the parsed data set with its rasters as typed arrays, the ingest report, the file list and the manifest. */
export interface CachedVersion {
  key: string;
  format: number;
  versionId: string;
  /** Epoch milliseconds, for keeping the newest entries. */
  storedAt: number;
  version: ModelDataVersion;
  dataset: Dataset;
  report: IngestReport;
  files: FileInfo[];
}

/** Where entries live. IndexedDB in the browser, a Map in tests. Any method may throw or reject: callers cope. */
export interface CacheStore {
  get(key: string): Promise<unknown>;
  put(entry: CachedVersion): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every entry's key and storedAt, without loading the entries themselves. */
  list(): Promise<{ key: string; storedAt: number }[]>;
}

/** The key a version is cached under: its id, hashesOf(version) and the cache format. */
export function cacheKey(version: Pick<ModelDataVersion, "id" | "files">): string {
  return `${version.id}:${hashesOf(version)}:f${CACHE_FORMAT}`;
}

/**
 * A store in memory, for tests and for a page with no IndexedDB that still wants to keep one
 * load. Entries are copied in and out with structuredClone, as IndexedDB copies them, so the
 * cost of the copy is measured and a caller cannot change what is stored.
 */
export function memoryStore(): CacheStore & { entries: Map<string, CachedVersion> } {
  const entries = new Map<string, CachedVersion>();
  return {
    entries,
    get: async (key) => {
      const hit = entries.get(key);
      return hit ? structuredClone(hit) : undefined;
    },
    put: async (entry) => {
      entries.set(entry.key, structuredClone(entry));
    },
    delete: async (key) => {
      entries.delete(key);
    },
    list: async () => [...entries.values()].map((e) => ({ key: e.key, storedAt: e.storedAt })),
  };
}

function settle<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" }).createIndex(BY_STORED_AT, "storedAt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB could not be opened"));
    req.onblocked = () => reject(new Error("IndexedDB is open in another tab with an older version"));
  });
}

/** Runs one transaction and waits for it to finish, closing the database either way. */
async function inTransaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    // Attached before any request, so a transaction that completes quickly is not missed.
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    const result = await run(tx.objectStore(STORE));
    await done;
    return result;
  } finally {
    db.close();
  }
}

/** Keys and storedAt values by cursor over the index, so no entry's rasters are loaded just to list it. */
function listKeys(store: IDBObjectStore): Promise<{ key: string; storedAt: number }[]> {
  return new Promise((resolve, reject) => {
    const out: { key: string; storedAt: number }[] = [];
    const req = store.index(BY_STORED_AT).openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push({ key: String(cursor.primaryKey), storedAt: Number(cursor.key) });
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
  });
}

/** The browser's IndexedDB as a CacheStore, or null when this runtime has none (Node, an old browser). */
export function indexedDbStore(): CacheStore | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    get: (key) => inTransaction("readonly", (store) => settle(store.get(key))),
    put: (entry) => inTransaction("readwrite", async (store) => void (await settle(store.put(entry)))),
    delete: (key) => inTransaction("readwrite", async (store) => void (await settle(store.delete(key)))),
    list: () => inTransaction("readonly", listKeys),
  };
}

/** True when a stored value is a whole entry under this key, with its rasters still typed arrays. */
export function isCachedVersion(value: unknown, key: string): value is CachedVersion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CachedVersion>;
  if (v.key !== key || v.format !== CACHE_FORMAT || typeof v.versionId !== "string" || typeof v.storedAt !== "number") return false;
  if (typeof v.version !== "object" || v.version === null || v.version.id !== v.versionId) return false;
  const d = v.dataset;
  if (typeof d !== "object" || d === null || !Array.isArray(d.buildings) || !Array.isArray(d.scenarios) || !Array.isArray(d.rasters)) return false;
  if (!d.rasters.every((r) => r && r.data instanceof Float32Array && r.data.length === r.width * r.height)) return false;
  if (typeof v.report !== "object" || v.report === null || !Array.isArray(v.files)) return false;
  return true;
}

/** The entry under `key`, or null when there is none, it is not whole, or the store fails. */
export async function readCached(key: string, store: CacheStore | null): Promise<CachedVersion | null> {
  if (!store) return null;
  try {
    const value = await store.get(key);
    return isCachedVersion(value, key) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the oldest entries beyond `keep`, never the one under `keepKey`. Returns the keys
 * deleted; an empty list when the store fails.
 */
export async function pruneCached(store: CacheStore | null, keep = KEEP_VERSIONS, keepKey?: string): Promise<string[]> {
  if (!store) return [];
  try {
    const entries = (await store.list()).sort((a, b) => b.storedAt - a.storedAt);
    const kept = new Set(entries.slice(0, keep).map((e) => e.key));
    if (keepKey) kept.add(keepKey);
    const gone: string[] = [];
    for (const e of entries) {
      if (kept.has(e.key)) continue;
      await store.delete(e.key);
      gone.push(e.key);
    }
    return gone;
  } catch {
    return [];
  }
}

/** Stores an entry and prunes to KEEP_VERSIONS. False when the store fails, in which case nothing is promised about what it holds. */
export async function writeCached(entry: CachedVersion, store: CacheStore | null): Promise<boolean> {
  if (!store) return false;
  try {
    await store.put(entry);
  } catch {
    return false;
  }
  await pruneCached(store, KEEP_VERSIONS, entry.key);
  return true;
}

/** Deletes every entry. False when the store fails. */
export async function clearCached(store: CacheStore | null): Promise<boolean> {
  if (!store) return false;
  try {
    for (const e of await store.list()) await store.delete(e.key);
    return true;
  } catch {
    return false;
  }
}
