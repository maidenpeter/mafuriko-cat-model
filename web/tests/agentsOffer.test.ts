import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/agents/[role]/route";
import { BRIEF_MAX_QUOTES, BRIEF_QUOTE_MAX_CHARS, readOfferBrief, type OfferBrief } from "../src/lib/agents/offerBrief";
import { aiChecks, deliberate, judgementLedger, replay, type Deliberation } from "../src/lib/agents/orchestrate";
import { buildPrompt } from "../src/lib/agents/prompts";
import { RESPONSE_SCHEMAS, responseSchemaFor } from "../src/lib/agents/responseSchema";
import { decisionSchema, nestReply, offerDecisionSchema, offerProposalSchema, PARAMETER_NAMES, parameterNames, proposalSchema, schemaFor, toJudgement, toParams, type Role } from "../src/lib/agents/schema";
import { flattenParams, REFERENCE_PARAMS } from "../src/lib/model/params";
import type { Dataset } from "../src/lib/model/types";
import { enforceJudgement, JUDGEMENT_BOUNDS, JUDGEMENT_KEYS, JUDGEMENT_LABELS, JUDGEMENT_PARAMETER_NAMES, REFERENCE_JUDGEMENT, type OfferJudgement } from "../src/lib/offer/judgement";

// Every fact and sentence here is invented. None of it comes from a real offer, and no real model is called.
const BRIEF: OfferBrief = {
  housingClass: "concrete_rcc",
  occupancy: "commercial",
  insuredValueKes: 2_000_000_000,
  basements: 2,
  criticalPlantInBasement: true,
  drainageCondition: "Open channels on two sides, reported silted",
  floodLossCount: 1,
  floodLossTotalKes: 14_000_000,
  floodHistoryYears: 11,
  pointDryByTier: [
    { tier: "extreme", dry: true },
    { tier: "common", dry: true },
  ],
  nearestMappedWaterM: 40,
  wetShareWidestTier: { within100m: 0.12, within250m: 0.2, within500m: 0.31 },
  nearestRiverM: 600,
  nearestDrainM: 35,
  quotes: [{ about: "basement plant", quote: "An invented sentence about a generator on the lower level." }],
};

// A reply in the flat form the model is asked for: the model's parameters at their reference values, then the offer's five.
const modelEntries = (extra: object = {}) => flattenParams(REFERENCE_PARAMS).map((p) => ({ name: p.path, reason: `because ${p.path}`, basis: "brief", ...extra, value: p.value }));
const offerEntries = (values: Partial<OfferJudgement> = {}, extra: object = {}) =>
  JUDGEMENT_KEYS.map((k) => ({ name: `offer.${k}`, reason: `because of the offer's ${k}`, basis: "offer", ...extra, value: values[k] ?? REFERENCE_JUDGEMENT[k] }));
const flat = (values: Partial<OfferJudgement> = {}, extra: object = {}) => [...modelEntries(extra), ...offerEntries(values, extra)];

