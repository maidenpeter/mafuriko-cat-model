import { NextResponse } from "next/server";
import { generateJson, keyFor, modelName } from "@/lib/agents/gemini";
import { buildPrompt, type AgentRequest } from "@/lib/agents/prompts";
import { RESPONSE_SCHEMAS } from "@/lib/agents/responseSchema";
import { nestReply, ROLES, SCHEMAS, type Role } from "@/lib/agents/schema";

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
  if (!apiKey) return NextResponse.json({ ok: false, error: `No API key configured for the ${role} agent. Set GEMINI_API_KEY_${role.toUpperCase()} or GEMINI_API_KEY in web/.env.local.` }, { status: 503 });

  const request = (await req.json()) as AgentRequest;
  const prompt = buildPrompt(role, request);
  const started = Date.now();
  const attempts: { raw: string; problem: string | null }[] = [];

  try {
    let user = prompt.user;
    // One retry with the validation error fed back, then give up and let the walkthrough fall back.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text: raw, usage } = await generateJson(apiKey, prompt.system, user, RESPONSE_SCHEMAS[role], role);
      let problem: string | null = null;
      try {
        const parsed = SCHEMAS[role].safeParse(nestReply(role, parseJson(raw)));
        if (parsed.success) {
          attempts.push({ raw, problem: null });
          return NextResponse.json({ ok: true, role, model: modelName(), ms: Date.now() - started, prompt, raw, usage, attempts: attempts.length, output: parsed.data });
        }
        problem = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } catch (e) {
        problem = usage.finishReason === "MAX_TOKENS" ? "the reply hit the output limit before it was complete" : `not valid JSON (${(e as Error).message})`;
      }
      attempts.push({ raw, problem });
      user = `${prompt.user}\n\nYour previous reply was rejected: ${problem}. Reply again with the complete JSON object in exactly the requested shape.`;
    }
    return NextResponse.json({ ok: false, role, model: modelName(), ms: Date.now() - started, prompt, attempts, error: `Reply did not match the required shape: ${attempts[attempts.length - 1].problem}` }, { status: 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, role, model: modelName(), ms: Date.now() - started, prompt, attempts, error: (e as Error).message }, { status: 502 });
  }
}
