import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../src/app/api/decisions/route";
import { emptyDecision, stampDecision } from "../src/lib/decision";
import { fileNameFor, FILE_PATTERN, ID_PATTERN, offerSlug, readDecisionRecord, recordFromDecision, sortNewestFirst, stampFor, summaryOf, toJson, type DecisionFocus, type DecisionRecord } from "../src/lib/decisionLog";
import { REFERENCE_PARAMS } from "../src/lib/model/params";
import type { ModelDataVersion } from "../src/lib/modelData/version";
import { buildTrace } from "../src/lib/trace";

// Every name, figure and hash here is invented. No real offer is read.
const VERSION: ModelDataVersion = {
  id: "2026-10-09_starter-kit",
  date: "2026-10-09",
  label: "Nairobi starter kit",
  description: "The starter kit as handed out.",
  area: { id: "nairobi", name: "Nairobi", centre: [36.82, -1.29], zoom: 11, hazardKind: "score" },
  status: "approved",
  files: [{ name: "exposure.csv", role: "exposure", provenance: "synthetic", sha256: "a".repeat(64), bytes: 1234, rows: 600 }],
  sources: [],
  notes: [],
};

const trace = buildTrace({
  version: VERSION,
  active: { source: "reference", params: REFERENCE_PARAMS },
  mode: "all_drivers",
  judgement: null,
  deliberation: null,
  offer: { fileName: "Invented Plaza offer (final).docx", sha256: "c".repeat(64) },
  generatedAt: "2026-10-09T20:00:00.000Z",
  app: { commit: "abc1234", version: "0.1.0" },
});

const focus = (over: Partial<DecisionFocus> = {}): DecisionFocus => ({
  documentName: "Invented Plaza offer (final).docx",
  line: { insured: "Invented Plaza Ltd", sumInsuredKes: 4_250_000_000 },
  building: { name: "Invented Plaza" },
  price: { total: { ratePerMilleGross: 1.53, loss100GrossKes: 81_700_000, aalGrossKes: 1_800_000 } },
  drivers: { premium: { floodPremiumKes: 8_740_000, floodRatePerMille: 2.06, setBy: "modelled" } },
  mode: "all_drivers",
  drainageOn: true,
  assumptionsInForce: "ai",
  flags: [
    { id: "basement-ingress", severity: "high", title: "The basement takes water from the 1-in-25 flood" },
    { id: "under_insurance", severity: "medium", title: "Declared values look low" },
  ],
  conditions: [
    { id: "flood_sublimit", text: "Consider a flood sub-limit below the full sum insured." },
    { id: "relocate_plant", text: "Consider asking for critical plant to be moved out of the basement." },
  ],
  ...over,
});

const decided = stampDecision({ ...emptyDecision(), choice: "accept_with_conditions", note: "  Subject to survey.  ", conditions: ["relocate_plant", "not-on-the-page"] }, new Date("2026-10-09T20:01:00Z"));
const SAVED_AT = "2026-10-09T20:15:30.123Z";
const record = () => recordFromDecision({ decision: decided, focus: focus(), trace, savedAt: SAVED_AT });

