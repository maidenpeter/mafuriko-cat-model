import type { Check } from "../checks";
import { BOUNDS, enforceBounds, flattenParams, type Adjustment } from "../model/params";
import { resultFingerprint, runModel } from "../model/pipeline";
import type { Dataset, ModelParams, ModelResult } from "../model/types";
import { enforceJudgement, JUDGEMENT_BOUNDS, JUDGEMENT_KEYS, JUDGEMENT_LABELS, REFERENCE_JUDGEMENT, type JudgementAdjustment, type OfferJudgement } from "../offer/judgement";
import type { OfferBrief } from "./offerBrief";
import { outcomeSummary, type DataProfile } from "./profile";
import type { AgentRequest, ChairContext, ChairSide } from "./prompts";
import { reasonAt, toJudgement, toParams, type AgentOutput, type Critique, type Decision, type JudgementDecision, type JudgementProposal, type Proposal, type Role } from "./schema";

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

/** One of the offer's five figures that code moved back into its range, and whose figure it was. */
export interface RoleJudgementAdjustment extends JudgementAdjustment {
  role: "optimist" | "cautious" | "chair";
}

/**
 * What the agents settled about the offer: its five judgement figures (see offer/judgement.ts).
 * Every set here has been through enforceJudgement, so each figure is inside its range.
 */
