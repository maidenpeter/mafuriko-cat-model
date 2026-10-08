import { describe, expect, it } from "vitest";
import {
  DECISION_LABELS,
  DECISION_STANCE,
  EMPTY_FACTS,
  countFlags,
  emptyDecision,
  flagsFromChecks,
  sortFlags,
  stampDecision,
  suggestedConditions,
  toggleCondition,
  validateDecision,
} from "../src/lib/decision";
import type { Flag, OfferFacts } from "../src/lib/decision";
import {
  MAX_FLAGS_ON_NOTE,
  STANDING_LIMITS,
  buildDecisionNoteHtml,
  decisionNoteFileName,
  escapeHtml,
  fmtNoteDate,
} from "../src/lib/decisionNote";
import type { DecisionNoteInput } from "../src/lib/decisionNote";

const flag = (id: string, severity: Flag["severity"], title: string, kind: "quote" | "figure" = "figure"): Flag => ({
  id,
  severity,
  title,
  detail: `${title} detail`,
  evidence: { kind, text: `${title} evidence` },
});

const facts = (over: Partial<OfferFacts> = {}): OfferFacts => ({ ...EMPTY_FACTS, basements: 0, ...over });
const ids = (over: Partial<OfferFacts> = {}, flags: Flag[] = []) => suggestedConditions(flags, facts(over)).map((c) => c.id);

describe("flags", () => {
  const checks = [
    { id: "c1", status: "warn" as const, title: "Zeta warning", detail: "w" },
    { id: "c2", status: "pass" as const, title: "All good", detail: "p" },
    { id: "c3", status: "fail" as const, title: "Sum insured mismatch", detail: "f" },
    { id: "c4", status: "warn" as const, title: "Alpha warning", detail: "w2" },
  ];

  it("turns failed checks into high flags, warnings into medium ones and drops passes", () => {
    const flags = flagsFromChecks(checks);
    expect(flags.map((f) => [f.id, f.severity])).toEqual([
      ["c3", "high"],
      ["c4", "medium"],
      ["c1", "medium"],
    ]);
    expect(flags[0].evidence).toEqual({ kind: "figure", text: "f" });
  });

  it("merges extra flags and sorts by severity then title", () => {
    const flags = flagsFromChecks(checks, [flag("x1", "low", "Low point"), flag("x2", "high", "Basement plant", "quote")]);
    expect(flags.map((f) => f.id)).toEqual(["x2", "c3", "c4", "c1", "x1"]);
    expect(countFlags(flags)).toEqual({ high: 2, medium: 2, low: 1 });
  });

  it("lets an extra flag replace a check with the same id, and keeps a check's own evidence", () => {
    const flags = flagsFromChecks(
      [
        { id: "a", status: "warn", title: "A", detail: "d", evidence: { kind: "quote", text: "from the slip" } },
        { id: "b", status: "fail", title: "B", detail: "d" },
      ],
      [flag("b", "low", "B replaced")],
    );
    expect(flags.map((f) => [f.id, f.severity])).toEqual([
      ["a", "medium"],
      ["b", "low"],
    ]);
    expect(flags[0].evidence.kind).toBe("quote");
  });

  it("sorts without changing the list it was given", () => {
    const list = [flag("1", "low", "B"), flag("2", "high", "Z"), flag("3", "high", "A")];
    expect(sortFlags(list).map((f) => f.id)).toEqual(["3", "2", "1"]);
    expect(list.map((f) => f.id)).toEqual(["1", "2", "3"]);
  });
});

