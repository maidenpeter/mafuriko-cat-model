/**
 * The printable decision note: one A4 page as a complete HTML document in a string.
 * Pure: inline CSS only, system fonts, black on white, no scripts, no outside resources.
 *
 * How to use it (in a click handler in the browser):
 *   const html = buildDecisionNoteHtml(input);
 *   const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
 *   const a = document.createElement("a");
 *   a.href = url; a.download = decisionNoteFileName(input.offer.insured, new Date()); a.click();
 *   URL.revokeObjectURL(url);
 * The reader opens the file and prints it (or saves it as PDF) from the browser.
 *
 * Every piece of text is escaped here, so pass raw strings. Money is passed as raw shillings.
 */

import { DECISION_LABELS, EVIDENCE_LABELS, SEVERITY_LABELS, sortFlags } from "./decision";
import type { DecisionRecord, Flag } from "./decision";
import { fmtKes, fmtNum } from "./format";
import { perMille, PLACEHOLDER_BADGE, PLACEHOLDER_RATE_LINE, rpLabel, SETTER_WORDS } from "./labels";

export type DecisionNoteInput = {
  /** The offer in one line. */
  offer: {
    insured: string;
    location: string;
    sumInsuredKes: number | null;
    /** For example "Flood, material damage and business interruption". */
    coverSought: string;
  };
  figures: {
    grossLoss100Kes: number | null;
    averageAnnualLossKes: number | null;
    pureRatePerMille: number | null;
    /** The flood premium per mille of the sum insured, when a premium was built up. It then leads the third box, with the pure rate under it. */
    floodRatePerMille?: number | null;
    /** Change to the portfolio's 1-in-100 gross loss when this offer is added, in shillings: the figure the capital load is worked out from. The box says "gross". */
    portfolioChange100Kes: number | null;
    /** The same change as a fraction of the portfolio's 1-in-100 before the offer (0.004 is 0.4%). Optional. */
    portfolioChange100Fraction?: number | null;
  };
  lossByReturnPeriod: { returnPeriodYears: number; groundUpKes: number | null; grossKes: number | null }[];
  /**
   * The loss drivers behind the figures. Left out, the note is the short one: loss by return period
   * and nothing on drivers. Given, the note carries the loss by driver, the premium build-up, the
   * assumptions in force and the questions for the broker, and the rest is set tighter so a typical
   * offer still prints on one page.
   */
  drivers?: {
    /** "All loss drivers" or "Depth only": what the losses on the note count. */
    basis: string;
    /** The drivers that take part in the price, in the order they are added up. One column each. */
    columns: { id: string; label: string }[];
    /** The names of the drivers that take no part, said in one line under the table. */
    off: string[];
    /** One row per modelled return period. byDriverKes is ground-up, keyed by column id. */
    rows: { returnPeriodYears: number; byDriverKes: Record<string, number>; groundUpKes: number; grossKes: number }[];
  };
  /** The premium build-up, top to bottom. Amounts in shillings a year. */
  premium?: {
    /** `placeholder` marks the capital load and the minimum: worked from figures only Kenya Re underwriting can set. */
    lines: { label: string; kes: number; ratePerMille: number; note?: string; total?: boolean; placeholder?: boolean }[];
    floodPremiumKes: number;
    floodRatePerMille: number;
    /** "modelled" or "minimum rate": which of the two set the flood premium. */
    setBy: string;
    /** The offer's own premium for all risks, when it states one. */
    stated?: { premiumKes: number; ratePerMille: number } | null;
    /** The document's own flood loss history as one sentence: a sense check, not part of the price. */
    history?: string;
  };
  /** Every assumption in force behind the drivers and the premium: its short name, its value in words, and who set it. `placeholder` marks the cost of capital and the minimum rate. */
  assumptions?: { label: string; value: string; setBy: "offer" | "agents" | "typed" | "reference"; placeholder?: boolean }[];
  /** The questions for the broker, in the order to ask them. */
  questions?: string[];
  flags: Flag[];
  /** Every suggested condition on the page. The ticked ones are read from decision.conditions. */
  conditions: { id: string; text: string }[];
  decision: DecisionRecord;
  terms: {
    /** "document" when the terms were read from the offer, "example" when the page used example terms. */
    source: "document" | "example";
    lines: { label: string; value: string }[];
  };
  footer: {
    modelVersion: string;
    /** Where the model data came from, for example "Bundled sample data" or an upload name and date. */
    dataSource: string;
    /** "agents" when the agents' assumptions are in force, "reference" for the reference set. */
    assumptions: "agents" | "reference";
    /** When the note was made. Defaults to now. */
    generatedAt?: Date | string;
  };
};

