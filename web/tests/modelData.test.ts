import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getFile } from "../src/app/api/model-data/[...path]/route";
import { GET as getList } from "../src/app/api/model-data/route";
import { detectDatasets } from "../src/lib/ingest";
import { loadModelFiles, modelFileUrl, pickNairobi, SAMPLE_ZIP_URL } from "../src/lib/modelData/client";
import { contentTypeFor, listModelFiles, modelDataDir, resolveListed } from "../src/lib/modelData/server";

// A made-up folder laid out like the starter kit, with everything the listing must leave out.
const EXPOSURE = "loc_id,lat,lon,housing_class,tiv_kes,hazard_score_extreme,hazard_score_common\nX-1,-1.25,36.85,concrete_rcc,1000000,0.1,0.4\n";
const HOTSPOTS = "name,lat,lon\nMathare,-1.26,36.86\n";
const TIF_BYTES = Uint8Array.from([73, 73, 42, 0, 8, 0, 0, 0, 1, 2, 3]);
const SECRET = "secret,value\nkey,12345\n";

let base: string;
let root: string;
let outside: string;
let fileLinkMade = false;
let folderLinkMade = false;
const savedSetting = process.env.MODEL_DATA_DIR;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "model-data-test-"));
  root = join(base, "kit");
  outside = join(base, "outside");
  for (const dir of ["team_a_nairobi", "team_b_nzoia", "test-data", "team_a_nairobi/test-data", ".cache"]) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(outside);

  writeFileSync(join(root, "team_a_nairobi", "exposure.csv"), EXPOSURE);
  writeFileSync(join(root, "team_a_nairobi", "hotspots.csv"), HOTSPOTS);
  writeFileSync(join(root, "team_a_nairobi", "hazard_extreme.tif"), TIF_BYTES);
  writeFileSync(join(root, "team_a_nairobi", "hazard_common.TIFF"), TIF_BYTES);
  writeFileSync(join(root, "team_b_nzoia", "exposure.csv"), EXPOSURE);
  // None of these may be listed.
  writeFileSync(join(root, "README.docx"), "notes");
  writeFileSync(join(root, ".hidden.csv"), EXPOSURE);
  writeFileSync(join(root, ".cache", "old.csv"), EXPOSURE);
  writeFileSync(join(root, "test-data", "fixture.csv"), EXPOSURE);
  writeFileSync(join(root, "team_a_nairobi", "test-data", "fixture.tif"), TIF_BYTES);
  writeFileSync(join(outside, "secret.csv"), SECRET);

  // Links need rights that not every machine gives. Where they cannot be made, those cases are skipped.
  try {
    symlinkSync(join(outside, "secret.csv"), join(root, "team_a_nairobi", "linked.csv"), "file");
    fileLinkMade = true;
  } catch {
    fileLinkMade = false;
  }
  try {
    // A junction on Windows, which needs no special rights; a plain folder link elsewhere.
    symlinkSync(outside, join(root, "linked"), "junction");
    folderLinkMade = true;
  } catch {
    folderLinkMade = false;
  }
});

afterAll(() => {
  if (savedSetting === undefined) delete process.env.MODEL_DATA_DIR;
  else process.env.MODEL_DATA_DIR = savedSetting;
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.MODEL_DATA_DIR = root;
});

const LISTED = ["team_a_nairobi/exposure.csv", "team_a_nairobi/hazard_common.TIFF", "team_a_nairobi/hazard_extreme.tif", "team_a_nairobi/hotspots.csv", "team_b_nzoia/exposure.csv"];

const fileRequest = (segments: string[]) => getFile(new Request("http://localhost/api/model-data/x"), { params: Promise.resolve({ path: segments }) });

