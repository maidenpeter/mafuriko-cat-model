"use client";

import type { Deliberation } from "@/lib/agents/orchestrate";
import type { Check, CheckGroup } from "@/lib/checks";
import { buildAudit, buildNote, LIMITS, PARAM_LABELS, TERMS_NOTICE, termRows, unusedForDepth } from "@/lib/export";
import { fmtNum } from "@/lib/format";
import { kes1 } from "@/lib/labels";
import { flattenParams, REFERENCE_PARAMS } from "@/lib/model/params";
import type { TermsResult } from "@/lib/model/terms";
import { download, slim, type Active, type LogEntry, type Session } from "@/lib/session";
import { SourceBadge } from "../charts/ChartFrame";
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
  /** The insurance terms in force and what they do to every event. */
  terms: TermsResult;
}

export function AuditStep({ session, active, deliberation, checks, log, terms }: Props) {
  const isScore = session.dataset.hazardKind === "score";
  const ref = new Map(flattenParams(REFERENCE_PARAMS).map((p) => [p.path, p.value]));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const base = `mafuriko-${session.dataset.name}-${stamp}`;

  return (
    <div>
      <StepHeader kicker="Step 9" title="Audit">
        Everything needed to challenge or reproduce this result: every check, every assumption and where it came from, the limits of the model, and a log of what ran.
      </StepHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => download(`${base}-note.md`, buildNote(session, active, deliberation, checks, terms), "text/markdown")}>Download the written note</Button>
        <Button variant="secondary" onClick={() => download(`${base}-audit.json`, JSON.stringify(buildAudit(session, active, deliberation, checks, log, terms), null, 1))}>Download the full audit file</Button>
        {deliberation?.final && <Button variant="ghost" onClick={() => download(`${base}-agent-run.json`, JSON.stringify(slim(deliberation), null, 1))}>Save the agent run for replay</Button>}
      </div>

      <Card title="All checks" aside={<ChecksSummary checks={checks} />}>
        {/* The groups flow down one column and on into the next, so a short group sits under another short one
            and no column is left half empty. A group is never split across two columns. */}
        <div className="-mb-5 gap-x-8 @3xl:columns-2 @6xl:columns-3">
          {GROUPS.map((g) => {
            const group = checks.filter((c) => c.group === g.id);
            if (group.length === 0) return null;
            return (
              <div key={g.id} className="break-inside-avoid pb-5">
                <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{g.title}</div>
                <CheckList checks={group} stagger={70} />
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Insurance terms in force" className="mt-4" aside={<SourceBadge kind="assumption" />}>
        <p className="-mt-2 mb-4 text-sm font-medium text-ink">{TERMS_NOTICE}</p>
        {/* The terms on the left, what they come to on the right; one under the other where there is no room for both. */}
        <div className="grid gap-x-10 gap-y-5 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-112 text-sm">
              <thead className="text-xs text-muted"><tr><th className="pb-2 text-left font-medium">Term</th><th className="pb-2 pl-3 text-left font-medium">In force</th><th className="pb-2 pl-3 text-left font-medium">Source</th></tr></thead>
              <tbody className="divide-y divide-line">
                {termRows(terms).map((row) => (
                  <tr key={row.term}><td className="py-1.5 align-top text-ink-2">{row.term}</td><td className="tabular py-1.5 pl-3 align-top font-semibold text-ink">{row.value}</td><td className="py-1.5 pl-3 align-top whitespace-nowrap text-muted">Example term</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="min-w-0 space-y-4 text-sm leading-relaxed text-ink-2">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Excess of loss applied</div>
              <p>
                Pays the part of the retained loss in one event above <span className="tabular font-semibold text-ink">{kes1(terms.xol.attachmentKes)}</span>, up to <span className="tabular font-semibold text-ink">{kes1(terms.xol.limitKes)}</span>.{" "}
                {terms.xol.attachmentIsDefault && terms.xol.limitIsDefault
                  ? "Both figures are the defaults, read off the retained losses."
                  : `The attachment ${terms.xol.attachmentIsDefault ? "is the default" : "was typed in"}; the limit ${terms.xol.limitIsDefault ? "is the default" : "was typed in"}.`}
              </p>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Average annual loss</div>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                <dt>Ground-up, before any terms</dt><dd className="tabular text-right font-semibold text-ink">{kes1(terms.aal.groundUpKes)}</dd>
                <dt>Gross, after deductibles and limits</dt><dd className="tabular text-right font-semibold text-ink">{kes1(terms.aal.grossKes)}</dd>
                <dt>Net, after reinsurance</dt><dd className="tabular text-right font-semibold text-ink">{kes1(terms.aal.netKes)}</dd>
              </dl>
            </div>
          </div>
        </div>
      </Card>

      {/* Where there is room for columns, the limits run across the full width in short lines, and the run log
          sits beside the assumption table and takes the table's height. Stacked on a narrow screen. */}
      <div className="mt-4 grid gap-4 @3xl:grid-cols-2 @6xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card title="Assumptions in force" aside={<Tag kind={active.source === "ai" ? "ai" : "assumption"}>{active.source === "ai" ? "Agreed by the agents" : "Reference values"}</Tag>}>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted"><tr><th className="pb-2 text-left font-medium">Assumption</th><th className="pb-2 pl-3 text-right font-medium">In force</th><th className="pb-2 pl-3 text-right font-medium">Reference</th></tr></thead>
            <tbody className="divide-y divide-line">
              {flattenParams(active.params).filter((p) => isScore || !unusedForDepth(p.path)).map((p) => (
                <tr key={p.path}><td className="py-1.5 text-ink-2">{PARAM_LABELS[p.path]}</td><td className="tabular py-1.5 pl-3 text-right font-semibold text-ink">{fmtNum(p.value)}</td><td className="tabular py-1.5 pl-3 text-right text-muted">{fmtNum(ref.get(p.path)!)}</td></tr>
              ))}
            </tbody>
          </table>
          {active.source === "ai" && <p className="mt-3 text-xs text-muted">The reason for each value is in the assumption ledger in step 3 and in the written note.</p>}
        </Card>

        <Card title="What this model cannot tell you" className="@3xl:col-span-full @3xl:row-start-1">
          <ul className="-mb-2 gap-x-8 text-sm leading-relaxed text-ink-2 @3xl:columns-2 @6xl:columns-3">
            {LIMITS.filter((l) => isScore || !/score|tiers are assumed|proxy/.test(l)).map((l) => (
              <li key={l} className="flex break-inside-avoid gap-2.5 pb-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-axis" />{l}</li>
            ))}
          </ul>
        </Card>

        <Card title="Run log" className="flex flex-col">
          {/* Beside the table the log asks for no height of its own: it fills what the table gives it and scrolls inside.
              Where the log is narrow the message takes its own line under the time and step, so it is not squeezed into a sliver. */}
          <ol className="@container max-h-72 space-y-1 overflow-auto font-mono text-xs leading-relaxed text-ink-2 @3xl:max-h-none @3xl:min-h-48 @3xl:flex-[1_1_0px]">
            {log.map((entry, i) => (
              <li key={i} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 pb-1 @xl:grid-cols-[5.5rem_7rem_minmax(0,1fr)] @xl:pb-0">
                <span className="tabular text-muted">{entry.at.slice(11, 23)}</span>
                <span className="text-ink">{entry.step}</span>
                <span className="col-span-2 wrap-break-word @xl:col-span-1">{entry.message}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