describe("suggested conditions", () => {
  it("suggests nothing when nothing supports a suggestion", () => {
    expect(ids()).toEqual([]);
    expect(ids({ dryInEveryTier: true, nearestWetCellM: 5000, grossLoss100Kes: 1e5, tivKes: 1e9 })).toEqual([]);
  });

  it("suggests moving or protecting basement plant only when plant is in a basement", () => {
    expect(ids({ basements: 2 })).toEqual([]);
    const out = suggestedConditions([], facts({ basements: 2, criticalPlantInBasement: true }));
    expect(out.map((c) => c.id)).toEqual(["relocate_plant"]);
    expect(out[0].text).toMatch(/^Consider /);
    expect(out[0].why).toMatch(/basement/);
  });

  it("suggests a sub-limit and a higher deductible from the size of the 1-in-100 loss", () => {
    expect(ids({ grossLoss100Kes: 2e6, tivKes: 1e8 })).toEqual([]);
    expect(ids({ grossLoss100Kes: 5e6, tivKes: 1e8 })).toEqual(["higher_deductible"]);
    const out = suggestedConditions([], facts({ grossLoss100Kes: 2e7, tivKes: 1e8 }));
    expect(out.map((c) => c.id)).toEqual(["flood_sublimit", "higher_deductible"]);
    expect(out[0].why).toContain("20% of the sum insured");
    expect(ids({ grossLoss100Kes: 2e7, tivKes: null })).toEqual([]);
    expect(ids({ grossLoss100Kes: 2e7, tivKes: 0 })).toEqual([]);
  });

  it("suggests a sub-limit and a higher deductible after a past flood loss", () => {
    expect(ids({ pastFloodLoss: true })).toEqual(["flood_sublimit", "higher_deductible"]);
  });

  it("suggests a survey for an approximate location, a dry site near wet ground or unknown basements", () => {
    expect(ids({ approximateLocation: true })).toEqual(["survey_before_binding"]);
    expect(ids({ dryInEveryTier: true, nearestWetCellM: 120 })).toEqual(["survey_before_binding"]);
    expect(ids({ dryInEveryTier: false, nearestWetCellM: 120 })).toEqual([]);
    expect(ids({ basements: null })).toEqual(["survey_before_binding"]);
    expect(suggestedConditions([], facts({ dryInEveryTier: true, nearestWetCellM: 120 }))[0].why).toContain("120 m");
  });

  it("suggests the remaining conditions one fact at a time", () => {
    expect(ids({ drainagePoor: true })).toEqual(["drainage_evidence"]);
    expect(ids({ underInsured: true })).toEqual(["revaluation"]);
    expect(ids({ unverifiedValues: 3 })).toEqual(["confirm_unverified"]);
    expect(ids({ commercialOnResidentialCurve: true })).toEqual(["confirm_occupancy"]);
    expect(suggestedConditions([], facts({ unverifiedValues: 1 }))[0].why).toContain("1 value could not");
    expect(suggestedConditions([], facts({ unverifiedValues: 3 }))[0].why).toContain("3 values could not");
  });

  it("is supported by a flag alone and names the flags it came from", () => {
    const flags = [flag("drainage_blocked", "medium", "Storm drains reported blocked"), flag("other", "low", "Something else")];
    const out = suggestedConditions(flags, facts());
    expect(out.map((c) => c.id)).toEqual(["drainage_evidence"]);
    expect(out[0].because).toEqual(["drainage_blocked"]);
    expect(out[0].why).not.toBe("");
  });

  it("words every condition as a suggestion with a reason", () => {
    const all = suggestedConditions(
      [],
      facts({
        basements: null,
        criticalPlantInBasement: true,
        pastFloodLoss: true,
        approximateLocation: true,
        unverifiedValues: 2,
        underInsured: true,
        commercialOnResidentialCurve: true,
        drainagePoor: true,
      }),
    );
    expect(all).toHaveLength(8);
    for (const c of all) {
      expect(c.text).toMatch(/^Consider /);
      expect(c.text).not.toMatch(/\b(must|decline|accept)\b/i);
      expect(c.why.length).toBeGreaterThan(10);
    }
    expect(new Set(all.map((c) => c.id)).size).toBe(8);
  });
});

