import type { Check } from "../checks";
import { BOUNDS, enforceBounds, flattenParams, type Adjustment } from "../model/params";
import { resultFingerprint, runModel } from "../model/pipeline";
import type { Dataset, ModelParams, ModelResult } from "../model/types";
import { outcomeSummary, type DataProfile } from "./profile";
import type { AgentRequest, ChairContext } from "./prompts";
import { reasonAt, toParams, type AgentOutput, type Critique, type Decision, type Proposal, type Role } from "./schema";

export type AgentStatus = "idle" | "running" | "done" | "error";

export interface AgentRun<R extends Role = Role> {
  role: R;
  status: AgentStatus;
  model?: string;
  ms?: number;
  attempts?: number;
  usage?: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number; finishReason?: string; firstTextS?: number; padded?: boolean };
  prompt?: { system: string; user: string };
  raw?: string;
  output?: AgentOutput[R];
  error?: string;
}

export interface Scored {
  /** Parameters after the allowed ranges were enforced. */
  params: ModelParams;
  adjustments: Adjustment[];
  result: ModelResult;
}

export interface Deliberation {
  startedAt: string;
  datasetName: string;
  profile: DataProfile;
  runs: { optimist: AgentRun<"optimist">; cautious: AgentRun<"cautious">; critic: AgentRun<"critic">; chair: AgentRun<"chair"> };
  optimist: Scored | null;
  cautious: Scored | null;
  final: Scored | null;
  /** Fingerprint of the final result, so a replay can prove it reproduces. */
  fingerprint: string | null;
}

