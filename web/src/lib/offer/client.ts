import { fromFlatReply, offerReplySchema } from "./extraction";
import { redact } from "./redact";
import { extractByRules } from "./rules";
import type { ExtractOffer, ExtractionRun, OfferExtractRequest, OfferExtractResponse } from "./types";
import { verifyExtraction } from "./verify";

/**
 * What the screen calls to read an offer. Contact details are taken out here, in the browser,
 * before anything is posted. The hosted model reads the text when a key is set; in every other
 * case the fixed rules read it, and the reason is kept so the screen can say which and why.
 * Either way, code then checks every value against the text that was read.
 */

const ROUTE = "/api/offer/extract";

/** True when the reply names any value at all. A model that found nothing is no better than the rules. */
const saysSomething = (entries: { value: string; quote: string }[]) => entries.some((e) => e.value.trim() || e.quote.trim());

export const extractOffer: ExtractOffer = async (text, options = {}) => {
  const { text: documentText, removed } = redact(text);

  const byRules = (fallbackReason: string, sentToModel: boolean, call: Partial<Pick<ExtractionRun, "prompt" | "model" | "usage" | "ms" | "replyJson">> = {}): ExtractionRun => ({
    extraction: verifyExtraction(extractByRules(documentText, options.knownPlaces), documentText),
    documentText,
    removed,
    path: "rules",
    fallbackReason,
    sentToModel,
    prompt: null,
    model: null,
    usage: null,
    ms: null,
    replyJson: null,
    ...call,
  });

  if (options.rulesOnly) return byRules("The fixed rules were chosen, so nothing was sent to the model.", false);
  if (!documentText.trim()) return byRules("There is no text to read.", false);

  let body: OfferExtractResponse;
  try {
    const request: OfferExtractRequest = { text: documentText };
    const res = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: options.signal });
    body = (await res.json()) as OfferExtractResponse;
    if (typeof body?.ok !== "boolean") throw new Error(`the server answered ${res.status} with something other than a result`);
  } catch (e) {
    // It cannot be known how far the request got, so the cautious reading is that the text was sent.
    return byRules(`The model could not be reached (${(e as Error).message}), so the fixed rules read the text.`, true);
  }

  if (!body.ok) {
    const call = { model: body.model ?? null, ms: body.ms ?? null };
    if (body.code === "no_key") return byRules(`${body.error} The fixed rules read the text instead.`, false, call);
    if (body.code === "bad_request") return byRules(`${body.error} The fixed rules read the text instead.`, false, call);
    if (body.code === "bad_reply") return byRules(`${body.error}. It was not used, and the fixed rules read the text instead.`, true, call);
    return byRules(`The call to the model failed: ${body.error}. The fixed rules read the text instead.`, true, call);
  }

  // The reply is kept as text for the audit trail, whether or not it turns out to be usable.
  const call = { prompt: body.prompt, model: body.model, usage: body.usage, ms: body.ms, replyJson: body.reply === undefined ? null : JSON.stringify(body.reply, null, 1) };
  // The route has checked the shape already. Checking again here costs nothing and means a
  // changed route can never hand the screen something it cannot draw.
  const reply = offerReplySchema.safeParse(body.reply);
  if (!reply.success) return byRules("The model's reply was not in the required shape. It was not used, and the fixed rules read the text instead.", true, call);
  if (!saysSomething(reply.data.entries)) return byRules("The model found nothing to list in this text, so the fixed rules read it instead.", true, call);

  // The quotes are checked against the text the route says it sent, which is this text unless the route's own pass removed more.
  return {
    extraction: verifyExtraction(fromFlatReply(reply.data), body.documentText),
    documentText: body.documentText,
    removed,
    path: "model",
    fallbackReason: null,
    sentToModel: true,
    ...call,
  };
};
