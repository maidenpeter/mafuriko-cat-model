"use client";

/**
 * Audit: everything needed to challenge or reproduce the result, on one page and as a PDF.
 *
 *   The offer on record     its one line, where it stands, and the decision recorded on the Results step
 *   All checks              six groups: data, hazard, vulnerability, financial and terms, agents, the offer
 *   Extraction record       what was sent, what came back, which path read it, and one row per value
 *                           with its source sentence and the result of the check on it
 *   Agent usage and cost    per agent and in total; a cost only when token prices are set on the server
 *   Model data, insurance terms, assumptions and where each came from, limits, run log
 *   Exports                 the print view (save as PDF), the written note, the audit file, the agent run
 *
 * The page is laid out once as plain rows (auditPage) and drawn twice from them: on screen, and as a
 * self-contained black on white document for printing (auditHtml). Nothing is priced here: every
 * offer figure and every check on the offer comes from the focus (lib/offer/focus).
 *
 * The offer's sections show in Offer mode, and for an offer that could not be priced, where the
 * record of how it was read is all there is. In Portfolio mode with a priced offer the step is the
 * portfolio's audit, with one line saying an offer is loaded.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { Deliberation } from "@/lib/agents/orchestrate";
import { ROLES } from "@/lib/agents/schema";
import { costOf, fmtUsd, usageRows, usageTotals, type Prices, type UsageSource } from "@/lib/agents/usage";
import type { Check, CheckStatus } from "@/lib/checks";
import { checkGroups, flagCountText, headlineFlags, type AuditGroup } from "@/lib/dashboard";
import { DECISION_LABELS, type DecisionRecord } from "@/lib/decision";
import { escapeHtml, fmtNoteDate } from "@/lib/decisionNote";
import { buildAudit, buildNote, type ExportExtras, type OasisReference, LIMITS, PARAM_LABELS, TERMS_NOTICE, termRows, unusedForDepth } from "@/lib/export";
import { fmtInt, fmtNum } from "@/lib/format";
import { kes1 } from "@/lib/labels";
import { flattenParams, REFERENCE_PARAMS } from "@/lib/model/params";
import type { TermsResult } from "@/lib/model/terms";
import { isPriced, type OfferFocus, type OfferFocusProps } from "@/lib/offer/focus";
import { download, slim, type Active, type LogEntry, type Session } from "@/lib/session";
import { STEP_NAMES, stepKicker, type StepId } from "@/lib/steps";
import { SourceBadge, SourceLine } from "../charts/ChartFrame";
import { Button, Card, CheckList, ChecksSummary, Note, StepHeader, Tag } from "../ui";

interface Props extends OfferFocusProps {
  session: Session;
  active: Active;
  deliberation: Deliberation | null;
  checks: Check[];
  log: LogEntry[];
  /** The insurance terms in force and what they do to every event. */
  terms: TermsResult;
  /** Where the model data was read from, when it came from the folder or the built-in sample. */
  modelSource?: { source: "folder" | "sample"; folderName: string; reason: string | null };
  /** The model data's origin in the header's words: "Nairobi starter kit, from the model data folder". */
  dataSource?: string;
  /** Token prices set on the server, or null when none are set: no cost is shown without them. */
  prices?: Prices | null;
  /** The underwriter's decision on the offer, as recorded on the Results step. */
  decision?: DecisionRecord | null;
  /** Opens another step of the walkthrough. */
  onOpenStep?: (id: StepId) => void;
}

const STATUS_WORD: Record<CheckStatus, string> = { pass: "Pass", warn: "Warning", fail: "Fail" };
const NOT_REPORTED = "not reported";

/** A table as plain text: what the screen and the print view both draw. */
interface Rows {
  head: string[];
  rows: string[][];
  /** A closing row of totals, when the table has one. */
  total?: string[];
}

/** The whole audit as plain rows and sentences. */
interface AuditPage {
  dataSource: string;
  model: [string, string][];
  offer: { line: string; document: string; status: string; decision: [string, string][] } | null;
  groups: AuditGroup[];
  extraction: {
    facts: [string, string][];
    sentTitle: string;
    sent: { label: string; text: string }[];
    received: string | null;
    receivedNote: string;
    fields: Rows;
  } | null;
  usage: { table: Rows | null; notes: string[] };
  terms: Rows;
  termsAal: [string, string][];
  xol: string;
  assumptionsSource: string;
  assumptions: Rows;
  limits: string[];
}

