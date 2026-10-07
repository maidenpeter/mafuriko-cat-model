import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/lib/agents/prompts";
import { RESPONSE_SCHEMAS } from "../src/lib/agents/responseSchema";
import { decisionSchema, nestReply, PARAMETER_NAMES, proposalSchema, toParams } from "../src/lib/agents/schema";
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
});