describe("the parameter list with an offer loaded", () => {
  it("is the model's 14 followed by the offer's 5", () => {
    expect(parameterNames(true)).toHaveLength(19);
    expect(parameterNames(true).slice(0, 14)).toEqual(PARAMETER_NAMES);
    expect(parameterNames(true).slice(14)).toEqual(JUDGEMENT_PARAMETER_NAMES);
    expect(JUDGEMENT_PARAMETER_NAMES).toEqual(["offer.siteRadiusM", "offer.basementLoading", "offer.drainageLoading", "offer.experienceWeight", "offer.minimumRatePerMille"]);
  });

  it("is the model's 14 alone without one, and the enforced shape asks for 14", () => {
    expect(parameterNames(false)).toBe(PARAMETER_NAMES);
    expect(PARAMETER_NAMES).toHaveLength(14);
    for (const role of ["optimist", "cautious", "chair"] as const) {
      expect(responseSchemaFor(role, false)).toBe(RESPONSE_SCHEMAS[role]);
      const schema = responseSchemaFor(role, false) as { properties: { parameters: { minItems: number; maxItems: number; items: { properties: { name: { enum: string[] }; basis: { enum: string[] } } } } } };
      expect(schema.properties.parameters).toMatchObject({ minItems: 14, maxItems: 14 });
      expect(schema.properties.parameters.items.properties.name.enum).toEqual(PARAMETER_NAMES);
      expect(schema.properties.parameters.items.properties.basis.enum).toEqual(["jrc_reference", "data_profile", "brief", "judgement"]);
    }
  });

  it("asks for 19 flat entries in the enforced shape, with nothing nested deeper", () => {
    for (const role of ["optimist", "cautious", "chair"] as const) {
      const schema = responseSchemaFor(role, true) as { properties: { parameters: { minItems: number; maxItems: number; items: { properties: Record<string, { type: string; enum?: string[] }> } } } };
      expect(schema.properties.parameters).toMatchObject({ minItems: 19, maxItems: 19 });
      const entry = schema.properties.parameters.items.properties;
      expect(entry.name.enum).toEqual(parameterNames(true));
      expect(entry.basis.enum).toContain("offer");
      // Every field of an entry is a plain value: the list stays flat.
      for (const field of Object.values(entry)) expect(["STRING", "NUMBER"]).toContain(field.type);
    }
    const critic = responseSchemaFor("critic", true) as { properties: { challenges: { minItems: number; maxItems: number } } };
    expect(critic.properties.challenges).toMatchObject({ minItems: 4, maxItems: 8 });
  });
});

describe("a flat reply with the offer's figures", () => {
  it("nests into the 14 model parameters and the 5 judgement figures", () => {
    const parsed = offerProposalSchema.parse(nestReply("optimist", { stance: "s", parameters: flat({ siteRadiusM: 250 }) }, true));
    expect(toParams(parsed)).toEqual(REFERENCE_PARAMS);
    expect(toJudgement(parsed.offerJudgement)).toEqual({ ...REFERENCE_JUDGEMENT, siteRadiusM: 250 });
    expect(Object.keys(parsed.offerJudgement)).toEqual(JUDGEMENT_KEYS);
    expect(parsed.offerJudgement.basementLoading).toEqual({ value: REFERENCE_JUDGEMENT.basementLoading, reason: "because of the offer's basementLoading", basis: "offer" });
    // The model's parameters are where they always were, with no trace of the offer among them.
    expect(parsed.cap.semi_permanent.reason).toBe("because cap.semi_permanent");
    expect(parsed).not.toHaveProperty("offer");
  });

  it("keeps which way the Chair leaned on each of the five", () => {
    const parsed = offerDecisionSchema.parse(nestReply("chair", { summary: "s", parameters: flat({}, { leans: "cautious" }), responses: [] }, true));
    expect(toParams(parsed.decision)).toEqual(REFERENCE_PARAMS);
    expect(parsed.offerJudgement.experienceWeight).toMatchObject({ value: REFERENCE_JUDGEMENT.experienceWeight, leans: "cautious", basis: "offer" });
    expect(parsed.decision).not.toHaveProperty("offer");
  });

  it("is rejected when one of the five is left out, naming it", () => {
    const short = flat().filter((p) => p.name !== "offer.experienceWeight");
    const result = schemaFor("cautious", true).safeParse(nestReply("cautious", { stance: "s", parameters: short }, true));
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path.join("."))).toEqual(["offerJudgement.experienceWeight"]);
    // All five missing is five problems, not a pass.
    const none = schemaFor("chair", true).safeParse(nestReply("chair", { summary: "s", parameters: modelEntries({ leans: "between" }), responses: [] }, true));
    expect(none.error!.issues.map((i) => i.path.join("."))).toEqual(JUDGEMENT_KEYS.map((k) => `offerJudgement.${k}`));
  });

  it("is rejected when one of the five has no reason", () => {
    const blank = flat().map((p) => (p.name === "offer.minimumRatePerMille" ? { ...p, reason: "" } : p));
    const result = offerProposalSchema.safeParse(nestReply("optimist", { stance: "s", parameters: blank }, true));
    expect(result.error!.issues.map((i) => i.path.join("."))).toEqual(["offerJudgement.minimumRatePerMille.reason"]);
  });

  it("without an offer drops any offer entry and gives the same result as before", () => {
    const withExtra = nestReply("optimist", { stance: "s", parameters: flat() });
    expect(withExtra).toEqual(nestReply("optimist", { stance: "s", parameters: modelEntries() }));
    expect(withExtra).not.toHaveProperty("offerJudgement");
    expect(toParams(proposalSchema.parse(withExtra))).toEqual(REFERENCE_PARAMS);
    expect(decisionSchema.parse(nestReply("chair", { summary: "s", parameters: modelEntries({ leans: "between" }), responses: [] }))).not.toHaveProperty("offerJudgement");
  });
});

