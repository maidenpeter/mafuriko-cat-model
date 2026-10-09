"use client";

import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { buildLedger, judgementLedger, type AgentRun, type Deliberation, type JudgementLedgerRow, type LedgerRow, type Scored } from "@/lib/agents/orchestrate";
import { BASIS_LABELS, reasonAt, ROLE_LABELS, type Basis, type Proposal, type Role } from "@/lib/agents/schema";
import { costOf, fmtUsd, usageRows, usageTotals, type Prices } from "@/lib/agents/usage";
import type { Check } from "@/lib/checks";
import { judgementRange, judgementText, PARAM_LABELS, SETTER_LABELS, unusedForDepth } from "@/lib/export";
import { fmtNum, fmtPct } from "@/lib/format";
import { isPlaceholder, kes1, LOSS_MODE_LABELS, perMille, PLACEHOLDER_RATE_LINE, rpLabel, rpWithChance, selectMode, type SourceKind } from "@/lib/labels";
import type { LossMode } from "@/lib/model/drivers";
import { flattenParams, REFERENCE_PARAMS } from "@/lib/model/params";
import { HOUSING_LABELS, SCORE_TIERS } from "@/lib/model/types";
import { DRIVER_LABELS } from "@/lib/offer/drivers";
import { isPriced, PORTFOLIO_KEYS, type AssumptionPrice, type FocusJudgement, type JudgementSetter, type OfferFocus, type PricedFocus } from "@/lib/offer/focus";
import { AGENT_JUDGEMENT_KEYS, BASEMENT_LADDER, JUDGEMENT_BOUNDS, JUDGEMENT_KEYS, JUDGEMENT_LABELS, ladderRung, OUTAGE_LADDER, REFERENCE_JUDGEMENT, type OfferJudgement } from "@/lib/offer/judgement";
import type { Session } from "@/lib/session";
import { STEP_NAMES, stepKicker, type StepId } from "@/lib/steps";
import { LegendMark, SourceBadge, SourceLine } from "../charts/ChartFrame";
import { StepShapley } from "../interpret/Movers";
import { Button, Card, ChecksLine, Fold, Note, OfferNotice, PlaceholderBadge, selectView, StatusIcon, StepHeader, StepLink, Tag } from "../ui";

const ROLE_BLURB: Record<Role, string> = {
  optimist: "Argues for the least severe assumptions that can still be defended.",
  cautious: "Argues for the most severe assumptions that are still credible.",
  critic: "Challenges the data and the reference assumptions.",
  chair: "Weighs both proposals and the challenges, then settles the final set.",
};

const SEVERITY = { high: "High", medium: "Medium", low: "Low" } as const;
const VERDICT = { accepted: "Accepted", partly: "Partly accepted", rejected: "Rejected" } as const;

/** The agents in the order they speak: three side by side, then the Chair. */
const ROLES: Role[] = ["optimist", "cautious", "critic", "chair"];
const RUN_WORD: Record<AgentRun["status"], string> = { idle: "waiting", running: "working", done: "done", error: "no valid reply" };
const runIcon = (run: AgentRun) => (run.status === "done" ? "pass" : run.status === "error" ? "fail" : run.status === "running" ? "running" : "idle");

/** Heading inside a fold, and the line under it. */
const SUB_HEADING = "text-sm font-semibold text-ink";
const SUB_TEXT = "mt-1 max-w-3xl text-sm leading-relaxed text-ink-2";
/** A disclosure inside a fold. Fold marks its own state by its nearest open parent, so it is not nested. */
const INNER_SUMMARY = "cursor-pointer select-none text-sm font-medium text-ink-2 hover:text-ink";

/** Where each agent stands, in words as well as by its icon, and what went wrong for one that gave no valid reply. */
function AgentStatuses({ d }: { d: Deliberation }) {
  const failed = ROLES.filter((role) => d.runs[role].status === "error");
  return (
    <div className="mt-3 border-t border-line pt-3">
      <ul aria-label="The agents" className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-2">
        {ROLES.map((role) => (
          <li key={role} className="inline-flex items-center gap-1.5">
            <StatusIcon status={runIcon(d.runs[role])} size={16} />
            <span><span className="font-medium text-ink">{ROLE_LABELS[role]}</span>: {RUN_WORD[d.runs[role].status]}</span>
          </li>
        ))}
      </ul>
      {failed.map((role) => (
        <p key={role} className="mt-2 max-w-4xl text-sm leading-relaxed text-ink-2 wrap-anywhere"><strong className="font-semibold text-ink">{ROLE_LABELS[role]}, no valid reply.</strong> {d.runs[role].error}</p>
      ))}
    </div>
  );
}

function Thinking() {
  return (
    <div className="space-y-2.5 py-2" aria-label="Working">
      {[92, 76, 84, 58].map((w, i) => (
        <motion.div key={i} className="h-2.5 rounded-full bg-surface-2" style={{ width: `${w}%` }} animate={{ opacity: [0.45, 1, 0.45] }} transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.18 }} />
      ))}
    </div>
  );
}

const tokens = (value: number | null) => (value === null ? "not reported" : value.toLocaleString("en-KE"));
const seconds = (value: number | null) => (value === null ? "not reported" : `${value.toFixed(1)} s`);

const COST_NOTE = "Estimated from the prices set in .env.local";

