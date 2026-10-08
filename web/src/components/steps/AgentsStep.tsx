"use client";

import { motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { buildLedger, type AgentRun, type Deliberation, type Scored } from "@/lib/agents/orchestrate";
import { BASIS_LABELS, reasonAt, ROLE_LABELS, type Basis, type Proposal, type Role } from "@/lib/agents/schema";
import type { Check } from "@/lib/checks";
import { PARAM_LABELS, unusedForDepth } from "@/lib/export";
import { fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { flattenParams, REFERENCE_PARAMS } from "@/lib/model/params";
import type { Session } from "@/lib/session";
import { Button, Card, CheckList, ChecksSummary, Note, StatusIcon, StepHeader, Tag } from "../ui";

const ROLE_BLURB: Record<Role, string> = {
  optimist: "Argues for the least severe assumptions that can still be defended.",
  cautious: "Argues for the most severe assumptions that are still credible.",
  critic: "Challenges the data and the reference assumptions.",
  chair: "Weighs both proposals and the challenges, then settles the final set.",
};

const SEVERITY = { high: "High", medium: "Medium", low: "Low" } as const;
const VERDICT = { accepted: "Accepted", partly: "Partly accepted", rejected: "Rejected" } as const;

const ROUND_1 = "Round 1 · in parallel";
const ROUND_2 = "Round 2 · decision";

function RoundLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted ${className}`}>{children}</div>;
}

function RoleHeading({ role }: { role: Role }) {
  return (
    <div className="min-w-0">
      <h3 className="text-base font-semibold text-ink">{ROLE_LABELS[role]}</h3>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{ROLE_BLURB[role]}</p>
    </div>
  );
}

/** Who takes part, shown before a run so the reader knows what the button starts. */
function RoleCard({ role, className = "" }: { role: Role; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-surface p-5 ${className}`}>
      <RoleHeading role={role} />
    </section>
  );
}

/**
 * Boxes side by side where the card has the room, three to a row at most. The rows are kept even (four boxes
 * sit two and two, not three and one) and a short last row stretches, so no hole is left beside it.
 */
function BoxRow({ count, children }: { count: number; children: ReactNode }) {
  const perRow = Math.ceil(count / Math.ceil(count / 3)) || 1;
  return <ul className="mt-4 flex flex-wrap gap-3" style={{ "--per-row": perRow } as CSSProperties}>{children}</ul>;
}

const BOX = "min-w-0 grow basis-full rounded-xl bg-surface-2 p-3 @3xl:basis-[calc(100%/var(--per-row)_-_0.75rem)]";
const TILE = "flex min-w-0 grow basis-44 flex-col justify-center rounded-xl bg-surface-2 p-3";

function Thinking() {
  return (
    <div className="space-y-2.5 py-2" aria-label="Working">
      {[92, 76, 84, 58].map((w, i) => (
        <motion.div key={i} className="h-2.5 rounded-full bg-surface-2" style={{ width: `${w}%` }} animate={{ opacity: [0.45, 1, 0.45] }} transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.18 }} />
      ))}
    </div>
  );
}

