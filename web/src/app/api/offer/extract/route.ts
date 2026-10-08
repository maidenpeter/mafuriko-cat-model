// Relative paths, not the "@/" alias: the tests call this handler directly, and they run without the alias.
import { generateJson, keyFor, keySettings, modelName } from "../../../../lib/agents/provider";
import { buildOfferPrompt, OFFER_RESPONSE_SCHEMA, offerReplySchema } from "../../../../lib/offer/extraction";
import { redact } from "../../../../lib/offer/redact";
import { OFFER_MAX_CHARS, type OfferExtractFailure, type OfferExtractResponse } from "../../../../lib/offer/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Reads an offer with the hosted model and returns its flat reply, unchecked: the browser
 * checks every value against the text that was sent.
 *
 * The document is never written to the server's log and never echoed in an error. The only
 * line logged is the provider's own, which carries the label, the time and the token counts.
 */

const STATUS: Record<OfferExtractFailure, number> = { no_key: 503, bad_request: 400, provider: 502, bad_reply: 422 };

const respond = (body: OfferExtractResponse) => Response.json(body, { status: body.ok ? 200 : STATUS[body.code] });

/** Models sometimes wrap JSON in a code fence even when asked not to. */
function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(trimmed);
}

export async function POST(req: Request) {
  // The offer is read with the key of the agent that settles the assumptions; no fifth key is needed.
  const apiKey = keyFor("chair");
  if (!apiKey) return respond({ ok: false, code: "no_key", error: `No API key is set for the model. Set ${keySettings("chair")} in web/.env.local. Nothing was sent.` });

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) return respond({ ok: false, code: "bad_request", error: "There is no text to read. Nothing was sent." });
  if (text.length > OFFER_MAX_CHARS) {
    return respond({
      ok: false,
      code: "bad_request",
      error: `The text is ${text.length.toLocaleString("en-GB")} characters long and the most that can be sent is ${OFFER_MAX_CHARS.toLocaleString("en-GB")}. Nothing was sent.`,
    });
  }

  // The browser has already taken contact details out. This second pass is a guard, and changes nothing when it has.
  const documentText = redact(text).text;
  const prompt = buildOfferPrompt(documentText);
  const started = Date.now();
  let problem = "";

  try {
    let user = prompt.user;
    // One retry with the validation problem fed back, then give up and let the browser fall back to the rules.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text: raw, usage } = await generateJson(apiKey, prompt.system, user, OFFER_RESPONSE_SCHEMA, "offer");
      try {
        const parsed = offerReplySchema.safeParse(parseJson(raw));
        if (parsed.success) return respond({ ok: true, model: modelName(), ms: Date.now() - started, attempts: attempt, usage, prompt, documentText, reply: parsed.data });
        // Paths and messages only: an issue never carries the text of the reply.
        problem = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } catch {
        // The parser's own message can quote a piece of the reply, and the reply quotes the document, so it is not passed on.
        // "MAX_TOKENS" is Gemini's name for running out of room, "length" is OpenAI's.
        problem = usage.finishReason === "MAX_TOKENS" || usage.finishReason === "length" ? "the reply hit the output limit before it was complete" : "the reply was not valid JSON";
      }
      user = `${prompt.user}\n\nYour previous reply was rejected: ${problem}. Reply again with the complete JSON object in exactly the requested shape.`;
    }
    return respond({ ok: false, code: "bad_reply", error: `The model's reply did not match the required shape: ${problem}`, model: modelName(), ms: Date.now() - started });
  } catch (e) {
    return respond({ ok: false, code: "provider", error: (e as Error).message, model: modelName(), ms: Date.now() - started });
  }
}