/** Printed on every note. */
export const STANDING_LIMITS = "Synthetic portfolio and a proxy hazard: an illustration, not a quotation.";

export const MAX_FLAGS_ON_NOTE = 6;
export const MAX_CONDITIONS_ON_NOTE = 6;
export const MAX_RETURN_PERIODS_ON_NOTE = 6;
export const MAX_TERMS_ON_NOTE = 6;
/** With the loss drivers on the note, fewer points are printed so the page still holds everything. */
export const MAX_FLAGS_WITH_DRIVERS = 4;
export const MAX_QUESTIONS_ON_NOTE = 8;
const SET_BY_ORDER = ["offer", "agents", "typed", "reference"] as const;
const headed = (text: string) => text[0].toUpperCase() + text.slice(1);
/** Who set an assumption, in the words the note groups them under: the counted form of the one table in labels.ts (SETTER_WORDS). */
export const SET_BY_LABELS = Object.fromEntries(SET_BY_ORDER.map((who) => [who, headed(SETTER_WORDS[who].counted)])) as Record<(typeof SET_BY_ORDER)[number], string>;
const MAX_NOTE_CHARS = 600;
const MAX_FLAG_TEXT_CHARS = 200;

const TIME_ZONE = "Africa/Nairobi";

/** Makes any text safe to place in HTML, in an element or in an attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3).trimEnd()}...` : clean;
};

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** 8 October 2026, 14:25 (Nairobi time) */
export function fmtNoteDate(value: Date | string | null | undefined): string {
  const date = asDate(value);
  if (!date) return "not recorded";
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: TIME_ZONE });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });
  return `${day}, ${time} (Nairobi time)`;
}

/** +KES 1.2m, -KES 85,000, KES 0 */
function fmtSignedKes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value === 0) return fmtKes(0);
  return `${value > 0 ? "+" : "-"}${fmtKes(Math.abs(value))}`;
}

function fmtSignedPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "";
  const body = `${fmtNum(Math.abs(fraction) * 100, 2)}%`;
  return fraction === 0 ? body : `${fraction > 0 ? "+" : "-"}${body}`;
}

const fmtRate = perMille;

/** The placeholder badge as the note prints it, after the figure it marks. */
const badge = (placeholder: boolean | undefined) => (placeholder ? ` <span class="tag">${escapeHtml(PLACEHOLDER_BADGE)}</span>` : "");

/** decision-note-acme-mills-ltd-2026-10-08.html. The date is the day in Nairobi. */
export function decisionNoteFileName(insured: string, date: Date | string = new Date()): string {
  const slug = insured
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const when = asDate(date);
  const day = when
    ? new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE }).format(when)
    : "";
  return ["decision-note", slug || "offer", day].filter(Boolean).join("-") + ".html";
}

const more = (hidden: number, one: string, many: string) =>
  hidden > 0 ? `<p class="more">${hidden} more ${hidden === 1 ? one : many} on screen, not shown here.</p>` : "";

