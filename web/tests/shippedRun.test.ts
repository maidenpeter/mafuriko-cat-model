import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OfferBrief } from "../src/lib/agents/offerBrief";
import { aiChecks, replay, type Deliberation } from "../src/lib/agents/orchestrate";
import { nestReply } from "../src/lib/agents/schema";
import { loadShipped, offerKey, pickShipped, readShippedIndex, readShippedRun, replayShipped, sameInputs, shippedLabel, type ShippedEntry, type ShippedIndex } from "../src/lib/agents/shipped";
import { detectDatasets, loadDataset, type FileSource } from "../src/lib/ingest";
import { BOUNDS, flattenParams, REFERENCE_PARAMS } from "../src/lib/model/params";
import { resultFingerprint, runModel } from "../src/lib/model/pipeline";
import type { Dataset, ModelParams } from "../src/lib/model/types";
import { sameOffer } from "../src/lib/offer/focus";
import { AGENT_JUDGEMENT_KEYS, JUDGEMENT_BOUNDS, REFERENCE_JUDGEMENT, type OfferJudgement } from "../src/lib/offer/judgement";
import { OCCUPANCIES } from "../src/lib/offer/types";
import { loadRun, runInputs, saveRun, type RunInputs, type SavedRun, type Session } from "../src/lib/session";

// Every building, fact, sentence and reply here is invented. No model is called and no browser is opened:
// the run is built by hand, saved the way the app saves one, packed by the script into a temporary folder
// and read back from there.

const SCRIPT = join(__dirname, "..", "scripts", "pack-run.mjs");
const PUBLIC = join(__dirname, "..", "public", "agents");
const MODEL = "invented-model-1";

const dataset: Dataset = {
  name: "toy",
  hazardKind: "score",
  scenarios: [
    { id: "extreme", label: "extreme" },
    { id: "common", label: "common" },
  ],
  hotspots: [],
  rasters: [],
  buildings: [
    { locId: "A", lat: 0, lon: 0, housingClassRaw: "informal_iron_sheet", housingClass: "informal_iron_sheet", floorAreaM2: null, costPerM2Kes: null, tivKes: 1000, synthetic: true, hazard: [0, 0.25] },
    { locId: "B", lat: 0, lon: 0, housingClassRaw: "concrete_rcc", housingClass: "concrete_rcc", floorAreaM2: null, costPerM2Kes: null, tivKes: 100000, synthetic: true, hazard: [0.25, 0.5] },
  ],
};
/** Only the data set and the reference result are read when a run is saved. */
const session = { dataset, reference: runModel(dataset, REFERENCE_PARAMS) } as Session;
const INPUTS: RunInputs = runInputs(session);

const BRIEF: OfferBrief = {
  housingClass: "concrete_rcc",
  occupancy: "commercial",
  insuredValueKes: 2_000_000_000,
  floorAreaM2: 30_000,
  locationApproximate: false,
  basements: 2,
  basementDepthM: 7.5,
  criticalPlantInBasement: true,
  equipmentBelowGroundCount: 3,
  valueBelowGroundKes: null,
  drainageCondition: "Open channels on two sides, reported silted",
  drainDesignRp: 50,
  sumpPumpCapacity: "Two pumps, duty and standby",
  sumpPumpBackup: "no",
  floodBarriers: "absent",
  nonReturnValves: null,
  biCovered: "covered",
  floodLossCount: 1,
  floodLossTotalKes: 14_000_000,
  floodHistoryYears: 11,
  bufferRadiusM: 250,
  depthsByTier: [{ tier: "common", returnPeriod: 250, pointM: 0, bufferM: 0.86, pondingM: 0.05, overloaded: true }],
  nearestMappedWaterM: 40,
  nearestRiverM: 600,
  nearestDrainM: 35,
  quotes: [{ about: "equipment below ground", quote: "An invented sentence about a generator on the lower level." }],
};

/** What the Chair settles: one value moved inside its range, and one outside it, which code brings back. */
const CHAIR: Record<string, number> = { depthScaleM: 3.2, "fragility.concrete_rcc": 9, "returnPeriods.common": 300 };
const AGREED: ModelParams = { ...REFERENCE_PARAMS, depthScaleM: 3.2, fragility: { ...REFERENCE_PARAMS.fragility, concrete_rcc: BOUNDS.fragility.max }, returnPeriods: { ...REFERENCE_PARAMS.returnPeriods, common: 300 } };
/** The Chair's figures for the offer: inside their ranges, both ladders left at the reference. */
const OFFER_AGREED: Partial<OfferJudgement> = { ...Object.fromEntries(AGENT_JUDGEMENT_KEYS.map((k) => [k, REFERENCE_JUDGEMENT[k]])), bufferRadiusM: 300, uncertaintyLoading: 0.2 };