describe("the prompt with an offer loaded", () => {
  it("names all 19 and states every range and reference value from the judgement file", () => {
    for (const role of ["optimist", "cautious", "chair"] as const) {
      const { system, user } = buildPrompt(role, { profile: {} as never, offer: BRIEF });
      expect(system).toContain("The 19 parameters, by name:");
      for (const name of parameterNames(true)) expect(system).toContain(`- ${name}`);
      expect(system).toContain('"parameters": [ exactly 19 entries');
      for (const key of JUDGEMENT_KEYS) {
        expect(system).toContain(`- offer.${key}: ${JUDGEMENT_LABELS[key]}. Allowed range ${JUDGEMENT_BOUNDS[key].min} to ${JUDGEMENT_BOUNDS[key].max}, reference value ${REFERENCE_JUDGEMENT[key]}.`);
      }
      // The same ranges travel with the input, under the names the agent replies with.
      const input = JSON.parse(user.slice(user.indexOf("{"))) as { offer: OfferBrief; offerFigures: Record<string, { min: number; max: number; reference: number }> };
      expect(input.offer).toEqual(BRIEF);
      expect(Object.keys(input.offerFigures)).toEqual(JUDGEMENT_PARAMETER_NAMES);
      expect(input.offerFigures["offer.drainageLoading"]).toEqual({ ...JUDGEMENT_BOUNDS.drainageLoading, reference: REFERENCE_JUDGEMENT.drainageLoading });
    }
  });

  it("gives each role its part in the offer", () => {
    const prompt = (role: Role) => buildPrompt(role, { profile: {} as never, offer: BRIEF }).system;
    expect(prompt("optimist")).toContain("argue the least severe reading of this site");
    expect(prompt("cautious")).toContain("argue the most severe reading of this site");
    const critic = prompt("critic");
    for (const point of ["the single cell", "plant below ground", "the stated loss history", "residential"]) expect(critic).toContain(point);
    expect(critic).toContain("Raise between 4 and 8 challenges");
    expect(prompt("chair")).toContain("you settle all 19 parameters");
  });

  it("is the old prompt when no offer is sent, whether left out or null", () => {
    for (const role of ["optimist", "cautious", "critic", "chair"] as const) {
      const plain = buildPrompt(role, { profile: { a: 1 } as never });
      expect(buildPrompt(role, { profile: { a: 1 } as never, offer: null })).toEqual(plain);
      expect(plain.system).toContain("The 14 parameters, by name:");
      expect(plain.system).not.toContain("offer");
      expect(plain.user).not.toContain("offer");
    }
    expect(buildPrompt("critic", { profile: {} as never }).system).toContain("Raise between 3 and 6 challenges");
  });

  it("uses no long dash", () => {
    for (const role of ["optimist", "cautious", "critic", "chair"] as const) expect(buildPrompt(role, { profile: {} as never, offer: BRIEF }).system).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("the offer brief as it arrives in a request", () => {
  it("is null when none was sent", () => {
    for (const nothing of [undefined, null, "text", 3, []]) expect(readOfferBrief(nothing)).toBeNull();
  });

  it("passes the stated facts through unchanged", () => {
    expect(readOfferBrief(BRIEF)).toEqual(BRIEF);
    expect(readOfferBrief(JSON.parse(JSON.stringify(BRIEF)))).toEqual(BRIEF);
  });

  it("drops anything that is not one of its fields, and cuts long text", () => {
    const long = "word ".repeat(200);
    const read = readOfferBrief({
      ...BRIEF,
      documentText: "an invented page of a document that must not travel",
      insuredName: "Invented Holdings",
      quotes: [...Array.from({ length: 12 }, (_, i) => ({ about: "past flood", quote: `${i} ${long}`, page: 4 })), { about: 7, quote: "no label" }],
    })!;
    expect(read).not.toHaveProperty("documentText");
    expect(read).not.toHaveProperty("insuredName");
    expect(read.quotes).toHaveLength(BRIEF_MAX_QUOTES);
    for (const q of read.quotes) {
      expect(Object.keys(q)).toEqual(["about", "quote"]);
      expect(q.quote.length).toBeLessThanOrEqual(BRIEF_QUOTE_MAX_CHARS);
    }
  });

  it("reads a value of the wrong kind as not known, never as zero", () => {
    const read = readOfferBrief({ housingClass: "glass", occupancy: "castle", insuredValueKes: "2bn", basements: -1, criticalPlantInBasement: "yes", wetShareWidestTier: { within100m: 4, within250m: "x" }, nearestRiverM: Number.NaN, pointDryByTier: [{ tier: "common", dry: "no" }, { tier: "extreme", dry: false }] })!;
    expect(read).toMatchObject({ housingClass: null, occupancy: null, insuredValueKes: null, basements: null, criticalPlantInBasement: false, drainageCondition: null, floodLossCount: 0, floodLossTotalKes: null, nearestRiverM: null, nearestDrainM: null, quotes: [] });
    expect(read.wetShareWidestTier).toEqual({ within100m: 1, within250m: null, within500m: null });
    expect(read.pointDryByTier).toEqual([{ tier: "extreme", dry: false }]);
  });
});

// --- the route and a whole run, against a local stand-in for the provider ----------------------------

type Sent = { system: string; user: string; schema: { properties: { parameters?: { minItems: number }; challenges?: { minItems: number } } } };
let server: Server;
let sent: Sent[] = [];
let answer: (role: Role, n: number) => object;
const saved: Record<string, string | undefined> = {};
const ENV = ["AGENT_PROVIDER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_API_KEY_OPTIMIST", "OPENAI_API_KEY_CAUTIOUS", "OPENAI_API_KEY_CRITIC", "OPENAI_API_KEY_CHAIR"];

const roleOf = (system: string): Role => (system.includes("Your role: the Optimist.") ? "optimist" : system.includes("Your role: the Cautious voice.") ? "cautious" : system.includes("Your role: the Critic.") ? "critic" : "chair");
const respond = (res: ServerResponse, content: object) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content), refusal: null } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
};
const call = (role: string, body: object) => POST(new Request(`http://localhost/api/agents/${role}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ role }) });

const CRITIQUE = {
  summary: "An invented summary.",
  challenges: ["C1", "C2", "C3", "C4"].map((id) => ({ id, title: `Challenge ${id}`, detail: "An invented detail.", severity: "medium", affects: id === "C1" ? ["offer.siteRadiusM"] : ["data"], recommendation: "An invented recommendation." })),
};
const RESPONSES = CRITIQUE.challenges.map((c) => ({ challengeId: c.id, verdict: "accepted", response: "An invented response." }));

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: string }[]; response_format: { json_schema: { schema: Sent["schema"] } } };
      const system = parsed.messages[0].content;
      sent.push({ system, user: parsed.messages[1].content, schema: parsed.response_format.json_schema.schema });
      respond(res, answer(roleOf(system), sent.length));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // Every call goes to the stand-in on this machine, with a key that opens nothing.
  process.env.AGENT_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  sent = [];
});

describe("the agents route with an offer", () => {
  it("sends the brief's facts and the 19-entry shape, and returns the five figures beside the parameters", async () => {
    answer = () => ({ stance: "An invented stance.", parameters: flat({ siteRadiusM: 150 }) });
    const res = await call("optimist", { profile: { dataset: "toy" }, offer: { ...BRIEF, documentText: "an invented page that must not travel" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(toParams(body.output)).toEqual(REFERENCE_PARAMS);
    expect(toJudgement(body.output.offerJudgement)).toEqual({ ...REFERENCE_JUDGEMENT, siteRadiusM: 150 });

    expect(sent).toHaveLength(1);
    expect(sent[0].schema.properties.parameters!.minItems).toBe(19);
    expect(sent[0].system).toContain("- offer.minimumRatePerMille");
    expect(sent[0].user).toContain('"nearestMappedWaterM": 40');
    expect(sent[0].user).not.toContain("must not travel");
    // What was sent is also what the screen is given to show.
    expect(body.prompt).toEqual({ system: sent[0].system, user: sent[0].user });
  });

  it("asks again, naming the figure, when one of the five is missing, then gives up", async () => {
    answer = () => ({ stance: "An invented stance.", parameters: flat().filter((p) => p.name !== "offer.experienceWeight") });
    const res = await call("cautious", { profile: {}, offer: BRIEF });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("offer.experienceWeight");
    expect(sent).toHaveLength(2);
    expect(sent[1].user).toContain("Your previous reply was rejected: offer.experienceWeight");
  });

  it("works exactly as before when no offer is sent", async () => {
    answer = () => ({ stance: "An invented stance.", parameters: modelEntries() });
    const res = await call("optimist", { profile: {} });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.output).not.toHaveProperty("offerJudgement");
    expect(sent[0].schema.properties.parameters!.minItems).toBe(14);
    expect(sent[0].system).not.toContain("offer");
    expect(sent[0].user).not.toContain("offer");
  });
});

describe("a whole run with an offer", () => {
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
  // The Optimist stays in range, the Cautious goes over on two figures, the Chair goes over on one.
  const OPTIMIST = { siteRadiusM: 50, basementLoading: 0.1, drainageLoading: 0.05, experienceWeight: 0.2, minimumRatePerMille: 0.05 };
  const CAUTIOUS = { siteRadiusM: 900, basementLoading: 0.6, drainageLoading: 0.8, experienceWeight: 0.6, minimumRatePerMille: 0.5 };
  const CHAIR = { siteRadiusM: 250, basementLoading: 0.4, drainageLoading: 0.3, experienceWeight: 0.5, minimumRatePerMille: 2.5 };
  const replies = (role: Role): object =>
    role === "optimist"
      ? { stance: "An invented stance.", parameters: flat(OPTIMIST) }
      : role === "cautious"
        ? { stance: "An invented stance.", parameters: flat(CAUTIOUS) }
        : role === "critic"
          ? CRITIQUE
          : { summary: "An invented summary.", parameters: flat(CHAIR, { leans: "cautious" }), responses: RESPONSES };

  // The browser reaches the route by a relative address; here the same request is handed straight to the route.
  beforeAll(() => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/agents/")) return real(input, init);
      const role = url.slice("/api/agents/".length);
      return POST(new Request(`http://localhost${url}`, init), { params: Promise.resolve({ role }) });
    });
  });

  it("carries the three sets of five figures, the Chair's reasons and what code corrected", async () => {
    answer = replies;
    const updates: Deliberation[] = [];
    const d = await deliberate(dataset, {} as never, (u) => updates.push(u), BRIEF);

    expect(Object.values(d.runs).map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
    expect(toParams(d.runs.chair.output!.decision)).toEqual(REFERENCE_PARAMS);
    expect(d.final!.params).toEqual(REFERENCE_PARAMS);

    const j = d.offerJudgement!;
    expect(j.optimist).toEqual(OPTIMIST);
    expect(j.cautious).toEqual({ ...CAUTIOUS, siteRadiusM: JUDGEMENT_BOUNDS.siteRadiusM.max, drainageLoading: JUDGEMENT_BOUNDS.drainageLoading.max });
    expect(j.final).toEqual({ ...CHAIR, minimumRatePerMille: JUDGEMENT_BOUNDS.minimumRatePerMille.max });
    for (const set of [j.optimist, j.cautious, j.final]) expect(enforceJudgement(set!).adjustments).toEqual([]);
    expect(j.adjustments.map((a) => [a.role, a.key, a.from, a.to])).toEqual([
      ["cautious", "siteRadiusM", 900, 500],
      ["cautious", "drainageLoading", 0.8, 0.5],
      ["chair", "minimumRatePerMille", 2.5, 2],
    ]);
    expect(Object.keys(j.reasons)).toEqual(JUDGEMENT_KEYS);
    expect(j.reasons.siteRadiusM).toEqual({ reason: "because of the offer's siteRadiusM", basis: "offer", leans: "cautious" });
    expect(j.brief).toEqual(BRIEF);
    // The screen is told about the offer from the first update, before any agent has answered.
    expect(updates[0].offerJudgement).toMatchObject({ optimist: null, cautious: null, final: null, reasons: {}, adjustments: [] });

    // All four agents were given the offer, and the Chair saw what code applied for each side.
    expect(sent).toHaveLength(4);
    for (const s of sent) expect(s.user).toContain('"nearestMappedWaterM": 40');
    const chair = JSON.parse(sent[3].user.slice(sent[3].user.indexOf("{"))) as { cautious: { appliedOfferJudgement: OfferJudgement; proposal: { offerJudgement: Record<string, { value: number }> } } };
    expect(chair.cautious.appliedOfferJudgement.siteRadiusM).toBe(500);
    expect(chair.cautious.proposal.offerJudgement.siteRadiusM.value).toBe(900);

    const rows = judgementLedger(d);
    expect(rows.map((r) => r.key)).toEqual(JUDGEMENT_KEYS);
    expect(rows[0]).toEqual({ key: "siteRadiusM", label: JUDGEMENT_LABELS.siteRadiusM, reference: REFERENCE_JUDGEMENT.siteRadiusM, optimist: 50, cautious: 500, agreed: 250, reason: "because of the offer's siteRadiusM", basis: "offer", leans: "cautious", adjusted: false });
    expect(rows.filter((r) => r.adjusted).map((r) => r.key)).toEqual(["minimumRatePerMille"]);

    const check = aiChecks(dataset, d).find((c) => c.id === "offer-judgement")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("15 of 15 figures carry a written reason");
    expect(check.detail).toContain("3 value(s) were corrected by code");

    // A saved run comes back with the same figures, worked out again from the saved replies.
    const again = replay(dataset, JSON.parse(JSON.stringify({ ...d, optimist: null, cautious: null, final: null, offerJudgement: { ...j, final: null, adjustments: [] } })) as Deliberation);
    expect(again.offerJudgement).toEqual(j);
    expect(again.final!.params).toEqual(REFERENCE_PARAMS);
  });

  it("passes the check when every figure is in range", async () => {
    answer = (role) => (role === "critic" ? CRITIQUE : role === "chair" ? { summary: "An invented summary.", parameters: flat(OPTIMIST, { leans: "optimist" }), responses: RESPONSES } : { stance: "An invented stance.", parameters: flat(OPTIMIST) });
    const d = await deliberate(dataset, {} as never, () => {}, BRIEF);
    const check = aiChecks(dataset, d).find((c) => c.id === "offer-judgement")!;
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(`${JUDGEMENT_LABELS.siteRadiusM}: ${JUDGEMENT_BOUNDS.siteRadiusM.min} to ${JUDGEMENT_BOUNDS.siteRadiusM.max}`);
    expect(d.offerJudgement!.adjustments).toEqual([]);
  });

  it("keeps the two proposals when the Chair's reply has no figures for the offer", async () => {
    answer = (role) => (role === "critic" ? CRITIQUE : role === "chair" ? { summary: "An invented summary.", parameters: modelEntries({ leans: "between" }), responses: RESPONSES } : { stance: "An invented stance.", parameters: flat(OPTIMIST) });
    const d = await deliberate(dataset, {} as never, () => {}, BRIEF);
    expect(d.runs.chair.status).toBe("error");
    expect(d.runs.chair.error).toContain("offer.siteRadiusM");
    expect(d.final).toBeNull();
    expect(d.offerJudgement).toMatchObject({ optimist: OPTIMIST, cautious: OPTIMIST, final: null, reasons: {} });
    expect(judgementLedger(d).map((r) => [r.optimist, r.agreed, r.reason])).toEqual(JUDGEMENT_KEYS.map((k) => [OPTIMIST[k], null, ""]));
  });

  it("runs exactly as before without an offer: 14 parameters, no offer figures, no offer check", async () => {
    answer = (role) => (role === "critic" ? { ...CRITIQUE, challenges: CRITIQUE.challenges.slice(0, 3).map((c) => ({ ...c, affects: ["data"] })) } : role === "chair" ? { summary: "An invented summary.", parameters: modelEntries({ leans: "between" }), responses: RESPONSES } : { stance: "An invented stance.", parameters: modelEntries() });
    const updates: Deliberation[] = [];
    const d = await deliberate(dataset, {} as never, (u) => updates.push(u));
    expect(d.final!.params).toEqual(REFERENCE_PARAMS);
    expect(d).not.toHaveProperty("offerJudgement");
    for (const u of updates) expect(u).not.toHaveProperty("offerJudgement");
    for (const s of sent) {
      expect(s.user).not.toContain("offer");
      expect((s.schema.properties.parameters ?? s.schema.properties.challenges)!.minItems).toBe(s.schema.properties.parameters ? 14 : 3);
    }
    expect(judgementLedger(d)).toEqual([]);
    expect(aiChecks(dataset, d).map((c) => c.id)).toEqual(["schema", "ranges", "reasons", "challenges", "reproducible"]);
    // null is the same as leaving the offer out.
    expect(await deliberate(dataset, {} as never, () => {}, null)).not.toHaveProperty("offerJudgement");
  });

  it("replays a run saved before offers were argued", () => {
    const reasonedSet = (extra: object = {}) => nestReply("optimist", { parameters: modelEntries(extra) }) as object;
    const old = {
      startedAt: "2026-01-01T00:00:00.000Z",
      datasetName: "toy",
      profile: {},
      runs: {
        optimist: { role: "optimist", status: "done", output: { stance: "s", ...reasonedSet() } },
        cautious: { role: "cautious", status: "done", output: { stance: "s", ...reasonedSet() } },
        critic: { role: "critic", status: "done", output: CRITIQUE },
        chair: { role: "chair", status: "done", output: { summary: "s", decision: reasonedSet({ leans: "between" }), responses: RESPONSES } },
      },
      optimist: null,
      cautious: null,
      final: null,
      fingerprint: null,
    } as unknown as Deliberation;
    const d = replay(dataset, JSON.parse(JSON.stringify(old)) as Deliberation);
    expect(d.final!.params).toEqual(REFERENCE_PARAMS);
    expect(d.optimist!.params).toEqual(REFERENCE_PARAMS);
    expect(d).not.toHaveProperty("offerJudgement");
    expect(judgementLedger(d)).toEqual([]);
    expect(aiChecks(dataset, d).some((c) => c.id === "offer-judgement")).toBe(false);
  });
});
