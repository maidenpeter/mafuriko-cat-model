// Relative paths, not the "@/" alias, as in the model data routes beside this one.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelDataDir } from "../../../../lib/modelData/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * Runs Oasis LMF on this machine for the result on screen, and hands back what it wrote.
 *
 *   POST { dataset, fingerprint, mode, csv }   runs oasis/build_and_run.py on the building-level export
 *                                              in `csv` (the app's own, with its view on the comment line)
 *   GET  ?fingerprint=...                      the run already made for that result, 404 when there is none
 *
 * Oasis is installed in WSL, so the script is started there. Everything stays on this machine:
 * the export and the output go under oasis/runs, which is not in git, and nothing is sent anywhere.
 * A run is kept by the fingerprint of the result it was made for, so the same result never runs twice.
 *
 * Settings, all optional, in web/.env.local:
 *   OASIS_WSL_DISTRO   the WSL distribution Oasis is installed in (default "Ubuntu")
 *   OASIS_PYTHON       the Python that has oasislmf, as WSL sees it (default "~/oasis-venv/bin/python")
 */

const NO_STORE = { "Cache-Control": "no-store" };
const fail = (status: number, reason: string) => Response.json({ ok: false, reason }, { status, headers: NO_STORE });

const FINGERPRINT = /^[0-9a-f]{6,64}$/;
const DATASET = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_CSV_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 12 * 60 * 1000;

const repoRoot = () => path.resolve(process.cwd(), "..");
const liveDir = () => path.join(repoRoot(), "oasis", "runs", "live");
const outFile = (fingerprint: string) => path.join(liveDir(), `${fingerprint}.json`);

/** "C:\a\b c" as WSL sees it: "/mnt/c/a/b c". null for a path that is not on a lettered drive. */
function toWsl(windowsPath: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : null;
}

/** One argument for bash, whatever it holds. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const isDir = async (p: string) => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folder on disk that holds the data set of this name: the model data folder itself, a folder
 * of that name inside it, or one level further down (a dated version folder). null when the data
 * set is not on this machine's disk, as with one dropped into the browser.
 */
async function dataDirFor(dataset: string): Promise<string | null> {
  const root = modelDataDir();
  if (path.basename(root) === dataset && (await isDir(root))) return root;
  const direct = path.join(root, dataset);
  if (await isDir(direct)) return direct;
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const nested = path.join(root, name, dataset);
    if (await isDir(nested)) return nested;
  }
  return null;
}

async function readRun(fingerprint: string): Promise<unknown | null> {
  try {
    const run = JSON.parse(await readFile(outFile(fingerprint), "utf8")) as { view?: { fingerprint?: string } | null };
    return run?.view?.fingerprint === fingerprint ? run : null;
  } catch {
    return null;
  }
}

/** Runs in flight, by fingerprint: a second press for the same result waits for the first. */
const inFlight = new Map<string, Promise<{ ok: true } | { ok: false; reason: string }>>();

function runScript(command: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const distro = process.env.OASIS_WSL_DISTRO?.trim() || "Ubuntu";
    let tail = "";
    let settled = false;
    const done = (value: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lc", command], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, reason: "Oasis did not finish within 12 minutes, so the run was stopped." });
    }, TIMEOUT_MS);
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", () => done({ ok: false, reason: "WSL could not be started on this machine, so Oasis was not run." }));
    child.on("close", (code) => {
      if (code === 0) return done({ ok: true });
      // The script's own last lines say why: an export that does not match the exposure file, or Oasis missing.
      const last = tail.split("\0").join("").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(" ");
      done({ ok: false, reason: last ? `Oasis did not run: ${last}`.slice(0, 600) : `Oasis did not run (exit code ${code}).` });
    });
  });
}

export async function GET(request: Request) {
  const fingerprint = new URL(request.url).searchParams.get("fingerprint") ?? "";
  if (!FINGERPRINT.test(fingerprint)) return fail(400, "A result fingerprint is needed.");
  const run = await readRun(fingerprint);
  return run ? Response.json({ ok: true, run, cached: true }, { headers: NO_STORE }) : fail(404, "No Oasis run has been made for this result.");
}

export async function POST(request: Request) {
  let body: { dataset?: unknown; fingerprint?: unknown; mode?: unknown; csv?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "The request could not be read.");
  }
  const { dataset, fingerprint, mode, csv } = body;
  if (typeof dataset !== "string" || !DATASET.test(dataset)) return fail(400, "The data set name is missing or not a plain folder name.");
  if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) return fail(400, "A result fingerprint is needed.");
  if (mode !== "depths" && mode !== "damage_ratios") return fail(400, "The run needs to be told whether it is given depths or damage ratios.");
  if (typeof csv !== "string" || csv.length === 0) return fail(400, "The building-level export is missing.");
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) return fail(413, "The building-level export is too large to run here.");

  const kept = await readRun(fingerprint);
  if (kept) return Response.json({ ok: true, run: kept, cached: true }, { headers: NO_STORE });

  const dataDir = await dataDirFor(dataset);
  if (!dataDir) {
    return fail(409, `Oasis reads the exposure file from disk, and no folder named ${dataset} was found under the model data folder. Put the data set there and reload the model data.`);
  }
  const script = path.join(repoRoot(), "oasis", "build_and_run.py");
  try {
    if (!(await stat(script)).isFile()) throw new Error("not a file");
  } catch {
    return fail(409, "oasis/build_and_run.py was not found beside the web folder, so Oasis cannot be run from here.");
  }

  const exportFile = path.join(liveDir(), `${fingerprint}.csv`);
  const out = outFile(fingerprint);
  const wsl = { root: toWsl(repoRoot()), data: toWsl(dataDir), csv: toWsl(exportFile), out: toWsl(out) };
  if (!wsl.root || !wsl.data || !wsl.csv || !wsl.out) return fail(409, "The project is not on a lettered Windows drive, so WSL cannot be pointed at it.");

  const started = Date.now();
  let job = inFlight.get(fingerprint);
  if (!job) {
    await mkdir(liveDir(), { recursive: true });
    await writeFile(exportFile, csv, "utf8");
    const python = process.env.OASIS_PYTHON?.trim() || "~/oasis-venv/bin/python";
    const flag = mode === "depths" ? "--depths" : "--damage-ratios";
    // The Python path is left unquoted so that "~" expands; it comes from this machine's own settings.
    const command = `cd ${quote(wsl.root)} && ${python} oasis/build_and_run.py --data-dir ${quote(wsl.data)} ${flag} ${quote(wsl.csv)} --out ${quote(wsl.out)}`;
    job = runScript(command).finally(() => inFlight.delete(fingerprint));
    inFlight.set(fingerprint, job);
  }
  const outcome = await job;
  if (!outcome.ok) return fail(502, outcome.reason);

  const run = await readRun(fingerprint);
  if (!run) return fail(502, "Oasis finished, but what it wrote is not for the result on screen, so it is not shown.");
  return Response.json({ ok: true, run, cached: false, seconds: Math.round((Date.now() - started) / 1000) }, { headers: NO_STORE });
}