const modelEntries = (values: Record<string, number> = {}, extra: object = {}) => flattenParams(REFERENCE_PARAMS).map((p) => ({ name: p.path, reason: `because ${p.path}`, basis: "brief", ...extra, value: values[p.path] ?? p.value }));
const offerEntries = (values: Partial<OfferJudgement>, extra: object = {}) => AGENT_JUDGEMENT_KEYS.map((k) => ({ name: `offer.${k}`, reason: `because of the offer's ${k}`, basis: "offer", ...extra, value: values[k] ?? REFERENCE_JUDGEMENT[k] }));
const CRITIQUE = { summary: "An invented summary.", challenges: [{ id: "C1", title: "An invented challenge", detail: "An invented detail.", severity: "medium", affects: ["data"], recommendation: "An invented recommendation." }] };

/** A finished run as the app holds it after a live one, with its per-building results: made by hand, then scored by code. */
function finishedRun(withOffer: boolean, startedAt = "2026-10-08T09:15:00.000Z"): Deliberation {
  const proposal = (values: Record<string, number>) => nestReply("optimist", { stance: "An invented stance.", parameters: [...modelEntries(values), ...(withOffer ? offerEntries({}) : [])] }, withOffer);
  const decision = nestReply("chair", { summary: "An invented summary.", parameters: [...modelEntries(CHAIR, { leans: "between" }), ...(withOffer ? offerEntries(OFFER_AGREED, { leans: "between" }) : [])], responses: [{ challengeId: "C1", verdict: "accepted", response: "An invented response." }] }, withOffer);
  const run = (role: string, output: unknown, tokens: number) => ({ role, status: "done", model: MODEL, ms: 1200, attempts: 1, usage: { promptTokens: tokens, outputTokens: 50, thinkingTokens: 5 }, prompt: { system: `Invented instructions for the ${role}.`, user: "An invented input." }, raw: JSON.stringify(output), output });
  const saved = {
    startedAt,
    datasetName: dataset.name,
    profile: {},
    runs: { optimist: run("optimist", proposal({ depthScaleM: 2.5 }), 100), cautious: run("cautious", proposal({ depthScaleM: 5 }), 110), critic: run("critic", CRITIQUE, 120), chair: run("chair", decision, 130) },
    optimist: null,
    cautious: null,
    final: null,
    fingerprint: resultFingerprint(runModel(dataset, AGREED)),
    ...(withOffer ? { offerJudgement: { optimist: null, cautious: null, final: null, reasons: {}, adjustments: [], brief: BRIEF } } : {}),
  } as unknown as Deliberation;
  return replay(dataset, saved);
}

/** The value the app leaves under the browser's storage key after a live run, written to a file. */
function savedFile(folder: string, name: string, d: Deliberation): string {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { setItem: (k: string, v: string) => store.set(k, v), getItem: (k: string) => store.get(k) ?? null });
  saveRun(session, d);
  expect([...store.keys()]).toEqual([`mafuriko:run:toy:2:${INPUTS.totalTivKes}`]);
  // What comes back out of the browser is what went in.
  expect(loadRun(session)).toEqual(JSON.parse([...store.values()][0]));
  const path = join(folder, name);
  writeFileSync(path, [...store.values()][0]);
  return path;
}

const pack = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const json = <T,>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
/** Reads one file of a folder the way the app fetches one from /agents. */
const reader = (folder: string) => async (name: string) => json<unknown>(join(folder, name));

let work: string;
let out: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "mafuriko-runs-"));
  out = join(work, "agents");
});
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe("a run as the app saves it", () => {
  it("states what it was made on and its final parameters, without the per-building results", () => {
    const stored = json<SavedRun>(savedFile(work, "stored.json", finishedRun(false)));
    expect(stored.inputs).toEqual({ dataset: "toy", buildings: 2, totalTivKes: 101000, reference: resultFingerprint(session.reference) });
    expect(stored.finalParams).toEqual(AGREED);
    expect(stored.final).toBeNull();
    expect(stored.optimist).toBeNull();
    expect(stored.runs.chair.usage).toEqual({ promptTokens: 130, outputTokens: 50, thinkingTokens: 5 });
  });
});