const tokens = (n: number | null) => (n === null ? NOT_REPORTED : fmtInt(n));

function usageTable(deliberation: Deliberation | null, offer: OfferFocus | null, prices: Prices | null): AuditPage["usage"] {
  const sources: UsageSource[] = deliberation ? ROLES.map((role) => deliberation.runs[role]).filter((run) => run.status === "done" || run.status === "error") : [];
  if (offer && (offer.document.path === "model" || offer.document.model !== null || offer.document.usage !== null)) {
    sources.push({ role: "reader", label: "Offer reader", model: offer.document.model, ms: offer.document.ms, usage: offer.document.usage });
  }
  if (sources.length === 0) return { table: null, notes: ["No model has been called in this session, so there is no usage to report."] };
  const rows = usageRows(sources);
  const totals = usageTotals(rows);
  const cost = (item: Parameters<typeof costOf>[0]) => (prices ? [fmtUsd(costOf(item, prices))] : []);
  const table: Rows = {
    head: ["Agent", "Model", "Tokens in", "Tokens out", "Thinking tokens", "Seconds", ...(prices ? ["Cost"] : [])],
    rows: rows.map((r) => [r.label, r.model ?? NOT_REPORTED, tokens(r.inputTokens), tokens(r.outputTokens), tokens(r.thinkingTokens), r.seconds === null ? NOT_REPORTED : fmtNum(r.seconds, 1), ...cost(r)]),
    total: ["Total", totals.models.join(", ") || NOT_REPORTED, fmtInt(totals.inputTokens), fmtInt(totals.outputTokens), fmtInt(totals.thinkingTokens), fmtNum(totals.seconds, 1), ...cost(totals)],
  };
  const notes = [
    prices
      ? `Cost uses the prices set on the server: USD ${fmtNum(prices.inPerM)} per million input tokens and USD ${fmtNum(prices.outPerM)} per million output and thinking tokens.`
      : "No cost is shown: no token prices are set on the server.",
    ...(totals.unreported > 0 ? [`${fmtInt(totals.unreported)} of ${fmtInt(totals.agents)} calls reported no token counts, so the totals leave them out.`] : []),
    ...(totals.retried > 0 ? [`${fmtInt(totals.retried)} ${totals.retried === 1 ? "agent was" : "agents were"} asked more than once. Only the last call's tokens are reported, so those counts are understated; the seconds cover every call.`] : []),
    ...(deliberation ? ["The first round runs three agents side by side, so the total of seconds is time worked, not time waited."] : []),
  ];
  return { table, notes };
}

function extractionRecord(offer: OfferFocus): NonNullable<AuditPage["extraction"]> {
  const doc = offer.document;
  const byModel = doc.path === "model";
  const facts: [string, string][] = [
    ["Document", doc.name],
    ["Read by", byModel ? "The hosted model, then checked by code" : "The fixed rules, in the browser"],
    ["Why", doc.why],
    ...(doc.model ? ([["Model", doc.model]] as [string, string][]) : []),
    ...(doc.ms !== null ? ([["Time taken", `${fmtNum(doc.ms / 1000, 1)} seconds`]] as [string, string][]) : []),
    ["Removed first", doc.removedLine],
  ];
  const sent = doc.sent
    ? [
        { label: "Instructions", text: doc.sent.system },
        { label: "Message, with the document as sent", text: doc.sent.user },
      ]
    : [{ label: doc.sentToModel ? "The document as sent (the server did not report the instructions)" : "The text the rules read. Nothing was sent to a hosted model", text: doc.text }];
  const several = offer.buildings.length > 1;
  return {
    facts,
    sentTitle: doc.sentToModel ? "What was sent" : "What was read",
    sent,
    received: doc.replyJson,
    receivedNote: doc.replyJson ? "The reply as the server handed it back." : doc.sentToModel ? "No usable reply came back." : "Nothing was received: no model was called.",
    fields: {
      head: ["Field", "Value", "Source sentence", "Check"],
      rows: offer.fields.map((f) => [
        `${several && f.row !== null ? `Building ${f.row + 1}: ` : ""}${f.label}`,
        f.value || "Not stated",
        f.quote.trim(),
        `${f.origin}${f.reason ? `. ${f.reason}` : ""}${f.holdsPricing ? " Pricing waits for this value." : ""}`,
      ]),
    },
  };
}