describe("recording a decision", () => {
  it("uses the four labels exactly", () => {
    expect(DECISION_LABELS).toEqual({
      accept: "Accept",
      accept_with_conditions: "Accept with conditions",
      refer: "Refer",
      decline: "Decline",
    });
    expect(DECISION_STANCE).toMatch(/does not accept or decline/);
    expect(DECISION_STANCE).toMatch(/underwriter decides/);
  });

  it("asks for a choice first", () => {
    expect(validateDecision(emptyDecision())).toEqual(["Choose Accept, Accept with conditions, Refer or Decline."]);
  });

  it("accepts a plain Accept with no note", () => {
    expect(validateDecision({ ...emptyDecision(), choice: "accept" })).toEqual([]);
  });

  it("needs a note for Refer and Decline", () => {
    expect(validateDecision({ ...emptyDecision(), choice: "refer", note: "  " })).toEqual([
      "Add a note saying why you refer this offer.",
    ]);
    expect(validateDecision({ ...emptyDecision(), choice: "decline" })).toEqual([
      "Add a note saying why you decline this offer.",
    ]);
    expect(validateDecision({ ...emptyDecision(), choice: "decline", note: "Outside appetite" })).toEqual([]);
  });

  it("needs at least one ticked condition for Accept with conditions", () => {
    const draft = { ...emptyDecision(), choice: "accept_with_conditions" as const };
    expect(validateDecision(draft)).toEqual(["Tick at least one condition to accept with conditions."]);
    const tickedDraft = toggleCondition(draft, "flood_sublimit");
    expect(validateDecision(tickedDraft)).toEqual([]);
    expect(validateDecision(tickedDraft, ["revaluation"])).toHaveLength(1);
    expect(toggleCondition(tickedDraft, "flood_sublimit").conditions).toEqual([]);
  });

  it("stamps the time and trims the note", () => {
    const done = stampDecision({ ...emptyDecision(), choice: "refer", note: " To the treaty team \n" }, new Date("2026-10-08T11:25:00Z"));
    expect(done.recordedAt).toBe("2026-10-08T11:25:00.000Z");
    expect(done.note).toBe("To the treaty team");
  });
});