// Each test starts Node once or more for the script, which is slow while the other test files run beside it.
describe("the pack script", { timeout: 60_000 }, () => {
  it("writes a portfolio run under a dated name and lists it in the index", () => {
    const res = pack(savedFile(work, "portfolio.json", finishedRun(false)), "--kind", "portfolio", "--out", out);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tokens in 460, out 200, thinking 20");
    const index = json<ShippedIndex>(join(out, "index.json"));
    expect(index.runs).toEqual([{ file: "portfolio-2026-10-08.json", kind: "portfolio", savedAt: "2026-10-08T09:15:00.000Z", model: MODEL, inputs: INPUTS }]);
    // The index is exactly what the app reads back, and the file is the run as it was saved: replies, tokens, model, inputs, parameters.
    expect(readShippedIndex(index)).toEqual(index);
    const run = json<SavedRun>(join(out, "portfolio-2026-10-08.json"));
    expect(run.inputs).toEqual(INPUTS);
    expect(run.finalParams).toEqual(AGREED);
    expect(run.runs.optimist.model).toBe(MODEL);
    expect(run.runs.chair.raw).toContain("An invented summary.");
    expect(run.runs.chair.prompt?.system).toContain("Invented instructions");
    expect(run).not.toHaveProperty("offerJudgement");
  });

  it("lists an offer run with the key of its offer, and leaves the prompts and the document's sentences out when asked", () => {
    const res = pack(savedFile(work, "offer.json", finishedRun(true)), "--kind", "offer", "--drop-prompts", "--out", out);
    expect(res.stderr).toBe("");
    const key = offerKey(BRIEF);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    const file = `offer-2026-10-08-${key.slice(0, 8)}.json`;
    const index = json<ShippedIndex>(join(out, "index.json"));
    expect(index.runs.map((r) => r.file)).toEqual(["portfolio-2026-10-08.json", file]);
    // The script works out the same key in plain JavaScript as the app does.
    expect(index.runs[1]).toEqual({ file, kind: "offer", savedAt: "2026-10-08T09:15:00.000Z", model: MODEL, inputs: INPUTS, offerKey: key });

    const text = readFileSync(join(out, file), "utf8");
    expect(text).not.toContain("Invented instructions");
    expect(text).not.toContain("An invented input.");
    expect(text).not.toContain("generator on the lower level");
    expect(text).not.toContain("reported silted");
    const run = JSON.parse(text) as SavedRun;
    for (const role of ["optimist", "cautious", "critic", "chair"] as const) {
      expect(run.runs[role]).not.toHaveProperty("prompt");
      expect(run.runs[role].raw).toBeTruthy();
      expect(run.runs[role].usage?.promptTokens).toBeGreaterThan(0);
    }
    expect(run.offerJudgement?.final).toEqual(OFFER_AGREED);
    expect(run.offerJudgement?.brief).toMatchObject({ basements: 2, insuredValueKes: 2_000_000_000, quotes: [], drainageCondition: null, sumpPumpCapacity: null });
  });

  it("replaces an older run of the same kind and inputs, and keeps the others", () => {
    const res = pack(savedFile(work, "newer.json", finishedRun(false, "2026-10-09T07:00:00.000Z")), "--kind", "portfolio", "--out", out);
    expect(res.status).toBe(0);
    const index = json<ShippedIndex>(join(out, "index.json"));
    expect(index.runs.map((r) => r.file)).toEqual(["portfolio-2026-10-09.json", `offer-2026-10-08-${offerKey(BRIEF).slice(0, 8)}.json`]);
    expect(existsSync(join(out, "portfolio-2026-10-08.json"))).toBe(false);
    expect(readdirSync(out).sort()).toEqual(["index.json", ...index.runs.map((r) => r.file)].sort());
  });

  it("refuses a run that is not whole, and says why", () => {
    const whole = json<SavedRun>(savedFile(work, "whole.json", finishedRun(false)));
    const broken = (name: string, change: (run: Record<string, unknown>) => void, ...flags: string[]) => {
      const run = JSON.parse(JSON.stringify(whole)) as Record<string, unknown>;
      change(run);
      const path = join(work, name);
      writeFileSync(path, JSON.stringify(run));
      const before = readFileSync(join(out, "index.json"), "utf8");
      const res = pack(path, "--kind", "portfolio", "--out", out, ...flags);
      expect(res.status).toBe(1);
      expect(readFileSync(join(out, "index.json"), "utf8")).toBe(before);
      return res.stderr;
    };
    expect(broken("no-inputs.json", (r) => delete r.inputs)).toContain("does not say what it was made on");
    expect(broken("no-params.json", (r) => delete r.finalParams)).toContain("does not state its final parameters");
    expect(broken("no-critic.json", (r) => ((r.runs as Record<string, unknown>).critic = { role: "critic", status: "error", error: "An invented failure." }))).toContain("The critic gave no valid reply");
    expect(broken("with-offer.json", (r) => (r.offerJudgement = { final: OFFER_AGREED, brief: BRIEF }))).toContain("made with an offer loaded");
    // A portfolio run has no figures for an offer, so it cannot ship as an offer run.
    const res = pack(join(work, "whole.json"), "--kind", "offer", "--out", out);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no agreed figures for an offer");
    expect(pack(join(work, "whole.json"), "--out", out).stderr).toContain("Usage:");
  });
});