export function auditPage(p: { session: Session; active: Active; deliberation: Deliberation | null; checks: Check[]; terms: TermsResult; modelSource: Props["modelSource"]; dataSource: string; prices: Prices | null; decision: DecisionRecord | null; offer: OfferFocus | null }): AuditPage {
  const { session, active, terms, offer, decision } = p;
  const { dataset } = session;
  const isScore = dataset.hazardKind === "score";
  const ref = new Map(flattenParams(REFERENCE_PARAMS).map((x) => [x.path, x.value]));

  const model: [string, string][] = [
    [
      "Source",
      p.modelSource?.source === "folder"
        ? `The model data folder on this machine, named ${p.modelSource.folderName}`
        : p.modelSource?.source === "sample"
          ? `The sample data set that ships with the app. The model data folder was not used${p.modelSource.reason ? `: ${p.modelSource.reason}` : "."}`
          : p.dataSource,
    ],
    ["Data set", dataset.name],
    ["Hazard maps", `${fmtInt(dataset.scenarios.length)} ${isScore ? "tiers, read as a hazard score" : "flood depth maps"}`],
    ["Insured buildings", fmtInt(dataset.buildings.length)],
    ["Flood source", dataset.drainage ? "Terrain and drainage" : "Terrain only"],
  ];

  let offerPart: AuditPage["offer"] = null;
  if (offer) {
    const recorded = decision && decision.recordedAt && decision.choice ? decision : null;
    const ticked = recorded ? offer.conditions.filter((c) => recorded.conditions.includes(c.id)) : [];
    const top = headlineFlags(offer.flags, 0);
    offerPart = {
      line: offer.line.text || offer.documentName,
      document: offer.documentName,
      status: offer.statusLine,
      decision: recorded
        ? [
            ["Decision", DECISION_LABELS[recorded.choice!]],
            ["Recorded", fmtNoteDate(recorded.recordedAt)],
            ...(ticked.length > 0 ? ([["Conditions", ticked.map((c) => c.text).join(" ")]] as [string, string][]) : []),
            ...(recorded.note.trim() ? ([["Note", recorded.note.trim()]] as [string, string][]) : []),
            ["Points to weigh", flagCountText(top.counts)],
          ]
        : [
            ["Decision", "None recorded"],
            ["Points to weigh", flagCountText(top.counts)],
          ],
    };
  }

  const offerTerms: string[][] = offer
    ? [
        ["This offer: flood deductible", offer.terms.deductible.text, `${offer.terms.deductible.source}${offer.terms.deductible.mixed ? ", part typed by you" : ""}`],
        ["This offer: flood limit", offer.terms.limit.text, `${offer.terms.limit.source}${offer.terms.limit.mixed ? ", part typed by you" : ""}`],
      ]
    : [];

  return {
    dataSource: p.dataSource,
    model,
    offer: offerPart,
    groups: checkGroups(p.checks, offer?.checks ?? []),
    extraction: offer ? extractionRecord(offer) : null,
    usage: usageTable(p.deliberation, offer, p.prices),
    terms: {
      head: ["Term", "In force", "Source"],
      rows: [...offerTerms.map((r) => [r[0], r[1], r[2][0].toUpperCase() + r[2].slice(1)]), ...termRows(terms).map((row) => [offer ? `Portfolio: ${row.term[0].toLowerCase()}${row.term.slice(1)}` : row.term, row.value, "Example term"])],
    },
    termsAal: [
      ["Ground-up, before any terms", kes1(terms.aal.groundUpKes)],
      ["Gross, after deductibles and limits", kes1(terms.aal.grossKes)],
      ["Net, after reinsurance", kes1(terms.aal.netKes)],
    ],
    xol: `Pays the part of the retained loss in one event above ${kes1(terms.xol.attachmentKes)}, up to ${kes1(terms.xol.limitKes)}. ${
      terms.xol.attachmentIsDefault && terms.xol.limitIsDefault
        ? "Both figures are the defaults, read off the retained losses."
        : `The attachment ${terms.xol.attachmentIsDefault ? "is the default" : "was typed in"}; the limit ${terms.xol.limitIsDefault ? "is the default" : "was typed in"}.`
    }`,
    assumptionsSource: active.source === "ai" ? "Agreed by the agents" : "Reference values",
    assumptions: {
      head: ["Assumption", "In force", "Reference", "Where it came from"],
      rows: flattenParams(active.params)
        .filter((x) => isScore || !unusedForDepth(x.path))
        .map((x) => {
          const reference = ref.get(x.path)!;
          const moved = Math.abs(x.value - reference) > 1e-9;
          return [PARAM_LABELS[x.path], fmtNum(x.value), fmtNum(reference), active.source === "ai" ? (moved ? "Agents, moved from the reference" : "Agents, kept at the reference") : "Reference value"];
        }),
    },
    limits: LIMITS.filter((l) => isScore || !/score|tiers are assumed|proxy/.test(l)),
  };
}