const CSS = `
@page { size: A4; margin: 12mm 14mm; }
* { box-sizing: border-box; }
html { background: white; }
body { margin: 0 auto; max-width: 182mm; padding: 8mm 0; color: black; background: white;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 9.5pt; line-height: 1.3; }
h1 { font-size: 14pt; margin: 0; }
h2 { font-size: 9.5pt; margin: 9pt 0 3pt; padding-bottom: 1.5pt; border-bottom: 1pt solid black; text-transform: uppercase; letter-spacing: 0.04em; }
p { margin: 0 0 2pt; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 8pt; border-bottom: 2pt solid black; padding-bottom: 3pt; }
.offer { margin-top: 5pt; font-size: 10.5pt; }
.figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5pt; }
.figure { border: 1pt solid black; padding: 4pt 5pt; }
.figure .label { font-size: 8pt; }
.figure .value { font-size: 12pt; font-weight: 700; }
.figure .sub { font-size: 8pt; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10pt; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: right; padding: 1.5pt 4pt; border-bottom: 0.5pt solid black; }
th:first-child, td:first-child { text-align: left; }
th { font-weight: 700; }
ul { list-style: none; margin: 0; padding: 0; }
li { margin: 0 0 3pt; break-inside: avoid; }
.tag { display: inline-block; border: 1pt solid black; padding: 0 3pt; font-size: 8pt; font-weight: 700; margin-right: 3pt; }
.tag.high { background: black; color: white; }
.tag.low { border-style: dashed; }
.evidence { margin-left: 8pt; padding-left: 5pt; border-left: 1.5pt solid black; font-size: 8.5pt; }
.box { display: inline-block; width: 15pt; font-family: ui-monospace, Consolas, monospace; }
.decision { border: 1.5pt solid black; padding: 5pt 6pt; break-inside: avoid; }
.decision .choice { font-size: 12pt; font-weight: 700; }
.more { font-size: 8.5pt; font-style: italic; }
.sign { display: flex; gap: 14pt; margin-top: 10pt; }
.sign span { flex: 1; border-top: 0.5pt solid black; padding-top: 1.5pt; font-size: 8pt; }
footer { margin-top: 8pt; padding-top: 3pt; border-top: 1pt solid black; font-size: 8pt; }
.hint { border: 1pt dashed black; padding: 4pt 6pt; margin-bottom: 8pt; }
.small { font-size: 8pt; }
tr.total td { font-weight: 700; border-top: 1pt solid black; }
ol.inline { margin: 0; padding: 0; list-style: none; font-size: 8pt; }
ol.inline li { display: inline; margin: 0 6pt 0 0; }
body.tight { font-size: 8.5pt; line-height: 1.24; }
body.tight h2 { font-size: 8.5pt; margin: 6pt 0 2pt; }
body.tight li { margin-bottom: 2pt; }
body.tight .figure .value { font-size: 11pt; }
body.tight .evidence { font-size: 8pt; }
body.tight .sign { margin-top: 8pt; }
@media print { body { padding: 0; max-width: none; } .hint { display: none; } }
`;