/** A row of small label and value pairs. */
function Pairs({ items, className = "" }: { items: [string, string][]; className?: string }) {
  return (
    <dl className={`flex flex-wrap gap-x-4 gap-y-1 ${className}`}>
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="inline text-muted">{label}: </dt>
          <dd className="tabular inline wrap-anywhere font-medium text-ink-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const finished = (run: AgentRun) => run.status === "done" || run.status === "error";

/** What each agent used, one line per agent. A cost appears only when prices are set. */
function RunUsage({ d, prices }: { d: Deliberation; prices: Prices | null }) {
  return (
    <ul className="mt-3 divide-y divide-line text-xs text-muted">
      {ROLES.map((role) => d.runs[role]).filter(finished).map((run) => {
        const used = usageRows([run])[0];
        const cost = costOf(used, prices);
        return (
          <li key={run.role} className="py-2">
            <div className="text-sm font-medium text-ink">{ROLE_LABELS[run.role]}</div>
            <Pairs
              className="mt-0.5"
              items={[
                ["Model", used.model ?? "not reported"],
                ["Tokens in", tokens(used.inputTokens)],
                ["Tokens out", tokens(used.outputTokens)],
                ["Thinking tokens", tokens(used.thinkingTokens)],
                ["Time", seconds(used.seconds)],
                ...(cost !== null ? [["Cost", fmtUsd(cost)] as [string, string]] : []),
              ]}
            />
          </li>
        );
      })}
    </ul>
  );
}

const TRANSCRIPT = "mt-1 max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-2 p-2.5 font-mono text-xs leading-relaxed text-ink-2";

/** Each agent's prompt exactly as sent and its reply exactly as received, one disclosure per agent. */
function RunTranscripts({ d }: { d: Deliberation }) {
  const runs = ROLES.map((role) => d.runs[role]).filter(finished);
  // A run saved with the app may have been packed without the prompts (scripts/pack-run.mjs, --drop-prompts).
  const repliesOnly = runs.some((run) => run.raw) && runs.every((run) => !run.prompt);
  return (
    <div className="space-y-2">
      {repliesOnly && <p className="text-sm leading-relaxed text-ink-2">This run was saved without the prompts that were sent. Each reply is shown as it was received.</p>}
      {runs.map((run) => (
        <details key={run.role} className="text-xs text-muted">
          <summary className={INNER_SUMMARY}>
            {ROLE_LABELS[run.role]}{run.usage?.firstTextS !== undefined ? ` · first text after ${run.usage.firstTextS} s` : ""}{run.usage?.padded ? " · cut off after the reply was complete" : ""}{(run.attempts ?? 1) > 1 ? " · needed a retry" : ""}
          </summary>
          {run.prompt && (
            <>
              <div className="mt-2 font-semibold text-ink-2">Instructions</div>
              <pre className={TRANSCRIPT}>{run.prompt.system}</pre>
              <div className="mt-2 font-semibold text-ink-2">Input</div>
              <pre className={TRANSCRIPT}>{run.prompt.user}</pre>
            </>
          )}
          {run.raw && (
            <>
              <div className="mt-2 font-semibold text-ink-2">Reply, unedited</div>
              <pre className={TRANSCRIPT}>{run.raw}</pre>
            </>
          )}
        </details>
      ))}
    </div>
  );
}

/** One agent's reply inside a fold: who it is, what it argues for, and its body once the reply is in. */
function AgentBox({ run, className = "", children }: { run: AgentRun; className?: string; children?: ReactNode }) {
  return (
    <section className={`min-w-0 rounded-xl border border-line p-4 ${className}`}>
      <h4 className={SUB_HEADING}>{ROLE_LABELS[run.role]}</h4>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{ROLE_BLURB[run.role]}</p>
      <div className="mt-3">
        {run.status === "running" && <Thinking />}
        {run.status === "idle" && <p className="text-sm text-muted">Waiting for the first round.</p>}
        {run.status === "error" && <p className="text-sm leading-relaxed text-ink-2 wrap-anywhere"><strong className="font-semibold text-ink">No valid reply.</strong> {run.error}</p>}
        {run.status === "done" && children}
      </div>
    </section>
  );
}

/** `offerFigures` are this agent's assumptions beyond flood depth as code kept them in range, when it argued the offer on screen. */
function ProposalBody({ proposal, scored, session, offerFigures = null }: { proposal: Proposal; scored: Scored | null; session: Session; offerFigures?: Partial<OfferJudgement> | null }) {
  const beyond = offerFigures ? AGENT_JUDGEMENT_KEYS.filter((key) => offerFigures[key] !== undefined) : [];
  const isScore = session.dataset.hazardKind === "score";
  const rows = scored ? flattenParams(scored.params).filter((p) => isScore || !unusedForDepth(p.path)) : [];
  const ref = new Map(flattenParams(REFERENCE_PARAMS).map((p) => [p.path, p.value]));
  const rarest = scored?.result.scenarios[scored.result.scenarios.length - 1];
  return (
    <div>
      <p className="text-sm leading-relaxed text-ink">{proposal.stance}</p>
      {scored && rarest && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <div className="text-xs text-muted">What these assumptions produce, computed by code. Ground-up loss, before insurance terms.</div>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
            <span>{rpWithChance(rarest.returnPeriod)} event: <strong className="tabular font-semibold text-ink">{kes1(rarest.lossKes)}</strong></span>
            <span>Average annual loss: <strong className="tabular font-semibold text-ink">{kes1(scored.result.aalKes)}</strong></span>
          </div>
          <SourceLine
            className="mt-2"
            sources={[
              { kind: "ai", text: "Assumptions proposed by this agent" },
              { kind: "synthetic", text: "Portfolio of insured buildings" },
            ]}
          />
        </div>
      )}
      <details className="mt-3">
        <summary className={INNER_SUMMARY}>{rows.length + beyond.length} values and the reason for each</summary>
        <ul className="mt-2 divide-y divide-line">
          {rows.map(({ path, value }) => {
            const r = reasonAt<Proposal["depthScaleM"]>(proposal, path);
            const delta = value - ref.get(path)!;
            return (
              <li key={path} className="py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="text-ink">{PARAM_LABELS[path]}</span>
                  <span className="tabular ml-auto whitespace-nowrap text-ink"><strong className="font-semibold">{fmtNum(value)}</strong> <span className="text-muted">({delta === 0 ? "same as reference" : `reference ${fmtNum(ref.get(path)!)}`})</span></span>
                </div>
                <div className="mt-0.5 text-sm leading-relaxed text-ink-2">{r?.reason} <span className="text-muted">· {BASIS_LABELS[(r?.basis ?? "judgement") as Basis]}</span></div>
              </li>
            );
          })}
          {beyond.map((key) => {
            const r = proposal.offerJudgement?.[key];
            const value = offerFigures![key]!;
            return (
              <li key={key} className="py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                  <span className="text-ink">{JUDGEMENT_LABELS[key]}</span>
                  <span className="tabular ml-auto whitespace-nowrap text-ink"><strong className="font-semibold">{judgementText(key, value)}</strong> <span className="text-muted">({value === REFERENCE_JUDGEMENT[key] ? "same as reference" : `reference ${judgementText(key, REFERENCE_JUDGEMENT[key])}`})</span></span>
                </div>
                <div className="mt-0.5 text-sm leading-relaxed text-ink-2">{r?.reason} <span className="text-muted">· {BASIS_LABELS[(r?.basis ?? "judgement") as Basis]}</span></div>
              </li>
            );
          })}
        </ul>
      </details>
      {scored && scored.adjustments.length > 0 && (
        <p className="mt-2 text-sm text-ink-2"><strong className="font-semibold text-ink">Corrected by code:</strong> {scored.adjustments.map((a) => `${PARAM_LABELS[a.path] ?? a.path} ${fmtNum(a.from)} → ${fmtNum(a.to)}`).join("; ")}</p>
      )}
    </div>
  );
}

/** What the whole run used, added up, then the same for each agent. */
function RunTotals({ d, prices }: { d: Deliberation; prices: Prices | null }) {
  const rows = usageRows(Object.values(d.runs).filter(finished));
  if (rows.length === 0) return <p className="text-sm text-muted">No agent has replied yet.</p>;
  const totals = usageTotals(rows);
  const cost = costOf(totals, prices);
  const caveats = [
    "Seconds are added across the agents. The first three ran side by side, so the wait was shorter.",
    totals.unreported > 0 ? `${totals.unreported} ${totals.unreported === 1 ? "agent" : "agents"} reported no token counts, so the totals leave ${totals.unreported === 1 ? "it" : "them"} out.` : "",
    totals.retried > 0 ? `${totals.retried} ${totals.retried === 1 ? "agent was" : "agents were"} asked twice; only the tokens of the last request are counted.` : "",
    cost !== null ? `${COST_NOTE}.` : "",
  ].filter(Boolean);
  return (
    <div>
      <Pairs
        className="text-sm"
        items={[
          [totals.models.length > 1 ? "Models" : "Model", totals.models.join(", ") || "not reported"],
          ["Tokens in", totals.reported > 0 ? tokens(totals.inputTokens) : "not reported"],
          ["Tokens out", totals.reported > 0 ? tokens(totals.outputTokens) : "not reported"],
          ["Thinking tokens", totals.reported > 0 ? tokens(totals.thinkingTokens) : "not reported"],
          ["Time worked", seconds(totals.seconds)],
          ...(cost !== null ? [["Cost", fmtUsd(cost)] as [string, string]] : []),
        ]}
      />
      <p className="mt-2 max-w-4xl text-xs leading-relaxed text-muted">{caveats.join(" ")}</p>
      <RunUsage d={d} prices={prices} />
    </div>
  );
}

const SET_BLURB: Record<AssumptionPrice["id"], string> = {
  reference: "The model's starting values",
  optimist: "Least severe that can be defended",
  cautious: "Most severe that is still credible",
  agreed: "What the Chair settled",
};

/** An amount with a bar beside it, so the sets can be compared by eye. The bar is left out where the table is narrow. */
function BarValue({ value, max, text }: { value: number | null; max: number; text: string }) {
  const share = value !== null && max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="flex items-center justify-end gap-3">
      <span aria-hidden className="hidden h-2 w-20 shrink-0 overflow-hidden rounded-full border border-line bg-surface-2 @xl:block">
        <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: "var(--series-1)" }} />
      </span>
      <span className="tabular whitespace-nowrap">{text}</span>
    </div>
  );
}

const kesRange = (a: number, b: number) => (a === b ? kes1(a) : `${kes1(Math.min(a, b))} to ${kes1(Math.max(a, b))}`);
/** A rate as the shared formatter writes it, without its unit: for a column or a range that names the unit once. */
const rate = (value: number) => perMille(value).replace(" per mille", "");
const perMilleRange = (a: number, b: number) => (perMille(a) === perMille(b) ? perMille(a) : `${rate(Math.min(a, b))} to ${perMille(Math.max(a, b))}`);

// ---------------------------------------------------------------------------------------------
// The assumptions beyond flood depth
// ---------------------------------------------------------------------------------------------

type JudgementKey = keyof OfferJudgement;

const LADDER_KEYS: ReadonlySet<JudgementKey> = new Set([...BASEMENT_LADDER, ...OUTAGE_LADDER]);
/** Every figure that is not a rung of a ladder, in the order of judgement.ts. */
const SINGLE_KEYS = JUDGEMENT_KEYS.filter((key) => !LADDER_KEYS.has(key));
const ARGUED: ReadonlySet<JudgementKey> = new Set(AGENT_JUDGEMENT_KEYS);

/** One value for every rung of a ladder. */
const everyRung = <T,>(ladder: JudgementKey[], value: T) => Object.fromEntries(ladder.map((key) => [key, value])) as Partial<Record<JudgementKey, T>>;

/** Which loss driver, or which line of the premium, each figure feeds. */
const FEEDS = {
  bufferRadiusM: DRIVER_LABELS.surrounding,
  ingressThresholdM: DRIVER_LABELS.basement,
  ...everyRung(BASEMENT_LADDER, DRIVER_LABELS.basement),
  belowGroundShare: DRIVER_LABELS.basement,
  ...everyRung(OUTAGE_LADDER, DRIVER_LABELS.interruption),
  uncertaintyLoading: DRIVER_LABELS.uncertainty,
  drainDesignRp: DRIVER_LABELS.overload,
  drainOverloadDepthM: DRIVER_LABELS.overload,
  annualRentShare: DRIVER_LABELS.interruption,
  costOfCapital: "Premium, capital load",
  minimumRatePerMille: "Premium, minimum rate",
} as Record<JudgementKey, string>;