describe("the runs that ship with the app", () => {
  it("are matched by what they were made on", async () => {
    const shipped = (await loadShipped(INPUTS, reader(out)))!;
    expect(shipped.otherData).toBe(false);
    expect(shipped.runs.map((r) => r.entry.kind)).toEqual(["portfolio", "offer"]);
    // The same data set under the same name, read by a model that has changed since: the reference fingerprint differs.
    for (const other of [{ ...INPUTS, reference: "00000000" }, { ...INPUTS, buildings: 3 }, { ...INPUTS, totalTivKes: INPUTS.totalTivKes + 1 }, { ...INPUTS, dataset: "another" }]) {
      expect(sameInputs(INPUTS, other)).toBe(false);
      expect(await loadShipped(other, reader(out))).toEqual({ runs: [], otherData: true });
    }
  });

  it("ignores a run that does not match, or that cannot be replayed", async () => {
    const index = json<ShippedIndex>(join(out, "index.json"));
    const portfolio = index.runs[0];
    const file = json<Record<string, unknown>>(join(out, portfolio.file));
    expect(readShippedRun(file, portfolio)).not.toBeNull();
    // Listed under inputs the file itself was not made on.
    expect(readShippedRun(file, { ...portfolio, inputs: { ...INPUTS, reference: "00000000" } })).toBeNull();
    // A Chair's reply with a parameter missing would not survive a replay.
    const cut = JSON.parse(JSON.stringify(file)) as { runs: { chair: { output: { decision: Record<string, unknown> } } } };
    delete cut.runs.chair.output.decision.depthScaleM;
    expect(readShippedRun(cut, portfolio)).toBeNull();
    expect(readShippedRun({ ...file, runs: { ...(file.runs as object), critic: { role: "critic", status: "error" } } }, portfolio)).toBeNull();
    expect(readShippedRun("not a run", portfolio)).toBeNull();
    // A listed file that is missing or broken is left out; the other runs still load.
    const read = reader(out);
    const shipped = await loadShipped(INPUTS, async (name) => (name === portfolio.file ? Promise.reject(new Error("gone")) : read(name)));
    expect(shipped?.runs.map((r) => r.entry.kind)).toEqual(["offer"]);
  });

  it("drops the lines of an index that are not whole", () => {
    const good: ShippedEntry = { file: "portfolio-2026-10-08.json", kind: "portfolio", savedAt: "2026-10-08T09:15:00.000Z", model: MODEL, inputs: INPUTS };
    const lines = [good, { ...good, file: "../outside.json" }, { ...good, file: "https://example.org/run.json" }, { ...good, kind: "other" }, { ...good, savedAt: "yesterday" }, { ...good, model: "" }, { ...good, inputs: { dataset: "toy" } }, { ...good, kind: "offer" }, null, "text"];
    expect(readShippedIndex({ runs: lines }).runs).toEqual([good]);
    for (const nothing of [null, undefined, "text", [], {}, { runs: "none" }]) expect(readShippedIndex(nothing)).toEqual({ runs: [] });
  });

  it("uses an offer run only for its own offer", async () => {
    const { runs } = (await loadShipped(INPUTS, reader(out)))!;
    const [portfolio, offer] = runs;
    expect(pickShipped(runs, null)).toBe(portfolio);
    expect(pickShipped(runs, offerKey(BRIEF))).toBe(offer);
    // What the maps show at the point moves with the flood source and the assumptions: still the same offer.
    const onOtherMaps: OfferBrief = { ...BRIEF, bufferRadiusM: 100, depthsByTier: [], nearestMappedWaterM: 0 };
    expect(pickShipped(runs, offerKey(onOtherMaps))).toBe(offer);
    // Another offer, or this one with a fact changed: the portfolio run applies.
    expect(pickShipped(runs, offerKey({ ...BRIEF, basements: 1 }))).toBe(portfolio);
    expect(pickShipped(runs, "0000000000000000")).toBe(portfolio);
    // With no portfolio run shipped, an offer run still never serves another offer, or no offer.
    expect(pickShipped([offer], null)).toBeNull();
    expect(pickShipped([offer], offerKey({ ...BRIEF, basements: 1 }))).toBeNull();
    expect(pickShipped([], offerKey(BRIEF))).toBeNull();

    // The portfolio run carries no figures for an offer, so an offer priced beside it stays on the reference values.
    expect(replayShipped(dataset, portfolio.run)).not.toHaveProperty("offerJudgement");
    // The offer run is handed on without its brief: its key has matched, so its figures are for the offer on screen.
    const replayed = replayShipped(dataset, offer.run)!;
    expect(replayed.offerJudgement?.brief).toBeUndefined();
    expect(replayed.offerJudgement?.final).toEqual(OFFER_AGREED);
    expect(replayed.offerJudgement?.reasons.bufferRadiusM).toEqual({ reason: "because of the offer's bufferRadiusM", basis: "offer", leans: "between" });
    for (const key of AGENT_JUDGEMENT_KEYS) expect(replayed.offerJudgement!.final![key]).toBeLessThanOrEqual(JUDGEMENT_BOUNDS[key].max);
  });

  it("gives two briefs the same key exactly when they describe the same offer", () => {
    const changed: Partial<OfferBrief>[] = [
      { housingClass: "permanent_masonry" },
      { occupancy: OCCUPANCIES.find((o) => o !== BRIEF.occupancy) },
      { insuredValueKes: 2_000_000_001 },
      { floorAreaM2: 30_001 },
      { locationApproximate: true },
      { basements: 1 },
      { basementDepthM: 6 },
      { criticalPlantInBasement: false },
      { equipmentBelowGroundCount: 2 },
      { valueBelowGroundKes: 5 },
      { drainageCondition: "Another invented line" },
      { drainDesignRp: 25 },
      { sumpPumpCapacity: null },
      { sumpPumpBackup: "yes" },
      { floodBarriers: "present" },
      { nonReturnValves: "present" },
      { biCovered: "excluded" },
      { floodLossCount: 2 },
      { floodLossTotalKes: 1 },
      { floodHistoryYears: 5 },
      { nearestRiverM: 700 },
      { nearestDrainM: 60 },
      { quotes: [{ about: "equipment below ground", quote: "Another invented sentence." }] },
      { quotes: [] },
    ];
    const unchanged: Partial<OfferBrief>[] = [{}, { bufferRadiusM: 100 }, { depthsByTier: [] }, { nearestMappedWaterM: null }, { insuredValueKes: 2_000_000_000.4 }, { quotes: [{ about: "renamed", quote: BRIEF.quotes[0].quote }] }];
    for (const change of changed) {
      expect(sameOffer(BRIEF, { ...BRIEF, ...change })).toBe(false);
      expect(offerKey({ ...BRIEF, ...change })).not.toBe(offerKey(BRIEF));
    }
    for (const change of unchanged) {
      expect(sameOffer(BRIEF, { ...BRIEF, ...change })).toBe(true);
      expect(offerKey({ ...BRIEF, ...change })).toBe(offerKey(BRIEF));
    }
  });

  it("replay to the same final parameters, with every check run again by code", async () => {
    const { runs } = (await loadShipped(INPUTS, reader(out)))!;
    for (const { run } of runs) {
      const replayed = replayShipped(dataset, run)!;
      expect(replayed.final!.params).toEqual(run.finalParams);
      expect(replayed.final!.params).toEqual(AGREED);
      // The Chair asked for a fragility outside its range; code brought it back, and says so.
      expect(replayed.final!.adjustments.map((a) => [a.path, a.from, a.to])).toEqual([["fragility.concrete_rcc", 9, BOUNDS.fragility.max]]);
      expect(replayed.final!.result).toEqual(runModel(dataset, AGREED));
      expect(resultFingerprint(replayed.final!.result)).toBe(run.fingerprint);
      expect(replayed.optimist!.params.depthScaleM).toBe(2.5);
      expect(replayed.cautious!.params.depthScaleM).toBe(5);
      const checks = aiChecks(dataset, replayed);
      expect(checks.find((c) => c.id === "reproducible")!.status).toBe("pass");
      expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    }
    // On other data the same replies give another result, and the saved fingerprint shows it.
    const moved: Dataset = { ...dataset, buildings: dataset.buildings.map((b) => ({ ...b, tivKes: b.tivKes * 2 })) };
    expect(aiChecks(moved, replayShipped(moved, runs[0].run)!).find((c) => c.id === "reproducible")!.status).toBe("fail");
  });

  it("are named by the day they were made, in Nairobi, and the model", () => {
    expect(shippedLabel({ savedAt: "2026-10-08T09:15:00.000Z", model: MODEL })).toBe(`Saved run from 8 October 2026, model ${MODEL}`);
    expect(shippedLabel({ savedAt: "2026-10-07T22:30:00.000Z", model: "m" })).toBe("Saved run from 8 October 2026, model m");
  });

  it("leave the app as it is when the index lists none, or cannot be read", async () => {
    let asked: string[] = [];
    const empty = async (name: string) => {
      asked.push(name);
      return { runs: [] };
    };
    expect(await loadShipped(INPUTS, empty)).toBeNull();
    // Only the index was asked for.
    expect(asked).toEqual(["index.json"]);
    asked = [];
    expect(await loadShipped(INPUTS, async () => Promise.reject(new Error("no network")))).toBeNull();
    expect(await loadShipped(INPUTS, async () => "<html>not found</html>")).toBeNull();
    // With nothing loaded there is nothing to pick, so the run in force is the reader's own or none.
    expect(pickShipped([], null)).toBeNull();
  });
});