describe("decision note", () => {
  const input = (over: Partial<DecisionNoteInput> = {}): DecisionNoteInput => ({
    offer: {
      insured: 'Mills <script>alert("x")</script> & Sons',
      location: "Industrial Area, Nairobi",
      sumInsuredKes: 850e6,
      coverSought: "Flood, material damage",
    },
    figures: {
      grossLoss100Kes: 42.5e6,
      averageAnnualLossKes: 1.3e6,
      pureRatePerMille: 1.53,
      portfolioChange100Kes: 12e6,
      portfolioChange100Fraction: 0.004,
    },
    lossByReturnPeriod: [
      { returnPeriodYears: 100, groundUpKes: 60e6, grossKes: 42.5e6 },
      { returnPeriodYears: 10, groundUpKes: 0, grossKes: 0 },
      { returnPeriodYears: 250, groundUpKes: 90e6, grossKes: 70e6 },
    ],
    flags: [
      flag("f-low", "low", "Minor point"),
      { ...flag("f-high", "high", "Plant in basement", "quote"), evidence: { kind: "quote", text: "generators <b>below</b> grade" } },
    ],
    conditions: [
      { id: "relocate_plant", text: "Consider moving plant." },
      { id: "flood_sublimit", text: "Consider a flood sub-limit." },
    ],
    decision: {
      choice: "accept_with_conditions",
      note: "Subject to survey & <sign-off>",
      conditions: ["flood_sublimit"],
      recordedAt: "2026-10-08T11:25:00Z",
    },
    terms: { source: "example", lines: [{ label: "Deductible", value: "KES 1.0m" }] },
    footer: {
      modelVersion: "v1.2",
      dataSource: "Bundled sample data",
      assumptions: "agents",
      generatedAt: "2026-10-08T11:30:00Z",
    },
    ...over,
  });

  it("escapes every piece of text", () => {
    const html = buildDecisionNoteHtml(input());
    expect(html).toContain("Mills &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sons");
    expect(html).toContain("Subject to survey &amp; &lt;sign-off&gt;");
    expect(html).toContain("generators &lt;b&gt;below&lt;/b&gt; grade");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<sign-off>");
    expect(escapeHtml(`a&b<c>"d'`)).toBe("a&amp;b&lt;c&gt;&quot;d&#39;");
  });

  it("has no script, no outside address and no event handlers", () => {
    const html = buildDecisionNoteHtml(input());
    expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(/i);
    expect(html).not.toMatch(/https?:|\/\/[a-z]/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("size: A4");
  });

  it("contains every section", () => {
    const html = buildDecisionNoteHtml(input());
    for (const id of ["offer", "figures", "loss-table", "terms", "flags", "conditions", "decision", "footer"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("Industrial Area, Nairobi");
    expect(html).toContain("Sum insured KES 850.0m");
    expect(html).toContain("Cover sought: Flood, material damage.");
    expect(html).toContain("1-in-100 gross loss");
    expect(html).toContain("KES 42.5m");
    expect(html).toContain("Average annual loss");
    expect(html).toContain("1.53 per mille");
    expect(html).toContain("Change to the portfolio&#39;s 1-in-100");
    expect(html).toContain("+KES 12.0m");
    expect(html).toContain("+0.4%");
    expect(html).toContain("Example terms");
    expect(html).toContain("Accept with conditions");
    expect(html).toContain("8 October 2026, 14:25 (Nairobi time)");
    expect(html).toContain("Model version: v1.2.");
    expect(html).toContain("Model data: Bundled sample data.");
    expect(html).toContain("set by the agents");
    expect(html).toContain(STANDING_LIMITS);
  });

  it("orders return periods, flags by severity, and marks the ticked conditions", () => {
    const html = buildDecisionNoteHtml(input());
    expect(html.indexOf("1 in 10 years")).toBeLessThan(html.indexOf("1 in 100 years"));
    expect(html.indexOf("1 in 100 years")).toBeLessThan(html.indexOf("1 in 250 years"));
    expect(html.indexOf("Plant in basement")).toBeLessThan(html.indexOf("Minor point"));
    expect(html).toContain("Document quote: &quot;generators");
    expect(html).toContain("Model figure: Minor point evidence");
    expect(html).toContain("<strong>Selected.</strong> Consider a flood sub-limit.");
    expect(html).toContain("Not selected. Consider moving plant.");
    expect(html.indexOf("Consider a flood sub-limit.")).toBeLessThan(html.indexOf("Consider moving plant."));
  });

  it("caps the flags and says how many more there are", () => {
    const many = Array.from({ length: MAX_FLAGS_ON_NOTE + 3 }, (_, i) => flag(`m${i}`, "medium", `Point ${String(i).padStart(2, "0")}`));
    const html = buildDecisionNoteHtml(input({ flags: many }));
    expect(html).toContain("3 more flags on screen, not shown here.");
    expect(html).toContain(`Points for the underwriter (${MAX_FLAGS_ON_NOTE + 3})`);
    expect(html).toContain("Point 05 detail");
    expect(html).not.toContain("Point 06 detail");
    expect(buildDecisionNoteHtml(input({ flags: many.slice(0, MAX_FLAGS_ON_NOTE + 1) }))).toContain("1 more flag on screen");
  });

  it("copes with an empty draft", () => {
    const html = buildDecisionNoteHtml(
      input({
        flags: [],
        conditions: [],
        lossByReturnPeriod: [],
        decision: emptyDecision(),
        terms: { source: "document", lines: [] },
        figures: { grossLoss100Kes: null, averageAnnualLossKes: null, pureRatePerMille: null, portfolioChange100Kes: null },
        footer: { modelVersion: "v1.2", dataSource: "Uploaded data", assumptions: "reference", generatedAt: "2026-10-08T11:30:00Z" },
      }),
    );
    expect(html).toContain("No decision recorded");
    expect(html).toContain("Recorded: not recorded");
    expect(html).toContain("No flags were raised.");
    expect(html).toContain("No conditions were suggested.");
    expect(html).toContain("Terms read from the offer document.");
    expect(html).toContain("reference set");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("uses no long dashes", () => {
    expect(buildDecisionNoteHtml(input())).not.toMatch(/[–—]/);
  });

  it("names the file from the insured and the Nairobi date", () => {
    expect(decisionNoteFileName("Mills <script> & Sons Ltd.", "2026-10-08T11:25:00Z")).toBe(
      "decision-note-mills-script-sons-ltd-2026-10-08.html",
    );
    expect(decisionNoteFileName("Acme", new Date("2026-10-08T22:30:00Z"))).toBe("decision-note-acme-2026-10-09.html");
    expect(decisionNoteFileName("  ", "not a date")).toBe("decision-note-offer.html");
    expect(fmtNoteDate(null)).toBe("not recorded");
  });
});