/** How far one click of the arrows moves each figure. */
const STEP = {
  bufferRadiusM: 10,
  ingressThresholdM: 0.01,
  ...everyRung(BASEMENT_LADDER, 0.05),
  belowGroundShare: 0.01,
  ...everyRung(OUTAGE_LADDER, 1),
  uncertaintyLoading: 0.01,
  drainDesignRp: 1,
  drainOverloadDepthM: 0.01,
  annualRentShare: 0.01,
  costOfCapital: 0.01,
  minimumRatePerMille: 0.05,
} as Record<JudgementKey, number>;

const SHARE_KEYS: ReadonlySet<JudgementKey> = new Set([...BASEMENT_LADDER, "belowGroundShare", "uncertaintyLoading", "annualRentShare", "costOfCapital"]);
const METRE_KEYS: ReadonlySet<JudgementKey> = new Set(["bufferRadiusM", "ingressThresholdM", "drainOverloadDepthM"]);
/**
 * The unit a figure is typed in, the one every record writes it in: a share is typed as a percentage
 * (the model keeps it as a fraction, so `scale` is 100), everything else as it is kept.
 */
const boxUnit = (key: JudgementKey): { scale: number; unit: string } =>
  SHARE_KEYS.has(key) ? { scale: 100, unit: "%" } : METRE_KEYS.has(key) ? { scale: 1, unit: "m" } : key === "drainDesignRp" ? { scale: 1, unit: "years" } : key === "minimumRatePerMille" ? { scale: 1, unit: "per mille" } : { scale: 1, unit: "days" };

/** A figure with its unit, as the Audit step and the written note print it. "-" where there is none. */
const figure = (key: JudgementKey, value: number | null | undefined) => (value === null || value === undefined ? "-" : judgementText(key, value));

/** What every row of the assumptions needs: the figures, who set each, the agents' views and the way to type over one. */
interface JudgementView {
  judgement: FocusJudgement;
  /** The agents' views by figure. Empty unless they argued the offer now on screen. */
  rows: Map<JudgementKey, JudgementLedgerRow>;
  /** True while the agents' agreed set is in force for the figures they argue. */
  agentsInUse: boolean;
  /** The badge a figure read from the offer document carries. */
  documentKind: SourceKind;
  /** True on the portfolio's view: the assumptions alone, never a figure the offer states. */
  portfolio: boolean;
  onJudgement?: (next: Partial<OfferJudgement>) => void;
  onOpenStep?: (id: StepId) => void;
}

const valueOf = (v: JudgementView, key: JudgementKey) => (v.portfolio ? v.judgement.assumed[key] : v.judgement.inForce[key]);
const fromAgents = (v: JudgementView, key: JudgementKey) => v.agentsInUse && !!v.judgement.agreed && key in v.judgement.agreed;

/** Who set the figure shown. The portfolio never takes a figure from the offer document, so there the assumption's own setter is named. */
function setterOf(v: JudgementView, key: JudgementKey): JudgementSetter {
  const who = v.judgement.setBy[key];
  if (who !== "offer" || !v.portfolio) return who;
  return v.judgement.raised[key]?.by ?? (key in v.judgement.typed ? "typed" : fromAgents(v, key) ? "agents" : "reference");
}

/**
 * The library's record of a ladder rung that code raised to keep the ladder rising: the rung's own value, the value
 * in force, who set the rung that pushed it up, and the reason. Such a rung is marked "typed" or "agents" without
 * being among the typed or the agreed figures, so its value is read from the figures in force, never from those.
 */
const raisedOf = (v: JudgementView, key: JudgementKey) => (setterOf(v, key) === "offer" ? undefined : v.judgement.raised[key]);

function Setter({ v, k }: { v: JudgementView; k: JudgementKey }) {
  const who = setterOf(v, k);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {/* An assumption keeps its badge whoever set it; the agents' own badge is added beside it. A figure read from the offer is not an assumption. */}
      <SourceBadge kind={who === "offer" ? v.documentKind : "assumption"} />
      {who === "agents" && <SourceBadge kind="ai" />}
      <span className="text-ink">{SETTER_LABELS[who]}</span>
    </span>
  );
}

const NUMBER_BOX = "tabular w-24 min-w-0 rounded-lg border border-axis bg-surface px-2 py-1 text-right text-sm text-ink";

/**
 * A number box for one figure. What is typed is kept as typed while the box has the focus and takes
 * effect at once; on leaving the box it shows the value in force, which code may have moved into its range.
 */
function FigureBox({ k, value, onCommit }: { k: JudgementKey; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const { min, max } = JUDGEMENT_BOUNDS[k];
  const { scale, unit } = boxUnit(k);
  // Rounded once here, so a percentage never shows the tail a fraction times 100 can leave.
  const shown = (x: number) => Number((x * scale).toFixed(4));
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        inputMode="decimal"
        aria-label={`${JUDGEMENT_LABELS[k]}, in ${unit === "%" ? "per cent" : unit}, allowed ${judgementRange(k)}`}
        min={shown(min)}
        max={shown(max)}
        step={shown(STEP[k])}
        value={draft ?? fmtNum(shown(value), 4)}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          if (text.trim() !== "" && Number.isFinite(Number(text))) onCommit(Number(text) / scale);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={NUMBER_BOX}
      />
      <span className="whitespace-nowrap text-xs text-muted">{unit}</span>
    </span>
  );
}

/** The figure in force: a box to type over it, or plain text when the offer document states it. */
function InForce({ v, k }: { v: JudgementView; k: JudgementKey }) {
  const who = setterOf(v, k);
  const value = valueOf(v, k);
  const onJudgement = v.onJudgement;
  const editable = who !== "offer" && !!onJudgement;
  const raised = raisedOf(v, k);
  // A return period typed in years is read back with its annual chance; every other box already shows its unit.
  const plain = editable && k === "drainDesignRp" ? rpWithChance(value) : "";
  return (
    <div className="flex flex-col items-end gap-1">
      {editable ? <FigureBox k={k} value={value} onCommit={(next) => onJudgement({ [k]: next })} /> : <span className="tabular font-semibold text-ink">{figure(k, value)}</span>}
      {plain && <span className="tabular text-xs text-muted">{plain}</span>}
      {/* The reason and the rung's own value are written out under the ladder; here the rung only says it was moved. */}
      {raised && <span className="text-xs text-muted">Raised by code</span>}
      {/* Only a figure the underwriter typed can be handed back: a rung code raised is marked "typed" without being one. */}
      {editable && k in v.judgement.typed && (
        <button type="button" onClick={() => onJudgement({ [k]: undefined })} aria-label={`${fromAgents(v, k) ? "Use the agents' value" : "Use the reference value"} for: ${JUDGEMENT_LABELS[k]}`} className="rounded-full border border-axis px-2.5 py-0.5 text-xs font-medium text-ink hover:bg-surface-2">
          {fromAgents(v, k) ? "Use the agents' value" : "Use the reference value"}
        </button>
      )}
    </div>
  );
}

/** Under a figure's name: its sentence in the offer, the Chair's reason, or that it is set on screen only. */
function Why({ v, k }: { v: JudgementView; k: JudgementKey }) {
  const stated = v.portfolio ? undefined : v.judgement.fromOffer[k];
  const row = v.rows.get(k);
  if (stated) {
    return (
      <div className="mt-1 text-sm leading-relaxed text-ink-2">
        <blockquote className="border-l-2 border-axis pl-2.5 wrap-anywhere">&ldquo;{stated.quote}&rdquo;</blockquote>
        <p className="mt-1 text-xs text-muted">Read from the offer, so it is not typed over here. Change it in the <StepLink to="offer" onOpenStep={v.onOpenStep} /> step.</p>
      </div>
    );
  }
  if (row?.reason) {
    return (
      <p className="mt-1 text-sm leading-relaxed text-ink-2">
        <span className="text-muted">Chair:</span> {row.reason} <span className="text-muted">· leans {row.leans} · {BASIS_LABELS[row.basis as Basis] ?? row.basis}</span>
      </p>
    );
  }
  if (!ARGUED.has(k) && !v.portfolio) return <p className="mt-1 text-xs leading-relaxed text-muted">Set on screen only: the agents do not argue this one.</p>;
  return null;
}

