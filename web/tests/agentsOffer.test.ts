import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/agents/[role]/route";
import { BRIEF_MAX_QUOTES, BRIEF_QUOTE_MAX_CHARS, readOfferBrief, type OfferBrief } from "../src/lib/agents/offerBrief";
import { aiChecks, deliberate, judgementLedger, replay, type Deliberation, type ModelBasis } from "../src/lib/agents/orchestrate";
import { buildPrompt } from "../src/lib/agents/prompts";
import { RESPONSE_SCHEMAS, responseSchemaFor } from "../src/lib/agents/responseSchema";
import { decisionSchema, issueName, nestReply, offerDecisionSchema, offerProposalSchema, PARAMETER_NAMES, parameterNames, proposalSchema, schemaFor, toJudgement, toParams, type Role } from "../src/lib/agents/schema";
import { flattenParams, REFERENCE_PARAMS } from "../src/lib/model/params";
import { resultFingerprint, runModel } from "../src/lib/model/pipeline";
import type { Dataset } from "../src/lib/model/types";
import {
  AGENT_JUDGEMENT_KEYS,
  BASEMENT_LADDER,
  enforceJudgement,
  JUDGEMENT_BOUNDS,
  JUDGEMENT_KEYS,
  JUDGEMENT_LABELS,
  JUDGEMENT_PARAMETER_NAMES,
  OUTAGE_LADDER,
  REFERENCE_JUDGEMENT,
  type OfferJudgement,
} from "../src/lib/offer/judgement";

// Every fact and sentence here is invented. None of it comes from a real offer, and no real model is called.
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
  depthsByTier: [
    { tier: "extreme", returnPeriod: 10, pointM: 0, bufferM: 0.12, pondingM: 0, overloaded: false },
    { tier: "common", returnPeriod: 250, pointM: 0, bufferM: 0.86, pondingM: 0.05, overloaded: true },
  ],
  nearestMappedWaterM: 40,
  nearestRiverM: 600,
  nearestDrainM: 35,
  quotes: [{ about: "equipment below ground", quote: "An invented sentence about a generator on the lower level." }],
};

/** The 14 figures the agents argue, at their reference values. */
const REFERENCE_14 = Object.fromEntries(AGENT_JUDGEMENT_KEYS.map((k) => [k, REFERENCE_JUDGEMENT[k]])) as Partial<OfferJudgement>;

// A reply in the flat form the model is asked for: the model's parameters at their reference values, then the offer's 14.
const modelEntries = (extra: object = {}) => flattenParams(REFERENCE_PARAMS).map((p) => ({ name: p.path, reason: `because ${p.path}`, basis: "brief", ...extra, value: p.value }));
const offerEntries = (values: Partial<OfferJudgement> = {}, extra: object = {}) =>
  AGENT_JUDGEMENT_KEYS.map((k) => ({ name: `offer.${k}`, reason: `because of the offer's ${k}`, basis: "offer", ...extra, value: values[k] ?? REFERENCE_JUDGEMENT[k] }));
const flat = (values: Partial<OfferJudgement> = {}, extra: object = {}) => [...modelEntries(extra), ...offerEntries(values, extra)];

