"use client";

import type { Deliberation } from "@/lib/agents/orchestrate";
import type { Check, CheckGroup } from "@/lib/checks";
import { buildAudit, buildNote, LIMITS, PARAM_LABELS, unusedForDepth } from "@/lib/export";
import { fmtNum } from "@/lib/format";
import { flattenParams, REFERENCE_PARAMS } from "@/lib/model/params";
import { download, slim, type Active, type LogEntry, type Session } from "@/lib/session";
import { Button, Card, CheckList, ChecksSummary, StepHeader, Tag } from "../ui";

const GROUPS: { id: CheckGroup; title: string }[] = [
  { id: "data", title: "Reading the data" },
  { id: "hazard", title: "Hazard" },
  { id: "ai", title: "Agents" },
  { id: "vulnerability", title: "Vulnerability" },
  { id: "financial", title: "Financial" },
];

interface Props {
  session: Session;
  active: Active;
  deliberation: Deliberation | null;
  checks: Check[];
  log: LogEntry[];
}

export function AuditStep({ session, active, deliberation, checks, log }: Props) {
  const isScore = session.dataset.hazardKind === "score";
  const ref = new Map(flattenParams(REFERENCE_PARAMS).map((p) => [p.path, p.value]));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const base = `mafuriko-${session.dataset.name}-${stamp}`;

  return (
    <div>
      <StepHeader kicker="Step 7" title="Audit">
        Everything needed to challenge or reproduce this result: every check, every assumption and where it came from, the limits of the model, and a log of what ran.
      </StepHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => download(`${base}-note.md`, buildNote(session, active, deliberation, checks), "text/markdown")}>Download the written note</Button>
        <Button variant="secondary" onClick={() => download(`${base}-audit.json`, JSON.stringify(buildAudit(session, active, deliberation, checks, log), null, 1))}>Download the full audit file</Button>
        {deliberation?.final && <Button variant="ghost" onClick={() => download(`${base}-agent-run.json`, JSON.stringify(slim(deliberation), null, 1))}>Save the agent run for replay</Button>}
      </div>

      <Card title="All checks" aside={<ChecksSummary checks={checks} />}>
        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
          {GROUPS.map((g) => {
            const group = checks.filter((c) => c.group === g.id);
            if (group.length === 0) return null;
            return (
              <div key={g.id}>
                <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{g.title}</div>
                <CheckList checks={group} stagger={70} />
              </div>
            );
          })}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Assumptions in force" aside={<Tag kind={active.source === "ai" ? "ai" : "assumption"}>{active.source === "ai" ? "Agreed by the agents" : "Reference values"}</Tag>}>
          <table className="w-full text-[13px]">
            <thead className="text-xs text-muted"><tr><th className="pb-2 text-left font-medium">Assumption</th><th className="pb-2 text-right font-medium">In force</th><th className="pb-2 text-right font-medium">Reference</th></tr></thead>
            <tbody className="divide-y divide-line">
              {flattenParams(active.params).filter((p) => isScore || !unusedForDepth(p.path)).map((p) => (
                <tr key={p.path}><td className="py-1.5 text-ink-2">{PARAM_LABELS[p.path]}</td><td className="tabular py-1.5 text-right font-semibold text-ink">{fmtNum(p.value)}</td><td className="tabular py-1.5 text-right text-muted">{fmtNum(ref.get(p.path)!)}</td></tr>
              ))}
            </tbody>
          </table>
          {active.source === "ai" && <p className="mt-3 text-xs text-muted">The reason for each value is in the assumption ledger in step 3 and in the written note.</p>}
        </Card>

        <Card title="What this model cannot tell you">
          <ul className="space-y-2 text-sm leading-relaxed text-ink-2">
            {LIMITS.filter((l) => isScore || !/score|tiers are assumed|proxy/.test(l)).map((l) => (
              <li key={l} className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-axis" />{l}</li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Run log" className="mt-4">
        <ol className="max-h-72 space-y-1 overflow-auto font-mono text-[12px] leading-relaxed text-ink-2">
          {log.map((entry, i) => (
            <li key={i} className="grid grid-cols-[5.5rem_7rem_1fr] gap-2">
              <span className="tabular text-muted">{entry.at.slice(11, 23)}</span>
              <span className="text-ink">{entry.step}</span>
              <span>{entry.message}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