/** A complete HTML document for one printed A4 page. */
export function buildDecisionNoteHtml(input: DecisionNoteInput): string {
  const e = escapeHtml;
  const { offer, figures, decision, terms, footer } = input;

  // With the drivers on the note there is more to fit on the page, so the lists are set tighter.
  const tight = Boolean(input.drivers || input.premium || input.assumptions?.length || input.questions);
  const flagChars = tight ? 130 : MAX_FLAG_TEXT_CHARS;

  const allFlags = sortFlags(input.flags);
  const flags = allFlags.slice(0, tight ? MAX_FLAGS_WITH_DRIVERS : MAX_FLAGS_ON_NOTE);
  const flagItems = flags
    .map((flag) => {
      const detail = clip(flag.detail, flagChars);
      const evidence = clip(flag.evidence.text, flagChars);
      const quoted = flag.evidence.kind === "quote" ? `&quot;${e(evidence)}&quot;` : e(evidence);
      const evidenceLine =
        evidence && evidence !== detail
          ? `<div class="evidence">${e(EVIDENCE_LABELS[flag.evidence.kind])}: ${quoted}</div>`
          : "";
      return `<li><span class="tag ${flag.severity}">${e(SEVERITY_LABELS[flag.severity])}</span><strong>${e(flag.title)}</strong>${detail ? `. ${e(detail)}` : ""}${evidenceLine}</li>`;
    })
    .join("\n");

  // Ticked conditions are never dropped in favour of unticked ones.
  const ticked = new Set(decision.conditions);
  const orderedConditions = [
    ...input.conditions.filter((c) => ticked.has(c.id)),
    ...input.conditions.filter((c) => !ticked.has(c.id)),
  ];
  const conditions = orderedConditions.slice(0, Math.max(MAX_CONDITIONS_ON_NOTE, orderedConditions.filter((c) => ticked.has(c.id)).length));
  const selectedItem = (text: string) => `<li><span class="box">[x]</span><strong>Selected.</strong> ${e(text)}</li>`;
  // On the tight page the suggestions not selected run on in one small paragraph; the selected ones keep a line each.
  const unticked = conditions.filter((c) => !ticked.has(c.id));
  const conditionItems = tight
    ? [
        ...conditions.filter((c) => ticked.has(c.id)).map((c) => selectedItem(c.text)),
        ...(unticked.length > 0 ? [`<li class="small"><span class="box">[ ]</span>Not selected: ${unticked.map((c) => e(c.text.replace(/\.$/, ""))).join("; ")}.</li>`] : []),
      ].join("\n")
    : conditions.map((c) => (ticked.has(c.id) ? selectedItem(c.text) : `<li><span class="box">[ ]</span>Not selected. ${e(c.text)}</li>`)).join("\n");

  // The loss by driver: one column per driver that takes part, then the ground-up loss they add up to and the gross loss.
  const drivers = input.drivers;
  const driverRows = drivers
    ? [...drivers.rows]
        .sort((a, b) => a.returnPeriodYears - b.returnPeriodYears)
        .slice(-MAX_RETURN_PERIODS_ON_NOTE)
        .map(
          (row) =>
            `<tr><td>${e(rpLabel(row.returnPeriodYears))}</td>${drivers.columns.map((c) => `<td>${e(fmtKes(row.byDriverKes[c.id] ?? 0))}</td>`).join("")}<td>${e(fmtKes(row.groundUpKes))}</td><td>${e(fmtKes(row.grossKes))}</td></tr>`,
        )
        .join("\n")
    : "";
  const driverTable = drivers
    ? `<div id="loss-by-driver">
<h2>Loss by driver, ground-up (${e(drivers.basis)})</h2>
${driverRows ? `<table><thead><tr><th>Return period</th>${drivers.columns.map((c) => `<th>${e(c.label)}</th>`).join("")}<th>Ground-up</th><th>Gross</th></tr></thead><tbody>\n${driverRows}\n</tbody></table>` : "<p>No losses by driver were supplied.</p>"}
${drivers.off.length > 0 ? `<p class="more">Not in this price: ${e(drivers.off.join(", "))}.</p>` : ""}
</div>`
    : "";

  const premium = input.premium;
  const premiumRows = premium
    ? premium.lines
        .map((line) => `<tr${line.total ? ' class="total"' : ""}><td>${e(line.label)}${line.note ? ` <span class="small">(${e(line.note)})</span>` : ""}${badge(line.placeholder)}</td><td>${e(fmtKes(line.kes))}</td><td>${e(fmtRate(line.ratePerMille))}</td></tr>`)
        .join("\n")
    : "";
  const statedShare = premium?.stated && premium.stated.ratePerMille > 0 ? `${fmtNum((premium.floodRatePerMille / premium.stated.ratePerMille) * 100, 1)}%` : null;
  const premiumBlock = premium
    ? `<div id="premium">
<h2>Premium build-up, a year</h2>
<table><thead><tr><th>Line</th><th>KES</th><th>Rate</th></tr></thead><tbody>\n${premiumRows}\n</tbody></table>
<p class="small">Flood premium ${e(fmtKes(premium.floodPremiumKes))}, ${e(fmtRate(premium.floodRatePerMille))}, set by the ${premium.setBy === "minimum rate" ? "minimum rate" : "modelled figures"}. ${
        premium.stated
          ? `The offer's own premium for all risks: ${e(fmtKes(premium.stated.premiumKes))}, ${e(fmtRate(premium.stated.ratePerMille))}${statedShare ? `; the flood rate is ${e(statedShare)} of it` : ""}.`
          : "The offer states no premium for all risks."
      }${premium.history ? ` ${e(premium.history)}` : ""}</p>
