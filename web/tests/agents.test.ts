import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/lib/agents/prompts";
import { RESPONSE_SCHEMAS, responseSchemaFor } from "../src/lib/agents/responseSchema";
import { BASES, decisionSchema, nestReply, PARAMETER_NAMES, parameterNames, proposalSchema, ROLES, schemaFor, SCHEMAS, toParams } from "../src/lib/agents/schema";
import { flattenParams, REFERENCE_PARAMS } from "../src/lib/model/params";

// A reply in the flat form the model is asked for, built from the reference values.
const flat = (extra: object = {}) => flattenParams(REFERENCE_PARAMS).map((p) => ({ name: p.path, reason: `because ${p.path}`, basis: "brief", ...extra, value: p.value }));

describe("agent replies", () => {
  it("names all 14 parameters", () => {
    expect(PARAMETER_NAMES).toHaveLength(14);
    expect(PARAMETER_NAMES).toContain("depthScaleM");
    expect(PARAMETER_NAMES).toContain("fragility.concrete_rcc");
    expect(PARAMETER_NAMES).toContain("returnPeriods.common");
  });

  it("turns a flat proposal into the nested set the engine uses", () => {
    const parsed = proposalSchema.parse(nestReply("optimist", { stance: "s", parameters: flat() }));
    expect(toParams(parsed)).toEqual(REFERENCE_PARAMS);
    expect(parsed.cap.semi_permanent.reason).toBe("because cap.semi_permanent");
  });

  it("turns a flat decision into the nested form, keeping which way it leans", () => {
    const parsed = decisionSchema.parse(nestReply("chair", { summary: "s", parameters: flat({ leans: "cautious" }), responses: [] }));
    expect(toParams(parsed.decision)).toEqual(REFERENCE_PARAMS);
    expect(parsed.decision.depthScaleM.leans).toBe("cautious");
  });

  it("rejects a proposal that leaves a parameter out, naming it", () => {
    const short = flat().filter((p) => p.name !== "cap.concrete_rcc");
    const result = proposalSchema.safeParse(nestReply("cautious", { stance: "s", parameters: short }));
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path.join("."))).toContain("cap.concrete_rcc");
  });

  it("leaves the critic's reply and already-nested replies alone", () => {
    const critique = { summary: "s", challenges: [] };
    expect(nestReply("critic", critique)).toBe(critique);
    const nested = { stance: "s", depthScaleM: {} };
    expect(nestReply("optimist", nested)).toBe(nested);
  });

  it("asks for the same flat shape in the prompt and in the enforced schema", () => {
    for (const role of ["optimist", "cautious", "chair"] as const) {
      const schema = RESPONSE_SCHEMAS[role] as { properties: { parameters: { minItems: number; items: { properties: { name: { enum: string[] } } } } } };
      expect(schema.properties.parameters.minItems).toBe(14);
      expect(schema.properties.parameters.items.properties.name.enum).toEqual(PARAMETER_NAMES);
      const { system } = buildPrompt(role, { profile: {} as never });
      for (const name of PARAMETER_NAMES) expect(system).toContain(`- ${name}`);
      expect(system).toContain('"parameters": [ exactly 14 entries');
    }
  });

  it("keeps the list, the shapes and the checks as they were when no offer is loaded", () => {
    expect(parameterNames(false)).toBe(PARAMETER_NAMES);
    expect(BASES).toEqual(["jrc_reference", "data_profile", "brief", "judgement"]);
    for (const role of ROLES) {
      expect(responseSchemaFor(role, false)).toBe(RESPONSE_SCHEMAS[role]);
      expect(schemaFor(role, false)).toBe(SCHEMAS[role]);
      expect(JSON.stringify(RESPONSE_SCHEMAS[role])).not.toContain("offer");
      const { system, user } = buildPrompt(role, { profile: {} as never });
      expect(system).toContain("The 14 parameters, by name:");
      expect(system).not.toContain("offer");
      expect(user).not.toContain("offer");
    }
    for (const role of ["optimist", "cautious", "chair"] as const) {
      const schema = RESPONSE_SCHEMAS[role] as { properties: { parameters: { maxItems: number; items: { properties: { basis: { enum: string[] } } } } } };
      expect(schema.properties.parameters.maxItems).toBe(14);
      expect(schema.properties.parameters.items.properties.basis.enum).toEqual([...BASES]);
    }
    const critic = RESPONSE_SCHEMAS.critic as { properties: { challenges: { minItems: number; maxItems: number } } };
    expect(critic.properties.challenges).toMatchObject({ minItems: 3, maxItems: 6 });
  });

  it("sends, byte for byte, the instructions and the shapes it sent before offers were argued", () => {
    // Fingerprints taken before the loss drivers beyond depth were added. With no offer loaded nothing an agent is sent may change.
    const BEFORE: Record<string, { system: string; user: string; schema: string }> = {
      optimist: { system: "51175ea3a4ac1e67", user: "f812c8e652d1d23a", schema: "f22bd8860db06612" },
      cautious: { system: "7188ef8b822f58e7", user: "f812c8e652d1d23a", schema: "f22bd8860db06612" },
      critic: { system: "a6bfadb513d0b335", user: "f812c8e652d1d23a", schema: "7aa935527893e87c" },
      chair: { system: "a8ca001a696b42db", user: "63b18f2b589c8261", schema: "058b2bacd84d7d28" },
    };
    const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
    for (const role of ROLES) {
      const { system, user } = buildPrompt(role, { profile: { a: 1 } as never });
      expect({ system: sha(system), user: sha(user), schema: sha(JSON.stringify(RESPONSE_SCHEMAS[role])) }).toEqual(BEFORE[role]);
    }
  });

  it("nests a reply the same way whether or not the offer argument is given", () => {
    const reply = { stance: "s", parameters: flat() };
    expect(nestReply("optimist", reply, false)).toEqual(nestReply("optimist", reply));
    expect(nestReply("optimist", reply)).not.toHaveProperty("offerJudgement");
    expect(Object.keys(nestReply("chair", { summary: "s", parameters: flat({ leans: "between" }), responses: [] }) as object)).toEqual(["summary", "responses", "decision"]);
  });
});
