import { basesFor, parameterNames, type Role } from "./schema";

/**
 * The reply shapes in the form the Gemini API enforces while it generates, so
 * a reply ends when its object closes. openai.ts turns the same shapes into the
 * form OpenAI enforces.
 *
 * They are deliberately shallow: a list of flat entries, one per parameter.
 * A nested shape (an object per parameter, grouped by class and tier) was
 * accepted by the API but never started producing text. The route turns the
 * flat list back into the nested form that the Zod schemas validate.
 *
 * With an offer loaded the same flat list is longer: the figures behind the offer's
 * loss drivers that the agents argue follow the model's parameters, one entry each,
 * and nothing is nested any deeper. A ladder is five entries, not a list inside one.
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

/** How many challenges the Critic raises. An offer gives it more to challenge. */
export const challengeLimits = (hasOffer: boolean) => (hasOffer ? { minItems: 4, maxItems: 8 } : { minItems: 3, maxItems: 6 });

function build(hasOffer: boolean): Record<Role, Schema> {
  const names = parameterNames(hasOffer);
  const bases = basesFor(hasOffer);
  const every = { minItems: names.length, maxItems: names.length };
  // The reason is written before the value, so the number follows from the argument.
  const proposed = object({ name: oneOf(names), reason: text, basis: oneOf(bases), value: { type: "NUMBER" } });
  const decided = object({ name: oneOf(names), reason: text, basis: oneOf(bases), leans: oneOf(["optimist", "cautious", "between", "outside"]), value: { type: "NUMBER" } });
  const proposal = object({ stance: text, parameters: list(proposed, every) });
  return {
    optimist: proposal,
    cautious: proposal,
    critic: object({
      summary: text,
      challenges: list(
        object({ id: text, title: text, detail: text, severity: oneOf(["high", "medium", "low"]), affects: list(text), recommendation: text }),
        challengeLimits(hasOffer),
      ),
    }),
    chair: object({
      summary: text,
      parameters: list(decided, every),
      responses: list(object({ challengeId: text, verdict: oneOf(["accepted", "partly", "rejected"]), response: text })),
    }),
  };
}

/** The shapes with no offer loaded: the model's own parameters and nothing else. */
export const RESPONSE_SCHEMAS: Record<Role, Schema> = build(false);

const OFFER_RESPONSE_SCHEMAS: Record<Role, Schema> = build(true);

/** The shape enforced for this request: the longer list when an offer is loaded. */
export const responseSchemaFor = (role: Role, hasOffer: boolean): Schema => (hasOffer ? OFFER_RESPONSE_SCHEMAS : RESPONSE_SCHEMAS)[role];