</div>`
    : "";

  const assumed = input.assumptions ?? [];
  const assumptionGroups = SET_BY_ORDER.map((who) => ({ who, items: assumed.filter((a) => a.setBy === who) })).filter((g) => g.items.length > 0);
  const assumptionsBlock =
    assumed.length > 0
      ? `<div id="assumptions">
<h2>Assumptions in force (${assumed.length}), and who set each</h2>
${assumptionGroups.map((g) => `<p class="small"><strong>${e(SET_BY_LABELS[g.who])} (${g.items.length}):</strong> ${g.items.map((a) => `${e(a.label)} ${e(a.value)}${badge(a.placeholder)}`).join("; ")}.</p>`).join("\n")}
</div>`
      : "";

  const allQuestions = input.questions ?? [];
  const questions = allQuestions.slice(0, MAX_QUESTIONS_ON_NOTE);
  const questionsBlock = input.questions
    ? `<div id="questions">
<h2>Questions for the broker (${allQuestions.length})</h2>
${questions.length > 0 ? `<ol class="inline">\n${questions.map((q, i) => `<li><strong>${i + 1}.</strong> ${e(clip(q, 160))}</li>`).join("\n")}\n</ol>` : "<p>None: the document states every value the price needs.</p>"}
${more(allQuestions.length - questions.length, "question", "questions")}
</div>`
    : "";

  const periods = [...input.lossByReturnPeriod]
    .sort((a, b) => a.returnPeriodYears - b.returnPeriodYears)
    .slice(-MAX_RETURN_PERIODS_ON_NOTE);
  const periodRows = periods
    .map(
      (row) =>
        `<tr><td>${e(rpLabel(row.returnPeriodYears))}</td><td>${e(fmtKes(row.groundUpKes))}</td><td>${e(fmtKes(row.grossKes))}</td></tr>`,
    )
    .join("\n");

  const termLines = terms.lines.slice(0, MAX_TERMS_ON_NOTE);
  const termRows = termLines.map((line) => `<tr><td>${e(line.label)}</td><td>${e(line.value)}</td></tr>`).join("\n");
  const termsSource =
    terms.source === "document"
      ? "Terms read from the offer document."
      : "Example terms: the offer document did not give terms, so these are placeholders and not the broker's.";

  const choiceLabel = decision.choice ? DECISION_LABELS[decision.choice] : "No decision recorded";
  const fullNote = decision.note.trim();
  const note = fullNote.length > MAX_NOTE_CHARS ? `${fullNote.slice(0, MAX_NOTE_CHARS - 3).trimEnd()}...` : fullNote;
  const noteShortened = note !== fullNote ? `<p class="more">Note shortened to fit the page; the full note is on screen.</p>` : "";

  const changePct = fmtSignedPct(figures.portfolioChange100Fraction);
  const figure = (label: string, value: string, sub = "") =>
    `<div class="figure"><div class="label">${e(label)}</div><div class="value">${e(value)}</div>${sub ? `<div class="sub">${e(sub)}</div>` : ""}</div>`;

  const assumptions =
    footer.assumptions === "agents" ? "Assumptions in force: set by the agents." : "Assumptions in force: reference set.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Decision note: ${e(offer.insured)}</title>
<style>${CSS}</style>
</head>
<body${tight ? ' class="tight"' : ""}>
<p class="hint">To keep a copy on paper or as a PDF, print this page (Ctrl+P, or Cmd+P on a Mac). This box is not printed.</p>
<div class="head"><h1>Flood decision note</h1><span>${e(fmtNoteDate(footer.generatedAt ?? new Date()))}</span></div>
<p class="offer" id="offer"><strong>${e(offer.insured)}</strong>, ${e(offer.location)}. Sum insured ${e(fmtKes(offer.sumInsuredKes))}. Cover sought: ${e(offer.coverSought)}.</p>

<h2>Key figures${drivers ? ` (losses from: ${e(drivers.basis)})` : ""}</h2>
<div class="figures" id="figures">
${figure("1-in-100 gross loss", fmtKes(figures.grossLoss100Kes))}
${figure("Average annual loss, gross", fmtKes(figures.averageAnnualLossKes))}
${
  figures.floodRatePerMille !== null && figures.floodRatePerMille !== undefined
    ? figure("Flood rate", fmtRate(figures.floodRatePerMille), `of sum insured; pure rate ${fmtRate(figures.pureRatePerMille)}`)
    : figure("Pure rate", fmtRate(figures.pureRatePerMille), "of sum insured")
}
${figure("Change to the portfolio's 1-in-100, gross", fmtSignedKes(figures.portfolioChange100Kes), changePct)}
</div>
${figures.floodRatePerMille !== null && figures.floodRatePerMille !== undefined ? `<p class="small" id="placeholders">${e(PLACEHOLDER_RATE_LINE)}</p>` : ""}

${driverTable}

<div class="cols">
${
  drivers
    ? premiumBlock
    : `<div id="loss-table">