export interface OfferDeliberation {
  /** The Optimist's five figures. null when its reply did not arrive. */
  optimist: OfferJudgement | null;
  /** The Cautious five figures. null when its reply did not arrive. */
  cautious: OfferJudgement | null;
  /** The Chair's five figures: the agreed set. null when the Chair did not decide. */
  final: OfferJudgement | null;
  /** The Chair's reason for each figure, by key ("siteRadiusM", not "offer.siteRadiusM"). Empty when the Chair did not decide. */
  reasons: Record<string, { reason: string; basis: string; leans?: string }>;
  /** Every figure code moved back into its range, in any of the three sets. */
  adjustments: RoleJudgementAdjustment[];
  /** The facts of the offer the agents were given, so the screen can tell whether they ran with the offer now loaded. */
  brief: OfferBrief;
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
  /** There only when the agents ran with an offer loaded. A run made without one, or saved before offers were argued, has none. */
  offerJudgement?: OfferDeliberation | null;
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

/** The offer's five figures from the three replies, each kept inside its range by code, with what was moved and the Chair's reasons. */
function settleJudgement(runs: Deliberation["runs"], brief: OfferBrief): OfferDeliberation {
  const adjustments: RoleJudgementAdjustment[] = [];
  const enforce = (role: RoleJudgementAdjustment["role"], set: JudgementProposal | undefined): OfferJudgement | null => {
    if (!set) return null;
    const enforced = enforceJudgement(toJudgement(set));
    adjustments.push(...enforced.adjustments.map((a) => ({ ...a, role })));
    return enforced.judgement;
  };
  const decided: JudgementDecision | undefined = runs.chair.output?.offerJudgement;
  const optimist = enforce("optimist", runs.optimist.output?.offerJudgement);
  const cautious = enforce("cautious", runs.cautious.output?.offerJudgement);
  const final = enforce("chair", decided);
  const reasons: OfferDeliberation["reasons"] = {};
  if (decided) for (const key of JUDGEMENT_KEYS) reasons[key] = { reason: decided[key].reason, basis: decided[key].basis, leans: decided[key].leans };
  return { optimist, cautious, final, reasons, adjustments, brief };
}

/**
 * Round 1: Optimist, Cautious and Critic in parallel. Code then runs the engine
 * on both proposals. Round 2: the Chair settles the final set. Code runs it.
 *
 * With an offer loaded, pass its brief: every agent is then also given the offer's facts, the
 * proposing agents and the Chair argue its five judgement figures beside the model's parameters,
 * and the result carries them under offerJudgement. Without one nothing about the run changes.
 */
export async function deliberate(dataset: Dataset, profile: DataProfile, onUpdate: (d: Deliberation) => void, offer?: OfferBrief | null): Promise<Deliberation> {
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
  // The request is exactly as it was when no offer is loaded.
  const base: AgentRequest = offer ? { profile, offer } : { profile };
  const emit = () => {
    if (offer) d.offerJudgement = settleJudgement(d.runs, offer);
    onUpdate({ ...d, runs: { ...d.runs } });
  };
  emit();

  await Promise.all([
    callAgent("optimist", base).then((run) => {
      d.runs.optimist = run;
      if (run.output) d.optimist = score(dataset, toParams(run.output));
      emit();
    }),
    callAgent("cautious", base).then((run) => {
      d.runs.cautious = run;
      if (run.output) d.cautious = score(dataset, toParams(run.output));
      emit();
    }),
    callAgent("critic", base).then((run) => {
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

  const side = (proposal: Proposal | undefined, scored: Scored | null, judgement: OfferJudgement | null | undefined): ChairSide | null => {
    if (!proposal || !scored) return null;
    const out: ChairSide = { proposal, applied: scored.params, outcome: outcomeSummary(scored.result) };
    if (judgement) out.appliedOfferJudgement = judgement;
    return out;
  };
  const chair: ChairContext = {
    optimist: side(d.runs.optimist.output, d.optimist, d.offerJudgement?.optimist),
    cautious: side(d.runs.cautious.output, d.cautious, d.offerJudgement?.cautious),
    critique: d.runs.critic.output ?? null,
  };

  d.runs.chair = { role: "chair", status: "running" };
  emit();
  d.runs.chair = await callAgent("chair", { ...base, chair });
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
  const replayed: Deliberation = {
    ...saved,
    optimist: rescore(saved.runs.optimist.output),
    cautious: rescore(saved.runs.cautious.output),
    final: rescore(saved.runs.chair.output?.decision),
  };
  // The offer's figures are worked out again from the saved replies, like the parameters. A run saved without an offer stays without one.
  if (saved.offerJudgement) replayed.offerJudgement = settleJudgement(saved.runs, saved.offerJudgement.brief);
  return replayed;
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

export interface JudgementLedgerRow {
  /** Which of the five figures. */
  key: keyof OfferJudgement;
  /** Its plain name, with the unit. */
  label: string;
  reference: number;
  optimist: number | null;
  cautious: number | null;
  /** The Chair's figure after code kept it in range. null when the Chair did not decide. */
  agreed: number | null;
  /** The Chair's reason. "" when the Chair did not decide. */
  reason: string;
  basis: string;
  leans: string;
  /** True when code moved the agreed figure back into its range. */
  adjusted: boolean;
}

/** One row for each of the offer's five figures: every view side by side, and the Chair's reason for the agreed one. Empty when the agents ran without an offer. */
export function judgementLedger(d: Deliberation | null | undefined): JudgementLedgerRow[] {
  const j = d?.offerJudgement;
  if (!j) return [];
  return JUDGEMENT_KEYS.map((key) => ({
    key,
    label: JUDGEMENT_LABELS[key],
    reference: REFERENCE_JUDGEMENT[key],
    optimist: j.optimist?.[key] ?? null,
    cautious: j.cautious?.[key] ?? null,
    agreed: j.final?.[key] ?? null,
    reason: j.reasons[key]?.reason ?? "",
    basis: j.reasons[key]?.basis ?? "judgement",
    leans: j.reasons[key]?.leans ?? "between",
    adjusted: j.adjustments.some((a) => a.role === "chair" && a.key === key),
  }));
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
      ? `Depth scale ${BOUNDS.depthScaleM.min} to ${BOUNDS.depthScaleM.max} m, fragility ${BOUNDS.fragility.min} to ${BOUNDS.fragility.max}, cap ${BOUNDS.cap.min} to ${BOUNDS.cap.max}, return periods ${BOUNDS.returnPeriod.min} to ${BOUNDS.returnPeriod.max} years and rising.`
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

  // Only when the agents ran with an offer loaded: its five figures, checked like the parameters.
  const j = d.offerJudgement;
  if (j) {
    const argued: (JudgementProposal | undefined)[] = [d.runs.optimist.output?.offerJudgement, d.runs.cautious.output?.offerJudgement, d.runs.chair.output?.offerJudgement];
    let figures = 0;
    let unreasoned = 0;
    for (const set of argued) {
      if (!set) continue;
      for (const key of JUDGEMENT_KEYS) {
        figures += 1;
        if (!set[key]?.reason?.trim()) unreasoned += 1;
      }
    }
    const moved = j.adjustments;
    const ranges = JUDGEMENT_KEYS.map((key) => `${JUDGEMENT_LABELS[key]}: ${JUDGEMENT_BOUNDS[key].min} to ${JUDGEMENT_BOUNDS[key].max}`).join("; ");
    const corrected = moved.slice(0, 3).map((a) => `${a.role} ${JUDGEMENT_LABELS[a.key]} ${a.from} to ${a.to} (${a.reason})`).join("; ");
    out.push({
      group: g, id: "offer-judgement", title: "Every judgement figure for the offer is inside its range and has a reason",
      status: figures === 0 || unreasoned > 0 ? "fail" : moved.length > 0 ? "warn" : "pass",
      detail: figures === 0
        ? "No agent returned the offer's five figures, so the reference values stay in force."
        : `${figures - unreasoned} of ${figures} figures carry a written reason. ${moved.length === 0 ? `All are inside their ranges. ${ranges}.` : `${moved.length} value(s) were corrected by code: ${corrected}.`}`,
    });
  }

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
