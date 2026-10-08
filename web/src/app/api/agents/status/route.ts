import { NextResponse } from "next/server";
import { keyFor, modelName, providerName } from "@/lib/agents/provider";
import { ROLES } from "@/lib/agents/schema";
import { pricesFromEnv } from "@/lib/agents/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which service and model run the agents, which agents have a key, and the token prices when both
 * are set for that service (OPENAI_PRICE_IN_PER_M and OPENAI_PRICE_OUT_PER_M, or the GEMINI_ ones).
 * prices is null unless both are set: there is no default price anywhere. Never returns a key.
 */
export async function GET() {
  const provider = providerName();
  return NextResponse.json({
    provider,
    model: modelName(),
    configured: Object.fromEntries(ROLES.map((r) => [r, keyFor(r) !== null])),
    prices: pricesFromEnv(process.env, provider),
  });
}
