import type { ProviderName } from "./provider";
import { ROLE_LABELS, type Role } from "./schema";

/**
 * What each agent used: model name, input tokens, output tokens, thinking tokens and seconds,
 * with totals, and a cost in US dollars only when prices have been set.
 *
 * There is no price anywhere in this code. A cost is shown only when BOTH
 *   <PROVIDER>_PRICE_IN_PER_M   US dollars per million input tokens
 *   <PROVIDER>_PRICE_OUT_PER_M  US dollars per million output tokens
 * are set in web/.env.local (OPENAI_... or GEMINI_...). Otherwise every cost is null and the
 * screen shows the token counts alone.
 *
 * How to use it on the Audit step:
 *
 *   const rows = usageRows(deliberation.runs);      // one per agent, in the order given
 *   const totals = usageTotals(rows);
 *   costOf(rows[0], prices), costOf(totals, prices) // null when prices is null
 *   fmtUsd(cost)                                     // "USD 0.0123", or "n/a" for null
 *
 * To include the offer reader, add it as one more run:
 *   usageRows([...Object.values(deliberation.runs), { role: "reader", label: "Offer reader", model: run.model, ms: run.ms, usage: run.usage }])
 *
 * NOTE FOR WHOEVER WIRES THIS IN: how the prices reach the screen.
 * The settings are read on the server, never in the browser (they have no NEXT_PUBLIC_ prefix,
 * and should not get one). Add one field to the reply of GET /api/agents/status:
 *
 *   prices: pricesFromEnv(process.env, providerName())
 *
 * That route already reports the provider and the model without returning any key, and a price
 * is not a secret. The screen fetches the route as it does today, keeps `prices` (an object or
 * null) and hands it to costOf. Nothing else about the keys or the environment is exposed.
 * Save `prices` in the run record next to the usage, so a replayed run shows the cost it had
 * when it ran and not one worked out from whatever is set later. Add the four settings to
 * .env.example with empty values.
 *
 * Three things the figures do not cover, to say on screen where they apply:
 *   - An agent that failed reports no usage, though it may have used tokens. usageTotals counts
 *     these as `unreported`.
 *   - When an agent's first reply was rejected and it was asked again (attempts of 2), the route
 *     returns the usage of the last call only, so that agent's tokens are understated. Its
 *     seconds cover both calls. usageTotals counts these as `retried`.
 *   - Round 1 runs three agents at once, so the total of seconds is time worked, not time waited.
 */

/** The least a run has to carry. AgentRun fits as it is. */
export interface UsageSource {
  /** An agent's role, or any other short name for a call that is not one of the four agents. */
  role: string;
  /** Used when the role is not one of the four agents. */
  label?: string;
  model?: string | null;
  /** How long the call took, in milliseconds. */
  ms?: number | null;
  attempts?: number | null;
  usage?: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number } | null;
}

/** One agent's usage. A count of null means the agent did not report it. It is never a stand-in for zero. */
export interface UsageRow {
  role: string;
  label: string;
  model: string | null;
  inputTokens: number | null;
  /** Tokens of the written reply, thinking not included: both providers are stored that way. */
  outputTokens: number | null;
  thinkingTokens: number | null;
  seconds: number | null;
  /** How many times the agent was asked. null when not known. */
  attempts: number | null;
}

export interface UsageTotals {
  /** How many rows were added up. */
  agents: number;
  /** How many of them reported at least one token count. */
  reported: number;
  /** How many reported nothing, so their tokens are missing from the totals. */
  unreported: number;
  /** How many were asked more than once, so their tokens are understated. */
  retried: number;
  /** Every model named, without repeats, in the order first seen. */
  models: string[];
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** The agents' seconds added together. Agents that ran side by side are each counted in full. */
  seconds: number;
}