<h2>Loss by return period</h2>
${periodRows ? `<table><thead><tr><th>Return period</th><th>Ground-up</th><th>Gross</th></tr></thead><tbody>\n${periodRows}\n</tbody></table>` : "<p>No losses by return period were supplied.</p>"}
</div>`
}
<div id="terms">
<h2>Terms used</h2>
<p><strong>${e(termsSource)}</strong></p>
${termRows ? `<table><tbody>\n${termRows}\n</tbody></table>` : "<p>No terms were supplied.</p>"}
${more(terms.lines.length - termLines.length, "term", "terms")}
</div>
</div>

<div id="flags">
<h2>Points for the underwriter (${allFlags.length}), most severe first</h2>
${flagItems ? `<ul>\n${flagItems}\n</ul>` : "<p>No flags were raised.</p>"}
${more(allFlags.length - flags.length, "flag", "flags")}
</div>

<div id="conditions">
<h2>Suggested conditions</h2>
${conditionItems ? `<ul>\n${conditionItems}\n</ul>` : "<p>No conditions were suggested.</p>"}
${more(orderedConditions.length - conditions.length, "suggestion", "suggestions")}
</div>

${questionsBlock}

${assumptionsBlock}
${drivers ? "" : premiumBlock}

<div id="decision">
<h2>Underwriter's decision</h2>
<div class="decision">
<p><span class="choice">${e(choiceLabel)}</span> &nbsp; Recorded: ${e(fmtNoteDate(decision.recordedAt))}</p>
<p><strong>Note:</strong> ${note ? e(note) : "No note was written."}</p>
${noteShortened}
<div class="sign"><span>Underwriter</span><span>Signature</span><span>Date</span></div>
</div>
<p class="more">The tool does not accept or decline. The decision above is the underwriter's.</p>
</div>

<footer id="footer">
<p>Model version: ${e(footer.modelVersion)}. Model data: ${e(footer.dataSource)}. ${e(assumptions)}</p>
<p><strong>${e(STANDING_LIMITS)}</strong></p>
</footer>
</body>
</html>
`;
}