/** One figure per row: its name and reason, the value in force, who set it, its range and every view of it. */
function FigureTable({ v, keys }: { v: JudgementView; keys: JudgementKey[] }) {
  const argued = v.rows.size > 0;
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-left text-sm ${argued ? "min-w-208" : "min-w-160"}`}>
        <thead className="text-xs text-muted">
          <tr>
            <th className="pb-2 font-medium">Assumption</th>
            <th className="pb-2 pl-4 text-right font-medium">In force</th>
            <th className="pb-2 pl-4 font-medium">Set by</th>
            <th className="pb-2 pl-4 text-right font-medium">Allowed range</th>
            <th className="pb-2 pl-4 text-right font-medium">Reference</th>
            {argued && <th className="pb-2 pl-4 text-right font-medium">Optimist</th>}
            {argued && <th className="pb-2 pl-4 text-right font-medium">Cautious</th>}
            {argued && <th className="pb-2 pl-4 text-right font-medium">Agreed</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line align-top">
          {keys.map((k) => {
            const row = v.rows.get(k);
            const stated = v.portfolio ? undefined : v.judgement.fromOffer[k];
            return (
              <tr key={k}>
                <td className="py-2.5 pr-3">
                  <div className="text-ink">{stated ? stated.what : JUDGEMENT_LABELS[k]}</div>
                  <div className="text-xs text-muted">Feeds: {FEEDS[k]}</div>
                  {isPlaceholder(k) && (
                    <div className="mt-1">
                      <PlaceholderBadge />
                    </div>
                  )}
                  <Why v={v} k={k} />
                </td>
                <td className="py-2.5 pl-4"><InForce v={v} k={k} /></td>
                <td className="py-2.5 pl-4"><Setter v={v} k={k} /></td>
                <td className="tabular whitespace-nowrap py-2.5 pl-4 text-right text-ink-2">{judgementRange(k)}</td>
                <td className="tabular py-2.5 pl-4 text-right text-ink-2">{figure(k, v.judgement.reference[k])}</td>
                {argued && <td className="tabular py-2.5 pl-4 text-right text-ink-2">{figure(k, row?.optimist)}</td>}
                {argued && <td className="tabular py-2.5 pl-4 text-right text-ink-2">{figure(k, row?.cautious)}</td>}
                {argued && <td className="tabular py-2.5 pl-4 text-right font-semibold text-ink">{figure(k, row?.agreed)}{row?.adjusted ? "*" : ""}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A rung's one name (its place and its flood), with a capital to open a column head or a line. */
function rungName(key: JudgementKey, returnPeriods?: number[]): string {
  const text = ladderRung(key, returnPeriods)?.text ?? JUDGEMENT_LABELS[key];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The flood a rung stands for, when there are as many floods modelled as rungs: its return period. undefined otherwise. */
function rungFlood(key: JudgementKey, returnPeriods: number[]): number | undefined {
  const rung = ladderRung(key);
  return rung && returnPeriods.length === rung.of ? returnPeriods[rung.rung - 1] : undefined;
}

/** A ladder as a ladder: its five rungs side by side, most frequent flood first, and every view of each rung under it. */
function LadderTable({ v, title, unit, keys, returnPeriods }: { v: JudgementView; title: string; unit: string; keys: JudgementKey[]; returnPeriods: number[] }) {
  const argued = v.rows.size > 0;
  const reasons = keys.map((k) => ({ k, row: v.rows.get(k) })).filter((x) => x.row?.reason);
  const raised = keys.flatMap((k) => {
    const record = raisedOf(v, k);
    return record ? [{ k, record }] : [];
  });
  const view = (label: string, cell: (k: JudgementKey) => ReactNode, strong = false) => (
    <tr>
      <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-2">{label}</th>
      {keys.map((k) => <td key={k} className={`tabular py-2 pl-4 text-right ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>{cell(k)}</td>)}
    </tr>
  );
  return (
    <section className="mt-6">
      <h4 className={SUB_HEADING}>{title}</h4>
      <p className={SUB_TEXT}>
        Feeds: {FEEDS[keys[0]]}. One figure for each flood modelled, in {unit}: rung 1 on the left is the most frequent flood and rung {keys.length} the rarest. Allowed: {judgementRange(keys[0])}. A rung set lower than the one before it is raised to match.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-176 text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">Flood</th>
              {keys.map((k) => {
                const flood = rungFlood(k, returnPeriods);
                return (
                  <th key={k} scope="col" className="pb-2 pl-4 text-right align-bottom font-medium">
                    {rungName(k)}
                    {flood !== undefined && <span className="block font-normal">{rpWithChance(flood)}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line align-top">
            <tr>
              <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">In force</th>
              {keys.map((k) => <td key={k} className="py-2 pl-4"><InForce v={v} k={k} /></td>)}
            </tr>
            <tr>
              <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-2">Set by</th>
              {keys.map((k) => <td key={k} className="py-2 pl-4"><div className="flex justify-end"><Setter v={v} k={k} /></div></td>)}
            </tr>
            {view("Reference", (k) => figure(k, v.judgement.reference[k]))}
            {argued && view("Optimist", (k) => figure(k, v.rows.get(k)?.optimist))}
            {argued && view("Cautious", (k) => figure(k, v.rows.get(k)?.cautious))}
            {argued && view("Agreed", (k) => <>{figure(k, v.rows.get(k)?.agreed)}{v.rows.get(k)?.adjusted ? "*" : ""}</>, true)}
          </tbody>
        </table>
      </div>
      {raised.length > 0 && (
        <ul className="mt-2 max-w-3xl space-y-1 text-xs leading-relaxed text-muted">
          {raised.map(({ k, record }) => (
            <li key={k}>
              <span className="font-medium text-ink-2">{rungName(k, returnPeriods)}:</span> {record.reason} Its own value was {figure(k, record.from)}.
            </li>
          ))}
        </ul>
      )}
      {reasons.length > 0 && (
        <details className="mt-2">
          <summary className={INNER_SUMMARY}>Why the Chair chose each rung</summary>
          <ul className="mt-2 divide-y divide-line">
            {reasons.map(({ k, row }) => {
              return (
                <li key={k} className="py-2 text-sm leading-relaxed text-ink-2">
                  <span className="font-medium text-ink">{rungName(k, returnPeriods)}:</span> {row!.reason} <span className="text-muted">· leans {row!.leans} · {BASIS_LABELS[row!.basis as Basis] ?? row!.basis}</span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}

/** The mark used in the tables, explained once under them. A rung code raised carries its own reason under its ladder. */
function Footnotes({ v, keys }: { v: JudgementView; keys: JudgementKey[] }) {
  if (!keys.some((k) => v.rows.get(k)?.adjusted)) return null;
  return <p className="mt-3 text-xs leading-relaxed text-muted">* As proposed it was outside its range, or below the rung before it; corrected by code.</p>;
}

/** How many figures are typed, and the way to drop them all. */
function TypedLine({ v }: { v: JudgementView }) {
  const count = Object.keys(v.judgement.typed).length;
  const onJudgement = v.onJudgement;
  if (count === 0 || !onJudgement) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
      <span>{count} {count === 1 ? "figure is" : "figures are"} typed over. A typed figure is used under every set of assumptions.</span>
      <button type="button" onClick={() => onJudgement({})} className="rounded-full border border-axis px-2.5 py-0.5 text-xs font-medium text-ink hover:bg-surface-2">Clear everything typed</button>
    </p>
  );
}

const ARGUED_COUNT = AGENT_JUDGEMENT_KEYS.length;
const SCREEN_COUNT = JUDGEMENT_KEYS.length - ARGUED_COUNT;

/** Where the agents stand on these figures, in one sentence. */
function agentsLine(v: JudgementView, d: Deliberation | null, busy: boolean, referenceChosen: boolean): ReactNode {
  if (busy) return "The agents are working. Their figures appear here as the replies come in; the reference values stay in force until the Chair decides.";
  if (referenceChosen) return <><strong className="font-semibold text-ink">&ldquo;Reference, no AI&rdquo; is selected in the bar above, so the reference values are in force.</strong> The agents&apos; figures are shown beside them for comparison and take no part in the price.</>;
  if (v.judgement.agents === "another_offer") return <><strong className="font-semibold text-ink">The agents argued a different offer,</strong> or this offer&apos;s facts have changed since they ran, so their figures are not used. Run the agents on this offer to have these argued.</>;
  if (!d) return `Reference values are in force until the agents have run on this offer. They then argue ${ARGUED_COUNT} of these figures, each inside its allowed range; the other ${SCREEN_COUNT} are set on screen only.`;
  if (v.judgement.agents === "none") return "The agents ran without an offer, so they have not argued these figures. Run the agents on this offer to have them argued.";
  if (!v.judgement.agreed || Object.keys(v.judgement.agreed).length === 0) return "The Chair has not settled these figures, so the reference values stay in force.";
  return `The agents argued ${ARGUED_COUNT} of these figures for this offer, and the Chair's agreed set is in force for them. The other ${SCREEN_COUNT} are set on screen only.`;
}

/** All 19 assumptions behind the loss drivers and the premium of the offer, each editable in place. `stand` is where the agents stand on them. */
function OfferAssumptions({ v, stand, mode, returnPeriods }: { v: JudgementView; stand: ReactNode | null; mode: LossMode; returnPeriods: number[] }) {
  return (
    <div>
      <div className="mb-4 space-y-3">
        {stand && <Note>{stand}</Note>}
        {mode === "depth_only" && <Note tone="warn"><strong className="font-semibold text-ink">{LOSS_MODE_LABELS.depth_only} is selected,</strong> so none of these figures takes part in the price. {selectMode("all_drivers")} to see what they do.</Note>}
      </div>
      <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
        Read along a row: the figure in force, who set it, the range code keeps it in, the reference value and what each agent proposed. Type in a box to change a figure; its unit is beside the box.
      </p>
      <FigureTable v={v} keys={SINGLE_KEYS} />
      <LadderTable v={v} title="Basement damage ladder" unit="per cent of the value below ground" keys={BASEMENT_LADDER} returnPeriods={returnPeriods} />
      <LadderTable v={v} title="Outage ladder" unit="days of lost rent or revenue" keys={OUTAGE_LADDER} returnPeriods={returnPeriods} />
      <Footnotes v={v} keys={JUDGEMENT_KEYS} />
      <TypedLine v={v} />
      <SourceLine
        className="mt-4 border-t border-line pt-3"
        sources={[
          { kind: "assumption", text: "Reference values, allowed ranges and typed figures" },
          ...(v.rows.size > 0 ? [{ kind: "ai" as const, text: "Optimist, Cautious and Agreed figures, and the reasons: written by the agents, kept in range by code" }] : []),
          ...(Object.keys(v.judgement.fromOffer).length > 0 ? [{ kind: v.documentKind, text: `Figures set by the offer: read from the document, see ${STEP_NAMES.offer}` }] : []),
        ]}
      />
    </div>
  );
}

/**
 * The flood rate under each set of assumptions on one line from zero: the band is the spread between the
 * Optimist and the Cautious, the tick the reference rate and the dot the agreed one. Every mark is named
 * with its figure in the key under the line, so nothing is read from colour or position alone.
 */
function RangeBar({ reference, agreed, optimist, cautious }: { reference: AssumptionPrice; agreed?: AssumptionPrice; optimist: AssumptionPrice; cautious: AssumptionPrice }) {
  const low = Math.min(optimist.floodRatePerMille, cautious.floodRatePerMille);
  const high = Math.max(optimist.floodRatePerMille, cautious.floodRatePerMille);
  const top = Math.max(high, reference.floodRatePerMille, agreed?.floodRatePerMille ?? 0);
  const at = (value: number) => `${top > 0 ? (value / top) * 100 : 0}%`;
  const spread = perMilleRange(optimist.floodRatePerMille, cautious.floodRatePerMille);
  const key: { mark: "bar" | "tick" | "dot"; color: string; text: string }[] = [
    { mark: "bar", color: "var(--series-1)", text: `Optimist to Cautious: ${spread}` },
    { mark: "tick", color: "var(--ink)", text: `Reference: ${perMille(reference.floodRatePerMille)}` },
    ...(agreed ? [{ mark: "dot" as const, color: "var(--series-2)", text: `Agreed by the agents: ${perMille(agreed.floodRatePerMille)}` }] : []),
  ];
  return (
    <figure className="mt-4 max-w-3xl">
      <figcaption>
        <h4 className={SUB_HEADING}>The flood rate under each set of assumptions</h4>
        <p className={SUB_TEXT}>The line runs from zero. The band is the spread between the Optimist and the Cautious, the tick is the reference rate and the dot is the agreed one.</p>
      </figcaption>
      <div className="mt-3 px-2">
        <div role="img" aria-label={key.map((item) => item.text).join(". ")} className="relative h-6">
          <span className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full border border-line bg-surface-2" />
          <span className="absolute top-1/2 h-2 min-w-1 -translate-y-1/2 rounded-full" style={{ left: at(low), width: at(high - low), background: "var(--series-1)" }} />
          <span className="absolute top-0 h-6 w-1 -translate-x-1/2 rounded-full" style={{ left: at(reference.floodRatePerMille), background: "var(--ink)" }} />
          {agreed && <span className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface" style={{ left: at(agreed.floodRatePerMille), background: "var(--series-2)" }} />}
        </div>
        <div className="tabular mt-1 flex justify-between gap-3 text-xs text-muted">
          <span>0</span>
          <span>Flood rate, per mille of insured value</span>
          <span>{rate(top)}</span>
        </div>
      </div>
      <ul aria-label="Key" className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
        {key.map((item) => (
          <li key={item.mark} className="inline-flex min-w-0 items-center gap-2">
            <LegendMark mark={item.mark} color={item.color} />
            <span className="tabular min-w-0 wrap-anywhere">{item.text}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** What the agents changed for the offer: its flood rate under the reference and the agreed assumptions, and the spread to carry. Every figure comes from the offer focus: nothing is priced here. */
function OfferAnswer({ focus, d, busy, warning, onOpenStep }: { focus: PricedFocus; d: Deliberation | null; busy: boolean; warning: ReactNode | null; onOpenStep?: (id: StepId) => void }) {
  const { assumptions } = focus.price;
  const set = (id: AssumptionPrice["id"]) => assumptions.find((a) => a.id === id);
  const reference = set("reference");
  const optimist = set("optimist");
  const cautious = set("cautious");
  const agreed = set("agreed");
  const name = focus.building.name;
  const maxRate = Math.max(0, ...assumptions.map((a) => a.floodRatePerMille));
  const maxAal = Math.max(0, ...assumptions.map((a) => a.aalGrossKes));
  const atMinimum = assumptions.some((a) => a.premiumSetBy === "minimum rate");
  const shown = (value: number) => <strong className="tabular font-semibold">{perMille(value)}</strong>;

  let headline: ReactNode = null;
  if (busy) {
    headline = "The agents are working. The flood rate under each set of assumptions appears here as the replies come in.";
  } else if (reference && agreed) {
    headline =
      perMille(reference.floodRatePerMille) === perMille(agreed.floodRatePerMille) ? (
        <>The agents left the flood rate for {name} at {shown(agreed.floodRatePerMille)}: the assumptions they agreed give the same rate as the reference ones.</>
      ) : (
        <>The agents moved the flood rate for {name} from {shown(reference.floodRatePerMille)} under the reference assumptions to {shown(agreed.floodRatePerMille)} under the ones they agreed.</>
      );
  } else if (reference) {
    headline = <>Under the reference assumptions the flood rate for {name} is {shown(reference.floodRatePerMille)}. {d ? "The Chair has not settled an agreed set." : "Run the agents on this offer to see how far their judgement moves it."}</>;
  }

  let range: ReactNode = null;
  if (d && !busy) {
    if (!optimist || !cautious) {
      range = "The range needs both the Optimist's and the Cautious proposal, and one of them did not return a valid reply.";
    } else if (optimist.aalGrossKes === 0 && cautious.aalGrossKes === 0) {
      range = <><strong className="font-semibold text-ink">The agents&apos; judgement does not move the modelled loss.</strong> The Optimist&apos;s and the Cautious assumptions both give no loss at this building. The water at the site is in the <StepLink to="hazard" onOpenStep={onOpenStep} /> step.</>;
    } else {
      range = <><strong className="font-semibold text-ink">Uncertainty to carry.</strong> Between the Optimist and the Cautious the rate runs from {perMilleRange(optimist.floodRatePerMille, cautious.floodRatePerMille)}. That gap, not the single figure, is what an underwriter should carry into the price.</>;
    }
  }

  return (
    <Card title={d ? "What the agents changed for this offer" : "Before the agents run"} className="mb-5">
      <div className="@container">
        {warning && <div className="mb-4"><Note tone="warn">{warning}</Note></div>}
        <p className="max-w-4xl text-lg leading-relaxed text-ink">{headline}</p>
        <p className="mt-1 max-w-4xl text-sm leading-relaxed text-ink-2">The flood rate is the flood premium for a year, per mille of the insured value: KES 1 for every KES 1,000 insured.{agreed?.premiumSetBy === "minimum rate" ? " The agreed rate is the minimum flood rate: the modelled premium is lower." : ""}</p>
        {focus.mode === "all_drivers" && (
          <p className="mt-2 flex max-w-4xl flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-relaxed text-ink-2">
            <PlaceholderBadge />
            <span className="min-w-0">{PLACEHOLDER_RATE_LINE}</span>
          </p>
        )}
        {range && <p className="mt-3 max-w-4xl text-sm leading-relaxed text-ink-2">{range}</p>}
        {!busy && reference && optimist && cautious && <RangeBar reference={reference} agreed={agreed} optimist={optimist} cautious={cautious} />}
        <Fold summary="The same figures as a table, with the average annual loss" className="mt-4">
          <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
            The same building and the same policy terms, priced by code under each set of assumptions. The average annual loss is gross: what the insurer pays, after the deductible and the limit.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-104 text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Assumptions</th>
                  <th className="pb-2 pl-4 text-right font-medium">Flood rate, per mille of insured value</th>
                  <th className="pb-2 pl-4 text-right font-medium">Average annual loss, gross</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {assumptions.map((a) => (
                  <tr key={a.id} className={a.inForce ? "font-semibold text-ink" : "text-ink-2"}>
                    <td className="py-2 pr-3">
                      <div className="text-ink">{a.label}{a.inForce && <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-muted">In force</span>}</div>
                      <div className="text-xs font-normal text-muted">{SET_BLURB[a.id]}{a.id !== "reference" && !a.judgementFromAgents ? "; reference figures beyond depth" : ""}</div>
                    </td>
                    <td className="py-2 pl-4"><BarValue value={a.floodRatePerMille} max={maxRate} text={`${rate(a.floodRatePerMille)}${a.premiumSetBy === "minimum rate" ? "‡" : ""}`} /></td>
                    <td className="py-2 pl-4"><BarValue value={a.aalGrossKes} max={maxAal} text={kes1(a.aalGrossKes)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {atMinimum && <p className="mt-2 text-xs leading-relaxed text-muted">‡ Set by the minimum flood rate: the modelled premium under this set is lower.</p>}
          {optimist && cautious && !busy && <p className="mt-2 text-xs leading-relaxed text-muted">Between the Optimist and the Cautious the average annual loss, gross, runs from {kesRange(optimist.aalGrossKes, cautious.aalGrossKes)}.</p>}
          {focus.mode === "depth_only" && <p className="mt-2 text-xs leading-relaxed text-muted">{LOSS_MODE_LABELS.depth_only} is selected, so these figures read the depth at the point alone.</p>}
          {Object.keys(focus.judgement.typed).length > 0 && <p className="mt-2 text-xs leading-relaxed text-muted">Typed figures are used in every row, so the rows differ only in what was not typed.</p>}
        </Fold>
        <SourceLine
          className="mt-4 border-t border-line pt-3"
          sources={[
            { kind: "assumption", text: "Reference set and the figures beyond flood depth" },
            ...(d ? [{ kind: "ai" as const, text: "Optimist, Cautious and agreed sets: chosen by the agents, priced by code" }] : []),
            { kind: focus.document.path === "model" ? ("ai" as const) : ("real" as const), text: `Building and terms: read from the offer document, see ${STEP_NAMES.offer}` },
          ]}
        />
      </div>
    </Card>
  );
}

/** What the agents changed for the portfolio: its rarest modelled flood and its average annual loss, before and after. */
function PortfolioAnswer({ session, d }: { session: Session; d: Deliberation }) {
  const before = session.reference.scenarios[session.reference.scenarios.length - 1];
  const after = d.final?.result.scenarios[d.final.result.scenarios.length - 1];
  if (!d.final || !before || !after) return null;
  const change = fmtPct(d.final.result.aalKes / session.reference.aalKes - 1, 0).replace(/^(?!-)/, "+");
  const figures: { label: string; value: string; strong?: boolean }[] = [
    { label: `${rpWithChance(before.returnPeriod)} flood, reference assumptions`, value: kes1(before.lossKes) },
    { label: `${rpWithChance(after.returnPeriod)} flood, agreed assumptions`, value: kes1(after.lossKes), strong: true },
    { label: "Average annual loss, reference assumptions", value: kes1(session.reference.aalKes) },
    { label: "Average annual loss, agreed assumptions", value: kes1(d.final.result.aalKes), strong: true },
  ];
  return (
    <Card title="What the agents changed for the portfolio" className="mb-5">
      <p className="max-w-4xl text-lg leading-relaxed text-ink">
        With the assumptions the agents agreed, the portfolio&apos;s loss in a {rpWithChance(after.returnPeriod)} flood is <strong className="tabular font-semibold">{kes1(after.lossKes)}</strong>, against <strong className="tabular font-semibold">{kes1(before.lossKes)}</strong>{after.returnPeriod === before.returnPeriod ? "" : ` in a ${rpWithChance(before.returnPeriod)} flood`} under the reference ones. The average annual loss moves from {kes1(session.reference.aalKes)} to {kes1(d.final.result.aalKes)} ({change}).
      </p>
      <p className="mt-1 max-w-4xl text-sm leading-relaxed text-ink-2">These are ground-up losses: the damage before any insurance terms.</p>
      <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))] gap-3">
        {figures.map((item) => (
          // The agreed figure is told apart by its rule and its label, not by colour alone.
          <div key={item.label} className={`min-w-0 rounded-xl bg-surface-2 p-3 ${item.strong ? "border-l-4 border-l-brand" : ""}`}>
            <dt className="wrap-anywhere text-xs leading-relaxed text-muted">{item.label}</dt>
            <dd className="tabular mt-0.5 text-xl font-semibold text-ink">{item.value}</dd>
          </div>
        ))}
      </dl>
      <SourceLine
        className="mt-4 border-t border-line pt-3"
        sources={[
          { kind: "assumption", text: "Reference assumptions" },
          { kind: "ai", text: "Agreed assumptions: chosen by the agents, losses computed by code" },
          { kind: "synthetic", text: "Portfolio of insured buildings" },
        ]}
      />
    </Card>
  );
}

/** The Chair's summary, then the Critic's challenges by title with the verdict on each; the challenge and its answer open on demand. */
function ChairCard({ d }: { d: Deliberation }) {
  const run = d.runs.chair;
  const chair = run.output;
  const challenges = d.runs.critic.output?.challenges ?? [];
  return (
    <Card title="What the Chair decided" className="mb-5">
      {run.status === "running" && <Thinking />}
      {run.status === "idle" && <p className="text-sm text-muted">Waiting for the first round.</p>}
      {run.status === "error" && <p className="text-sm leading-relaxed text-ink-2">The Chair gave no valid reply, so nothing was settled.</p>}
      {chair && <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="max-w-4xl text-base leading-relaxed text-ink">{chair.summary}</motion.p>}
      {challenges.length > 0 && (
        <div className="mt-4">
          <h4 className={SUB_HEADING}>The Critic&apos;s challenges ({challenges.length}) and the verdict on each</h4>
          <ul className="mt-1 divide-y divide-line">
            {challenges.map((c) => {
              const answer = chair?.responses.find((r) => r.challengeId === c.id);
              return (
                <li key={c.id} className="py-1">
                  <Fold summary={<><span className="text-ink">{c.id} · {c.title}</span><span className="ml-2 whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-muted">{answer ? VERDICT[answer.verdict] : "Not answered"}</span></>}>
                    <div className="max-w-4xl space-y-1 pb-2 pl-5 text-sm leading-relaxed text-ink-2">
                      <p>{c.detail}</p>
                      <p><span className="text-muted">Recommends:</span> {c.recommendation} <span className="text-muted">· {SEVERITY[c.severity]} severity</span></p>
                      {answer && <p><span className="text-muted">Chair:</span> {answer.response}</p>}
                    </div>
                  </Fold>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <SourceLine className="mt-4 border-t border-line pt-3" sources={[{ kind: "ai", text: "Written by the agents. Every figure they chose is kept in its range by code, and code does every calculation" }]} />
    </Card>
  );
}

/** The model's own parameters that reach the offer's building: its class's pair and, on a score map, the depth scale and the return periods. */
function BuildingParams({ focus, ledger }: { focus: PricedFocus; ledger: LedgerRow[] }) {
  const { building } = focus.price;
  const cls = building.housingClass;
  const isScore = focus.hazardKind === "score";
  const paths = [`fragility.${cls}`, `cap.${cls}`, ...(isScore ? ["depthScaleM", ...SCORE_TIERS.map((t) => `returnPeriods.${t}`)] : [])];
  const reference = new Map(flattenParams(REFERENCE_PARAMS).map((p) => [p.path, p.value]));
  const agreed = new Map(ledger.map((row) => [row.path, row]));
  const capped = building.perReturnPeriod.filter((r) => r.capped);
  const effect = (path: string): string => {
    if (path.startsWith("fragility.")) return "Multiplies the depth of water at the building before the damage curve is read.";
    if (path.startsWith("cap.")) return capped.length > 0 ? `Reached here: it sets the damage in the ${capped.map((r) => rpLabel(r.returnPeriod)).join(", ")} ${capped.length === 1 ? "flood" : "floods"}.` : "The most this class can lose. Not reached at this building.";
    if (path === "depthScaleM") return "Turns the hazard score at the building into a depth of water.";
    return "How often this flood comes.";
  };
  return (
    <section className="mb-6">
      <h4 className={SUB_HEADING}>The ones that reach this building ({paths.length})</h4>
      <p className={`${SUB_TEXT} mb-3`}>
        Its class is {HOUSING_LABELS[cls]}, so of the fragility and cap values only that class&apos;s pair applies.{isScore ? " The depth scale and the return periods apply to every building." : ""} Every other parameter of the model leaves this price alone.
      </p>
      <div className="overflow-x-auto">
        <table className={`w-full text-left text-sm ${ledger.length > 0 ? "min-w-176" : "min-w-120"}`}>
          <thead className="text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">Assumption</th>
              <th className="pb-2 pl-4 text-right font-medium">Reference</th>
              {ledger.length > 0 && <th className="pb-2 pl-4 text-right font-medium">Agreed</th>}
              <th className="pb-2 pl-5 font-medium">What it does to this building</th>
              {ledger.length > 0 && <th className="pb-2 pl-5 font-medium">Why the Chair chose it</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line align-top">
            {paths.map((path) => {
              const row = agreed.get(path);
              return (
                <tr key={path}>
                  <td className="py-2 pr-3 text-ink">{PARAM_LABELS[path]}</td>
                  <td className="tabular py-2 pl-4 text-right text-ink-2">{fmtNum(reference.get(path) ?? NaN)}</td>
                  {ledger.length > 0 && <td className="tabular py-2 pl-4 text-right font-semibold text-ink">{row ? `${fmtNum(row.final)}${row.adjusted ? "*" : ""}` : "-"}</td>}
                  <td className="py-2 pl-5 leading-relaxed text-ink-2">{effect(path)}</td>
                  {ledger.length > 0 && <td className="py-2 pl-5 leading-relaxed text-ink-2">{row?.reason || "No reason given."}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {paths.some((path) => agreed.get(path)?.adjusted) && <p className="mt-2 text-xs text-muted">* Outside the allowed range as proposed; corrected by code.</p>}
    </section>
  );
}

/** The ledger: every parameter of the model with the reference value, each agent's proposal, the agreed value and the Chair's reason. */
function Ledger({ ledger }: { ledger: LedgerRow[] }) {
  return (
    <section>
      <h4 className={SUB_HEADING}>Every assumption of the model ({ledger.length})</h4>
      <p className={`${SUB_TEXT} mb-3`}>
        Read along a row: the reference value the model would use by itself, what each agent proposed, the value the Chair agreed, and why. The agreed column is what the model uses from here on. Fragility is a multiplier on flood depth and a damage cap is a share of insured value (0.6 means 60%); other units are in the assumption&apos;s name.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-176 text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">Assumption</th>
              <th className="pb-2 pl-4 text-right font-medium">Reference</th>
              <th className="pb-2 pl-4 text-right font-medium">Optimist</th>
              <th className="pb-2 pl-4 text-right font-medium">Cautious</th>
              <th className="pb-2 pl-4 text-right font-medium">Agreed</th>
              <th className="pb-2 pl-5 font-medium">Why the Chair chose it</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line align-top">
            {ledger.map((row) => (
              <tr key={row.path}>
                <td className="py-2 pr-3 text-ink @6xl:whitespace-nowrap">{PARAM_LABELS[row.path]}</td>
                <td className="tabular py-2 text-right text-ink-2">{fmtNum(row.reference)}</td>
                <td className="tabular py-2 text-right text-ink-2">{row.optimist === null ? "-" : fmtNum(row.optimist)}</td>
                <td className="tabular py-2 text-right text-ink-2">{row.cautious === null ? "-" : fmtNum(row.cautious)}</td>
                <td className="tabular py-2 text-right font-semibold text-ink">{fmtNum(row.final)}{row.adjusted ? "*" : ""}</td>
                <td className="py-2 pl-5 leading-relaxed text-ink-2">{row.reason} <span className="text-muted">· leans {row.leans} · {BASIS_LABELS[row.basis as Basis] ?? row.basis}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ledger.some((r) => r.adjusted) && <p className="mt-2 text-xs text-muted">* Outside the allowed range as proposed; corrected by code.</p>}
    </section>
  );
}

/** The three assumptions that act on every building of the portfolio, with the same editing as the offer's. */
function PortfolioAssumptions({ v, mode, hasOffer }: { v: JudgementView; mode: LossMode; hasOffer: boolean }) {
  return (
    <div>
      <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">
        Every building of the portfolio is read with these three: they are behind {DRIVER_LABELS.surrounding} and {DRIVER_LABELS.overload}, beside {DRIVER_LABELS.ponding}. Type in a box to change a figure; code keeps it inside its range.
      </p>
      {mode === "depth_only" && <div className="mb-4"><Note tone="warn"><strong className="font-semibold text-ink">{LOSS_MODE_LABELS.depth_only} is selected,</strong> so none of these figures takes part in the losses. {selectMode("all_drivers")} to see what they do.</Note></div>}
      <FigureTable v={{ ...v, rows: new Map() }} keys={PORTFOLIO_KEYS} />
      <TypedLine v={v} />
      <ul className="mt-4 max-w-3xl list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
        <li>The other {JUDGEMENT_KEYS.length - PORTFOLIO_KEYS.length} assumptions (the two ladders, the value below ground, the rent, the uncertainty loading and the premium figures) act on an offer alone. {hasOffer ? `${selectView("Offer")} to set them.` : "Read one to set them."}</li>
        {v.judgement.fromOffer.drainDesignRp && <li>The offer states its own drain design return period. That is used for the offer&apos;s building alone; the portfolio keeps the assumption above.</li>}
      </ul>
      <SourceLine className="mt-4 border-t border-line pt-3" sources={[{ kind: "assumption", text: "Reference values, allowed ranges and typed figures" }, { kind: "synthetic", text: "Portfolio of insured buildings" }]} />
    </div>
  );
}

interface Props {
  session: Session;
  deliberation: Deliberation | null;
  busy: boolean;
  checks: Check[];
  status: { model: string; configured: Record<Role, boolean> } | null;
  hasSaved: boolean;
  replayed: boolean;
  /** "Saved run from 8 October 2026, model x" while the run shown is the one that ships with the app. null for the reader's own run, and when there is none. */
  shippedLabel?: string | null;
  /** True when the app ships a run made on other model data, or before the model changed, so it is not replayed here. */
  shippedOtherData?: boolean;
  /** True when the server could not be asked which agents have a key. With a shipped run to show, that counts as having no key. */
  statusFailed?: boolean;
  /** Goes back to the run that ships with the app. Given only while the reader's own run has taken its place. */
  onShipped?: () => void;
  onRun: () => void;
  onReplay: () => void;
  onImport: (file: File) => void;
  /** US dollars per million tokens, when both prices are set in .env.local. null shows no cost at all. */
  prices?: Prices | null;
  /** The priced offer while the header switch is on Offer. */
  focus?: PricedFocus | null;
  /** The offer whatever the switch says, priced or not. */
  offerFocus?: OfferFocus | null;
  /** "depth_only" or "all_drivers", as the header switch says. */
  mode?: LossMode;
  /** The assumptions beyond flood depth in force and who set each. null only before the model has loaded. */
  judgement?: FocusJudgement | null;
  /** Types over one or more of them; a figure given as undefined goes back to the agents' or the reference value. */
  onJudgement?: (next: Partial<OfferJudgement>) => void;
  onOpenStep?: (id: StepId) => void;
}

export function AgentsStep({ session, deliberation: d, busy, checks, status, hasSaved, replayed, shippedLabel = null, shippedOtherData = false, statusFailed = false, onShipped, onRun, onReplay, onImport, prices = null, focus = null, offerFocus = null, mode = "all_drivers", judgement = null, onJudgement, onOpenStep }: Props) {
  // Once a figure is typed here its fold stays open, also after the figure is handed back.
  const [typedHere, setTypedHere] = useState(false);
  // The agents are handed the offer's facts only once it is priced, whatever the "View" switch in the bar says.
  const offerArgued = focus !== null || (!!offerFocus && isPriced(offerFocus));
  const isScore = session.dataset.hazardKind === "score";
  const missingKeys = status ? (Object.keys(status.configured) as Role[]).filter((r) => !status.configured[r]) : [];
  // With a shipped run at hand, a server that did not answer about the keys is treated as having none: a live run would only fail.
  const noAnswer = statusFailed && (shippedLabel !== null || !!onShipped);
  const liveOff = missingKeys.length === 4 || noAnswer;
  const liveLine = noAnswer
    ? "A live run needs an API key, and the server did not say whether one is set."
    : missingKeys.length === 4
      ? "A live run needs an API key, and none is set."
      : missingKeys.length > 0
        ? `A live run needs an API key for: ${missingKeys.map((r) => ROLE_LABELS[r]).join(", ")}.`
        : "A live run takes its place.";
  const ledger = d ? buildLedger(REFERENCE_PARAMS, d).filter((row) => isScore || !unusedForDepth(row.path)) : [];
  const referenceRows = flattenParams(REFERENCE_PARAMS).filter((p) => isScore || !unusedForDepth(p.path));
  const critic = d?.runs.critic;

  // The agents' figures count only when they argued the offer now on screen, and only while "Agreed by agents" is on.
  const arguedThis = judgement?.agents === "this_offer";
  const agentsInUse = arguedThis && offerFocus?.assumptionsInForce === "ai" && !!judgement?.agreed;
  const referenceChosen = !busy && !!d?.final && offerFocus?.assumptionsInForce === "reference";
  const judgementView: JudgementView | null = judgement && {
    judgement,
    rows: new Map(arguedThis ? judgementLedger(d).map((row) => [row.key, row]) : []),
    agentsInUse,
    documentKind: offerFocus?.document.path === "model" ? "ai" : "real",
    portfolio: focus === null,
    onJudgement: onJudgement && ((next) => {
      setTypedHere(true);
      onJudgement(next);
    }),
    onOpenStep,
  };
  // A ladder's rung is named by its flood when there are as many floods modelled as rungs.
  const returnPeriods = (focus?.price.scenarios ?? []).map((scenario) => scenario.returnPeriod);
  const offerSets = arguedThis ? d?.offerJudgement : null;
  // Where the agents stand on the offer's figures. A warning leads the answer; anything else sits with the figures in their fold.
  const stand = judgementView ? agentsLine(judgementView, d, busy, referenceChosen) : null;
  const standWarns = referenceChosen || judgement?.agents === "another_offer";
  const beyondKeys = focus ? JUDGEMENT_KEYS : PORTFOLIO_KEYS;
  const typedOpen = typedHere || (!!judgement && beyondKeys.some((key) => key in judgement.typed));

  return (
    <div>
      <StepHeader kicker={stepKicker("agents")} title="Agents set the assumptions">
        Some figures the data cannot settle{isScore ? ", such as how deep the water is at the highest hazard score" : ", such as how fragile each kind of building is"}. They are argued here in the open before they reach {focus ? "the price" : "the losses"}.
      </StepHeader>

      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onRun} disabled={busy || liveOff}>{busy ? "Agents working…" : offerArgued ? "Run the agents on this offer" : "Run the agents"}</Button>
          {hasSaved && <Button variant="secondary" onClick={onReplay} disabled={busy}>Replay the saved run</Button>}
          {onShipped && <Button variant="secondary" onClick={onShipped} disabled={busy}>Replay the run saved with the app</Button>}
          <label className="inline-flex cursor-pointer items-center rounded-full px-4 py-2 text-sm font-medium text-ink-2 hover:bg-surface-2">
            Load a run file
            <input type="file" accept=".json" className="hidden" onChange={(e) => { if (e.target.files?.[0]) onImport(e.target.files[0]); e.target.value = ""; }} />
          </label>
          {status && <span className="text-xs text-muted">Model: {status.model}</span>}
          {replayed && <Tag kind="ai">Replayed from a saved run; engine re-run now</Tag>}
          {shippedLabel && <Tag kind="ai">{shippedLabel}</Tag>}
        </div>
        <p className="mt-3 max-w-4xl text-sm leading-relaxed text-ink-2">
          Three agents argue the assumptions the data cannot settle: an optimist, a cautious one and a critic. A chair then settles them, and code checks every figure and does every calculation. The agents read a summary of the data, never the rows, and never produce a loss figure.
        </p>
        {shippedLabel && (
          <p className="mt-2 max-w-4xl text-sm leading-relaxed text-ink-2">
            <strong className="font-semibold text-ink">This run was saved with the app.</strong> Its replies are shown as they were given, and code has worked out every figure again just now. {liveLine}
          </p>
        )}
        {shippedOtherData && <p className="mt-2 max-w-4xl text-sm leading-relaxed text-ink-2">The run saved with the app was made on different model data, so it is not replayed here.</p>}
        {d && <AgentStatuses d={d} />}
        {missingKeys.length > 0 && !d && (
          <div className="mt-3 max-w-3xl">
            <Note tone="warn">
              {missingKeys.length === 4 ? "No API keys are configured, so the agents cannot run." : `No API key for: ${missingKeys.map((r) => ROLE_LABELS[r]).join(", ")}.`} Add them to <code className="font-mono text-sm">web/.env.local</code> and restart the server. You can continue without the agents; the model then uses its reference assumptions and says so.
            </Note>
          </div>
        )}
      </Card>

      {!focus && <OfferNotice offerFocus={offerFocus} what="the assumptions beyond flood depth and what they do to its price" onOpenStep={onOpenStep} />}

      {focus && <OfferAnswer focus={focus} d={d} busy={busy} warning={standWarns ? stand : null} onOpenStep={onOpenStep} />}
      {!focus && d && <PortfolioAnswer session={session} d={d} />}

      {d?.final && judgement && (
        <StepShapley focus={focus} dataset={session.dataset} agreedParams={d.final.params} judgement={judgement} mode={mode} onOpenStep={onOpenStep} className="mb-5" />
      )}

      {d && <ChairCard d={d} />}

      <Card title="The detail, for whoever wants it">
        <div className="-my-2 divide-y divide-line">
          {judgementView && (focus ? (
            <Fold summary={`The assumptions beyond flood depth (${JUDGEMENT_KEYS.length})`} open={typedOpen} className="py-2">
              <OfferAssumptions v={judgementView} stand={standWarns ? null : stand} mode={mode} returnPeriods={returnPeriods} />
            </Fold>
          ) : (
            <Fold summary={`The assumptions beyond flood depth that reach the portfolio (${PORTFOLIO_KEYS.length})`} open={typedOpen} className="py-2">
              <PortfolioAssumptions v={judgementView} mode={mode} hasOffer={offerArgued} />
            </Fold>
          ))}

          <Fold summary={`The model's assumptions (${ledger.length > 0 ? ledger.length : referenceRows.length})`} className="py-2">
            {focus && <BuildingParams focus={focus} ledger={ledger} />}
            {ledger.length > 0 ? (
              <Ledger ledger={ledger} />
            ) : (
              <section>
                <h4 className={SUB_HEADING}>The reference values ({referenceRows.length})</h4>
                <p className={`${SUB_TEXT} mb-3`}>These are in force until the agents have run.</p>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-x-8 gap-y-1.5 text-sm">
                  {referenceRows.map((p) => (
                    <div key={p.path} className="flex justify-between gap-3 border-b border-line py-1"><span className="text-ink-2">{PARAM_LABELS[p.path]}</span><span className="tabular font-medium text-ink">{fmtNum(p.value)}</span></div>
                  ))}
                </div>
              </section>
            )}
            <SourceLine
              className="mt-4 border-t border-line pt-3"
              sources={[
                { kind: "assumption", text: "Reference values: the model's starting assumptions" },
                ...(ledger.length > 0 ? [{ kind: "ai" as const, text: "Optimist, Cautious and Agreed values, and the reasons: written by the agents, range-checked by code" }] : []),
              ]}
            />
          </Fold>

          {d && critic && (
            <Fold summary="What each agent proposed" className="py-2">
              {/* The two proposals sit side by side to be compared; the Critic's summary takes the full width below them. */}
              <div className="grid gap-4 @3xl:grid-cols-2">
                <AgentBox run={d.runs.optimist}>{d.runs.optimist.output && <ProposalBody proposal={d.runs.optimist.output} scored={d.optimist} session={session} offerFigures={offerSets?.optimist ?? null} />}</AgentBox>
                <AgentBox run={d.runs.cautious}>{d.runs.cautious.output && <ProposalBody proposal={d.runs.cautious.output} scored={d.cautious} session={session} offerFigures={offerSets?.cautious ?? null} />}</AgentBox>
                <AgentBox run={critic} className="@3xl:col-span-2">
                  {critic.output && (
                    <>
                      <p className="max-w-3xl text-sm leading-relaxed text-ink">{critic.output.summary}</p>
                      <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">Its {critic.output.challenges.length} challenges are listed above with the Chair&apos;s verdict on each.{d.offerJudgement ? " The Critic was given the offer's facts, so those about the offer are listed with those about the data." : ""}</p>
                    </>
                  )}
                </AgentBox>
              </div>
            </Fold>
          )}

          {d && !busy && (
            <Fold summary="What the run used: tokens, time and cost" className="py-2">
              <RunTotals d={d} prices={prices} />
            </Fold>
          )}

          {d && (
            <Fold summary="The exact prompts and replies" className="py-2">
              <RunTranscripts d={d} />
            </Fold>
          )}
        </div>
      </Card>

      {d && !busy && <ChecksLine checks={checks} what="the agents" onOpenStep={onOpenStep} className="mt-4" />}
    </div>
  );
}
