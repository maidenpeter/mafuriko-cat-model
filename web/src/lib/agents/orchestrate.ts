import type { Check } from "../checks";
import { BOUNDS, enforceBounds, flattenParams, type Adjustment } from "../model/params";
import type { LossMode } from "../model/drivers";
import { resultFingerprint, runModel } from "../model/pipeline";
import type { Dataset, ModelParams, ModelResult } from "../model/types";
import { AGENT_JUDGEMENT_KEYS, BASEMENT_LADDER, enforceJudgement, JUDGEMENT_BOUNDS, JUDGEMENT_LABELS, OUTAGE_LADDER, REFERENCE_JUDGEMENT, type JudgementAdjustment, type OfferJudgement } from "../offer/judgement";
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

/**
 * The basis the portfolio's losses are worked out on: the header's switch between "Depth only" and
 * "All loss drivers", and the assumptions behind the drivers that act beyond depth (offer/judgement.ts).
 */
export interface ModelBasis {
  mode: LossMode;
  judgement: OfferJudgement;
}

/** One of the offer's figures that code corrected, and whose figure it was: moved back into its range, or raised so its ladder does not fall. */
export interface RoleJudgementAdjustment extends JudgementAdjustment {
  role: "optimist" | "cautious" | "chair";
}

/**
 * What the agents settled about the offer: the figures behind its loss drivers that they may argue
 * (AGENT_JUDGEMENT_KEYS in offer/judgement.ts). The figures set on screen only are never in these sets.
 * Every set here has been through enforceJudgement, so each figure is inside its range and both
 * ladders rise with rarity.
 */