describe("model data folder", () => {
  it("uses MODEL_DATA_DIR, or ../data/data beside the web folder when it is empty", () => {
    expect(modelDataDir()).toBe(resolve(root));
    process.env.MODEL_DATA_DIR = "  ";
    expect(modelDataDir()).toBe(resolve(process.cwd(), "..", "data", "data"));
    delete process.env.MODEL_DATA_DIR;
    expect(modelDataDir()).toBe(resolve(process.cwd(), "..", "data", "data"));
    process.env.MODEL_DATA_DIR = "some/folder";
    expect(modelDataDir()).toBe(resolve(process.cwd(), "some", "folder"));
  });

  it("lists only .tif, .tiff and .csv files, with forward slashes and sizes", async () => {
    const listing = await listModelFiles();
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.folderName).toBe("kit");
    expect(listing.files.map((f) => f.path)).toEqual(LISTED);
    expect(listing.files.find((f) => f.path === "team_a_nairobi/exposure.csv")?.size).toBe(Buffer.byteLength(EXPOSURE));
    expect(listing.files.find((f) => f.path === "team_a_nairobi/hazard_extreme.tif")?.size).toBe(TIF_BYTES.length);
  });

  it("leaves out test-data at any depth, hidden files and folders, and documents", async () => {
    const listing = await listModelFiles();
    if (!listing.ok) throw new Error("expected a listing");
    const paths = listing.files.map((f) => f.path).join("\n");
    expect(paths).not.toContain("test-data");
    expect(paths).not.toContain(".hidden");
    expect(paths).not.toContain(".cache");
    expect(paths).not.toContain("docx");
    expect(paths).not.toContain("\\");
  });

  it("knows the content type of each kind of input", () => {
    expect(contentTypeFor("a.tif")).toBe("image/tiff");
    expect(contentTypeFor("a.TIFF")).toBe("image/tiff");
    expect(contentTypeFor("a.csv")).toBe("text/csv; charset=utf-8");
    expect(contentTypeFor("a.docx")).toBeNull();
  });

  it("resolves a listed path to the file on disk", async () => {
    const found = await resolveListed("team_a_nairobi/exposure.csv");
    expect(found).not.toBeNull();
    expect(found?.size).toBe(Buffer.byteLength(EXPOSURE));
    expect(found?.contentType).toBe("text/csv; charset=utf-8");
    expect(found?.file.replaceAll("\\", "/").endsWith("kit/team_a_nairobi/exposure.csv")).toBe(true);
  });

  it.each([
    ["traversal out of the folder", "../outside/secret.csv"],
    ["traversal back into a listed file", "team_a_nairobi/../team_a_nairobi/exposure.csv"],
    ["a dot segment", "./team_a_nairobi/exposure.csv"],
    ["a leading slash", "/team_a_nairobi/exposure.csv"],
    ["a doubled slash", "team_a_nairobi//exposure.csv"],
    ["a backslash", "team_a_nairobi\\exposure.csv"],
    ["a backslash traversal", "..\\outside\\secret.csv"],
    ["an encoded separator", "team_a_nairobi%2Fexposure.csv"],
    ["an encoded traversal", "%2e%2e%2foutside%2fsecret.csv"],
    ["a Windows drive letter", "C:\\Windows\\win.ini"],
    ["a drive letter with forward slashes", "C:/Windows/win.ini"],
    ["a network share", "\\\\server\\share\\file.csv"],
    ["a file that is there but not a model input", "README.docx"],
    ["a hidden file", ".hidden.csv"],
    ["a file under test-data", "test-data/fixture.csv"],
    ["a file that does not exist", "team_a_nairobi/nothing.csv"],
    ["a folder", "team_a_nairobi"],
    ["different letter case", "TEAM_A_NAIROBI/exposure.csv"],
    ["a trailing null byte", "team_a_nairobi/exposure.csv\0"],
    ["an empty path", ""],
  ])("refuses %s", async (_what, requested) => {
    expect(await resolveListed(requested)).toBeNull();
  });

  it("refuses absolute paths, even to a listed file or to a real file outside", async () => {
    expect(await resolveListed(join(root, "team_a_nairobi", "exposure.csv"))).toBeNull();
    expect(await resolveListed(join(outside, "secret.csv"))).toBeNull();
    expect(await resolveListed(join(outside, "secret.csv").replaceAll("\\", "/"))).toBeNull();
  });

  it("does not list or serve a linked file that points out of the folder", async (ctx) => {
    if (!fileLinkMade) return ctx.skip();
    const listing = await listModelFiles();
    if (!listing.ok) throw new Error("expected a listing");
    expect(listing.files.map((f) => f.path)).not.toContain("team_a_nairobi/linked.csv");
    expect(await resolveListed("team_a_nairobi/linked.csv")).toBeNull();
    expect((await fileRequest(["team_a_nairobi", "linked.csv"])).status).toBe(404);
  });

  it("does not follow a linked folder or junction that points out of the folder", async (ctx) => {
    if (!folderLinkMade) return ctx.skip();
    const listing = await listModelFiles();
    if (!listing.ok) throw new Error("expected a listing");
    expect(listing.files.map((f) => f.path)).toEqual(LISTED);
    expect(await resolveListed("linked/secret.csv")).toBeNull();
    expect((await fileRequest(["linked", "secret.csv"])).status).toBe(404);
  });

  it("says why when MODEL_DATA_DIR points at a folder that does not exist, without the full path", async () => {
    process.env.MODEL_DATA_DIR = join(base, "not-here");
    const listing = await listModelFiles();
    expect(listing.ok).toBe(false);
    if (listing.ok) return;
    expect(listing.folderName).toBe("not-here");
    expect(listing.reason).toBe('MODEL_DATA_DIR points at a folder named "not-here" that does not exist.');
    expect(listing.reason).not.toContain(base);
    expect(await resolveListed("team_a_nairobi/exposure.csv")).toBeNull();
  });

  it("says so when MODEL_DATA_DIR points at a file", async () => {
    process.env.MODEL_DATA_DIR = join(root, "team_a_nairobi", "exposure.csv");
    const listing = await listModelFiles();
    expect(listing.ok).toBe(false);
    if (listing.ok) return;
    expect(listing.reason).toContain("is not a folder");
    expect(listing.reason).not.toContain(base);
  });
});

