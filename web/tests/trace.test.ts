import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { flattenParams, REFERENCE_PARAMS } from "../src/lib/model/params";
import { hashesOf, type ModelDataVersion } from "../src/lib/modelData/version";
import { portfolioJudgement } from "../src/lib/offer/focus";
import { JUDGEMENT_KEYS, REFERENCE_JUDGEMENT } from "../src/lib/offer/judgement";
import { appVersion, buildTrace, hashText, traceCompact, traceLines, type TraceInput } from "../src/lib/trace";

// Every name, hash and figure here is invented.
const VERSION: ModelDataVersion = {
  id: "2026-10-09_starter-kit",
  date: "2026-10-09",
  label: "Nairobi starter kit",
  description: "The starter kit as handed out.",
  area: { id: "nairobi", name: "Nairobi", centre: [36.82, -1.29], zoom: 11, hazardKind: "score" },
  status: "approved",
  files: [
    { name: "hazard_common.tif", role: "hazard", provenance: "proxy", sha256: "b".repeat(64), bytes: 99999, raster: { width: 10, height: 10 } },
    { name: "exposure.csv", role: "exposure", provenance: "synthetic", sha256: "a".repeat(64), bytes: 1234, rows: 600 },
  ],
  sources: ["starter kit"],
  notes: [],
};

const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const savedCommit = process.env.NEXT_PUBLIC_APP_VERSION;
const savedPackage = process.env.NEXT_PUBLIC_APP_PACKAGE_VERSION;

const input = (over: Partial<TraceInput> = {}): TraceInput => ({
  version: VERSION,
  active: { source: "ai", params: { ...REFERENCE_PARAMS, depthScaleM: 3.5 } },
  mode: "all_drivers",
  judgement: portfolioJudgement({ bufferRadiusM: 300 }),
  deliberation: { startedAt: "2026-10-08T07:12:03.511Z", fingerprint: "1a2b3c4d", runs: { chair: { model: "test-model" } } },
  shippedLabel: "Saved run from 8 October 2026, model test-model",
  offer: { fileName: "Invented offer.docx", sha256: "c".repeat(64) },
  generatedAt: "2026-10-09T20:00:00.000Z",
  ...over,
});