// ---------------------------------------------------------------------------------------------
// The print view: one self-contained document, black on white, with no script in it.
// ---------------------------------------------------------------------------------------------

const PRINT_CSS = `
@page { margin: 14mm; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 10.5pt/1.45 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: black; background: white; }
h1 { font-size: 18pt; margin: 0 0 4px; }
h2 { font-size: 13pt; margin: 22px 0 6px; padding-bottom: 3px; border-bottom: 1.5px solid black; break-after: avoid; }
h3 { font-size: 10.5pt; margin: 12px 0 4px; break-after: avoid; }
p { margin: 4px 0; }
table { width: 100%; border-collapse: collapse; margin: 6px 0; }
th, td { border: 1px solid black; padding: 3px 6px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { font-weight: 600; }
tr { break-inside: avoid; }
tr.total td { font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 6px 0; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: 4px 0; padding-left: 18px; }
pre { margin: 4px 0; padding: 6px; border: 1px solid black; font: 8.5pt/1.35 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.status { font-weight: 600; white-space: nowrap; }
.small { font-size: 9pt; }
`;

export function auditHtml(page: AuditPage, log: LogEntry[], generated: Date): string {
  const e = escapeHtml;
  const table = (t: Rows) =>
    `<table><thead><tr>${t.head.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${r.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`).join("")}${
      t.total ? `<tr class="total">${t.total.map((c) => `<td>${e(c)}</td>`).join("")}</tr>` : ""
    }</tbody></table>`;
  const facts = (rows: [string, string][]) => `<dl>${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl>`;
  const parts: string[] = [];
  parts.push(`<h1>Mafuriko audit</h1>`, `<p>Generated ${e(fmtNoteDate(generated))}. Model data: ${e(page.dataSource)}.</p>`);
  parts.push(`<p class="small">The portfolio is synthetic. Every loss figure is worked out by code; a language model reads the offer document and proposes assumptions, and code checks both.</p>`);
  if (page.offer) {
    parts.push(`<h2>The offer on record</h2>`, `<p><strong>${e(page.offer.line)}</strong></p>`, `<p>From ${e(page.offer.document)}. ${e(page.offer.status)}</p>`, facts(page.offer.decision));
  }
  parts.push(`<h2>All checks</h2>`);
  for (const g of page.groups) {
    parts.push(`<h3>${e(g.title)}</h3>`, `<table><tbody>${g.checks.map((c) => `<tr><td class="status">${e(STATUS_WORD[c.status])}</td><td><strong>${e(c.title)}</strong><br>${e(c.detail)}</td></tr>`).join("")}</tbody></table>`);
  }
  if (page.extraction) {
    const x = page.extraction;
    parts.push(`<h2>Extraction record</h2>`, facts(x.facts), `<h3>Values read, one row per field</h3>`, table(x.fields));
    parts.push(`<h3>${e(x.sentTitle)}</h3>`, ...x.sent.map((s) => `<p>${e(s.label)}:</p><pre>${e(s.text)}</pre>`));
    parts.push(`<h3>What was received</h3>`, `<p>${e(x.receivedNote)}</p>`, x.received ? `<pre>${e(x.received)}</pre>` : "");
  }
  parts.push(`<h2>Agent usage and cost</h2>`, page.usage.table ? table(page.usage.table) : "", `<ul>${page.usage.notes.map((n) => `<li>${e(n)}</li>`).join("")}</ul>`);
  parts.push(`<h2>Model data</h2>`, facts(page.model));
  parts.push(`<h2>Insurance terms in force</h2>`, `<p>${e(TERMS_NOTICE)}.</p>`, table(page.terms), `<p>Excess of loss applied: ${e(page.xol)}</p>`, `<h3>Portfolio average annual loss</h3>`, facts(page.termsAal));
  parts.push(`<h2>Assumptions in force: ${e(page.assumptionsSource.toLowerCase())}</h2>`, table(page.assumptions));
  parts.push(`<h2>What this model cannot tell you</h2>`, `<ul>${page.limits.map((l) => `<li>${e(l)}</li>`).join("")}</ul>`);
  parts.push(`<h2>Run log</h2>`, `<table><tbody>${log.map((entry) => `<tr><td class="status">${e(entry.at.slice(11, 23))}</td><td>${e(entry.step)}</td><td>${e(entry.message)}</td></tr>`).join("")}</tbody></table>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mafuriko audit</title><style>${PRINT_CSS}</style></head><body>${parts.join("\n")}</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------------------------

const KICKER = "text-xs font-semibold uppercase tracking-[0.14em] text-muted";

/** Label and value pairs in columns that fit the room. */
function Facts({ rows, className = "" }: { rows: [string, string][]; className?: string }) {
  return (
    <dl className={`grid grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-x-8 gap-y-3 text-sm ${className}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="wrap-anywhere font-semibold text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A plain table from rows of text. `numeric` names the columns set right, as figures. */
function PlainTable({ table, numeric = [], minWidth = "min-w-112", wrap = [] }: { table: Rows; numeric?: number[]; minWidth?: string; wrap?: number[] }) {
  const align = (i: number) => (numeric.includes(i) ? "tabular text-right whitespace-nowrap" : wrap.includes(i) ? "wrap-anywhere" : "");
  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${minWidth} text-sm`}>
        <thead className="text-xs text-muted">
          <tr>
            {table.head.map((h, i) => (
              <th key={h} scope="col" className={`pb-2 font-medium ${i > 0 ? "pl-3" : ""} ${numeric.includes(i) ? "text-right" : "text-left"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i} className={`py-1.5 align-top ${i > 0 ? "pl-3" : ""} ${i === 0 ? "text-ink-2" : i === 1 ? "font-semibold text-ink" : "text-ink-2"} ${align(i)}`}>{cell}</td>
              ))}
            </tr>
          ))}
          {table.total && (
            <tr className="border-t-2 border-axis">
              {table.total.map((cell, i) => (
                <td key={i} className={`py-1.5 align-top font-semibold text-ink ${i > 0 ? "pl-3" : ""} ${align(i)}`}>{cell}</td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A long text kept closed until asked for, scrolling inside its own box. */
function Folded({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
      <summary className="cursor-pointer text-sm font-semibold text-ink">{title}</summary>
      <div className="mt-2 space-y-3">{children}</div>
    </details>
  );
}

const Raw = ({ text }: { text: string }) => <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-ink-2">{text}</pre>;

export function AuditStep({ session, active, deliberation, checks, log, terms, modelSource, dataSource, prices = null, decision = null, focus = null, offerFocus = null, onOpenStep }: Props) {
  const isScore = session.dataset.hazardKind === "score";
  const [printNote, setPrintNote] = useState<string | null>(null);
  // The saved Oasis run ships with the app as a small file. The written note compares it with this run; without it the note says so.
  const [oasis, setOasis] = useState<OasisReference | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/oasis/reference.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((found: OasisReference | null) => {
        if (live) setOasis(found);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // The offer's sections show in Offer mode, and for an offer that could not be priced.
  const read = offerFocus && offerFocus.status !== "locating" ? offerFocus : null;
  const offer: OfferFocus | null = focus ?? (read && !isPriced(read) ? read : null);
  const offerHidden = !offer && read !== null;

  const source = dataSource ?? `${session.dataset.name}, read from ${session.uploadName}`;
  const page = auditPage({ session, active, deliberation, checks, terms, modelSource, dataSource: source, prices, decision, offer });
  const allChecks = [...checks, ...(offer?.checks ?? [])];

  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const base = () => `mafuriko-${session.dataset.name}-${stamp()}`;

  /** Opens the print view in a new window and asks the browser to print it; "Save as PDF" is one of the printers. */
  const print = () => {
    const html = auditHtml(page, log, new Date());
    const w = window.open("", "_blank");
    if (!w) {
      download(`${base()}-audit.html`, html, "text/html");
      setPrintNote("The browser blocked the print window, so the audit was downloaded as a page instead. Open it and print it from there.");
      return;
    }
    setPrintNote(null);
    w.document.open();
    w.document.write(html);
    w.document.close();
    // The page holds no script: the print call comes from here, once the new window has laid the page out.
    window.setTimeout(() => {
      w.focus();
      w.print();
    }, 200);
  };

  // The written note and the audit file take the offer whatever the header switch says, with the decision,
  // the data source, the token prices and the saved Oasis run.
  const extras: ExportExtras = { offer: read, decision, oasis, dataSource: source, prices };

  return (
    <div>
      <StepHeader kicker={stepKicker("audit")} title={STEP_NAMES.audit}>
        Everything needed to challenge or reproduce this result: every check, {offer ? "how the offer was read, " : ""}what the agents used, every assumption and where it came from, the limits of the model, and a log of what ran.
      </StepHeader>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button onClick={print}>Print or save the audit as PDF</Button>
        <Button variant="secondary" onClick={() => download(`${base()}-note.md`, buildNote(session, active, deliberation, checks, terms, extras), "text/markdown")}>Download the written note</Button>
        <Button variant="secondary" onClick={() => download(`${base()}-audit.json`, JSON.stringify(buildAudit(session, active, deliberation, checks, log, terms, extras), null, 1))}>Download the full audit file</Button>
        {deliberation?.final && <Button variant="ghost" onClick={() => download(`${base()}-agent-run.json`, JSON.stringify(slim(deliberation), null, 1))}>Save the agent run for replay</Button>}
      </div>
      <p className="-mt-2 mb-4 max-w-3xl text-xs leading-relaxed text-muted">The print view opens in a new window as a plain black on white page. Choose &quot;Save as PDF&quot; as the printer to keep it as a file.</p>
      {printNote && <div className="mb-4"><Note tone="warn">{printNote}</Note></div>}

      {offerHidden && read && (
        <div className="mb-4">
          <Note>An offer is loaded ({read.documentName}). Switch the view to Offer in the bar at the top to add its checks, its extraction record and its decision to this page and to the PDF.</Note>
        </div>
      )}

      {offer && page.offer && (
        <Card title="The offer on record" className="mb-4">
          <p className="-mt-2 wrap-anywhere text-base font-semibold text-ink">{page.offer.line}</p>
          {offer.outside ? (
            <div className="mt-3">
              <Note tone="warn">
                <strong className="font-semibold text-ink">{offer.outsideMessage}.</strong> {offer.coverage} There is no loss figure to audit; the record of how the document was read is below.
              </Note>
            </div>
          ) : !isPriced(offer) ? (
            <div className="mt-3">
              <Note tone="warn">
                <strong className="font-semibold text-ink">{offer.statusLine}</strong> The record of how the document was read is below.
              </Note>
            </div>
          ) : (
            <p className="mt-1 wrap-anywhere text-sm leading-relaxed text-ink-2">From {page.offer.document}. {page.offer.status}</p>
          )}
          <Facts rows={page.offer.decision} className="mt-4" />
          {isPriced(offer) && (
            <p className="mt-3 text-xs leading-relaxed text-muted">
              The figures, the points to weigh with their evidence and the decision note are in {STEP_NAMES.results}.
              {onOpenStep && (
                <>
                  {" "}
                  <button type="button" className="font-medium text-ink underline underline-offset-2" onClick={() => onOpenStep("results")}>Open {STEP_NAMES.results}</button>
                </>
              )}
            </p>
          )}
        </Card>
      )}

      <Card title="All checks" aside={<ChecksSummary checks={allChecks} />}>
        {/* The groups flow down one column and on into the next, so a short group sits under another short one
            and no column is left half empty. A group is never split across two columns. */}
        <div className="-mb-5 gap-x-8 @3xl:columns-2 @6xl:columns-3">
          {page.groups.map((g) => (
            <div key={g.id} className="break-inside-avoid pb-5">
              <div className={`mb-1 ${KICKER}`}>{g.title}</div>
              <CheckList checks={g.checks} stagger={70} />
            </div>
          ))}
        </div>
      </Card>

      {offer && page.extraction && (
        <Card title="Extraction record" className="mt-4" aside={<SourceBadge kind={offer.document.path === "model" ? "ai" : "real"} />}>
          <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">How the document became the values that were priced. Each value is kept only with the sentence it rests on; code looked for that sentence in the document&apos;s own text.</p>
          <Facts rows={page.extraction.facts} />
          <div className="mt-4 grid gap-3 @4xl:grid-cols-2">
            <Folded title={page.extraction.sentTitle}>
              {page.extraction.sent.map((s) => (
                <div key={s.label}>
                  <div className="mb-1 text-xs text-muted">{s.label}</div>
                  <Raw text={s.text} />
                </div>
              ))}
            </Folded>
            <Folded title="What was received">
              <p className="text-sm text-ink-2">{page.extraction.receivedNote}</p>
              {page.extraction.received && <Raw text={page.extraction.received} />}
            </Folded>
          </div>
          <div className={`mb-2 mt-5 ${KICKER}`}>Values read, one row per field</div>
          <div className="max-h-144 overflow-y-auto">
            <PlainTable table={page.extraction.fields} minWidth="min-w-[44rem]" wrap={[1, 2, 3]} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            &quot;AI, verified&quot;: read by the model and found again in the document by code. &quot;AI, unverified&quot;: not found again, so not used until confirmed. &quot;rules&quot;: read by the fixed rules. &quot;confirmed&quot; and &quot;edited&quot;: decided by the underwriter. The document with each sentence marked is in {STEP_NAMES.offer}.
          </p>
        </Card>
      )}

      <Card title="Agent usage and cost" className="mt-4" aside={<SourceBadge kind="ai" />}>
        {page.usage.table && <PlainTable table={page.usage.table} numeric={page.usage.table.head.map((_, i) => i).filter((i) => i >= 2)} minWidth="min-w-[40rem]" wrap={[1]} />}
        <ul className={`space-y-1 text-xs leading-relaxed text-muted ${page.usage.table ? "mt-3" : "-mt-2"}`}>
          {page.usage.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Card>

      <Card title="Model data" className="mt-4">
        <Facts rows={page.model} className="-mt-2" />
        <SourceLine
          className="mt-4 border-t border-line pt-3"
          sources={[
            { kind: "real", text: isScore ? "Hazard maps; the hazard score read from them is a derived proxy" : "Hazard maps" },
            { kind: "synthetic", text: "Portfolio of insured buildings" },
          ]}
        />
      </Card>

      <Card title="Insurance terms in force" className="mt-4" aside={<SourceBadge kind="assumption" />}>
        <p className="-mt-2 mb-4 text-sm font-medium text-ink">{offer ? "The portfolio is on example terms, not from any real policy or treaty. The offer's own terms are in the first two rows." : TERMS_NOTICE}</p>
        {/* The terms on the left, what they come to on the right; one under the other where there is no room for both. */}
        <div className="grid gap-x-10 gap-y-5 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <PlainTable table={page.terms} wrap={[1, 2]} />
          <div className="min-w-0 space-y-4 text-sm leading-relaxed text-ink-2">
            <div>
              <div className={`mb-1 ${KICKER}`}>Excess of loss applied</div>
              <p>{page.xol}</p>
            </div>
            <div>
              <div className={`mb-1 ${KICKER}`}>Portfolio average annual loss</div>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                {page.termsAal.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt>{k}</dt>
                    <dd className="tabular text-right font-semibold text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </Card>

      {/* Where there is room for columns, the limits run across the full width in short lines, and the run log
          sits beside the assumption table and takes the table's height. Stacked on a narrow screen. */}
      <div className="mt-4 grid gap-4 @3xl:grid-cols-2 @6xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="Assumptions in force" aside={<Tag kind={active.source === "ai" ? "ai" : "assumption"}>{page.assumptionsSource}</Tag>}>
          <p className="-mt-2 mb-3 text-sm leading-relaxed text-ink-2">Each row is one value the model uses, beside the reference value it started from.</p>
          <PlainTable table={page.assumptions} numeric={[1, 2]} minWidth="min-w-[30rem]" />
          {active.source === "ai" && <p className="mt-3 text-xs text-muted">The reason for each value is in the assumption ledger in the {STEP_NAMES.agents} step and in the written note.</p>}
        </Card>

        <Card title="What this model cannot tell you" className="@3xl:col-span-full @3xl:row-start-1">
          <ul className="-mb-2 gap-x-8 text-sm leading-relaxed text-ink-2 @3xl:columns-2 @6xl:columns-3">
            {page.limits.map((l) => (
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
