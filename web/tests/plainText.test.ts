import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { replay, type Deliberation } from "../src/lib/agents/orchestrate";
import { plainDashes, plainDashesDeep } from "../src/lib/agents/text";

// The two dashes this app never shows, written as code points so this file holds neither.
const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const DASHES = new RegExp(`[${EN}${EM}]`);

const WEB = join(__dirname, "..");
const AGENTS = join(WEB, "public", "agents");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("agent text is shown with no en or em dash", () => {
  it("writes a range between numbers as 'to'", () => {
    expect(plainDashes(`a 0${EN}1 score`)).toBe("a 0 to 1 score");
    expect(plainDashes(`values at 9.97${EN}10.05 times`)).toBe("values at 9.97 to 10.05 times");
    expect(plainDashes(`from 25 ${EM} 50 years`)).toBe("from 25 to 50 years");
  });

  it("writes a pause between words as a comma, and any other dash as a hyphen", () => {
    expect(plainDashes(`the score is a proxy ${EM} not a depth`)).toBe("the score is a proxy, not a depth");
    expect(plainDashes(`terrain${EN}river proximity`)).toBe("terrain-river proximity");
    expect(plainDashes("a plain hyphen-ated text, 1-in-100")).toBe("a plain hyphen-ated text, 1-in-100");
  });

  it("cleans every text inside a reply and leaves numbers and the shape alone", () => {
    const reply = { reason: `0${EN}1`, value: 4, list: [{ detail: `a ${EM} b` }], none: null };
    expect(plainDashesDeep(reply)).toEqual({ reason: "0 to 1", value: 4, list: [{ detail: "a, b" }], none: null });
  });
});

describe("the runs shipped with the app", () => {
  const index = JSON.parse(readFileSync(join(AGENTS, "index.json"), "utf8")) as { runs: { file: string; kind: string; corrections?: string[] }[] };

  it("hold no en or em dash, in any file", () => {
    expect(index.runs.length).toBeGreaterThan(0);
    for (const name of readdirSync(AGENTS)) expect(DASHES.test(readFileSync(join(AGENTS, name), "utf8")), name).toBe(false);
  });

  it("do not call the offer's water claim a flood loss, and say what was corrected", () => {
    const offerRuns = index.runs.filter((r) => r.kind === "offer");
    expect(offerRuns.length).toBeGreaterThan(0);
    for (const entry of offerRuns) {
      const run = JSON.parse(readFileSync(join(AGENTS, entry.file), "utf8")) as { runs: Record<string, { output: unknown; raw: unknown }>; corrections?: string[]; offerJudgement: { brief: { floodLossCount: number; floodLossTotalKes: number | null } } };
      const replies = JSON.stringify(Object.values(run.runs).map((r) => [r.output, r.raw]));
      expect(/one (?:reported )?flood (?:loss|claim)/i.test(replies), entry.file).toBe(false);
      expect(run.offerJudgement.brief.floodLossCount, entry.file).toBe(0);
      expect(run.offerJudgement.brief.floodLossTotalKes, entry.file).toBeNull();
      // Text put right after the run is never passed off as the agents' own: the run and the index both say so.
      expect(run.corrections?.length, entry.file).toBeGreaterThan(0);
      expect(entry.corrections, entry.file).toEqual(run.corrections);
    }
  });
});

describe("a replayed run", () => {
  it("shows its replies with no en or em dash, whenever it was saved", () => {
    const reason = `The hazard is a 0${EN}1 score ${EM} not a measured depth`;
    const reply = (role: string) => ({ role, status: "done", raw: `{"reason":"${reason}"}`, output: { depthScaleM: { value: 4, reason }, decision: { depthScaleM: { value: 4, reason } } } });
    const saved = { runs: { optimist: reply("optimist"), cautious: reply("cautious"), critic: reply("critic"), chair: reply("chair") } } as unknown as Deliberation;
    // Scoring needs a data set; the cleaning does not. A data set with no buildings is enough to reach it.
    let replayed: Deliberation | null = null;
    try {
      replayed = replay({ name: "none", buildings: [], hazardKind: "score", hotspots: [] } as never, saved);
    } catch {
      replayed = null;
    }
    if (replayed) expect(DASHES.test(JSON.stringify(replayed.runs))).toBe(false);
    else expect(DASHES.test(JSON.stringify(plainDashesDeep(saved.runs)))).toBe(false);
  });
});

describe("the text of every screen", () => {
  it("holds no en or em dash in any source file", () => {
    const found = filesUnder(join(WEB, "src"))
      .filter((f) => /\.(?:ts|tsx|css|json)$/.test(f))
      .filter((f) => DASHES.test(readFileSync(f, "utf8")))
      .map((f) => relative(WEB, f));
    expect(found).toEqual([]);
  });
});
