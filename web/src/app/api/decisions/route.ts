// Relative paths, not the "@/" alias: the tests call these handlers directly, and they run without the alias.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FILE_PATTERN, fileNameFor, ID_PATTERN, readDecisionRecord, sortNewestFirst, summaryOf, toJson, type DecisionRecord, type DecisionSummary } from "../../../lib/decisionLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The decision log on disk.
 *
 *   POST /api/decisions          body: a DecisionRecord (lib/decisionLog.ts, toJson). Saves it as <id>.json
 *                                and answers { ok: true, file, id }. 400 when the body is not a record.
 *   GET  /api/decisions          { ok: true, records: DecisionSummary[] }, newest first. An empty list
 *                                when the folder is not there yet.
 *   GET  /api/decisions?id=<id>  { ok: true, record: DecisionRecord }, or 404 { ok: false, reason }.
 *
 * The folder is DECISIONS_DIR when that is set (a relative value is taken from the web folder),
 * otherwise ../data/decisions beside the web folder, made when the first record is saved. A record
 * holds an offer's name and figures, so the folder is never inside the project, where git could pick
 * it up: a setting that resolves inside the project is refused unless it is under the project's
 * data folder, which git ignores. No reply ever carries a path on disk.
 */

/** Where the records go when DECISIONS_DIR is left empty, relative to the web folder. */
const DEFAULT_DECISIONS_DIR = "../data/decisions";
/** A request body larger than this is not a decision record. */
const MAX_BODY_BYTES = 2_000_000;

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const refuse = (reason: string, status: number) => answer({ ok: false, reason }, status);

/** True when `inner` is `outer` itself or sits somewhere below it. */
function isInside(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The folder the records are kept in, or why the setting cannot be used. The full path stays here. */
function decisionsDir(): { ok: true; dir: string } | { ok: false; reason: string } {
  const setting = (process.env.DECISIONS_DIR ?? "").trim();
  const dir = path.resolve(process.cwd(), setting || DEFAULT_DECISIONS_DIR);
  const project = path.resolve(process.cwd(), "..");
  const data = path.join(project, "data");
  if (isInside(project, dir) && !isInside(data, dir)) {
    return { ok: false, reason: "DECISIONS_DIR points inside the project. Decisions are kept under data/decisions, which stays out of git, or in a folder outside the project." };
  }
  return { ok: true, dir };
}

/** The record files in the folder, by name, sorted. An empty list when the folder is not there yet. */
async function listed(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => FILE_PATTERN.test(name)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** One record file read back, or null when it cannot be read or is not a record. `name` is always a name the listing produced. */
async function readOne(dir: string, name: string): Promise<DecisionRecord | null> {
  try {
    return readDecisionRecord(JSON.parse(await readFile(path.join(dir, name), "utf8")));
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return refuse("The request body could not be read.", 400);
  }
  if (raw.length > MAX_BODY_BYTES) return refuse("The request body is too large to be a decision record.", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("The request body is not JSON.", 400);
  }
  // Only the fields of a record, checked one by one, reach the disk.
  const record = readDecisionRecord(parsed);
  if (!record) return refuse("The request body is not a decision record.", 400);
  const file = fileNameFor(record);
  if (!FILE_PATTERN.test(file)) return refuse("The record's id cannot be used as a file name.", 400);

  const where = decisionsDir();
  if (!where.ok) return refuse(where.reason, 500);
  try {
    await mkdir(where.dir, { recursive: true });
    await writeFile(path.join(where.dir, file), toJson(record), "utf8");
  } catch (e) {
    // Only the error code is passed on: the message itself carries the full path.
    return refuse(`The decision could not be saved (${(e as NodeJS.ErrnoException).code ?? "unknown error"}).`, 500);
  }
  return answer({ ok: true, file, id: record.id });
}

export async function GET(req: Request) {
  const where = decisionsDir();
  if (!where.ok) return refuse(where.reason, 500);
  let names: string[];
  try {
    names = await listed(where.dir);
  } catch (e) {
    return refuse(`The decisions folder could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown error"}).`, 500);
  }

  const id = new URL(req.url).searchParams.get("id");
  if (id !== null) {
    // The id is never turned into a path by itself. It is compared, character for character, with
    // the names the listing produced, so "..", slashes, drive letters and encoded separators all
    // fail simply by not being on the list.
    const name = ID_PATTERN.test(id) ? names.find((n) => n === `${id}.json`) : undefined;
    const record = name ? await readOne(where.dir, name) : null;
    if (!record || record.id !== id) return refuse("No such decision.", 404);
    return answer({ ok: true, record });
  }

  const records: DecisionSummary[] = [];
  for (const name of names) {
    const record = await readOne(where.dir, name);
    if (record) records.push(summaryOf(record));
  }
  return answer({ ok: true, records: sortNewestFirst(records) });
}