function RunMeta({ run }: { run: AgentRun }) {
  if (run.status !== "done" && run.status !== "error") return null;
  return (
    <details className="mt-3 text-xs text-muted">
      <summary className="cursor-pointer select-none hover:text-ink-2">
        {run.model ?? "model"} · {run.ms ? `${(run.ms / 1000).toFixed(1)} s` : "-"}{run.usage?.outputTokens ? ` · ${run.usage.outputTokens.toLocaleString("en-KE")} tokens written${run.usage.thinkingTokens ? `, ${run.usage.thinkingTokens.toLocaleString("en-KE")} thinking` : ""}` : ""}{run.usage?.firstTextS !== undefined ? ` · first text after ${run.usage.firstTextS} s` : ""}{run.usage?.padded ? " · cut off after the reply was complete" : ""}{(run.attempts ?? 1) > 1 ? " · needed a retry" : ""} · show the exact prompt and reply
      </summary>
      {run.prompt && (
        <>
          <div className="mt-2 font-semibold text-ink-2">Instructions</div>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-2 p-2.5 font-mono text-xs leading-relaxed text-ink-2">{run.prompt.system}</pre>
          <div className="mt-2 font-semibold text-ink-2">Input</div>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-2 p-2.5 font-mono text-xs leading-relaxed text-ink-2">{run.prompt.user}</pre>
        </>
      )}
      {run.raw && (
        <>
          <div className="mt-2 font-semibold text-ink-2">Reply, unedited</div>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-2 p-2.5 font-mono text-xs leading-relaxed text-ink-2">{run.raw}</pre>
        </>
      )}
    </details>
  );
}

function AgentCard({ run, className = "", children }: { run: AgentRun; className?: string; children?: ReactNode }) {
  return (
    <motion.section layout className={`flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-5 ${className}`}>
      <header className="flex items-start justify-between gap-3">
        <RoleHeading role={run.role} />
        <StatusIcon status={run.status === "done" ? "pass" : run.status === "error" ? "fail" : run.status === "running" ? "running" : "idle"} />
      </header>
      {/* A container, so the body lays itself out by the width of this card and not of the screen. */}
      <div className="@container mt-3 flex-1">
        {run.status === "running" && <Thinking />}
        {run.status === "idle" && <p className="text-sm text-muted">Waiting for the first round.</p>}
        {run.status === "error" && <p className="text-sm leading-relaxed text-ink-2"><strong className="font-semibold text-ink">No valid reply.</strong> {run.error}</p>}
        {run.status === "done" && <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>{children}</motion.div>}
      </div>
      <RunMeta run={run} />
    </motion.section>
  );
}

