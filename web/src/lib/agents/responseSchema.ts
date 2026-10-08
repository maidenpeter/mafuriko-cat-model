import { BASES, PARAMETER_NAMES, type Role } from "./schema";

/**
 * The reply shapes in the form the Gemini API enforces while it generates, so
 * a reply ends when its object closes. openai.ts turns the same shapes into the
 * form OpenAI enforces.
 *
 * They are deliberately shallow: a list of flat entries, one per parameter.
 * A nested shape (an object per parameter, grouped by class and tier) was
 * accepted by the API but never started producing text. The route turns the
 * flat list back into the nested form that the Zod schemas validate.
 */
type Schema = Record<string, unknown>;

const text: Schema = { type: "STRING" };
const object = (properties: Record<string, Schema>): Schema => ({
  type: "OBJECT",
  properties,
  required: Object.keys(properties),
  propertyOrdering: Object.keys(properties),
});
const list = (items: Schema, limits: Schema = {}): Schema => ({ type: "ARRAY", items, ...limits });
const oneOf = (values: readonly string[]): Schema => ({ type: "STRING", enum: [...values] });

const every = { minItems: PARAMETER_NAMES.length, maxItems: PARAMETER_NAMES.length };
// The reason is written before the value, so the number follows from the argument.
const proposed = object({ name: oneOf(PARAMETER_NAMES), reason: text, basis: oneOf(BASES), value: { type: "NUMBER" } });
const decided = object({ name: oneOf(PARAMETER_NAMES), reason: text, basis: oneOf(BASES), leans: oneOf(["optimist", "cautious", "between", "outside"]), value: { type: "NUMBER" } });

const proposal = object({ stance: text, parameters: list(proposed, every) });

export const RESPONSE_SCHEMAS: Record<Role, Schema> = {
  optimist: proposal,
  cautious: proposal,
  critic: object({
    summary: text,
    challenges: list(
      object({ id: text, title: text, detail: text, severity: oneOf(["high", "medium", "low"]), affects: list(text), recommendation: text }),
      { minItems: 3, maxItems: 6 },
    ),
  }),
  chair: object({
    summary: text,
    parameters: list(decided, every),
    responses: list(object({ challengeId: text, verdict: oneOf(["accepted", "partly", "rejected"]), response: text })),
  }),
};