describe("recordFromDecision", () => {
  it("builds the record from the decision, the offer on screen and the trace", () => {
    const r = record();
    expect(r.format).toBe(1);
    expect(r.id).toBe("2026-10-09T20-15-30-123Z_invented-plaza-offer-final");
    expect(ID_PATTERN.test(r.id)).toBe(true);
    expect(fileNameFor(r)).toBe("2026-10-09T20-15-30-123Z_invented-plaza-offer-final.json");
    expect(FILE_PATTERN.test(fileNameFor(r))).toBe(true);
    expect(r.savedAt).toBe(SAVED_AT);
    expect(r.offer).toEqual({ fileName: "Invented Plaza offer (final).docx", buildingName: "Invented Plaza", insured: "Invented Plaza Ltd", sumInsuredKes: 4_250_000_000, hash: "c".repeat(64) });
    expect(r.figures).toEqual({
      ratePerMille: 2.06,
      pureRatePerMille: 1.53,
      floodPremiumKes: 8_740_000,
      premiumSetBy: "modelled",
      loss100GrossKes: 81_700_000,
      aalGrossKes: 1_800_000,
      mode: "all_drivers",
      floodSource: "terrain_drainage",
      assumptions: "agents",
    });
    expect(r.flags).toEqual([
      { id: "basement-ingress", severity: "high", title: "The basement takes water from the 1-in-25 flood" },
      { id: "under_insurance", severity: "medium", title: "Declared values look low" },
    ]);
    // Only the conditions ticked and on the page, with their words.
    expect(r.conditions).toEqual([{ id: "relocate_plant", text: "Consider asking for critical plant to be moved out of the basement." }]);
    expect(r.decision).toEqual({ choice: "accept_with_conditions", label: "Accept with conditions", recordedAt: "2026-10-09T20:01:00.000Z" });
    expect(r.note).toBe("Subject to survey.");
    expect(r.trace).toBe(trace);
  });

  it("refuses a draft without a choice", () => {
    expect(() => recordFromDecision({ decision: emptyDecision(), focus: focus(), trace })).toThrow(/Choose Accept/);
  });

  it("has no figures for an offer that is not priced, and no hash when the trace has none", () => {
    const r = recordFromDecision({ decision: { ...decided, choice: "refer" }, focus: focus({ price: null, drivers: null, building: null, drainageOn: false, assumptionsInForce: "reference" }), trace: { ...trace, offer: null }, savedAt: SAVED_AT });
    expect(r.figures).toEqual({ ratePerMille: null, pureRatePerMille: null, floodPremiumKes: null, premiumSetBy: null, loss100GrossKes: null, aalGrossKes: null, mode: "all_drivers", floodSource: "terrain", assumptions: "reference" });
    expect(r.offer.buildingName).toBe("");
    expect(r.offer.hash).toBeNull();
    expect(r.decision.label).toBe("Refer");
    expect(summaryOf(r).building).toBe("Invented Plaza Ltd");
  });

  it("stamps the time now when none is given", () => {
    const before = Date.now();
    const r = recordFromDecision({ decision: decided, focus: focus(), trace });
    expect(new Date(r.savedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(r.id.startsWith(`${stampFor(r.savedAt)}_`)).toBe(true);
  });

  it("round-trips through JSON", () => {
    const r = record();
    const back = readDecisionRecord(JSON.parse(toJson(r)));
    expect(back).toEqual(r);
    expect(toJson(back!)).toBe(toJson(r));
  });

  it("names the file from the offer's name", () => {
    expect(offerSlug("Invented Plaza offer (final).docx")).toBe("invented-plaza-offer-final");
    expect(offerSlug("typed text")).toBe("typed-text");
    expect(offerSlug("MEMO_2026.PDF")).toBe("memo-2026");
    expect(offerSlug("...")).toBe("offer");
    expect(offerSlug("")).toBe("offer");
    expect(offerSlug(`${"a".repeat(80)}.txt`)).toHaveLength(48);
    expect(stampFor("2026-10-09T20:15:30.123Z")).toBe("2026-10-09T20-15-30-123Z");
  });

  it("lists newest first", () => {
    const list = [
      { id: "b", savedAt: "2026-10-09T10:00:00.000Z" },
      { id: "a", savedAt: "2026-10-09T12:00:00.000Z" },
      { id: "c", savedAt: "2026-10-09T10:00:00.000Z" },
    ];
    expect(sortNewestFirst(list).map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(list.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});

describe("readDecisionRecord", () => {
  const plain = () => JSON.parse(toJson(record())) as Record<string, unknown>;

  it("keeps only the fields of a record", () => {
    const raw = plain();
    raw.path = "C:\\somewhere";
    (raw.offer as Record<string, unknown>).secret = "x";
    const r = readDecisionRecord(raw)!;
    expect(r).not.toBeNull();
    expect("path" in r).toBe(false);
    expect("secret" in r.offer).toBe(false);
    expect(Object.keys(r).sort()).toEqual(["conditions", "decision", "figures", "flags", "format", "id", "note", "offer", "savedAt", "trace"]);
  });

  it.each<[string, (raw: Record<string, unknown>) => void]>([
    ["another format", (raw) => (raw.format = 2)],
    ["an id with a slash", (raw) => (raw.id = "2026-10-09T20-15-30-123Z_a/b")],
    ["an id with a dot", (raw) => (raw.id = "2026-10-09T20-15-30-123Z_a.b")],
    ["an id with capitals", (raw) => (raw.id = "2026-10-09T20-15-30-123Z_Plaza")],
    ["an id whose stamp is not the time saved", (raw) => (raw.id = "2026-10-09T20-15-30-124Z_invented-plaza-offer-final")],
    ["a time that is not a date", (raw) => (raw.savedAt = "yesterday")],
    ["a decision that is not one of the four", (raw) => ((raw.decision as Record<string, unknown>).choice = "maybe")],
    ["a hash that is not sha256", (raw) => ((raw.offer as Record<string, unknown>).hash = "abc")],
    ["an unknown mode", (raw) => ((raw.figures as Record<string, unknown>).mode = "both")],
    ["an unknown premium setter", (raw) => ((raw.figures as Record<string, unknown>).premiumSetBy = "broker")],
    ["flags that are not a list", (raw) => (raw.flags = "none")],
    ["a flag without a severity", (raw) => (raw.flags = [{ id: "x", title: "y" }])],
    ["a condition without words", (raw) => (raw.conditions = [{ id: "x" }])],
    ["no trace", (raw) => delete raw.trace],
    ["a trace of another shape", (raw) => (raw.trace = { format: 0 })],
    ["no offer", (raw) => delete raw.offer],
  ])("refuses %s", (_what, break_) => {
    const raw = plain();
    break_(raw);
    expect(readDecisionRecord(raw)).toBeNull();
  });

  it("refuses what is not an object at all", () => {
    for (const raw of [null, undefined, 1, "text", [], true]) expect(readDecisionRecord(raw)).toBeNull();
  });
});

describe("the decisions API", () => {
  let base: string;
  let folder: string;
  const savedSetting = process.env.DECISIONS_DIR;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "decisions-test-"));
    folder = join(base, "decisions");
    // A record outside the folder, which no request may reach.
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "2026-10-09T20-15-30-123Z_secret.json"), toJson({ ...record(), id: "2026-10-09T20-15-30-123Z_secret" }));
  });
  afterAll(() => {
    if (savedSetting === undefined) delete process.env.DECISIONS_DIR;
    else process.env.DECISIONS_DIR = savedSetting;
    rmSync(base, { recursive: true, force: true });
  });
  beforeEach(() => {
    process.env.DECISIONS_DIR = folder;
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const post = (body: unknown) => POST(new Request("http://localhost/api/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const get = (query = "") => GET(new Request(`http://localhost/api/decisions${query}`));
  const later = (): DecisionRecord => recordFromDecision({ decision: { ...decided, choice: "decline", note: "Outside appetite." }, focus: focus({ documentName: "Second memo.txt", building: { name: "Second site" } }), trace, savedAt: "2026-10-10T08:00:00.000Z" });

  it("saves a record as <id>.json and lists the records newest first", async () => {
    const first = record();
    const second = later();
    const res = await post(first);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, file: fileNameFor(first), id: first.id });
    expect((await post(second)).status).toBe(200);

    expect(readdirSync(folder).sort()).toEqual([fileNameFor(first), fileNameFor(second)].sort());
    expect(JSON.parse(readFileSync(join(folder, fileNameFor(first)), "utf8"))).toEqual(first);

    const list = await get();
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      ok: true,
      records: [
        { id: second.id, savedAt: "2026-10-10T08:00:00.000Z", building: "Second site", decision: "Decline" },
        { id: first.id, savedAt: SAVED_AT, building: "Invented Plaza", decision: "Accept with conditions" },
      ],
    });
  });

  it("returns one record by id", async () => {
    const first = record();
    await post(first);
    const res = await get(`?id=${encodeURIComponent(first.id)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, record: first });
  });

  it("answers an empty list before anything is saved, and 404 for an id that is not there", async () => {
    expect(existsSync(folder)).toBe(false);
    const list = await get();
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ ok: true, records: [] });
    const one = await get("?id=2026-10-09T20-15-30-123Z_nothing");
    expect(one.status).toBe(404);
    expect(await one.json()).toEqual({ ok: false, reason: "No such decision." });
  });

  it.each([
    ["traversal", "../outside/2026-10-09T20-15-30-123Z_secret"],
    ["traversal with backslashes", "..\\outside\\2026-10-09T20-15-30-123Z_secret"],
    ["traversal after a good id", "2026-10-09T20-15-30-123Z_invented-plaza-offer-final/../../outside/2026-10-09T20-15-30-123Z_secret"],
    ["an encoded traversal", "%2e%2e%2foutside%2f2026-10-09T20-15-30-123Z_secret"],
    ["an absolute path", "C:\\Windows\\win.ini"],
    ["the file name itself", "2026-10-09T20-15-30-123Z_invented-plaza-offer-final.json"],
    ["different letter case", "2026-10-09T20-15-30-123Z_Invented-Plaza-Offer-Final"],
    ["a trailing null byte", "2026-10-09T20-15-30-123Z_invented-plaza-offer-final\0"],
    ["an empty id", ""],
  ])("refuses %s with a plain 404", async (_what, id) => {
    await post(record());
    const res = await get(`?id=${encodeURIComponent(id)}`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, reason: "No such decision." });
    expect(text).not.toContain("secret");
    expect(text).not.toContain(base.replaceAll("\\", "\\\\"));
  });

  it("refuses a body that is not a record, and writes nothing", async () => {
    const bad = await post({ ...record(), id: "../escape" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ ok: false, reason: "The request body is not a decision record." });
    const notJson = await post("{not json");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ ok: false, reason: "The request body is not JSON." });
    expect((await post(null)).status).toBe(400);
    expect(existsSync(folder)).toBe(false);
  });

  it.each([
    ["a folder inside the web folder", () => join(process.cwd(), "tmp-decisions-test")],
    ["a relative folder inside the web folder", () => "src/decisions"],
    ["a folder beside the web folder", () => resolve(process.cwd(), "..", "tmp-decisions-test")],
    ["the project folder itself", () => resolve(process.cwd(), "..")],
  ])("refuses %s and makes no folder", async (_what, where) => {
    const dir = where();
    const existedBefore = existsSync(resolve(process.cwd(), dir));
    process.env.DECISIONS_DIR = dir;
    const saved = await post(record());
    expect(saved.status).toBe(500);
    const body = await saved.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("inside the project");
    expect(body.reason).not.toContain(process.cwd());
    expect(existsSync(resolve(process.cwd(), dir))).toBe(existedBefore);
    const list = await get();
    expect(list.status).toBe(500);
    expect((await list.json()).reason).toContain("inside the project");
  });

  it("allows a folder under the project's data folder, which git ignores", async (ctx) => {
    const data = resolve(process.cwd(), "..", "data");
    if (!existsSync(data)) return ctx.skip();
    const dir = join(data, `.decisions-test-${process.pid}`);
    process.env.DECISIONS_DIR = dir;
    try {
      const saved = await post(record());
      expect(saved.status).toBe(200);
      expect(existsSync(join(dir, fileNameFor(record())))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a file in the folder that is not a record", async () => {
    await post(record());
    writeFileSync(join(folder, "2026-10-09T20-15-30-123Z_broken.json"), "{not json");
    writeFileSync(join(folder, "notes.txt"), "nothing");
    const list = await get();
    expect((await list.json()).records).toHaveLength(1);
    expect((await get("?id=2026-10-09T20-15-30-123Z_broken")).status).toBe(404);
  });
});