function ProposalBody({ proposal, scored, session }: { proposal: Proposal; scored: Scored | null; session: Session }) {
  const isScore = session.dataset.hazardKind === "score";
  const rows = scored ? flattenParams(scored.params).filter((p) => isScore || !unusedForDepth(p.path)) : [];
  const ref = new Map(flattenParams(REFERENCE_PARAMS).map((p) => [p.path, p.value]));
  const rarest = scored?.result.scenarios[scored.result.scenarios.length - 1];
  return (
    <div>
      <p className="text-sm leading-relaxed text-ink">{proposal.stance}</p>
      {scored && rarest && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <div className="text-xs text-muted">What these assumptions produce, computed by code</div>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
            <span>1 in {rarest.returnPeriod}: <strong className="tabular font-semibold text-ink">{fmtKes(rarest.lossKes, 2)}</strong></span>
            <span>Average year: <strong className="tabular font-semibold text-ink">{fmtKes(scored.result.aalKes, 2)}</strong></span>
          </div>
        </div>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer select-none text-sm font-medium text-ink-2 hover:text-ink">{rows.length} values and the reason for each</summary>
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
        </ul>
      </details>
      {scored && scored.adjustments.length > 0 && (
        <p className="mt-2 text-sm text-ink-2"><strong className="font-semibold text-ink">Corrected by code:</strong> {scored.adjustments.map((a) => `${PARAM_LABELS[a.path] ?? a.path} ${fmtNum(a.from)} → ${fmtNum(a.to)}`).join("; ")}</p>
      )}
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
  onRun: () => void;
  onReplay: () => void;
  onImport: (file: File) => void;
}

export function AgentsStep({ session, deliberation: d, busy, checks, status, hasSaved, replayed, onRun, onReplay, onImport }: Props) {
  const isScore = session.dataset.hazardKind === "score";
  const missingKeys = status ? (Object.keys(status.configured) as Role[]).filter((r) => !status.configured[r]) : [];
  const ledger = d ? buildLedger(REFERENCE_PARAMS, d).filter((row) => isScore || !unusedForDepth(row.path)) : [];
  const critic = d?.runs.critic.output;
  const chair = d?.runs.chair.output;
  const refRarest = session.reference.scenarios[session.reference.scenarios.length - 1];
  const finalRarest = d?.final?.result.scenarios[d.final.result.scenarios.length - 1];

  return (
    <div>
      <StepHeader kicker="Step 3" title="Agents set the assumptions">
        The model needs judgement calls that the data cannot settle: {isScore ? "how deep a score of 1.0 is, " : ""}how fragile each kind of building is, how much of its value can be lost{isScore ? ", and how rare each tier is" : ""}. Three agents argue those out in parallel, then a Chair decides. They read a profile of the data, never the rows, and they never produce a loss figure.
      </StepHeader>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button onClick={onRun} disabled={busy || missingKeys.length === 4}>{busy ? "Agents working…" : d ? "Run the agents again" : "Run the agents"}</Button>
        {hasSaved && <Button variant="secondary" onClick={onReplay} disabled={busy}>Replay the saved run</Button>}
        <label className="inline-flex cursor-pointer items-center rounded-full px-4 py-2 text-sm font-medium text-ink-2 hover:bg-surface-2">
          Load a run file
          <input type="file" accept=".json" className="hidden" onChange={(e) => { if (e.target.files?.[0]) onImport(e.target.files[0]); e.target.value = ""; }} />
        </label>
        {status && <span className="text-xs text-muted">Model: {status.model}</span>}
        {replayed && <Tag kind="ai">Replayed from a saved run; engine re-run now</Tag>}
      </div>

      {missingKeys.length > 0 && !d && (
        <div className="mb-5 max-w-3xl">
          <Note tone="warn">
            {missingKeys.length === 4 ? "No API keys are configured, so the agents cannot run." : `No API key for: ${missingKeys.map((r) => ROLE_LABELS[r]).join(", ")}.`} Add them to <code className="font-mono text-sm">web/.env.local</code> and restart the server. You can continue without the agents; the model then uses its reference assumptions and says so.
          </Note>
        </div>
      )}

      {d && (
        <>
          <RoundLabel>{ROUND_1}</RoundLabel>
          {/* The two proposals sit side by side to be compared. The Critic takes the full width below them, so its
              challenges can sit in a row and no card is left with a tall blank under a short reply. */}
          <div className="grid gap-4 @3xl:grid-cols-2">
            <AgentCard run={d.runs.optimist}>{d.runs.optimist.output && <ProposalBody proposal={d.runs.optimist.output} scored={d.optimist} session={session} />}</AgentCard>
            <AgentCard run={d.runs.cautious}>{d.runs.cautious.output && <ProposalBody proposal={d.runs.cautious.output} scored={d.cautious} session={session} />}</AgentCard>
            <AgentCard run={d.runs.critic} className="@3xl:col-span-2">
              {critic && (
                <div>
                  <p className="max-w-3xl text-sm leading-relaxed text-ink">{critic.summary}</p>
                  <BoxRow count={critic.challenges.length}>
                    {critic.challenges.map((c) => (
                      <li key={c.id} className={BOX}>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
                          <span className="font-semibold text-ink">{c.id} · {c.title}</span>
                          <span className="ml-auto whitespace-nowrap text-xs text-muted">{SEVERITY[c.severity]} severity</span>
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-ink-2">{c.detail}</p>
                        <p className="mt-1 text-sm leading-relaxed text-ink-2"><span className="text-muted">Recommends:</span> {c.recommendation}</p>
                      </li>
                    ))}
                  </BoxRow>
                </div>
              )}
            </AgentCard>
          </div>

          <RoundLabel className="mt-6">{ROUND_2}</RoundLabel>
          <AgentCard run={d.runs.chair}>
            {chair && (
              <div>
                {/* On a wide card the three figures sit beside the summary, which keeps its reading width. */}
                <div className="grid gap-x-6 gap-y-4 @6xl:grid-cols-[minmax(0,65ch)_minmax(0,1fr)]">
                  <p className="max-w-3xl text-base leading-relaxed text-ink">{chair.summary}</p>
                  {finalRarest && (
                    <div className="flex flex-wrap gap-3">
                      <div className={TILE}><div className="text-xs text-muted">1 in {refRarest.returnPeriod}, reference values</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(refRarest.lossKes, 2)}</div></div>
                      <div className={TILE}><div className="text-xs text-muted">1 in {finalRarest.returnPeriod}, agreed values</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtKes(finalRarest.lossKes, 2)}</div></div>
                      <div className={TILE}><div className="text-xs text-muted">Change in average annual loss</div><div className="tabular mt-0.5 text-lg font-semibold text-ink">{fmtPct(d.final!.result.aalKes / session.reference.aalKes - 1, 0).replace(/^(?!-)/, "+")}</div></div>
                    </div>
                  )}
                </div>
                {/* One box per challenge, in the same columns as the Critic's card, so an answer sits under its challenge. */}
                {critic && (
                  <BoxRow count={critic.challenges.length}>
                    {critic.challenges.map((c) => {
                      const a = chair.responses.find((r) => r.challengeId === c.id);
                      return (
                        <li key={c.id} className={`${BOX} text-sm leading-relaxed`}>
                          <span className="font-semibold text-ink">{c.id} · {c.title}</span>
                          <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-muted">{a ? VERDICT[a.verdict] : "Not answered"}</span>
                          {a && <div className="text-ink-2">{a.response}</div>}
                        </li>
                      );
                    })}
                  </BoxRow>
                )}
              </div>
            )}
          </AgentCard>

          {ledger.length > 0 && (
            <Card title="Assumption ledger" aside={<Tag kind="ai" />} className="mt-4">
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
            </Card>
          )}

          {checks.length > 0 && !busy && (
            <Card title="Checks on the agents" aside={<ChecksSummary checks={checks} />} className="mt-4">
              {/* Two lists side by side where there is room: the lines are short, and one list leaves most of a wide card blank. */}
              <div className="grid gap-x-10 @4xl:grid-cols-2">
                <CheckList checks={checks.slice(0, Math.ceil(checks.length / 2))} />
                {checks.length > 1 && <div className="border-t border-line @4xl:border-t-0"><CheckList checks={checks.slice(Math.ceil(checks.length / 2))} /></div>}
              </div>
            </Card>
          )}
        </>
      )}

      {!d && (
        <>
          <Card title="Reference assumptions" aside={<Tag kind="assumption" />}>
          <p className="mb-3 text-sm leading-relaxed text-ink-2">These are in force until the agents have run. They are also the &ldquo;without AI&rdquo; side of the comparison in the results.</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-x-8 gap-y-1.5 text-sm">
            {flattenParams(REFERENCE_PARAMS).filter((p) => isScore || !unusedForDepth(p.path)).map((p) => (
              <div key={p.path} className="flex justify-between gap-3 border-b border-line py-1"><span className="text-ink-2">{PARAM_LABELS[p.path]}</span><span className="tabular font-medium text-ink">{fmtNum(p.value)}</span></div>
            ))}
          </div>
          </Card>
          <div className="mt-5 grid gap-x-4 gap-y-5 @5xl:grid-cols-4">
            <div className="flex flex-col @5xl:col-span-3">
              <RoundLabel>{ROUND_1}</RoundLabel>
              <div className="grid flex-1 gap-4 @3xl:grid-cols-3">
                <RoleCard role="optimist" />
                <RoleCard role="cautious" />
                <RoleCard role="critic" />
              </div>
            </div>
            <div className="flex flex-col">
              <RoundLabel>{ROUND_2}</RoundLabel>
              <RoleCard role="chair" className="flex-1" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