describe("the parameter list with an offer loaded", () => {
  it("is the model's 14 followed by the offer's 14", () => {
    expect(parameterNames(true)).toHaveLength(28);
    expect(parameterNames(true).slice(0, 14)).toEqual(PARAMETER_NAMES);
    expect(parameterNames(true).slice(14)).toEqual(JUDGEMENT_PARAMETER_NAMES);
    expect(JUDGEMENT_PARAMETER_NAMES).toEqual([
      "offer.bufferRadiusM",
      "offer.ingressThresholdM",
      "offer.basementDamageExtreme",
      "offer.basementDamageSevere",
      "offer.basementDamageModerate",
      "offer.basementDamageOccasional",
      "offer.basementDamageCommon",
      "offer.belowGroundShare",
      "offer.outageDaysExtreme",
      "offer.outageDaysSevere",
      "offer.outageDaysModerate",
      "offer.outageDaysOccasional",
      "offer.outageDaysCommon",
      "offer.uncertaintyLoading",
    ]);
    // The figures set on screen only are not among them.
    expect(JUDGEMENT_KEYS).toHaveLength(19);
    for (const screenOnly of ["drainDesignRp", "drainOverloadDepthM", "annualRentShare", "costOfCapital", "minimumRatePerMille"]) expect(parameterNames(true)).not.toContain(`offer.${screenOnly}`);
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

  it("asks for 28 flat entries in the enforced shape, with nothing nested deeper", () => {
    for (const role of ["optimist", "cautious", "chair"] as const) {
      const schema = responseSchemaFor(role, true) as { properties: { parameters: { minItems: number; maxItems: number; items: { properties: Record<string, { type: string; enum?: string[] }> } } } };
      expect(schema.properties.parameters).toMatchObject({ minItems: 28, maxItems: 28 });
      const entry = schema.properties.parameters.items.properties;
      expect(entry.name.enum).toEqual(parameterNames(true));
      expect(entry.basis.enum).toContain("offer");
      // Every field of an entry is a plain value: the list stays flat, and a ladder is five entries.
      for (const field of Object.values(entry)) expect(["STRING", "NUMBER"]).toContain(field.type);
    }
    const critic = responseSchemaFor("critic", true) as { properties: { challenges: { minItems: number; maxItems: number } } };
    expect(critic.properties.challenges).toMatchObject({ minItems: 4, maxItems: 8 });
  });
});

describe("a flat reply with the offer's figures", () => {
  it("nests 28 entries into the 14 model parameters and the 14 figures", () => {
    const parsed = offerProposalSchema.parse(nestReply("optimist", { stance: "s", parameters: flat({ bufferRadiusM: 300 }) }, true));
    expect(toParams(parsed)).toEqual(REFERENCE_PARAMS);
    expect(toJudgement(parsed.offerJudgement)).toEqual({ ...REFERENCE_14, bufferRadiusM: 300 });
    expect(Object.keys(parsed.offerJudgement)).toEqual(AGENT_JUDGEMENT_KEYS);
    expect(parsed.offerJudgement.basementDamageSevere).toEqual({ value: REFERENCE_JUDGEMENT.basementDamageSevere, reason: "because of the offer's basementDamageSevere", basis: "offer" });
    // The model's parameters are where they always were, with no trace of the offer among them.
    expect(parsed.cap.semi_permanent.reason).toBe("because cap.semi_permanent");
    expect(parsed).not.toHaveProperty("offer");
  });

  it("drops an entry for a figure the agents do not argue", () => {
    const extra = [...flat(), { name: "offer.drainDesignRp", reason: "an invented reason", basis: "offer", value: 100 }, { name: "offer.siteRadiusM", reason: "an invented reason", basis: "offer", value: 100 }];
    const parsed = offerProposalSchema.parse(nestReply("optimist", { stance: "s", parameters: extra }, true));
    expect(Object.keys(parsed.offerJudgement)).toEqual(AGENT_JUDGEMENT_KEYS);
    expect(toJudgement(parsed.offerJudgement)).toEqual(REFERENCE_14);
    // The same when the numbers are read from a set that holds other keys.
    expect(toJudgement({ drainDesignRp: { value: 100 }, siteRadiusM: { value: 100 }, bufferRadiusM: { value: 120 }, belowGroundShare: { value: "0.2" }, uncertaintyLoading: null })).toEqual({ bufferRadiusM: 120 });
    expect(toJudgement(undefined)).toEqual({});
  });

  it("keeps which way the Chair leaned on each of the 14", () => {
    const parsed = offerDecisionSchema.parse(nestReply("chair", { summary: "s", parameters: flat({}, { leans: "cautious" }), responses: [] }, true));
    expect(toParams(parsed.decision)).toEqual(REFERENCE_PARAMS);
    expect(parsed.offerJudgement.outageDaysCommon).toMatchObject({ value: REFERENCE_JUDGEMENT.outageDaysCommon, leans: "cautious", basis: "offer" });
    expect(parsed.decision).not.toHaveProperty("offer");
  });

  it("is rejected when one of the 14 is left out, naming it", () => {
    const short = flat().filter((p) => p.name !== "offer.outageDaysModerate");
    const result = schemaFor("cautious", true).safeParse(nestReply("cautious", { stance: "s", parameters: short }, true));
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path.join("."))).toEqual(["offerJudgement.outageDaysModerate"]);
    expect(result.error!.issues.map((i) => issueName(i.path))).toEqual(["offer.outageDaysModerate"]);
    // All 14 missing is 14 problems, not a pass.
    const none = schemaFor("chair", true).safeParse(nestReply("chair", { summary: "s", parameters: modelEntries({ leans: "between" }), responses: [] }, true));
    expect(none.error!.issues.map((i) => i.path.join("."))).toEqual(AGENT_JUDGEMENT_KEYS.map((k) => `offerJudgement.${k}`));
  });

  it("is rejected when one of the 14 has no reason", () => {
    const blank = flat().map((p) => (p.name === "offer.uncertaintyLoading" ? { ...p, reason: "" } : p));
    const result = offerProposalSchema.safeParse(nestReply("optimist", { stance: "s", parameters: blank }, true));
    expect(result.error!.issues.map((i) => i.path.join("."))).toEqual(["offerJudgement.uncertaintyLoading.reason"]);
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
  it("names all 28 and states every range and reference value from the judgement file", () => {
    for (const role of ["optimist", "cautious", "chair"] as const) {
      const { system, user } = buildPrompt(role, { profile: {} as never, offer: BRIEF });
      expect(system).toContain("The 28 parameters, by name:");
      for (const name of parameterNames(true)) expect(system).toContain(`- ${name}`);
      expect(system).toContain('"parameters": [ exactly 28 entries');
      for (const key of AGENT_JUDGEMENT_KEYS) {
        expect(system).toContain(`- offer.${key}: ${JUDGEMENT_LABELS[key]}. Allowed range ${JUDGEMENT_BOUNDS[key].min} to ${JUDGEMENT_BOUNDS[key].max}, reference value ${REFERENCE_JUDGEMENT[key]}.`);
      }
      // A figure set on screen only is not offered to the agents as one of theirs.
      expect(system).not.toContain("- offer.drainDesignRp");
      // The same ranges travel with the input, under the names the agent replies with.
      const input = JSON.parse(user.slice(user.indexOf("{"))) as { offer: OfferBrief; offerFigures: Record<string, { min: number; max: number; reference: number }> };
      expect(input.offer).toEqual(BRIEF);
      expect(Object.keys(input.offerFigures)).toEqual(JUDGEMENT_PARAMETER_NAMES);
      expect(input.offerFigures["offer.belowGroundShare"]).toEqual({ ...JUDGEMENT_BOUNDS.belowGroundShare, reference: REFERENCE_JUDGEMENT.belowGroundShare });
    }
  });

  it("explains the six loss drivers and asks for the ladders to be argued as ladders", () => {
    for (const role of ["optimist", "cautious", "critic", "chair"] as const) {
      const { system } = buildPrompt(role, { profile: {} as never, offer: BRIEF });
      for (const driver of ["1. Surrounding flooding:", "2. Drainage ponding:", "3. Drain overload:", "4. Basement ingress:", "5. Business interruption:", "6. Uncertainty loading:"]) expect(system).toContain(driver);
      expect(system).toContain("the structure's loss is read once");
      // Each ladder is named rung by rung with its reference values, read from the judgement file.
      expect(system).toContain(`The basement ladder (${BASEMENT_LADDER.map((k) => `offer.${k}`).join(", ")}; reference ${BASEMENT_LADDER.map((k) => REFERENCE_JUDGEMENT[k]).join(", ")})`);
      expect(system).toContain(`The outage ladder (${OUTAGE_LADDER.map((k) => `offer.${k}`).join(", ")}; reference ${OUTAGE_LADDER.map((k) => REFERENCE_JUDGEMENT[k]).join(", ")})`);
      expect(system).toContain("A ladder never falls as events get rarer");
      expect(system).toContain("Steeper rungs need evidence");
      expect(system).toContain("Flatter rungs need");
      expect(system).toContain("Argue each ladder as a ladder");
      // Short reasons, so a reply of 28 entries is not cut off.
      expect(system).toContain("Keep every reason to one or two short sentences. The reply holds 28 entries");
      expect(system).toContain("a question for the broker, not a guess");
    }
  });

  it("gives each role its part in the offer", () => {
    const prompt = (role: Role) => buildPrompt(role, { profile: {} as never, offer: BRIEF }).system;
    expect(prompt("optimist")).toContain("argue the least severe reading of this building");
    expect(prompt("cautious")).toContain("argue the most severe reading of this building");
    const critic = prompt("critic");
    for (const point of ["the reference assumptions behind its loss drivers", "the single dry cell against the buffer", "plant below ground", "the drain design", "a commercial building", "residential", "what the document leaves unstated"]) expect(critic).toContain(point);
    expect(critic).toContain("Raise between 4 and 8 challenges");
    expect(prompt("chair")).toContain("you settle all 28 parameters and answer every challenge");
    expect(prompt("chair")).toContain("Settle each ladder as a whole");
  });

  it("is the old prompt when no offer is sent, whether left out or null", () => {
    for (const role of ["optimist", "cautious", "critic", "chair"] as const) {
      const plain = buildPrompt(role, { profile: { a: 1 } as never });
      expect(buildPrompt(role, { profile: { a: 1 } as never, offer: null })).toEqual(plain);
      expect(plain.system).toContain("The 14 parameters, by name:");
      expect(plain.system).not.toContain("offer");
      expect(plain.system).not.toContain("ladder");
      expect(plain.user).not.toContain("offer");
    }
    expect(buildPrompt("critic", { profile: {} as never }).system).toContain("Raise between 3 and 6 challenges");
  });

  it("tells every agent when the portfolio's losses count all loss drivers, in a sentence chosen by code", () => {
    const user = (role: Role, lossBasis?: unknown) => buildPrompt(role, { profile: {} as never, ...(lossBasis === undefined ? {} : { lossBasis }) } as never).user;
    for (const role of ["optimist", "cautious", "critic", "chair"] as const) {
      const input = JSON.parse(user(role, "all_drivers").slice(user(role, "all_drivers").indexOf("{"))) as { lossBasis: string };
      for (const part of ["surrounding flooding", "drainage ponding", "drain overload", "no basement data"]) expect(input.lossBasis).toContain(part);
      // Nothing is added on depth only, or for a value that is not the known word.
      expect(user(role, "depth_only")).toBe(user(role));
      expect(user(role, "an invented sentence that must not travel")).toBe(user(role));
      expect(user(role)).not.toContain("lossBasis");
    }
  });

  it("uses no long dash", () => {
    for (const role of ["optimist", "cautious", "critic", "chair"] as const) {
      const { system, user } = buildPrompt(role, { profile: {} as never, offer: BRIEF, lossBasis: "all_drivers" });
      expect(system + user).not.toMatch(/[\u2013\u2014]/);
    }
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

  it("carries the facts the agents need to argue the figures", () => {
    const read = readOfferBrief(BRIEF)!;
    expect(read).toMatchObject({ basements: 2, basementDepthM: 7.5, equipmentBelowGroundCount: 3, valueBelowGroundKes: null, drainDesignRp: 50, sumpPumpBackup: "no", floodBarriers: "absent", nonReturnValves: null, biCovered: "covered", bufferRadiusM: 250 });
    expect(read.depthsByTier[1]).toEqual({ tier: "common", returnPeriod: 250, pointM: 0, bufferM: 0.86, pondingM: 0.05, overloaded: true });
  });

  it("drops anything that is not one of its fields, and cuts long text", () => {
    const long = "word ".repeat(200);
    const read = readOfferBrief({
      ...BRIEF,
      documentText: "an invented page of a document that must not travel",
      insuredName: "Invented Holdings",
      sumpPumpCapacity: long,
      equipmentBelowGround: [{ item: { value: "an invented item that must not travel", quote: long } }],
      depthsByTier: [{ tier: "common", pointM: 0, bufferM: 0.4, overloaded: true, note: "an invented remark that must not travel" }],
      quotes: [...Array.from({ length: 20 }, (_, i) => ({ about: "past flood", quote: `${i} ${long}`, page: 4 })), { about: 7, quote: "no label" }],
    })!;
    expect(read).not.toHaveProperty("documentText");
    expect(read).not.toHaveProperty("insuredName");
    expect(read).not.toHaveProperty("equipmentBelowGround");
    expect(JSON.stringify(read)).not.toContain("must not travel");
    expect(read.sumpPumpCapacity!.length).toBeLessThanOrEqual(BRIEF_QUOTE_MAX_CHARS);
    expect(Object.keys(read.depthsByTier[0])).toEqual(["tier", "returnPeriod", "pointM", "bufferM", "pondingM", "overloaded"]);
    expect(read.quotes).toHaveLength(BRIEF_MAX_QUOTES);
    for (const q of read.quotes) {
      expect(Object.keys(q)).toEqual(["about", "quote"]);
      expect(q.quote.length).toBeLessThanOrEqual(BRIEF_QUOTE_MAX_CHARS);
    }
  });

  it("reads a value of the wrong kind as not known, never as zero", () => {
    const read = readOfferBrief({
      housingClass: "glass",
      occupancy: "castle",
      insuredValueKes: "2bn",
      basements: -1,
      basementDepthM: "deep",
      criticalPlantInBasement: "yes",
      valueBelowGroundKes: -5,
      drainDesignRp: "fifty",
      sumpPumpBackup: true,
      floodBarriers: "some",
      nonReturnValves: 1,
      biCovered: "yes",
      locationApproximate: "no",
      wetShareWidestTier: { within100m: 0.4 },
      nearestRiverM: Number.NaN,
      depthsByTier: [{ tier: "common", pointM: "dry", bufferM: -1, overloaded: "no" }, { pointM: 1, bufferM: 1, overloaded: true }, { tier: "extreme", pointM: 0, bufferM: 0.2, overloaded: false }],
    })!;
    expect(read).toMatchObject({ housingClass: null, occupancy: null, insuredValueKes: null, floorAreaM2: null, locationApproximate: false, basements: null, basementDepthM: null, criticalPlantInBasement: false });
    expect(read).toMatchObject({ equipmentBelowGroundCount: 0, valueBelowGroundKes: null, drainageCondition: null, drainDesignRp: null, sumpPumpCapacity: null, sumpPumpBackup: null, floodBarriers: null, nonReturnValves: null, biCovered: null });
    expect(read).toMatchObject({ floodLossCount: 0, floodLossTotalKes: null, bufferRadiusM: null, nearestRiverM: null, nearestDrainM: null, quotes: [] });
    // A field the brief no longer has is dropped like any other.
    expect(read).not.toHaveProperty("wetShareWidestTier");
    // A tier with no name is dropped; a depth that cannot be read is not known, and a real zero stays zero.
    expect(read.depthsByTier).toEqual([
      { tier: "common", returnPeriod: null, pointM: null, bufferM: null, pondingM: null, overloaded: null },
      { tier: "extreme", returnPeriod: null, pointM: 0, bufferM: 0.2, pondingM: null, overloaded: false },
    ]);
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
  challenges: ["C1", "C2", "C3", "C4"].map((id) => ({ id, title: `Challenge ${id}`, detail: "An invented detail.", severity: "medium", affects: id === "C1" ? ["offer.bufferRadiusM"] : ["data"], recommendation: "An invented recommendation." })),
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
  it("sends the brief's facts and the 28-entry shape, and returns the 14 figures beside the parameters", async () => {
    answer = () => ({ stance: "An invented stance.", parameters: flat({ bufferRadiusM: 150 }) });
    const res = await call("optimist", { profile: { dataset: "toy" }, offer: { ...BRIEF, documentText: "an invented page that must not travel" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(toParams(body.output)).toEqual(REFERENCE_PARAMS);
    expect(toJudgement(body.output.offerJudgement)).toEqual({ ...REFERENCE_14, bufferRadiusM: 150 });

    expect(sent).toHaveLength(1);
    expect(sent[0].schema.properties.parameters!.minItems).toBe(28);
    expect(sent[0].system).toContain("- offer.uncertaintyLoading");
    expect(sent[0].user).toContain('"nearestMappedWaterM": 40');
    expect(sent[0].user).toContain('"drainDesignRp": 50');
    expect(sent[0].user).toContain('"bufferM": 0.86');
    expect(sent[0].user).not.toContain("must not travel");
    // What was sent is also what the screen is given to show.
    expect(body.prompt).toEqual({ system: sent[0].system, user: sent[0].user });
  });

  it("asks again, naming the figure, when one of the 14 is missing, then gives up", async () => {
    answer = () => ({ stance: "An invented stance.", parameters: flat().filter((p) => p.name !== "offer.basementDamageCommon") });
    const res = await call("cautious", { profile: {}, offer: BRIEF });
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("offer.basementDamageCommon");
    expect(sent).toHaveLength(2);
    expect(sent[1].user).toContain("Your previous reply was rejected: offer.basementDamageCommon");
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
  // The Optimist stays in range with both ladders rising.
  const OPTIMIST: Partial<OfferJudgement> = {
    bufferRadiusM: 100,
    ingressThresholdM: 0.2,
    basementDamageExtreme: 0.05,
    basementDamageSevere: 0.1,
    basementDamageModerate: 0.2,
    basementDamageOccasional: 0.3,
    basementDamageCommon: 0.4,
    belowGroundShare: 0.05,
    outageDaysExtreme: 1,
    outageDaysSevere: 2,
    outageDaysModerate: 5,
    outageDaysOccasional: 10,
    outageDaysCommon: 20,
    uncertaintyLoading: 0.05,
  };
  // The Cautious voice goes over on two figures, and its basement ladder falls at the third rung.
  const CAUTIOUS: Partial<OfferJudgement> = {
    bufferRadiusM: 900,
    ingressThresholdM: 0.05,
    basementDamageExtreme: 0.3,
    basementDamageSevere: 0.5,
    basementDamageModerate: 0.45,
    basementDamageOccasional: 0.7,
    basementDamageCommon: 0.9,
    belowGroundShare: 0.2,
    outageDaysExtreme: 5,
    outageDaysSevere: 10,
    outageDaysModerate: 20,
    outageDaysOccasional: 40,
    outageDaysCommon: 80,
    uncertaintyLoading: 0.8,
  };
  // The Chair goes over on one figure, and its outage ladder falls at the third rung.
  const CHAIR: Partial<OfferJudgement> = {
    bufferRadiusM: 300,
    ingressThresholdM: 0.1,
    basementDamageExtreme: 0.2,
    basementDamageSevere: 0.3,
    basementDamageModerate: 0.45,
    basementDamageOccasional: 0.6,
    basementDamageCommon: 0.8,
    belowGroundShare: 0.6,
    outageDaysExtreme: 3,
    outageDaysSevere: 8,
    outageDaysModerate: 6,
    outageDaysOccasional: 30,
    outageDaysCommon: 60,
    uncertaintyLoading: 0.15,
  };
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

  it("carries the three sets of 14 figures, the Chair's reasons and what code corrected", async () => {
    answer = replies;
    const updates: Deliberation[] = [];
    const d = await deliberate(dataset, {} as never, (u) => updates.push(u), BRIEF);

    expect(Object.values(d.runs).map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
    expect(toParams(d.runs.chair.output!.decision)).toEqual(REFERENCE_PARAMS);
    expect(d.final!.params).toEqual(REFERENCE_PARAMS);

    const j = d.offerJudgement!;
    expect(j.optimist).toEqual(OPTIMIST);
    // Out of range comes back to the range; a rung lower than the one before it is raised to match it.
    expect(j.cautious).toEqual({ ...CAUTIOUS, bufferRadiusM: JUDGEMENT_BOUNDS.bufferRadiusM.max, uncertaintyLoading: JUDGEMENT_BOUNDS.uncertaintyLoading.max, basementDamageModerate: 0.5 });
    expect(j.final).toEqual({ ...CHAIR, belowGroundShare: JUDGEMENT_BOUNDS.belowGroundShare.max, outageDaysModerate: 8 });
    for (const set of [j.optimist, j.cautious, j.final]) {
      // Only the figures the agents argue are in a set, and nothing more needs correcting.
      expect(Object.keys(set!)).toEqual(AGENT_JUDGEMENT_KEYS);
      expect(enforceJudgement(set!).adjustments).toEqual([]);
      for (const ladder of [BASEMENT_LADDER, OUTAGE_LADDER]) for (let i = 1; i < ladder.length; i++) expect(set![ladder[i]]!).toBeGreaterThanOrEqual(set![ladder[i - 1]]!);
    }
    expect(j.adjustments.map((a) => [a.role, a.key, a.from, a.to])).toEqual([
      ["cautious", "bufferRadiusM", 900, 500],
      ["cautious", "uncertaintyLoading", 0.8, 0.5],
      ["cautious", "basementDamageModerate", 0.45, 0.5],
      ["chair", "belowGroundShare", 0.6, 0.5],
      ["chair", "outageDaysModerate", 6, 8],
    ]);
    expect(j.adjustments[2].reason).toContain("lower than the more frequent rung");
    expect(Object.keys(j.reasons)).toEqual(AGENT_JUDGEMENT_KEYS);
    expect(j.reasons.bufferRadiusM).toEqual({ reason: "because of the offer's bufferRadiusM", basis: "offer", leans: "cautious" });
    expect(j.brief).toEqual(BRIEF);
    // The screen is told about the offer from the first update, before any agent has answered.
    expect(updates[0].offerJudgement).toMatchObject({ optimist: null, cautious: null, final: null, reasons: {}, adjustments: [] });

    // All four agents were given the offer, and the Chair saw what code applied for each side.
    expect(sent).toHaveLength(4);
    for (const s of sent) expect(s.user).toContain('"nearestMappedWaterM": 40');
    const chair = JSON.parse(sent[3].user.slice(sent[3].user.indexOf("{"))) as { cautious: { appliedOfferJudgement: OfferJudgement; proposal: { offerJudgement: Record<string, { value: number }> } } };
    expect(chair.cautious.appliedOfferJudgement.bufferRadiusM).toBe(500);
    expect(chair.cautious.appliedOfferJudgement.basementDamageModerate).toBe(0.5);
    expect(chair.cautious.proposal.offerJudgement.bufferRadiusM.value).toBe(900);
    // No basis was given, so nothing is said about one.
    for (const s of sent) expect(s.user).not.toContain("lossBasis");

    const rows = judgementLedger(d);
    expect(rows.map((r) => r.key)).toEqual(AGENT_JUDGEMENT_KEYS);
    expect(rows[0]).toEqual({ key: "bufferRadiusM", label: JUDGEMENT_LABELS.bufferRadiusM, reference: REFERENCE_JUDGEMENT.bufferRadiusM, optimist: 100, cautious: 500, agreed: 300, reason: "because of the offer's bufferRadiusM", basis: "offer", leans: "cautious", adjusted: false });
    expect(rows.filter((r) => r.adjusted).map((r) => [r.key, r.agreed])).toEqual([["belowGroundShare", 0.5], ["outageDaysModerate", 8]]);

    const check = aiChecks(dataset, d).find((c) => c.id === "offer-judgement")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("42 of 42 figures carry a written reason");
    expect(check.detail).toContain("5 value(s) were corrected by code, 2 of them to keep a ladder from falling");

    // A saved run comes back with the same figures, worked out again from the saved replies.
    const again = replay(dataset, JSON.parse(JSON.stringify({ ...d, optimist: null, cautious: null, final: null, offerJudgement: { ...j, final: null, adjustments: [] } })) as Deliberation);
    expect(again.offerJudgement).toEqual(j);
    expect(again.final!.params).toEqual(REFERENCE_PARAMS);
  });

  it("passes the check when every figure is in range and both ladders rise", async () => {
    answer = (role) => (role === "critic" ? CRITIQUE : role === "chair" ? { summary: "An invented summary.", parameters: flat(OPTIMIST, { leans: "optimist" }), responses: RESPONSES } : { stance: "An invented stance.", parameters: flat(OPTIMIST) });
    const d = await deliberate(dataset, {} as never, () => {}, BRIEF);
    const check = aiChecks(dataset, d).find((c) => c.id === "offer-judgement")!;
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("All are inside their ranges and both ladders rise.");
    expect(check.detail).toContain(`${JUDGEMENT_LABELS.bufferRadiusM}: ${JUDGEMENT_BOUNDS.bufferRadiusM.min} to ${JUDGEMENT_BOUNDS.bufferRadiusM.max}`);
    expect(check.detail).toContain("Outage days for each tier: 0 to 365, never falling as events get rarer");
    expect(d.offerJudgement!.adjustments).toEqual([]);
  });

  it("keeps the two proposals when the Chair's reply has no figures for the offer", async () => {
    answer = (role) => (role === "critic" ? CRITIQUE : role === "chair" ? { summary: "An invented summary.", parameters: modelEntries({ leans: "between" }), responses: RESPONSES } : { stance: "An invented stance.", parameters: flat(OPTIMIST) });
    const d = await deliberate(dataset, {} as never, () => {}, BRIEF);
    expect(d.runs.chair.status).toBe("error");
    expect(d.runs.chair.error).toContain("offer.bufferRadiusM");
    expect(d.final).toBeNull();
    expect(d.offerJudgement).toMatchObject({ optimist: OPTIMIST, cautious: OPTIMIST, final: null, reasons: {} });
    expect(judgementLedger(d).map((r) => [r.optimist, r.agreed, r.reason])).toEqual(AGENT_JUDGEMENT_KEYS.map((k) => [OPTIMIST[k], null, ""]));
  });

  it("runs exactly as before without an offer: 14 parameters, no offer figures, no offer check", async () => {
    answer = (role) => (role === "critic" ? { ...CRITIQUE, challenges: CRITIQUE.challenges.slice(0, 3).map((c) => ({ ...c, affects: ["data"] })) } : role === "chair" ? { summary: "An invented summary.", parameters: modelEntries({ leans: "between" }), responses: RESPONSES } : { stance: "An invented stance.", parameters: modelEntries() });
    const updates: Deliberation[] = [];
    const d = await deliberate(dataset, {} as never, (u) => updates.push(u));
    expect(d.final!.params).toEqual(REFERENCE_PARAMS);
    expect(d.final!.result).toEqual(runModel(dataset, REFERENCE_PARAMS));
    expect(d.fingerprint).toBe(resultFingerprint(runModel(dataset, REFERENCE_PARAMS)));
    expect(d).not.toHaveProperty("offerJudgement");
    expect(d).not.toHaveProperty("basis");
    for (const u of updates) expect(u).not.toHaveProperty("offerJudgement");
    for (const s of sent) {
      expect(s.user).not.toContain("offer");
      expect(s.user).not.toContain("lossBasis");
      expect((s.schema.properties.parameters ?? s.schema.properties.challenges)!.minItems).toBe(s.schema.properties.parameters ? 14 : 3);
    }
    expect(judgementLedger(d)).toEqual([]);
    expect(aiChecks(dataset, d).map((c) => c.id)).toEqual(["schema", "ranges", "reasons", "challenges", "reproducible"]);
    // null is the same as leaving the offer out.
    expect(await deliberate(dataset, {} as never, () => {}, null)).not.toHaveProperty("offerJudgement");
  });

  it("works out what each side produces on the basis shown on screen, and keeps the fingerprint on depth only", async () => {
    answer = replies;
    const basis: ModelBasis = { mode: "all_drivers", judgement: { ...REFERENCE_JUDGEMENT, drainDesignRp: 5, drainOverloadDepthM: 0.3 } };
    const allDrivers = runModel(dataset, REFERENCE_PARAMS, basis);
    const depthOnly = runModel(dataset, REFERENCE_PARAMS);
    // The toy portfolio loses more once overloaded drains count, so the two bases can be told apart.
    expect(allDrivers.scenarios[0].lossKes).toBeGreaterThan(depthOnly.scenarios[0].lossKes);

    const d = await deliberate(dataset, {} as never, () => {}, BRIEF, basis);
    expect(d.basis).toEqual(basis);
    for (const side of [d.optimist, d.cautious, d.final]) expect(side!.result).toEqual(allDrivers);
    expect(d.fingerprint).toBe(resultFingerprint(depthOnly));
    expect(aiChecks(dataset, d).find((c) => c.id === "reproducible")!.status).toBe("pass");
    // All four agents are told what the losses count, and the Chair sees each side's outcome on that basis.
    for (const s of sent) expect(s.user).toContain('"lossBasis": "The portfolio\'s losses in this run count three loss drivers');
    const chair = JSON.parse(sent[3].user.slice(sent[3].user.indexOf("{"))) as { optimist: { outcome: { lossByScenario: { lossShareOfInsuredValue: number }[] } } };
    expect(chair.optimist.outcome.lossByScenario[0].lossShareOfInsuredValue).toBeCloseTo(allDrivers.scenarios[0].lossKes / allDrivers.totalTivKes, 4);

    // A saved run keeps its basis on replay, takes another when one is given, and the fingerprint still holds.
    const stored = JSON.parse(JSON.stringify({ ...d, optimist: null, cautious: null, final: null })) as Deliberation;
    const kept = replay(dataset, stored);
    expect(kept.basis).toEqual(basis);
    expect(kept.final!.result).toEqual(allDrivers);
    const switched = replay(dataset, stored, { mode: "depth_only", judgement: REFERENCE_JUDGEMENT });
    expect(switched.basis).toEqual({ mode: "depth_only", judgement: REFERENCE_JUDGEMENT });
    expect(switched.final!.result).toEqual(runModel(dataset, REFERENCE_PARAMS, { mode: "depth_only", judgement: REFERENCE_JUDGEMENT }));
    expect(resultFingerprint(switched.final!.result)).toBe(d.fingerprint);
    for (const run of [kept, switched]) expect(aiChecks(dataset, run).find((c) => c.id === "reproducible")!.status).toBe("pass");
    // A basis that cannot be read back is no basis: the run is re-scored on depth only.
    const broken = replay(dataset, { ...stored, basis: { mode: "everything", judgement: null } } as unknown as Deliberation);
    expect(broken).not.toHaveProperty("basis");
    expect(broken.final!.result).toEqual(depthOnly);
  });

  // A saved run from before any of this: the model's parameters only.
  const reasonedSet = (extra: object = {}) => nestReply("optimist", { parameters: modelEntries(extra) }) as object;
  const oldRun = (offer: (extra?: object) => object | undefined = () => undefined) =>
    ({
      startedAt: "2026-01-01T00:00:00.000Z",
      datasetName: "toy",
      profile: {},
      runs: {
        optimist: { role: "optimist", status: "done", output: { stance: "s", ...reasonedSet(), ...offer() } },
        cautious: { role: "cautious", status: "done", output: { stance: "s", ...reasonedSet(), ...offer() } },
        critic: { role: "critic", status: "done", output: CRITIQUE },
        chair: { role: "chair", status: "done", output: { summary: "s", decision: reasonedSet({ leans: "between" }), responses: RESPONSES, ...offer({ leans: "between" }) } },
      },
      optimist: null,
      cautious: null,
      final: null,
      fingerprint: resultFingerprint(runModel(dataset, REFERENCE_PARAMS)),
    }) as unknown as Deliberation;

  it("replays a run saved before offers were argued", () => {
    const d = replay(dataset, JSON.parse(JSON.stringify(oldRun())) as Deliberation);
    expect(d.final!.params).toEqual(REFERENCE_PARAMS);
    expect(d.optimist!.params).toEqual(REFERENCE_PARAMS);
    // On depth only, as it was made.
    expect(d.final!.result).toEqual(runModel(dataset, REFERENCE_PARAMS));
    expect(d).not.toHaveProperty("offerJudgement");
    expect(d).not.toHaveProperty("basis");
    expect(judgementLedger(d)).toEqual([]);
    const checks = aiChecks(dataset, d);
    expect(checks.some((c) => c.id === "offer-judgement")).toBe(false);
    expect(checks.find((c) => c.id === "reproducible")!.status).toBe("pass");
  });

  it("replays a run saved with the earlier five figures: they are ignored and the reference stays in force", () => {
    // The five figures of the method this one replaced, as an earlier run saved them.
    const EARLIER = { siteRadiusM: 250, basementLoading: 0.4, drainageLoading: 0.3, experienceWeight: 0.5, minimumRatePerMille: 0.5 };
    const earlierSet = (extra: object = {}) => ({ offerJudgement: Object.fromEntries(Object.entries(EARLIER).map(([k, value]) => [k, { value, reason: `an invented reason for ${k}`, basis: "offer", ...extra }])) });
    const earlierBrief = { housingClass: "concrete_rcc", insuredValueKes: 2_000_000_000, basements: 2, criticalPlantInBasement: true, pointDryByTier: [{ tier: "common", dry: true }], quotes: [] };
    const old = { ...oldRun(earlierSet), offerJudgement: { optimist: EARLIER, cautious: EARLIER, final: EARLIER, reasons: { siteRadiusM: { reason: "an invented reason", basis: "offer", leans: "between" } }, adjustments: [], brief: earlierBrief } };
    const d = replay(dataset, JSON.parse(JSON.stringify(old)) as Deliberation);

    // The model's parameters replay as they always did.
    expect(d.final!.params).toEqual(REFERENCE_PARAMS);
    expect(d.final!.result).toEqual(runModel(dataset, REFERENCE_PARAMS));
    // None of the earlier keys survives, and nothing is put in their place.
    expect(d.offerJudgement).toEqual({ optimist: null, cautious: null, final: null, reasons: {}, adjustments: [], brief: earlierBrief });
    const rows = judgementLedger(d);
    expect(rows.map((r) => r.key)).toEqual(AGENT_JUDGEMENT_KEYS);
    for (const row of rows) expect(row).toMatchObject({ reference: REFERENCE_JUDGEMENT[row.key], optimist: null, cautious: null, agreed: null, reason: "", adjusted: false });
    const check = aiChecks(dataset, d).find((c) => c.id === "offer-judgement")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("saved before these figures were argued");
    expect(check.detail).toContain("the reference values stay in force");
  });

  it("fills a figure a saved reply lacks from the reference, and reports it as unreasoned", () => {
    // A reply that holds some of the 14: what it holds is used, and the rest is left to the reference.
    const partial = (extra: object = {}) => ({ offerJudgement: { bufferRadiusM: { value: 700, reason: "an invented reason", basis: "offer", ...extra }, basementDamageSevere: { value: 0.05, reason: "an invented reason", basis: "offer", ...extra } } });
    const d = replay(dataset, JSON.parse(JSON.stringify({ ...oldRun(partial), offerJudgement: { optimist: null, cautious: null, final: null, reasons: {}, adjustments: [], brief: BRIEF } })) as Deliberation);
    // Out of range is corrected, and the rung is raised to the reference rung before it.
    expect(d.offerJudgement!.final).toEqual({ bufferRadiusM: 500, basementDamageSevere: REFERENCE_JUDGEMENT.basementDamageExtreme });
    expect(d.offerJudgement!.adjustments.filter((a) => a.role === "chair").map((a) => [a.key, a.from, a.to])).toEqual([["bufferRadiusM", 700, 500], ["basementDamageSevere", 0.05, REFERENCE_JUDGEMENT.basementDamageExtreme]]);
    const rows = judgementLedger(d);
    expect(rows.find((r) => r.key === "bufferRadiusM")).toMatchObject({ agreed: 500, adjusted: true });
    expect(rows.find((r) => r.key === "uncertaintyLoading")).toMatchObject({ agreed: null, reference: REFERENCE_JUDGEMENT.uncertaintyLoading });
    const check = aiChecks(dataset, d).find((c) => c.id === "offer-judgement")!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("6 of 42 figures carry a written reason");
  });
});