afterEach(() => {
  if (savedCommit === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
  else process.env.NEXT_PUBLIC_APP_VERSION = savedCommit;
  if (savedPackage === undefined) delete process.env.NEXT_PUBLIC_APP_PACKAGE_VERSION;
  else process.env.NEXT_PUBLIC_APP_PACKAGE_VERSION = savedPackage;
});

describe("buildTrace", () => {
  it("carries every field of the brief: version and hashes, app build, parameters and figures with their setters, the run, the offer and the time", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "abc1234";
    process.env.NEXT_PUBLIC_APP_PACKAGE_VERSION = "0.1.0";
    const trace = buildTrace(input());

    expect(trace.format).toBe(1);
    expect(trace.generatedAt).toBe("2026-10-09T20:00:00.000Z");
    expect(trace.app).toEqual({ commit: "abc1234", version: "0.1.0" });

    expect(trace.modelData.id).toBe("2026-10-09_starter-kit");
    expect(trace.modelData.status).toBe("approved");
    expect(trace.modelData.area).toEqual({ id: "nairobi", name: "Nairobi" });
    // Files sorted by name, each with its hash, whatever order the manifest lists them in.
    expect(trace.modelData.files.map((f) => f.name)).toEqual(["exposure.csv", "hazard_common.tif"]);
    expect(trace.modelData.files[0]).toEqual({ name: "exposure.csv", role: "exposure", provenance: "synthetic", sha256: "a".repeat(64), bytes: 1234 });
    // The same key the browser cache is kept under, so a cached load and its trace agree.
    expect(trace.modelData.hashes).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.modelData.hashes).toBe(hashesOf(VERSION));

    expect(trace.params.source).toBe("agents");
    expect(trace.params.values).toHaveLength(flattenParams(REFERENCE_PARAMS).length);
    expect(trace.params.values[0]).toEqual({ path: "depthScaleM", value: 3.5, reference: 4, setBy: "agents" });
    expect(trace.params.values.every((v) => v.setBy === "agents")).toBe(true);

    expect(trace.judgement.mode).toBe("all_drivers");
    expect(trace.judgement.values.map((v) => v.key)).toEqual(JUDGEMENT_KEYS);
    const buffer = trace.judgement.values.find((v) => v.key === "bufferRadiusM")!;
    expect(buffer).toMatchObject({ value: 300, reference: 250, setBy: "typed" });
    expect(buffer.label).toContain("Buffer around the building");
    expect(trace.judgement.values.filter((v) => v.setBy === "reference")).toHaveLength(JUDGEMENT_KEYS.length - 1);

    expect(trace.agentRun).toEqual({ id: "2026-10-08T07:12:03.511Z", startedAt: "2026-10-08T07:12:03.511Z", fingerprint: "1a2b3c4d", model: "test-model", label: "Saved run from 8 October 2026, model test-model" });
    expect(trace.offer).toEqual({ fileName: "Invented offer.docx", sha256: "c".repeat(64) });
  });

  it("says so when the figures rest on the reference set alone, with no run, no offer and no version", () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.NEXT_PUBLIC_APP_PACKAGE_VERSION;
    expect(appVersion()).toEqual({ commit: "unknown", version: "unknown" });
    const trace = buildTrace(input({ version: null, active: { source: "reference", params: REFERENCE_PARAMS }, mode: "depth_only", judgement: null, deliberation: null, shippedLabel: null, offer: null }));
    expect(trace.app).toEqual({ commit: "unknown", version: "unknown" });
    expect(trace.modelData).toMatchObject({ id: "none", status: "none", area: null, files: [], hashes: "none" });
    expect(trace.params.source).toBe("reference");
    expect(trace.params.values.every((v) => v.setBy === "reference" && v.value === v.reference)).toBe(true);
    expect(trace.judgement.values.every((v) => v.setBy === "reference" && v.value === REFERENCE_JUDGEMENT[v.key])).toBe(true);
    expect(trace.agentRun).toEqual({ id: null, startedAt: null, fingerprint: null, model: null, label: null });
    expect(trace.offer).toBeNull();
    const text = traceLines(trace).join("\n");
    expect(text).toContain("Agent run: none");
    expect(text).toContain("Offer: none");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
  });

  it("takes a plain set of figures without a setter map, and marks a moved figure as not recorded", () => {
    const trace = buildTrace(input({ judgement: { ...REFERENCE_JUDGEMENT, drainDesignRp: 50 } }));
    const drains = trace.judgement.values.find((v) => v.key === "drainDesignRp")!;
    expect(drains).toMatchObject({ value: 50, reference: 25, setBy: "not recorded" });
    expect(trace.judgement.values.filter((v) => v.setBy === "reference")).toHaveLength(JUDGEMENT_KEYS.length - 1);
  });

  it("takes the build from the input when it is given, and stamps the time when it is not", () => {
    const before = Date.now();
    const trace = buildTrace({ ...input(), generatedAt: undefined, app: { commit: "deadbee", version: "9.9.9" } });
    expect(trace.app).toEqual({ commit: "deadbee", version: "9.9.9" });
    expect(new Date(trace.generatedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("round-trips through JSON unchanged", () => {
    const trace = buildTrace(input());
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
  });
});

describe("traceLines and traceCompact", () => {
  it("prints every section, with the files, parameters and figures under their headings", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "abc1234";
    process.env.NEXT_PUBLIC_APP_PACKAGE_VERSION = "0.1.0";
    const lines = traceLines(buildTrace(input()));
    const text = lines.join("\n");
    expect(lines[0]).toBe(`Model data: 2026-10-09_starter-kit (Nairobi starter kit, approved), 2 files, file hashes ${hashesOf(VERSION)}`);
    expect(text).toContain(`  exposure.csv: exposure, synthetic, sha256 ${"a".repeat(64)}, 1234 bytes`);
    expect(text).toContain("App: commit abc1234, version 0.1.0");
    expect(text).toContain("Parameters: agreed by the agents, 1 of 14 differ from the reference");
    expect(text).toContain("  depthScaleM: 3.5 (Agents, reference 4)");
    expect(text).toContain("  fragility.concrete_rcc: 0.7 (Agents)");
    expect(text).toContain(`Figures beyond depth: All loss drivers; 1 typed by the underwriter, ${JUDGEMENT_KEYS.length - 1} reference values`);
    expect(text).toContain("  Buffer around the building where the highest map depth is taken (m): 300 (Typed, reference 250)");
    expect(text).toContain("Agent run: 2026-10-08T07:12:03.511Z, fingerprint 1a2b3c4d, model test-model, Saved run from 8 October 2026, model test-model");
    expect(text).toContain(`Offer: Invented offer.docx, sha256 ${"c".repeat(64)}`);
    expect(lines[lines.length - 1]).toBe("Generated: 2026-10-09T20:00:00.000Z");
    expect(text).not.toMatch(DASHES);
    expect(text).not.toContain("undefined");
  });

  it("keeps the headings alone in the summary", () => {
    const trace = buildTrace(input());
    const summary = traceLines(trace, "summary");
    expect(summary).toHaveLength(7);
    expect(summary.every((line) => !line.startsWith("  "))).toBe(true);
    expect(traceLines(trace).length).toBeGreaterThan(summary.length + 14 + JUDGEMENT_KEYS.length);
  });

  it("is one line in the compact form, with the version, the hash key, the build, the run and the offer", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "abc1234";
    const line = traceCompact(buildTrace(input()));
    expect(line).not.toContain("\n");
    expect(line).toContain(`Model data 2026-10-09_starter-kit (${hashesOf(VERSION)})`);
    expect(line).toContain("app abc1234");
    expect(line).toContain("parameters agreed by the agents");
    expect(line).toContain("All loss drivers");
    expect(line).toContain("agent run 2026-10-08T07:12:03.511Z");
    expect(line).toContain(`offer Invented offer.docx ${"c".repeat(12)}`);
    expect(line).toContain("2026-10-09T20:00:00.000Z");
    expect(line).not.toMatch(DASHES);
    expect(traceCompact(buildTrace(input({ offer: { fileName: "x.txt", sha256: null }, deliberation: null })))).toContain("offer x.txt unhashed");
  });
});

describe("hashes", () => {
  it("hashText is the sha256 of the text as hex", async () => {
    for (const text of ["", "An invented offer.", "Nairobi, 2026 é"]) {
      expect(await hashText(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
    expect(await hashText("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the block's hash key moves with any file hash and is none without files", () => {
    const key = buildTrace(input()).modelData.hashes;
    const changed = { ...VERSION, files: [VERSION.files[0], { ...VERSION.files[1], sha256: "d".repeat(64) }] };
    expect(buildTrace(input({ version: changed })).modelData.hashes).not.toBe(key);
    expect(buildTrace(input({ version: { ...VERSION, files: [] } })).modelData.hashes).toBe("none");
  });
});