// The folder as it ships. With an empty list this checks nothing more than the list itself.
describe("web/public/agents", () => {
  const index = readShippedIndex(json<unknown>(join(PUBLIC, "index.json")));
  const KIT = join(__dirname, "..", "..", "data", "data");

  it("lists only whole lines, each with a run file that can be replayed", () => {
    const listed = json<{ runs: unknown[] }>(join(PUBLIC, "index.json"));
    expect(Array.isArray(listed.runs)).toBe(true);
    expect(index.runs).toHaveLength(listed.runs.length);
    for (const entry of index.runs) expect(readShippedRun(json<unknown>(join(PUBLIC, entry.file)), entry), entry.file).not.toBeNull();
  });

  it.skipIf(index.runs.length === 0 || !existsSync(KIT))(
    "holds runs made on the starter kit and the model as they are now",
    async () => {
      const files: FileSource[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else {
            files.push({
              path: relative(KIT, full).replaceAll("\\", "/"),
              size: statSync(full).size,
              text: async () => readFileSync(full, "utf8"),
              arrayBuffer: async () => {
                const b = readFileSync(full);
                return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
              },
            });
          }
        }
      };
      walk(KIT);
      const found = await detectDatasets(files);
      for (const candidate of found.candidates.filter((c) => index.runs.some((r) => r.inputs.dataset === c.name))) {
        const loaded = (await loadDataset(candidate, found.files)).dataset;
        const now = runInputs({ dataset: loaded, reference: runModel(loaded, REFERENCE_PARAMS) } as Session);
        for (const entry of index.runs.filter((r) => r.inputs.dataset === candidate.name)) {
          expect(entry.inputs, `${entry.file} was made on other data or another model: run the agents again and pack the run`).toEqual(now);
          const replayed = replayShipped(loaded, readShippedRun(json<unknown>(join(PUBLIC, entry.file)), entry)!)!;
          expect(aiChecks(loaded, replayed).find((c) => c.id === "reproducible")!.status, entry.file).toBe("pass");
        }
      }
    },
    120_000,
  );
});
