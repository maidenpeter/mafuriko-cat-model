import { NextResponse } from "next/server";
import { keyFor, modelName, providerName } from "@/lib/agents/provider";
import { ROLES } from "@/lib/agents/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which service and model run the agents, and which agents have a key. Never returns the keys themselves. */
export async function GET() {
  return NextResponse.json({
    provider: providerName(),
    model: modelName(),
    configured: Object.fromEntries(ROLES.map((r) => [r, keyFor(r) !== null])),
  });
}