async function callAgent<R extends Role>(role: R, request: AgentRequest): Promise<AgentRun<R>> {
  try {
    const res = await fetch(`/api/agents/${role}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    const body = await res.json();
    if (body.ok) return { role, status: "done", model: body.model, ms: body.ms, attempts: body.attempts, usage: body.usage, prompt: body.prompt, raw: body.raw, output: body.output };
    return { role, status: "error", model: body.model, ms: body.ms, prompt: body.prompt, error: body.error ?? `Request failed (${res.status})` };
  } catch (e) {
    return { role, status: "error", error: (e as Error).message };
  }
}

function score(dataset: Dataset, proposed: ModelParams): Scored {
  const { params, adjustments } = enforceBounds(proposed);
  return { params, adjustments, result: runModel(dataset, params) };
}

/**
 * Round 1: Optimist, Cautious and Critic in parallel. Code then runs the engine
 * on both proposals. Round 2: the Chair settles the final set. Code runs it.
 */
export async function deliberate(dataset: Dataset, profile: DataProfile, onUpdate: (d: Deliberation) => void): Promise<Deliberation> {
  const d: Deliberation = {
    startedAt: new Date().toISOString(),
    datasetName: dataset.name,
    profile,
    runs: {
      optimist: { role: "optimist", status: "running" },
      cautious: { role: "cautious", status: "running" },
      critic: { role: "critic", status: "running" },
      chair: { role: "chair", status: "idle" },
    },
    optimist: null,
    cautious: null,
    final: null,
    fingerprint: null,
  };
  const emit = () => onUpdate({ ...d, runs: { ...d.runs } });
  emit();

  await Promise.all([
    callAgent("optimist", { profile }).then((run) => {
      d.runs.optimist = run;
      if (run.output) d.optimist = score(dataset, toParams(run.output));
      emit();
    }),
    callAgent("cautious", { profile }).then((run) => {
      d.runs.cautious = run;
      if (run.output) d.cautious = score(dataset, toParams(run.output));
      emit();
    }),
    callAgent("critic", { profile }).then((run) => {
      d.runs.critic = run;
      emit();
    }),
  ]);

  // The Chair needs at least one proposal to decide between.
  if (!d.optimist && !d.cautious) {
    d.runs.chair = { role: "chair", status: "error", error: "Neither proposal arrived, so there was nothing to decide." };
    emit();
    return d;
  }

  const side = (proposal: Proposal | undefined, scored: Scored | null) =>
    proposal && scored ? { proposal, applied: scored.params, outcome: outcomeSummary(scored.result) } : null;
  const chair: ChairContext = {
    optimist: side(d.runs.optimist.output, d.optimist),
    cautious: side(d.runs.cautious.output, d.cautious),
    critique: d.runs.critic.output ?? null,
  };

  d.runs.chair = { role: "chair", status: "running" };
  emit();
  d.runs.chair = await callAgent("chair", { profile, chair });
  if (d.runs.chair.output) {
    d.final = score(dataset, toParams(d.runs.chair.output.decision));
    d.fingerprint = resultFingerprint(d.final.result);
  }
  emit();
  return d;
}

/** Re-score a saved deliberation against the current data, without calling any model. */
export function replay(dataset: Dataset, saved: Deliberation): Deliberation {
  const rescore = (proposal: { depthScaleM: unknown } | undefined) => (proposal ? score(dataset, toParams(proposal as Proposal)) : null);
  return {
    ...saved,
    optimist: rescore(saved.runs.optimist.output),
    cautious: rescore(saved.runs.cautious.output),
    final: rescore(saved.runs.chair.output?.decision),
  };
}

export interface LedgerRow {
  path: string;
  reference: number;
  optimist: number | null;
  cautious: number | null;
  final: number;
  reason: string;
  basis: string;
  leans: string;
  adjusted: boolean;
}

/** One row per parameter: every value side by side, and the Chair's reason for the final one. */
export function buildLedger(reference: ModelParams, d: Deliberation): LedgerRow[] {
  if (!d.final) return [];
  const decision = d.runs.chair.output?.decision;
  const optimist = d.optimist ? new Map(flattenParams(d.optimist.params).map((p) => [p.path, p.value])) : null;
  const cautious = d.cautious ? new Map(flattenParams(d.cautious.params).map((p) => [p.path, p.value])) : null;
  const ref = new Map(flattenParams(reference).map((p) => [p.path, p.value]));
  return flattenParams(d.final.params).map(({ path, value }) => {
    const r = reasonAt<Decision["decision"]["depthScaleM"]>(decision, path);
    return {
      path,
      reference: ref.get(path)!,
      optimist: optimist?.get(path) ?? null,
      cautious: cautious?.get(path) ?? null,
      final: value,
      reason: r?.reason ?? "",
      basis: r?.basis ?? "judgement",
      leans: r?.leans ?? "between",
      adjusted: d.final!.adjustments.some((a) => a.path === path),
    };
  });
}

export function aiChecks(dataset: Dataset, d: Deliberation): Check[] {
  const g = "ai" as const;
  const out: Check[] = [];
  const runs = Object.values(d.runs) as AgentRun[];
  const ok = runs.filter((r) => r.status === "done");
  out.push({
    group: g, id: "schema", title: "Every agent reply matches the required shape",
    status: ok.length === runs.length ? "pass" : ok.length > 0 ? "warn" : "fail",
    detail: runs.map((r) => `${r.role}: ${r.status === "done" ? `valid${(r.attempts ?? 1) > 1 ? " on retry" : ""}` : r.error ?? r.status}`).join(" · "),
  });

  const adjustments = [d.optimist, d.cautious, d.final].flatMap((s) => s?.adjustments ?? []);
  out.push({
    group: g, id: "ranges", title: "Every parameter is inside its allowed range",
    status: adjustments.length === 0 ? "pass" : "warn",
    detail: adjustments.length === 0
      ? `Depth scale ${BOUNDS.depthScaleM.min}–${BOUNDS.depthScaleM.max} m, fragility ${BOUNDS.fragility.min}–${BOUNDS.fragility.max}, cap ${BOUNDS.cap.min}–${BOUNDS.cap.max}, return periods ${BOUNDS.returnPeriod.min}–${BOUNDS.returnPeriod.max} years and rising.`
      : `${adjustments.length} value(s) were corrected by code: ${adjustments.slice(0, 3).map((a) => `${a.path} ${a.from} → ${a.to} (${a.reason})`).join("; ")}`,
  });

  const sets: [string, unknown][] = [["optimist", d.runs.optimist.output], ["cautious", d.runs.cautious.output], ["chair", d.runs.chair.output?.decision]];
  let missing = 0;
  let counted = 0;
  for (const [, set] of sets) {
    if (!set) continue;
    for (const { path } of flattenParams(d.final?.params ?? d.optimist?.params ?? d.cautious!.params)) {
      counted += 1;
      if (!reasonAt<Proposal["depthScaleM"]>(set, path)?.reason?.trim()) missing += 1;
    }
  }
  out.push({ group: g, id: "reasons", title: "Every parameter has a reason", status: missing === 0 && counted > 0 ? "pass" : "fail", detail: `${counted - missing} of ${counted} proposed values carry a written reason.` });

  const challenges: Critique["challenges"] = d.runs.critic.output?.challenges ?? [];
  const answered = new Set((d.runs.chair.output?.responses ?? []).map((r) => r.challengeId));
  const unanswered = challenges.filter((c) => !answered.has(c.id));
  if (challenges.length > 0 && d.runs.chair.output) {
    out.push({
      group: g, id: "challenges", title: "The Chair answered every challenge from the Critic",
      status: unanswered.length === 0 ? "pass" : "warn",
      detail: unanswered.length === 0 ? `${challenges.length} challenges raised, ${challenges.length} answered.` : `Unanswered: ${unanswered.map((c) => c.id).join(", ")}.`,
    });
  }

  if (d.final) {
    const again = resultFingerprint(runModel(dataset, d.final.params));
    out.push({
      group: g, id: "reproducible", title: "Re-running the engine on the saved parameters gives the same result",
      status: again === d.fingerprint ? "pass" : "fail",
      detail: `Result fingerprint ${again}${again === d.fingerprint ? " on both runs." : `, expected ${d.fingerprint}.`}`,
    });
  }
  return out;
}