export interface OfferDeliberation {
  /** The Optimist's figures, by key. null when its reply did not arrive, or held none of them. */
  optimist: Partial<OfferJudgement> | null;
  /** The Cautious voice's figures. null as above. */
  cautious: Partial<OfferJudgement> | null;
  /** The Chair's figures: the agreed set. null when the Chair did not decide, or its reply held none of them. */
  final: Partial<OfferJudgement> | null;
  /** The Chair's reason for each figure, by key ("bufferRadiusM", not "offer.bufferRadiusM"). Empty when the Chair did not decide. */
  reasons: Record<string, { reason: string; basis: string; leans?: string }>;
  /** Every figure code corrected, in any of the three sets: out of its range, or a ladder rung lower than the one before it. */
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
  /**
   * Fingerprint of the final parameters' result, so a replay can prove it reproduces. Always taken
   * on "Depth only", the basis every check refers to, so it is the same whichever basis is shown.
   */
  fingerprint: string | null;
  /** The basis the three results above were worked out on. A run made before the switch existed has none: depth only. */
  basis?: ModelBasis;
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

/** With no basis the engine runs exactly as it did before the loss drivers beyond depth existed. */
function score(dataset: Dataset, proposed: ModelParams, basis?: ModelBasis): Scored {
  const { params, adjustments } = enforceBounds(proposed);
  return { params, adjustments, result: basis ? runModel(dataset, params, { mode: basis.mode, judgement: basis.judgement }) : runModel(dataset, params) };
}

/** The depth-only fingerprint of a scored set: its own result when that is depth only, otherwise one more run of the engine. */
const fingerprintOf = (dataset: Dataset, scored: Scored, basis?: ModelBasis): string =>
  resultFingerprint(basis && basis.mode !== "depth_only" ? runModel(dataset, scored.params) : scored.result);

/** A basis read back from a saved run: a known mode, and every figure inside its range. Anything else is no basis. */
function savedBasis(raw: unknown): ModelBasis | undefined {
  const { mode, judgement } = (typeof raw === "object" && raw !== null ? raw : {}) as { mode?: unknown; judgement?: unknown };
  if (mode !== "depth_only" && mode !== "all_drivers") return undefined;
  return { mode, judgement: enforceJudgement(typeof judgement === "object" && judgement !== null ? judgement : {}).judgement };
}

/**
 * The offer's figures from the three replies, each kept inside its range and its ladders kept rising
 * by code, with what was corrected and the Chair's reasons. Only the figures the agents argue are
 * read: a reply saved under an earlier set of figures holds other keys, which are ignored, and a
 * figure a reply lacks is left out, so the reference value stays in force for it.
 */
function settleJudgement(runs: Deliberation["runs"], brief: OfferBrief): OfferDeliberation {
  const adjustments: RoleJudgementAdjustment[] = [];
  const enforce = (role: RoleJudgementAdjustment["role"], set: JudgementProposal | undefined): Partial<OfferJudgement> | null => {
    const argued = toJudgement(set);
    const keys = AGENT_JUDGEMENT_KEYS.filter((key) => key in argued);
    if (keys.length === 0) return null;
    const enforced = enforceJudgement(argued);
    adjustments.push(...enforced.adjustments.filter((a) => keys.includes(a.key)).map((a) => ({ ...a, role })));
    return Object.fromEntries(keys.map((key) => [key, enforced.judgement[key]]));
  };
  const decided: JudgementDecision | undefined = runs.chair.output?.offerJudgement;
  const optimist = enforce("optimist", runs.optimist.output?.offerJudgement);
  const cautious = enforce("cautious", runs.cautious.output?.offerJudgement);
  const final = enforce("chair", decided);
  const reasons: OfferDeliberation["reasons"] = {};
  for (const key of AGENT_JUDGEMENT_KEYS) {
    const entry = decided?.[key];
    if (entry) reasons[key] = { reason: entry.reason, basis: entry.basis, leans: entry.leans };
  }
  return { optimist, cautious, final, reasons, adjustments, brief };
}

/**
 * Round 1: Optimist, Cautious and Critic in parallel. Code then runs the engine
 * on both proposals. Round 2: the Chair settles the final set. Code runs it.
 *
 * With an offer loaded, pass its brief: every agent is then also given the offer's facts, the
 * proposing agents and the Chair argue the figures behind its loss drivers beside the model's
 * parameters, and the result carries them under offerJudgement. Without one nothing about the run changes.
 *
 * Pass the basis shown on screen as `model`: every run of the engine here then uses it, so what each
 * set of assumptions produces is on the same basis as the figures beside it. Left out, the engine
 * reads depth at each building's point, as before.
 */
export async function deliberate(dataset: Dataset, profile: DataProfile, onUpdate: (d: Deliberation) => void, offer?: OfferBrief | null, model?: ModelBasis | null): Promise<Deliberation> {
  const basis = model ?? undefined;
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
  if (basis) d.basis = basis;
  // The request is exactly as it was when no offer is loaded and the basis is depth only.
  const base: AgentRequest = offer ? { profile, offer } : { profile };
  // Every agent is told when the portfolio's losses count more than the depth at each building's point.
  if (basis?.mode === "all_drivers") base.lossBasis = basis.mode;
  const emit = () => {
    if (offer) d.offerJudgement = settleJudgement(d.runs, offer);
    onUpdate({ ...d, runs: { ...d.runs } });
  };
  emit();

  await Promise.all([
    callAgent("optimist", base).then((run) => {
      d.runs.optimist = run;
      if (run.output) d.optimist = score(dataset, toParams(run.output), basis);
      emit();
    }),
    callAgent("cautious", base).then((run) => {
      d.runs.cautious = run;
      if (run.output) d.cautious = score(dataset, toParams(run.output), basis);
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

  const side = (proposal: Proposal | undefined, scored: Scored | null, judgement: Partial<OfferJudgement> | null | undefined): ChairSide | null => {
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
    d.final = score(dataset, toParams(d.runs.chair.output.decision), basis);
    d.fingerprint = fingerprintOf(dataset, d.final, basis);
  }
  emit();
  return d;
}

/**
 * Re-score a saved deliberation against the current data, without calling any model.
 *
 * The engine runs on the basis given as `model`. Left out, it keeps the basis the run was saved
 * with; a run saved before the switch existed has none and is re-scored on depth only, as it was made.
 * The saved fingerprint is left alone: it is the depth-only one whatever the basis.
 */
export function replay(dataset: Dataset, saved: Deliberation, model?: ModelBasis | null): Deliberation {
  const basis = model ?? savedBasis(saved.basis);
  const rescore = (proposal: { depthScaleM: unknown } | undefined) => (proposal ? score(dataset, toParams(proposal as Proposal), basis) : null);
  const replayed: Deliberation = {
    ...saved,
    optimist: rescore(saved.runs.optimist.output),
    cautious: rescore(saved.runs.cautious.output),
    final: rescore(saved.runs.chair.output?.decision),
  };
  // What was saved as the basis is used only after it has been read back and kept in range.
  if (basis) replayed.basis = basis;
  else delete replayed.basis;
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
  /** Which of the figures the agents argue. */
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
  /** True when code corrected the agreed figure: moved it back into its range, or raised it so its ladder does not fall. */
  adjusted: boolean;
}

/**
 * One row for each figure the agents argue for the offer, in the order of AGENT_JUDGEMENT_KEYS: every
 * view side by side, and the Chair's reason for the agreed one. A figure a saved reply does not hold
 * is null there, and the reference value stays in force for it. Empty when the agents ran without an offer.
 */
export function judgementLedger(d: Deliberation | null | undefined): JudgementLedgerRow[] {
  const j = d?.offerJudgement;
  if (!j) return [];
  return AGENT_JUDGEMENT_KEYS.map((key) => ({
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

const LADDER_KEYS: ReadonlySet<keyof OfferJudgement> = new Set([...BASEMENT_LADDER, ...OUTAGE_LADDER]);
/** A ladder's allowed range in one phrase. Its rungs share one range in judgement.ts; the widest is quoted in case they ever differ. */
const ladderRange = (name: string, ladder: (keyof OfferJudgement)[]) =>
  `${name}: ${Math.min(...ladder.map((key) => JUDGEMENT_BOUNDS[key].min))} to ${Math.max(...ladder.map((key) => JUDGEMENT_BOUNDS[key].max))}, never falling as events get rarer`;

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

  // Only when the agents ran with an offer loaded: the figures behind its loss drivers, checked like the parameters.
  const j = d.offerJudgement;
  if (j) {
    const argued: (JudgementProposal | undefined)[] = [d.runs.optimist.output?.offerJudgement, d.runs.cautious.output?.offerJudgement, d.runs.chair.output?.offerJudgement];
    let figures = 0;
    let unreasoned = 0;
    let earlier = 0;
    for (const set of argued) {
      if (!set) continue;
      // A reply saved under an earlier set of figures holds none of these: nothing in it is used.
      if (!AGENT_JUDGEMENT_KEYS.some((key) => set[key])) {
        earlier += 1;
        continue;
      }
      for (const key of AGENT_JUDGEMENT_KEYS) {
        figures += 1;
        if (!set[key]?.reason?.trim()) unreasoned += 1;
      }
    }
    const moved = j.adjustments;
    // A ladder correction starts from a value that was inside its range; a range correction does not.
    const rungs = moved.filter((a) => LADDER_KEYS.has(a.key) && a.from >= JUDGEMENT_BOUNDS[a.key].min && a.from <= JUDGEMENT_BOUNDS[a.key].max).length;
    const ranges = [
      ...AGENT_JUDGEMENT_KEYS.filter((key) => !LADDER_KEYS.has(key)).map((key) => `${JUDGEMENT_LABELS[key]}: ${JUDGEMENT_BOUNDS[key].min} to ${JUDGEMENT_BOUNDS[key].max}`),
      ladderRange("Basement damage ratio for each tier", BASEMENT_LADDER),
      ladderRange("Outage days for each tier", OUTAGE_LADDER),
    ].join("; ");
    const corrected = moved.slice(0, 3).map((a) => `${a.role} ${JUDGEMENT_LABELS[a.key]} ${a.from} to ${a.to} (${a.reason})`).join("; ");
    out.push({
      group: g, id: "offer-judgement", title: "Every figure the agents set for the offer is inside its range, has a reason, and the ladders rise with rarity",
      status: figures === 0 ? (earlier > 0 ? "warn" : "fail") : unreasoned > 0 ? "fail" : moved.length > 0 ? "warn" : "pass",
      detail: figures === 0
        ? earlier > 0
          ? "This run was saved before these figures were argued, so the reference values stay in force for the offer. Run the agents again to have them argued."
          : "No agent returned the offer's figures, so the reference values stay in force."
        : `${figures - unreasoned} of ${figures} figures carry a written reason. ${
            moved.length === 0
              ? `All are inside their ranges and both ladders rise. ${ranges}.`
              : `${moved.length} value(s) were corrected by code, ${rungs} of them to keep a ladder from falling: ${corrected}.`
          }`,
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
    // On depth only, the basis of the saved fingerprint, whichever basis the run is shown on.
    const again = resultFingerprint(runModel(dataset, d.final.params));
    out.push({
      group: g, id: "reproducible", title: "Re-running the engine on the saved parameters gives the same result",
      status: again === d.fingerprint ? "pass" : "fail",
      detail: `Result fingerprint ${again}${again === d.fingerprint ? " on both runs." : `, expected ${d.fingerprint}.`}`,
    });
  }
  return out;
}