describe("GET /api/model-data", () => {
  it("returns the list with no-store", async () => {
    const res = await getList();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe("folder");
    expect(body.folderName).toBe("kit");
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(LISTED);
    expect(JSON.stringify(body)).not.toContain(base.replaceAll("\\", "\\\\"));
  });

  it("is a 404 with the reason when the folder is missing", async () => {
    process.env.MODEL_DATA_DIR = join(base, "not-here");
    const res = await getList();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("not-here");
    expect(body.reason).not.toContain(base);
  });
});

describe("GET /api/model-data/[...path]", () => {
  it("serves a listed CSV as text/csv with its length and no-store", async () => {
    const res = await fileRequest(["team_a_nairobi", "exposure.csv"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(EXPOSURE)));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(EXPOSURE);
  });

  it("serves a listed raster as image/tiff, byte for byte", async () => {
    const res = await fileRequest(["team_a_nairobi", "hazard_extreme.tif"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/tiff");
    expect(res.headers.get("content-length")).toBe(String(TIF_BYTES.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(TIF_BYTES);
  });

  it.each([
    ["traversal", ["..", "outside", "secret.csv"]],
    ["traversal that arrived encoded in one segment", ["../outside/secret.csv"]],
    ["a listed path that arrived as one encoded segment", ["team_a_nairobi/exposure.csv"]],
    ["a backslash in a segment", ["team_a_nairobi\\exposure.csv"]],
    ["a drive letter", ["C:", "Windows", "win.ini"]],
    ["a document", ["README.docx"]],
    ["a hidden file", [".hidden.csv"]],
    ["test-data", ["test-data", "fixture.csv"]],
    ["a missing file", ["team_a_nairobi", "nothing.csv"]],
    ["an empty segment", ["team_a_nairobi", "", "exposure.csv"]],
    ["no segments", []],
  ])("answers %s with a plain 404", async (_what, segments) => {
    const res = await fileRequest(segments);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    // The same answer every time, and nothing in it about the disk.
    expect(JSON.parse(text)).toEqual({ ok: false, reason: "Not a model input file." });
    expect(text).not.toContain("kit");
  });

  it("is a 404 for every file when the folder is missing", async () => {
    process.env.MODEL_DATA_DIR = join(base, "not-here");
    expect((await fileRequest(["team_a_nairobi", "exposure.csv"])).status).toBe(404);
  });
});

describe("loadModelFiles, in the browser", () => {
  let calls: { url: string; cache: RequestCache | undefined }[] = [];
  let sampleZip: Uint8Array | null = null;

  // Stands in for the browser's fetch: sends each request to the real handlers.
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, cache: init?.cache });
    if (url === "/api/model-data") return getList();
    if (url.startsWith("/api/model-data/")) return fileRequest(url.slice("/api/model-data/".length).split("/").map(decodeURIComponent));
    if (url === SAMPLE_ZIP_URL) return sampleZip ? new Response(sampleZip.slice().buffer) : new Response("missing", { status: 404 });
    return new Response("missing", { status: 404 });
  }) as typeof fetch;

  beforeEach(() => {
    calls = [];
    sampleZip = null;
  });
  afterEach(() => {
    process.env.MODEL_DATA_DIR = root;
  });

  it("returns the folder's files without downloading any of them", async () => {
    const loaded = await loadModelFiles({ fetchImpl: fakeFetch });
    expect(loaded.source).toBe("folder");
    expect(loaded.folderName).toBe("kit");
    expect(loaded.reason).toBe("");
    expect(loaded.files.map((f) => f.path)).toEqual(LISTED);
    expect(loaded.files[0].size).toBe(Buffer.byteLength(EXPOSURE));
    expect(calls).toEqual([{ url: "/api/model-data", cache: "no-store" }]);
  });

  it("fetches a file only when asked, with no-store, and downloads a CSV once", async () => {
    const loaded = await loadModelFiles({ fetchImpl: fakeFetch });
    const csv = loaded.files.find((f) => f.path === "team_a_nairobi/exposure.csv")!;
    const tif = loaded.files.find((f) => f.path === "team_a_nairobi/hazard_extreme.tif")!;
    expect(await csv.text()).toBe(EXPOSURE);
    expect(await csv.text()).toBe(EXPOSURE);
    expect(new Uint8Array(await tif.arrayBuffer())).toEqual(TIF_BYTES);
    expect(calls.slice(1)).toEqual([
      { url: "/api/model-data/team_a_nairobi/exposure.csv", cache: "no-store" },
      { url: "/api/model-data/team_a_nairobi/hazard_extreme.tif", cache: "no-store" },
    ]);
  });

  it("can be handed straight to detectDatasets, and pickNairobi finds Team A", async () => {
    const loaded = await loadModelFiles({ fetchImpl: fakeFetch });
    const { candidates, files } = await detectDatasets(loaded.files, loaded.folderName);
    expect(candidates.map((c) => c.name).sort()).toEqual(["team_a_nairobi", "team_b_nzoia"]);
    expect(files).toHaveLength(LISTED.length);
    const chosen = pickNairobi(candidates);
    expect(chosen?.name).toBe("team_a_nairobi");
    expect(chosen?.rasters).toHaveLength(2);
    expect(chosen?.hotspots?.path).toBe("team_a_nairobi/hotspots.csv");
  });

  it("falls back to the sample zip and says why when the folder is missing", async () => {
    process.env.MODEL_DATA_DIR = join(base, "not-here");
    const zip = new JSZip();
    zip.file("team_a_nairobi/exposure.csv", EXPOSURE);
    sampleZip = await zip.generateAsync({ type: "uint8array" });

    const loaded = await loadModelFiles({ fetchImpl: fakeFetch });
    expect(loaded.source).toBe("sample");
    expect(loaded.folderName).toBe("sample-data");
    expect(loaded.reason).toBe('MODEL_DATA_DIR points at a folder named "not-here" that does not exist.');
    expect(loaded.files.map((f) => f.path)).toEqual(["team_a_nairobi/exposure.csv"]);
    expect(await loaded.files[0].text()).toBe(EXPOSURE);
    expect(calls).toEqual([
      { url: "/api/model-data", cache: "no-store" },
      { url: SAMPLE_ZIP_URL, cache: "no-store" },
    ]);
  });

  it("falls back when the folder is there but holds no model inputs", async () => {
    const empty = join(base, "empty");
    mkdirSync(empty, { recursive: true });
    process.env.MODEL_DATA_DIR = empty;
    const zip = new JSZip();
    zip.file("team_a_nairobi/exposure.csv", EXPOSURE);
    sampleZip = await zip.generateAsync({ type: "uint8array" });

    const loaded = await loadModelFiles({ fetchImpl: fakeFetch });
    expect(loaded.source).toBe("sample");
    expect(loaded.reason).toBe('The model data folder "empty" holds no .tif or .csv files.');
  });

  it("falls back when the list cannot be fetched at all", async () => {
    const zip = new JSZip();
    zip.file("exposure.csv", EXPOSURE);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const offline = (async (input: RequestInfo | URL) => {
      if (String(input) === SAMPLE_ZIP_URL) return new Response(bytes.slice().buffer);
      throw new TypeError("network down");
    }) as typeof fetch;
    const loaded = await loadModelFiles({ fetchImpl: offline });
    expect(loaded.source).toBe("sample");
    expect(loaded.reason).toContain("could not be fetched");
  });

  it("throws one clear message when neither the folder nor the sample can be read", async () => {
    process.env.MODEL_DATA_DIR = join(base, "not-here");
    await expect(loadModelFiles({ fetchImpl: fakeFetch })).rejects.toThrow(/does not exist\. The bundled sample, sample-data\.zip in web\/public, could not be read either/);
  });

  it("encodes each part of a path but keeps the slashes", () => {
    expect(modelFileUrl("team a/100% map#1.tif")).toBe("/api/model-data/team%20a/100%25%20map%231.tif");
  });
});

describe("pickNairobi", () => {
  const c = (name: string, dir = name) => ({ name, dir });

  it("prefers the Team A Nairobi folder wherever it comes in the list", () => {
    expect(pickNairobi([c("team_b_nzoia"), c("team_a_nairobi", "data/team_a_nairobi")])?.name).toBe("team_a_nairobi");
    expect(pickNairobi([c("team_b_nzoia"), c("nairobi_2024"), c("Team_A_Nairobi")])?.name).toBe("Team_A_Nairobi");
  });

  it("accepts any Nairobi folder when the kit's own name is not there", () => {
    expect(pickNairobi([c("team_b_nzoia"), c("Nairobi county")])?.name).toBe("Nairobi county");
    expect(pickNairobi([c("team_b_nzoia"), c("upload", "kits/nairobi/v2")])?.dir).toBe("kits/nairobi/v2");
  });

  it("takes the first when nothing is Nairobi, and null when there is nothing", () => {
    expect(pickNairobi([c("team_b_nzoia"), c("other")])?.name).toBe("team_b_nzoia");
    expect(pickNairobi([])).toBeNull();
  });
});