/** US dollars per million tokens. */
export interface Prices {
  inPerM: number;
  outPerM: number;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

const hasCounts = (row: Pick<UsageRow, "inputTokens" | "outputTokens" | "thinkingTokens">) => row.inputTokens !== null || row.outputTokens !== null || row.thinkingTokens !== null;

/** One row per run, in the order given. Takes a list, or the `runs` object of a deliberation. */
export function usageRows(runs: readonly UsageSource[] | Readonly<Record<string, UsageSource>>): UsageRow[] {
  const list: readonly UsageSource[] = Array.isArray(runs) ? runs : Object.values(runs);
  return list.map((run) => {
    const ms = count(run.ms);
    return {
      role: run.role,
      label: ROLE_LABELS[run.role as Role] ?? run.label ?? run.role,
      model: run.model?.trim() || null,
      inputTokens: count(run.usage?.promptTokens),
      outputTokens: count(run.usage?.outputTokens),
      thinkingTokens: count(run.usage?.thinkingTokens),
      seconds: ms === null ? null : ms / 1000,
      attempts: count(run.attempts),
    };
  });
}

export function usageTotals(rows: readonly UsageRow[]): UsageTotals {
  const totals: UsageTotals = { agents: rows.length, reported: 0, unreported: 0, retried: 0, models: [], inputTokens: 0, outputTokens: 0, thinkingTokens: 0, seconds: 0 };
  for (const row of rows) {
    if (hasCounts(row)) totals.reported += 1;
    else totals.unreported += 1;
    if ((row.attempts ?? 1) > 1) totals.retried += 1;
    if (row.model && !totals.models.includes(row.model)) totals.models.push(row.model);
    totals.inputTokens += row.inputTokens ?? 0;
    totals.outputTokens += row.outputTokens ?? 0;
    totals.thinkingTokens += row.thinkingTokens ?? 0;
    totals.seconds += row.seconds ?? 0;
  }
  return totals;
}

/** A setting as a price: plain digits, above zero. Anything else is "not set". */
function price(text: string | undefined): number | null {
  const trimmed = text?.trim() ?? "";
  if (!/^\d*\.?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The prices set for this provider, or null unless both are set to a number above zero.
 * There is no default: one price without the other gives null, not half a cost.
 * Server only. Pass process.env.
 */
export function pricesFromEnv(env: Readonly<Record<string, string | undefined>>, provider: ProviderName | string): Prices | null {
  const prefix = provider.trim().toUpperCase();
  if (!prefix) return null;
  const inPerM = price(env[`${prefix}_PRICE_IN_PER_M`]);
  const outPerM = price(env[`${prefix}_PRICE_OUT_PER_M`]);
  return inPerM !== null && outPerM !== null ? { inPerM, outPerM } : null;
}

/**
 * The cost of one row, or of the totals, in US dollars:
 *
 *   (input tokens × inPerM + (output tokens + thinking tokens) × outPerM) ÷ 1,000,000
 *
 * Thinking is billed at the output price by both providers, and is held apart from the output
 * count here, so the two are added. null when no prices are set, and null when nothing was
 * reported: an agent that reported no tokens has an unknown cost, not a cost of zero.
 */
export function costOf(item: Pick<UsageRow, "inputTokens" | "outputTokens" | "thinkingTokens"> | UsageTotals, prices: Prices | null | undefined): number | null {
  if (!prices) return null;
  if ("reported" in item ? item.reported === 0 : !hasCounts(item)) return null;
  return ((item.inputTokens ?? 0) * prices.inPerM + ((item.outputTokens ?? 0) + (item.thinkingTokens ?? 0)) * prices.outPerM) / 1e6;
}

/** USD 12.35, USD 0.0123, under USD 0.0001. A run costs cents or less, so small amounts keep four decimals. "n/a" for null. */
export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs === 0) return "USD 0.00";
  if (abs < 0.00005) return "under USD 0.0001";
  if (abs < 1) return `USD ${value.toFixed(4)}`;
  return `USD ${value.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
