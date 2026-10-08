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
  MAX_FLAGS_WITH_DRIVERS,
  MAX_QUESTIONS_ON_NOTE,
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
    const flags = [flag("under_insurance", "medium", "Declared values look low"), flag("other", "low", "Something else")];
    const out = suggestedConditions(flags, facts());
    expect(out.map((c) => c.id)).toEqual(["revaluation"]);
    expect(out[0].because).toEqual(["under_insurance"]);
    expect(out[0].why).not.toBe("");
  });

  it("asks for evidence of drainage upkeep only on a report of poor drainage", () => {
    // A flag that only mentions drains is not a report on how they are kept: an open question, assumed ponding, an overloaded design.
    const mentions = [flag("broker-questions-drains", "low", "2 questions for the broker on drains and flood protection"), flag("drainage-ponding", "low", "The depth here comes from assumed drainage ponding"), flag("drain-overload", "medium", "Drains are overloaded from the 1-in-50 flood")];
    expect(ids({}, mentions)).toEqual([]);
    // The report is a fact, and the flag that carries its sentence is named as the support.
    const reported = flag("drainage-condition", "medium", "The document reports poor drainage at the site", "quote");
    const out = suggestedConditions([...mentions, reported], facts({ drainagePoor: true }));
    expect(out.map((c) => c.id)).toEqual(["drainage_evidence"]);
    expect(out[0].because).toEqual(["drainage-condition"]);
    expect(out[0].why).toContain("reported as poor");
    // The flag without the fact suggests nothing.
    expect(ids({}, [reported])).toEqual([]);
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

describe("suggested conditions from the loss drivers beyond depth", () => {
  /** A flag as the focus raises it for a group of questions to the broker: the questions are in its detail. */
  const asked = (group: string, questions: string): Flag => ({
    id: `broker-questions-${group}`,
    severity: "low",
    title: `Questions for the broker on ${group}`,
    detail: `The document does not state these, and nothing is guessed. ${questions}`,
    evidence: { kind: "figure", text: "The model's own figure is used until the broker answers." },
  });

  it("leaves the new facts out of it when they are not given", () => {
    expect(ids({ basements: 2 })).toEqual([]);
    expect(EMPTY_FACTS.drainDesignStated).toBeUndefined();
  });

  it("counts equipment below ground towards moving or protecting the plant", () => {
    const out = suggestedConditions([], facts({ basements: 2, equipmentBelowGround: 6 }));
    expect(out.map((c) => c.id)).toEqual(["relocate_plant"]);
    expect(out[0].why).toContain("6 items of equipment below ground");
    expect(suggestedConditions([], facts({ basements: 1, equipmentBelowGround: 1 }))[0].why).toContain("1 item of equipment below ground");
    expect(ids({ basements: 2, equipmentBelowGround: 0 })).toEqual([]);
  });

  it("asks for the drain design when the offer does not state one", () => {
    expect(ids({ drainDesignStated: true })).toEqual([]);
    const out = suggestedConditions([], facts({ drainDesignStated: false }));
    expect(out.map((c) => c.id)).toEqual(["drain_design"]);
    expect(out[0].why).toContain("assumed design");
  });

  it("asks for pump backup, barriers and valves only where there may be a basement", () => {
    expect(ids({ basements: 0, sumpPumpBackup: "no", floodBarriers: "absent", nonReturnValves: null })).toEqual([]);
    expect(ids({ basements: 2, sumpPumpBackup: "yes", floodBarriers: "present", nonReturnValves: "present" })).toEqual([]);
    expect(ids({ basements: 2, sumpPumpBackup: "no" })).toEqual(["pump_backup"]);
    expect(ids({ basements: 2, sumpPumpBackup: null })).toEqual(["pump_backup"]);
    expect(suggestedConditions([], facts({ basements: 2, sumpPumpBackup: "no" }))[0].why).toContain("no backup power");
    expect(suggestedConditions([], facts({ basements: 2, sumpPumpBackup: null }))[0].why).toContain("does not say");
    const out = suggestedConditions([], facts({ basements: 2, floodBarriers: "absent", nonReturnValves: null }));
    expect(out.map((c) => c.id)).toEqual(["ingress_protection"]);
    expect(out[0].why).toContain("no flood barriers");
    expect(out[0].why).toContain("does not say whether non-return valves");
  });

  it("asks to confirm business interruption only when the offer does not say", () => {
    expect(ids({ interruptionCover: "covered" })).toEqual([]);
    expect(ids({ interruptionCover: "excluded" })).toEqual([]);
    const out = suggestedConditions([], facts({ interruptionCover: null }));
    expect(out.map((c) => c.id)).toEqual(["confirm_interruption"]);
    expect(out[0].why).toContain("no loss of rent or revenue is in the price");
  });

  it("reads the facts, never the wording of a flag", () => {
    const flags = [
      asked("drains", "What is the design return period of the site's storm drains? Do the sump pumps have backup power? Are non-return valves fitted on the drains that serve the basements?"),
      asked("cover", "Is business interruption or loss of rent to be insured for flood?"),
    ];
    // The questions are open, but no fact is given: nothing is suggested from their words.
    expect(suggestedConditions(flags, facts({ basements: 2 }))).toEqual([]);
    // The facts say the same gaps are there: each suggestion appears, and names no question flag as its support.
    const open = suggestedConditions(flags, facts({ basements: 2, drainDesignStated: false, sumpPumpBackup: null, floodBarriers: "present", nonReturnValves: null, interruptionCover: null }));
    expect(open.map((c) => c.id)).toEqual(["drain_design", "pump_backup", "ingress_protection", "confirm_interruption"]);
    expect(open.find((c) => c.id === "pump_backup")?.why).toContain("does not say whether the sump pumps have backup power");
    expect(open.find((c) => c.id === "ingress_protection")?.why).not.toContain("flood barriers are fitted");
    for (const c of open) expect(c.because).toEqual([]);
    // A fact that is given settles it, whatever the questions say.
    expect(suggestedConditions(flags, facts({ basements: 2, drainDesignStated: true, sumpPumpBackup: "yes", floodBarriers: "present", nonReturnValves: "present", interruptionCover: "covered" }))).toEqual([]);
  });

  it("names the flag that carries the figure as support, by its id, only when the fact holds", () => {
    const flags = [flag("drain-overload", "medium", "Drains are overloaded from the 1-in-50 flood"), flag("basement-ingress", "high", "The basement takes water from the 1-in-25 flood"), flag("interruption-not-stated", "low", "Business interruption is not priced")];
    const open = suggestedConditions(flags, { ...EMPTY_FACTS, basements: 2, drainDesignStated: false, sumpPumpBackup: "no", floodBarriers: "absent", nonReturnValves: "present", interruptionCover: null });
    const because = Object.fromEntries(open.map((c) => [c.id, c.because]));
    expect(because.drain_design).toEqual(["drain-overload"]);
    expect(because.pump_backup).toEqual(["basement-ingress"]);
    expect(because.ingress_protection).toEqual(["basement-ingress"]);
    expect(because.confirm_interruption).toEqual(["interruption-not-stated"]);
    // The same flags with every fact settled support none of the four.
    const settled = suggestedConditions(flags, { ...EMPTY_FACTS, basements: 2, drainDesignStated: true, sumpPumpBackup: "yes", floodBarriers: "present", nonReturnValves: "present", interruptionCover: "excluded" }).map((c) => c.id);
    for (const id of ["drain_design", "pump_backup", "ingress_protection", "confirm_interruption"]) expect(settled).not.toContain(id);
  });

  it("words the new conditions as suggestions too", () => {
    const all = suggestedConditions([], facts({ basements: 2, equipmentBelowGround: 3, drainDesignStated: false, sumpPumpBackup: "no", floodBarriers: "absent", nonReturnValves: "absent", interruptionCover: null }));
    expect(all.map((c) => c.id)).toEqual(["relocate_plant", "drain_design", "pump_backup", "ingress_protection", "confirm_interruption"]);
    for (const c of all) {
      expect(c.text).toMatch(/^Consider /);
      expect(c.text).not.toMatch(/\b(must|decline|accept)\b/i);
      expect(c.why.length).toBeGreaterThan(10);
    }
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

  it("badges the two placeholders and says once that the flood rate rests on them", () => {
    const badge = "Assumption, to be set by Kenya Re underwriting";
    const html = buildDecisionNoteHtml(
      input({
        figures: { ...input().figures, floodRatePerMille: 2.1 },
        premium: {
          lines: [
            { label: "Capital load", kes: 100e3, ratePerMille: 0.12, placeholder: true },
            { label: "Minimum rate", kes: 85e3, ratePerMille: 0.1, note: "the floor", placeholder: true },
            { label: "Flood premium", kes: 1.8e6, ratePerMille: 2.1, total: true },
          ],
          floodPremiumKes: 1.8e6,
          floodRatePerMille: 2.1,
          setBy: "modelled",
        },
        assumptions: [
          { label: "Cost of capital", value: "8% a year", setBy: "reference", placeholder: true },
          { label: "Buffer around the building", value: "250 m", setBy: "reference" },
        ],
      }),
    );
    expect(html.split(badge).length - 1).toBe(3);
    expect(html).toContain('id="placeholders"');
    expect(html).not.toMatch(/market/i);
    // Without a flood rate, as with Depth only, there is no line about it.
    expect(buildDecisionNoteHtml(input())).not.toContain('id="placeholders"');
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
    // Return periods read as everywhere else in the app, never "1 in 100 years".
    expect(html.indexOf("<td>1-in-10</td>")).toBeGreaterThan(-1);
    expect(html.indexOf("<td>1-in-10</td>")).toBeLessThan(html.indexOf("<td>1-in-100</td>"));
    expect(html.indexOf("<td>1-in-100</td>")).toBeLessThan(html.indexOf("<td>1-in-250</td>"));
    expect(html).not.toMatch(/1 in \d+ years/);
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
    expect(buildDecisionNoteHtml(input())).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });

  describe("with the loss drivers", () => {
    const withDrivers = (over: Partial<DecisionNoteInput> = {}) =>
      input({
        figures: { grossLoss100Kes: 81.7e6, averageAnnualLossKes: 1.8e6, pureRatePerMille: 1.65, floodRatePerMille: 8.02, portfolioChange100Kes: 86.7e6, portfolioChange100Fraction: 0.007 },
        drivers: {
          basis: "All loss drivers",
          columns: [
            { id: "surrounding", label: "Surrounding flooding" },
            { id: "overload", label: "Drain overload" },
            { id: "basement", label: "Basement ingress" },
            { id: "uncertainty", label: "Uncertainty loading" },
          ],
          off: ["Drainage ponding", "Business interruption"],
          rows: [
            { returnPeriodYears: 250, byDriverKes: { surrounding: 95.8e6, overload: 0, basement: 61e6, uncertainty: 15.7e6 }, groundUpKes: 172.5e6, grossKes: 163.9e6 },
            { returnPeriodYears: 100, byDriverKes: { surrounding: 0, overload: 30.9e6, basement: 48e6, uncertainty: 7.9e6 }, groundUpKes: 86.7e6, grossKes: 81.7e6 },
          ],
        },
        premium: {
          lines: [
            { label: "Surrounding flooding", kes: 636950, ratePerMille: 0.58, note: "average annual loss, gross" },
            { label: "Uncertainty loading", kes: 163727, ratePerMille: 0.15 },
            { label: "Capital load", kes: 6.94e6, ratePerMille: 6.37, note: "8% of KES 86.7m" },
            { label: "Minimum rate", kes: 109000, ratePerMille: 0.1, note: "the floor" },
            { label: "Flood premium", kes: 8.74e6, ratePerMille: 8.02, total: true },
          ],
          floodPremiumKes: 8.74e6,
          floodRatePerMille: 8.02,
          setBy: "modelled",
          stated: { premiumKes: 20e6, ratePerMille: 16.04 },
          history: "Sense check, not in the price: the document's own flood losses come to KES 77.3k a year.",
        },
        assumptions: [
          { label: "Buffer around the building", value: "250 m", setBy: "agents" },
          { label: "Drains designed for", value: "1-in-50", setBy: "offer" },
          { label: "Minimum flood rate", value: "0.1 per mille", setBy: "typed" },
          { label: "Uncertainty <loading>", value: "10%", setBy: "reference" },
          { label: "Cost of capital", value: "8% a year", setBy: "reference" },
        ],
        questions: ["Is business interruption insured for flood?", "Do the sump pumps have <backup> power?"],
        ...over,
      });

    it("prints the loss by driver, the premium build-up, the assumptions and the questions", () => {
      const html = buildDecisionNoteHtml(withDrivers());
      for (const id of ["offer", "figures", "loss-by-driver", "premium", "terms", "flags", "conditions", "questions", "assumptions", "decision", "footer"]) {
        expect(html).toContain(`id="${id}"`);
      }
      // The loss by driver takes the place of the plain loss table: both hold ground-up and gross.
      expect(html).not.toContain('id="loss-table"');
      expect(html).toContain("losses from: All loss drivers");
      expect(html).toContain("<th>Drain overload</th>");
      expect(html.indexOf("<td>1-in-100</td>")).toBeGreaterThan(-1);
      expect(html.indexOf("<td>1-in-100</td>")).toBeLessThan(html.indexOf("<td>1-in-250</td>"));
      // The two boxes that could be read either way say which loss they are.
      expect(html).toContain("Average annual loss, gross");
      expect(html).toContain("Change to the portfolio&#39;s 1-in-100, gross");
      expect(html).toContain("<td>KES 30.9m</td>");
      expect(html).toContain("Not in this price: Drainage ponding, Business interruption.");
      expect(html).toContain("Flood rate");
      expect(html).toContain("8.02 per mille");
      expect(html).toContain("pure rate 1.65 per mille");
      expect(html).toContain('<tr class="total"><td>Flood premium</td>');
      expect(html).toContain("8% of KES 86.7m");
      expect(html).toContain("set by the modelled figures");
      expect(html).toContain("the flood rate is 50% of it");
      expect(html).toContain("Sense check, not in the price");
    });

    it("says who set each assumption, and escapes what it is given", () => {
      const html = buildDecisionNoteHtml(withDrivers());
      expect(html).toContain("Assumptions in force (5), and who set each");
      expect(html).toContain("<strong>From the offer (1):</strong> Drains designed for 1-in-50.");
      expect(html).toContain("<strong>Agreed by the agents (1):</strong> Buffer around the building 250 m.");
      expect(html).toContain("<strong>Typed by the underwriter (1):</strong>");
      expect(html).toContain("<strong>Reference values (2):</strong> Uncertainty &lt;loading&gt; 10%; Cost of capital 8% a year.");
      expect(html.indexOf("From the offer (1)")).toBeLessThan(html.indexOf("Reference values (2)"));
      expect(html).toContain("Questions for the broker (2)");
      expect(html).toContain("Do the sump pumps have &lt;backup&gt; power?");
      expect(html).not.toContain("<backup>");
      expect(html).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
      expect(html).not.toContain("undefined");
      expect(html).not.toContain("NaN");
    });

    it("sets the page tighter so it still fits: fewer points, and the suggestions not selected in one line", () => {
      const many = Array.from({ length: MAX_FLAGS_WITH_DRIVERS + 2 }, (_, i) => flag(`m${i}`, "medium", `Point ${String(i).padStart(2, "0")}`));
      const html = buildDecisionNoteHtml(withDrivers({ flags: many }));
      expect(html).toContain('<body class="tight">');
      expect(html).toContain("2 more flags on screen, not shown here.");
      expect(html).toContain(`Point 0${MAX_FLAGS_WITH_DRIVERS - 1} detail`);
      expect(html).not.toContain(`Point 0${MAX_FLAGS_WITH_DRIVERS} detail`);
      expect(html).toContain("<strong>Selected.</strong> Consider a flood sub-limit.");
      expect(html).toContain("Not selected: Consider moving plant.");
      expect(buildDecisionNoteHtml(input())).not.toContain('class="tight"');
    });

    it("caps the questions, says when there are none, and copes without a stated premium", () => {
      const lots = Array.from({ length: MAX_QUESTIONS_ON_NOTE + 3 }, (_, i) => `Question ${i + 1}?`);
      const html = buildDecisionNoteHtml(withDrivers({ questions: lots }));
      expect(html).toContain(`Questions for the broker (${MAX_QUESTIONS_ON_NOTE + 3})`);
      expect(html).toContain("3 more questions on screen, not shown here.");
      expect(html).not.toContain(`Question ${MAX_QUESTIONS_ON_NOTE + 1}?`);
      expect(buildDecisionNoteHtml(withDrivers({ questions: [] }))).toContain("None: the document states every value the price needs.");
      const base = withDrivers();
      const bare = buildDecisionNoteHtml({ ...base, premium: { ...base.premium!, stated: null, history: undefined, setBy: "minimum rate" } });
      expect(bare).toContain("The offer states no premium for all risks.");
      expect(bare).toContain("set by the minimum rate");
    });

    it("keeps Depth only on the short figures: a pure rate and no assumptions", () => {
      const base = withDrivers();
      const html = buildDecisionNoteHtml({ ...base, figures: { ...base.figures, floodRatePerMille: null }, drivers: { ...base.drivers!, basis: "Depth only" }, assumptions: undefined });
      expect(html).toContain("losses from: Depth only");
      expect(html).toContain('<div class="label">Pure rate</div>');
      expect(html).not.toContain('id="assumptions"');
    });
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
