import { NextResponse } from "next/server";
import { keyFor, modelName } from "@/lib/agents/gemini";
import { ROLES } from "@/lib/agents/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which agents have a key. Never returns the keys themselves. */
export async function GET() {
  return NextResponse.json({
    model: modelName(),
    configured: Object.fromEntries(ROLES.map((r) => [r, keyFor(r) !== null])),
  });
}
