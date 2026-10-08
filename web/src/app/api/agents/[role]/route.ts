import { NextResponse } from "next/server";
// Relative paths, not the "@/" alias: the tests call this handler directly, and they run without the alias.
import { readOfferBrief } from "../../../../lib/agents/offerBrief";
import { buildPrompt, type AgentRequest } from "../../../../lib/agents/prompts";
import { generateJson, keyFor, keySettings, modelName } from "../../../../lib/agents/provider";
import { responseSchemaFor } from "../../../../lib/agents/responseSchema";
import { issueName, nestReply, ROLES, schemaFor, type Role } from "../../../../lib/agents/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Models sometimes wrap JSON in a code fence even when asked not to. */
function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(trimmed);
}

export async function POST(req: Request, { params }: { params: Promise<{ role: string }> }) {
  const { role: roleParam } = await params;
  if (!(ROLES as readonly string[]).includes(roleParam)) return NextResponse.json({ ok: false, error: `Unknown agent "${roleParam}"` }, { status: 404 });
  const role = roleParam as Role;

  const apiKey = keyFor(role);
  if (!apiKey) return NextResponse.json({ ok: false, error: `No API key configured for the ${role} agent. Set ${keySettings(role)} in web/.env.local.` }, { status: 503 });

  const body = (await req.json()) as AgentRequest;
  // With an offer loaded the agents also argue the figures behind its loss drivers. Only the plain
  // facts of the brief and its few short quotes go into the prompt; anything else sent with it is
  // dropped here, so no other text of the document reaches a prompt or a log.
  const offer = readOfferBrief(body.offer);
  const hasOffer = offer !== null;
  // The basis is one known word or nothing: buildPrompt turns it into a sentence of its own.
  const lossBasis = body.lossBasis === "all_drivers" ? body.lossBasis : undefined;
  const prompt = buildPrompt(role, { profile: body.profile, chair: body.chair, offer, lossBasis });
  const enforced = responseSchemaFor(role, hasOffer);
  const expected = schemaFor(role, hasOffer);
  const started = Date.now();
  const attempts: { raw: string; problem: string | null }[] = [];

  try {
    let user = prompt.user;
    // One retry with the validation error fed back, then give up and let the walkthrough fall back.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text: raw, usage } = await generateJson(apiKey, prompt.system, user, enforced, role);
      let problem: string | null = null;
      try {
        const parsed = expected.safeParse(nestReply(role, parseJson(raw), hasOffer));
        if (parsed.success) {
          attempts.push({ raw, problem: null });
          return NextResponse.json({ ok: true, role, model: modelName(), ms: Date.now() - started, prompt, raw, usage, attempts: attempts.length, output: parsed.data });
        }
        problem = parsed.error.issues.slice(0, 6).map((i) => `${issueName(i.path)}: ${i.message}`).join("; ");
      } catch (e) {
        // "MAX_TOKENS" is Gemini's name for running out of room, "length" is OpenAI's.
        problem = usage.finishReason === "MAX_TOKENS" || usage.finishReason === "length" ? "the reply hit the output limit before it was complete" : `not valid JSON (${(e as Error).message})`;
      }
      attempts.push({ raw, problem });
      user = `${prompt.user}\n\nYour previous reply was rejected: ${problem}. Reply again with the complete JSON object in exactly the requested shape.`;
    }
    return NextResponse.json({ ok: false, role, model: modelName(), ms: Date.now() - started, prompt, attempts, error: `Reply did not match the required shape: ${attempts[attempts.length - 1].problem}` }, { status: 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, role, model: modelName(), ms: Date.now() - started, prompt, attempts, error: (e as Error).message }, { status: 502 });
  }
}
