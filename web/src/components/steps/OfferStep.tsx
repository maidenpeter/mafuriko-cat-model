"use client";

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { loadGeo } from "@/lib/geo/layers";
import { kes1, rpWithChance, type SourceKind } from "@/lib/labels";
import { extractOffer } from "@/lib/offer/client";
import { offerCsv } from "@/lib/offer/csv";
import { docxToText } from "@/lib/offer/docx";
import { ROW_FIELDS, TERM_FIELDS, type FieldDef, type FieldKind } from "@/lib/offer/fields";
import type { FieldOrigin, FocusBuilding, FocusDocument, FocusField, OfferFocus, PricedFocus } from "@/lib/offer/focus";
import { fmtDistance, plural } from "@/lib/offer/shared";
import { OUTSIDE_MAPS_MESSAGE, type OfferDocument, type OfferExtraction, type OfferFile, type OfferState, type ValueRef } from "@/lib/offer/types";
import { confirmValue, editValue, statusCounts } from "@/lib/offer/verify";
import { ACCEPT, offerFileKind, offerFileProblem } from "@/lib/offerFiles/kind";
import { pdfToText } from "@/lib/offerFiles/pdf";
import { download, type Active, type Session } from "@/lib/session";
import { STEP_NAMES, stepIndex, stepKicker, type StepId } from "@/lib/steps";
import { SourceLine, type ChartSource } from "../charts/ChartFrame";
import type { OfferSummary } from "../dashboard/Dashboard";
import { DocumentQuotes, type DocumentQuote } from "../DocumentQuotes";
import { Button, Card, ChecksSummary, Note, StatusIcon, StepHeader, Tag } from "../ui";

/** The offer as it stands on screen. The type lives in lib/offer/types; it is named here too for the files that took it from this step. */
export type { OfferState };

interface Props {
  /** The loaded dataset as every step shows it. */
  session: Session;
  /** The assumptions in force. Not read here: the price comes ready in offerFocus. */
  active?: Active;
  /** Whether a key is set for the model. null while that is not known. */
  modelReady: boolean | null;
  offer: OfferState | null;
  onOffer: (next: OfferState | null) => void;
  /**
   * The walkthrough's one picture of the offer: located, priced and checked there, by code, on the
   * loaded maps and the assumptions in force. This step shows it; it prices nothing itself.
   * null when no offer has been read.
   */
  offerFocus: OfferFocus | null;
  /** The priced offer while the header switch is on "Offer". This step shows the offer in either mode, so it reads offerFocus. */
  focus?: PricedFocus | null;
  /** A line for the run log. Never carries document text. */
  onLog: (message: string) => void;
  /**
   * An offer handed over from the Dashboard. When seq changes, the step takes the file or the
   * text and reads it straight away, as if the reader had chosen it here and pressed the button.
   */
  incoming?: { file?: File; text?: string; seq: number } | null;
  /** Called whenever the priced result changes, and with null when the offer is cleared. */
  onSummary?: (summary: OfferSummary | null) => void;
  /** Opens another step of the walkthrough. When it is not given, the lead to the next step is a sentence, not a button. */
  onOpenStep?: (id: StepId) => void;
}

/**
 * The seq of the last offer taken from the Dashboard. Kept outside the component, so coming
 * back to this step later does not read the same offer a second time.
 */
let lastIncomingSeq: number | null = null;

// ---------------------------------------------------------------------------------------------
// Opening a file
// ---------------------------------------------------------------------------------------------

/**
 * Opens a Word, PDF or text file in this browser. Nothing is sent anywhere until the offer is read.
 * Rejects with a sentence ready to show: an old .doc file gives "Old Word format, please save as .docx".
 */
async function openOfferFile(file: OfferFile & { type?: string }): Promise<OfferDocument> {
  const kind = offerFileKind(file.name, file.type);
  const problem = offerFileProblem(kind);
  if (problem) throw new Error(problem);
  let text: string;
  if (kind === "pdf") text = await pdfToText(await file.arrayBuffer());
  else if (kind === "docx") text = await docxToText(await file.arrayBuffer());
  // Windows line endings and a leading byte order mark would otherwise end up inside quotes.
  else text = (await file.text()).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new Error(`${file.name} has no text in it.`);
  // A PDF is held as plain text from here on: OfferDocument has no kind of its own for it, and the file name keeps the ".pdf".
  return { name: file.name, kind: kind === "docx" ? "docx" : "txt", text };
}

const typedDocument = (text: string): OfferDocument => ({ name: "typed text", kind: "typed", text });

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const fmtRate = (perMille: number) => `${fmtNum(perMille, perMille !== 0 && Math.abs(perMille) < 0.1 ? 4 : 2)} per mille`;

/** The value as it sits in its box: digits the underwriter can type over. */
function boxText(value: string | number | null, kind: FieldKind): string {
  if (value === null) return "";
  if (typeof value !== "number") return value;
  if (kind === "degrees") return String(Number(value.toFixed(6)));
  return value.toLocaleString("en-KE", { maximumFractionDigits: 6 });
}

/** The same value in the short form used across the app, shown under a long figure. */
function plainer(value: string | number | null, kind: FieldKind): string | null {
  if (typeof value !== "number") return null;
  if (kind === "kes" && Math.abs(value) >= 1e6) return kes1(value);
  if (kind === "metres" && value >= 1000) return fmtDistance(value);
  return null;
}

/** The box a value is typed into: its kind, its choices and its hint. Notes have none. */
function defOf(ref: ValueRef): FieldDef<string> | null {
  if (ref.scope === "row") return ROW_FIELDS.find((f) => f.key === ref.key) ?? null;
  if (ref.scope === "terms") return TERM_FIELDS.find((f) => f.key === ref.key) ?? null;
  return null;
}

const BOX = "w-full min-w-0 rounded-lg border border-axis bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted";
const PRE = "mt-1 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-2 p-2.5 font-mono text-xs leading-relaxed text-ink-2";
const GROUP_TITLE = "mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted";

function SmallButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex shrink-0 items-center rounded-full border border-axis bg-surface px-3 py-1 text-xs font-medium text-ink transition hover:bg-surface-2">
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Where a value came from, by shape and by word
// ---------------------------------------------------------------------------------------------

const ORIGIN_WORDS: Record<FieldOrigin, string> = {
  "AI, verified": "AI, verified",
  "AI, unverified": "AI, unverified",
  rules: "Rules",
  confirmed: "Confirmed by you",
  edited: "Edited by you",
  "not stated": "Not stated",
};

/** Each origin has its own shape and its own words, so it never rests on colour. A value the rules read but code could not check says so. */
function OriginMark({ origin, unverified }: { origin: FieldOrigin; unverified: boolean }) {
  const drawn = (children: ReactNode) => (
    <svg viewBox="0 0 20 20" aria-hidden className="h-3.5 w-3.5 shrink-0" fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
  const icon =
    origin === "AI, verified" ? (
      <StatusIcon status="pass" size={14} />
    ) : origin === "AI, unverified" || (origin === "rules" && unverified) ? (
      <StatusIcon status="warn" size={14} />
    ) : origin === "not stated" ? (
      <StatusIcon status="idle" size={14} />
    ) : origin === "rules" ? (
      drawn(<path d="M3 5h14M3 10h14M3 15h9" />)
    ) : origin === "confirmed" ? (
      drawn(
        <>
          <rect x="2.5" y="2.5" width="15" height="15" rx="3" />
          <path d="M6 10.3l2.8 2.8 5.4-6" />
        </>,
      )
    ) : (
      drawn(<path d="M3 17l1-4L14 3l3 3L7 16z" />)
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ink-2">
      {icon}
      {origin === "rules" && unverified ? "Rules, unverified" : ORIGIN_WORDS[origin]}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// One value: its name, its origin, its box
// ---------------------------------------------------------------------------------------------

/**
 * A box the underwriter types into. The value is taken when they leave the box or press Enter,
 * and only when it differs from what was there: looking at a verified value does not make it "edited".
 */
function TypedBox({ id, label, initial, kind, onCommit }: { id: string; label: string; initial: string; kind: FieldKind; onCommit: (text: string | null) => boolean }) {
  const [draft, setDraft] = useState(initial);
  const [refused, setRefused] = useState(false);
  const commit = () => {
    if (draft.trim() === initial.trim()) return setRefused(false);
    setRefused(!onCommit(draft.trim() ? draft : null));
  };
  const wanted = kind === "degrees" ? "a number of degrees, such as -1.2921" : kind === "text" ? "text" : "a number of zero or more, such as 8,000,000";
  return (
    <div className="min-w-0 flex-1">
      <input
        id={id}
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        inputMode={kind === "text" || kind === "degrees" ? "text" : "decimal"}
        aria-invalid={refused}
        placeholder="Not stated"
        className={`${BOX} ${kind === "text" ? "" : "tabular"}`}
      />
      {refused && (
        <p role="alert" className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-ink-2">
          <span className="mt-0.5"><StatusIcon status="fail" size={12} /></span>
          Not taken: this box needs {wanted}.
        </p>
      )}
    </div>
  );
}

interface FieldRowProps {
  field: FocusField;
  /** True when this is the value picked out in the document. */
  active: boolean;
  /** Picks this value out in the document. */
  onSelect: () => void;
  onEdit: (value: string | null) => boolean;
  onConfirm: () => void;
}

/**
 * One value. Its name is a button where the document holds its sentence: pressing it shows the
 * sentence in the document. The box is not part of that button, so typing in it stays in the box.
 */
function FieldRow({ field, active, onSelect, onEdit, onConfirm }: FieldRowProps) {
  const id = useId();
  const def = defOf(field.ref);
  const unverified = field.status === "unverified";
  const quoted = field.mark !== null && field.quote.trim() !== "";
  const short = def ? plainer(field.raw, def.kind) : null;
  const isNote = field.group === "note";
  return (
    <div
      data-field={field.id}
      aria-current={active ? "true" : undefined}
      // The value picked out carries a thick rule down its side as well as the wash.
      className={`min-w-0 rounded-xl border p-2.5 ${active ? "border-accent border-l-4 bg-accent-wash" : "border-line bg-surface-2"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {quoted ? (
          <button type="button" onClick={onSelect} aria-pressed={active} title="Show its sentence in the document" className="min-w-0 text-left text-sm font-medium text-ink underline decoration-dotted decoration-axis underline-offset-4 hover:decoration-ink-2">
            {field.label}
          </button>
        ) : def ? (
          <label htmlFor={id} className="min-w-0 text-sm font-medium text-ink">{field.label}</label>
        ) : (
          <span className="min-w-0 text-sm font-medium text-ink">{field.label}</span>
        )}
        <OriginMark origin={field.origin} unverified={unverified} />
      </div>

      {def ? (
        <div className="mt-1.5 flex items-start gap-2">
          {def.choices ? (
            <select id={id} aria-label={field.label} value={typeof field.raw === "string" ? field.raw : ""} onChange={(e) => onEdit(e.target.value || null)} className={BOX}>
              <option value="">{def.empty ?? "Not stated"}</option>
              {def.choices.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          ) : (
            // Keyed by what it shows, so the box starts afresh whenever the value changes underneath it.
            <TypedBox key={`${field.status}:${boxText(field.raw, def.kind)}`} id={id} label={field.label} initial={boxText(field.raw, def.kind)} kind={def.kind} onCommit={onEdit} />
          )}
          {unverified && field.raw !== null && <SmallButton onClick={onConfirm}>Confirm</SmallButton>}
        </div>
      ) : (
        isNote && field.value && field.value !== field.label && <p className="mt-1 text-sm leading-relaxed text-ink-2 wrap-anywhere">{field.value}</p>
      )}

      {def && (short || def.hint) && <p className="mt-1 text-xs leading-relaxed text-muted">{[short, def.hint].filter(Boolean).join(" · ")}</p>}

      {unverified && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs leading-relaxed text-ink-2">
          <span className="min-w-0 flex-1 basis-48">
            {field.reason ?? "This value has not been checked."}{" "}
            {isNote ? "Not used in the checks until confirmed." : field.raw !== null ? "Not used until you confirm it or type over it." : "Type the value to use it."}
          </span>
          {isNote && (
            <>
              {field.raw !== null && <SmallButton onClick={onConfirm}>Confirm</SmallButton>}
              <SmallButton onClick={() => onEdit(null)}>Leave out</SmallButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// What was sent and what came back
// ---------------------------------------------------------------------------------------------

function ReadingRecord({ doc }: { doc: FocusDocument }) {
  const byModel = doc.path === "model";
  const chars = `${fmtInt(doc.text.length)} characters`;
  const took = doc.ms ? ` It took ${(doc.ms / 1000).toFixed(1)} s` : "";
  const tokens = doc.usage?.promptTokens ? `${took ? "," : " It used"} ${fmtInt(doc.usage.promptTokens)} tokens read and ${fmtInt(doc.usage.outputTokens ?? 0)} written` : "";
  const removedAny = doc.removed.emails + doc.removed.phones + doc.removed.blocks.length > 0;
  return (
    <Card title="How the offer was read" className="mt-4" aside={<Tag kind={byModel ? "ai" : "none"}>{byModel ? "Read by the model" : "Read by the fixed rules"}</Tag>}>
      <div className="space-y-3 text-sm leading-relaxed text-ink-2">
        {!byModel && doc.sentToModel ? (
          <Note tone="warn">The text was sent to the model, but its answer could not be used, so the fixed rules read the offer in this browser. {doc.why}</Note>
        ) : (
          <p className="max-w-5xl">
            {byModel ? "" : "Nothing left this browser. "}
            {doc.why}
            {byModel && (took || tokens) ? `${took}${tokens}.` : ""}
          </p>
        )}
        <p className="max-w-5xl">
          {doc.removedLine}
          {removedAny ? " This was done in this browser, and a marker in square brackets shows where each one was." : ""}
        </p>
        <details>
          <summary className="cursor-pointer select-none font-medium text-ink-2 hover:text-ink">
            {doc.sentToModel ? `What was sent to the model (${chars})` : `Nothing was sent to the model: the text the rules read (${chars})`}
          </summary>
          {doc.sent ? (
            <>
              <div className="mt-2 text-xs font-semibold text-ink-2">Instructions</div>
              <pre className={PRE}>{doc.sent.system}</pre>
              <div className="mt-2 text-xs font-semibold text-ink-2">Message, with the document as sent</div>
              <pre className={PRE}>{doc.sent.user}</pre>
            </>
          ) : (
            <>
              <div className="mt-2 text-xs font-semibold text-ink-2">The document, with contact details removed</div>
              <pre className={PRE}>{doc.text}</pre>
              {doc.sentToModel && <p className="mt-1 text-xs text-muted">The instructions sent around it were not reported back by the server.</p>}
            </>
          )}
        </details>
        {doc.sentToModel && (
          <details>
            <summary className="cursor-pointer select-none font-medium text-ink-2 hover:text-ink">What came back from the model</summary>
            {doc.replyJson ? (
              <>
                <pre className={PRE}>{doc.replyJson}</pre>
                <p className="mt-1 text-xs text-muted">The reply as received, before code checked any value in it.</p>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted">The server did not hand the reply back.</p>
            )}
          </details>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The result, and the lead to the next step
// ---------------------------------------------------------------------------------------------

function BuildingLine({ building, showOutside }: { building: FocusBuilding; showOutside: boolean }) {
  const facts = [building.housingLabel, building.ward ? `${building.ward.name} ward${building.ward.subcounty ? `, ${building.ward.subcounty}` : ""}` : null].filter(Boolean).join(" · ");
  return (
    <li className="min-w-0 text-sm leading-relaxed text-ink-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold text-ink wrap-anywhere">{building.name}</span>
        {facts && <span>{facts}</span>}
        {building.approximate && <Tag kind="assumption">Approximate location</Tag>}
      </div>
      <p className="mt-0.5 wrap-anywhere">{building.locationHow}</p>
      {building.approximate && <p className="mt-0.5">Every figure for this building depends on that stand-in point.</p>}
      {showOutside && building.status === "outside" && <p className="mt-0.5 font-semibold text-ink">{OUTSIDE_MAPS_MESSAGE}.</p>}
    </li>
  );
}

interface ResultProps {
  f: OfferFocus;
  onConfirm: (ref: ValueRef) => void;
  onClear: (ref: ValueRef) => void;
  onOpenStep?: (id: StepId) => void;
}

function ResultCard({ f, onConfirm, onClear, onOpenStep }: ResultProps) {
  if (f.status === "locating") {
    return <div className="mt-4"><Note>{f.statusLine}</Note></div>;
  }
  const where = (
    <ul className="space-y-3">
      {f.buildings.map((b) => (
        <BuildingLine key={b.locId} building={b} showOutside={!f.outside} />
      ))}
    </ul>
  );

  // Outside the maps: where the building is, the sentence, and nothing further. A figure of zero would be wrong.
  if (f.outside) {
    return (
      <Card title="Where the building is" className="mt-4">
        {where}
        <div className="mt-4"><Note tone="warn"><span className="font-semibold text-ink">{f.outsideMessage}.</span></Note></div>
      </Card>
    );
  }

  const price = f.price;
  const isScore = f.hazardKind === "score";
  const readByModel = f.document.path === "model";
  const termsFromDocument = f.terms.deductible.source !== "example terms" || f.terms.limit.source !== "example terms";
  const termsFromExample = f.terms.deductible.source === "example terms" || f.terms.limit.source === "example terms";
  const hazardKind: SourceKind = isScore ? "assumption" : "real";
  const sources: ChartSource[] = [
    { kind: hazardKind, text: isScore ? "Depth worked out from a 0 to 1 susceptibility score and an assumed depth scale" : "Hazard depth maps, read at the building's point" },
    ...(readByModel ? [{ kind: "ai" as const, text: `Building values${termsFromDocument ? " and terms" : ""} read from the document by the model, each checked against its sentence by code` }] : []),
    { kind: "assumption", text: `Return periods and damage curves${termsFromExample ? ", and the example deductible or limit where the document states none" : ""}${f.drainageOn ? ", and drainage ponding" : ""}` },
  ];

  const total = price?.total ?? null;
  const added = price?.portfolio.loss100ChangeKes ?? null;
  const addedShare = price?.portfolio.loss100ChangeShare ?? null;
  const sign = added !== null && added < 0 ? "-" : "+";
  const figures: { label: string; value: string; sub?: string }[] = total
    ? [
        {
          label: `Gross loss in a ${rpWithChance(100)} flood`,
          value: total.loss100GrossKes !== null ? `${kes1(total.loss100GrossKes)}${total.loss100Extrapolated ? " †" : ""}` : "Not modelled",
          sub: total.loss100GrossKes === null ? "More frequent than any flood modelled" : total.loss100Extrapolated ? "† held flat beyond the rarest flood modelled" : undefined,
        },
        { label: "Average annual loss, gross", value: kes1(total.aalGrossKes) },
        { label: "Pure flood rate, gross", value: fmtRate(total.ratePerMilleGross), sub: "Before expense, profit and uncertainty loadings" },
        {
          label: `Added to the portfolio's ${rpWithChance(100)} loss, ground-up`,
          value: added === null ? "Not modelled" : Math.abs(added) < 0.5 ? "No change" : `${sign}${kes1(Math.abs(added))}`,
          sub: added !== null && Math.abs(added) >= 0.5 && addedShare !== null ? `${sign}${fmtPct(Math.abs(addedShare), Math.abs(addedShare) < 0.001 ? 3 : 1)} of the portfolio's own` : undefined,
        },
      ]
    : [];
  const hazardStep = `step ${stepIndex("hazard")}, ${STEP_NAMES.hazard}`;

  return (
    <Card
      title={price ? "Where the building is, and the price code worked out" : "Where the building is"}
      className="mt-4"
      aside={<span className="text-xs text-muted">No figure here comes from the model</span>}
    >
      {f.buildings.length > 0 && where}
      {f.severalLine && <p className="mt-3 text-sm leading-relaxed text-ink-2">{f.severalLine}</p>}

      {f.waiting.length > 0 && (
        <div className="mt-4">
          <Note tone="warn">
            <div className="font-semibold text-ink">Pricing is waiting for {plural(f.waiting.length, "value")}</div>
            <p className="mt-0.5">Code could not check {f.waiting.length === 1 ? "this value" : "these values"} against the document. Confirm each one, clear it, or type the right value in its box above.</p>
            <ul className="mt-2 space-y-2">
              {f.waiting.map((w) => (
                <li key={w.fieldId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="min-w-0 flex-1 basis-64">
                    <span className="font-medium text-ink">{w.where}, {w.label.toLowerCase()}:</span> {w.value}. {w.reason}
                  </span>
                  <span className="inline-flex gap-2">
                    {f.fields.find((x) => x.id === w.fieldId)?.raw != null && <SmallButton onClick={() => onConfirm(w.ref)}>Confirm</SmallButton>}
                    <SmallButton onClick={() => onClear(w.ref)}>Clear</SmallButton>
                  </span>
                </li>
              ))}
            </ul>
          </Note>
        </div>
      )}

      {f.status === "not_ready" && (
        <div className="mt-4">
          <Note tone="warn">
            <div className="font-semibold text-ink">Not priced yet</div>
            {f.buildings.some((b) => b.blockers.length > 0) ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {f.buildings.flatMap((b) => b.blockers.map((text) => <li key={`${b.locId}:${text}`}>{f.several ? `${b.name}: ${text}` : text}</li>))}
              </ul>
            ) : (
              <p className="mt-0.5">The offer lists no building.</p>
            )}
          </Note>
        </div>
      )}

      {price && total && (
        <>
          {/* One row of figures, not cards: in Offer mode the bar at the top of the page carries the same four. */}
          <dl className="mt-5 grid gap-x-6 gap-y-4 border-t border-line pt-4 grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))]">
            {figures.map((x) => (
              <div key={x.label} className="min-w-0">
                <dt className="text-xs leading-snug text-muted">{x.label}</dt>
                <dd className="tabular mt-0.5 text-xl font-semibold tracking-tight text-ink wrap-anywhere">{x.value}</dd>
                {x.sub && <dd className="text-xs leading-relaxed text-ink-2">{x.sub}</dd>}
              </div>
            ))}
          </dl>
          <p className="mt-3 text-sm leading-relaxed text-ink-2">
            Terms used: {f.terms.summary.toLowerCase()}. Assumptions in force: {f.assumptionsInForce === "ai" ? "the set the agents agreed" : "the reference set"}.
          </p>
          {f.terms.floodCover === "excluded" && (
            <div className="mt-3"><Note tone="warn">The document asks for flood to be excluded. The figures here are what flood would cost if it were covered.</Note></div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-2">
            <ChecksSummary checks={f.checks} />
            <span className="min-w-0">
              {f.flags.length > 0 ? `${plural(f.flags.length, "point")} to weigh, set out in ${STEP_NAMES.results}. ` : ""}Every check is listed in {STEP_NAMES.audit}.
            </span>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-line pt-4">
            {onOpenStep ? (
              <Button className="whitespace-nowrap" onClick={() => onOpenStep("hazard")}>Next: see the building on the hazard map</Button>
            ) : (
              <span className="text-sm font-semibold text-ink">Next: see the building on the hazard map, in {hazardStep}.</span>
            )}
            <span className="min-w-0 flex-1 basis-64 text-sm leading-relaxed text-ink-2">
              The depth at the building is in {STEP_NAMES.hazard}, its damage in {STEP_NAMES.vulnerability}, the arithmetic for each return period in {STEP_NAMES.loss}, and the decision in {STEP_NAMES.results}.
            </span>
          </div>
          <SourceLine sources={sources} className="mt-4 border-t border-line pt-3" />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------

const FIELD_GROUPS: { group: FocusField["group"]; title: string }[] = [
  { group: "terms", title: "Flood terms" },
  { group: "site", title: "The building and where it is" },
];

export function OfferStep({ session, modelReady, offer, onOffer, offerFocus, onLog, incoming, onSummary, onOpenStep }: Props) {
  const { dataset } = session;

  // One source at a time: a chosen file or a typed description, never both.
  const [file, setFile] = useState<OfferDocument | null>(offer && offer.document.kind !== "typed" ? offer.document : null);
  const [typed, setTyped] = useState(offer?.document.kind === "typed" ? offer.document.text : "");
  /** Says what was cleared when one source took the place of the other. */
  const [swapped, setSwapped] = useState<string | null>(null);
  const [rulesOnly, setRulesOnly] = useState(false);
  /** A file is being opened in this browser. */
  const [opening, setOpening] = useState(false);
  /** The offer is being read into rows. */
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  /** Once an offer is read, the inputs fold away behind a button so the document has the room. */
  const [inputOpen, setInputOpen] = useState(false);
  /** The value picked out: its quote in the document and its box in the list of values. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const valuesPane = useRef<HTMLDivElement>(null);
  /** True when the last pick was made in the document, so the list of values follows it. */
  const pickedInDocument = useRef(false);
  const textId = useId();
  // Each choice of a source and each read takes a number. Only the latest of each may change the screen,
  // so a slow file or a slow answer can never overwrite what the reader did after it.
  const sourceTurn = useRef(0);
  const readTurn = useRef(0);

  /** Opens a file in this browser and makes it the source. Resolves to the document, or null when it could not be opened or something newer took its place. */
  const openFile = async (chosen: OfferFile & { type?: string }): Promise<OfferDocument | null> => {
    const turn = ++sourceTurn.current;
    const hadTyped = typed.trim().length > 0;
    setProblem(null);
    setSwapped(null);
    setOpening(true);
    try {
      const doc = await openOfferFile(chosen);
      if (turn !== sourceTurn.current) return null;
      setFile(doc);
      setTyped("");
      if (hadTyped) setSwapped(`The typed description was cleared: ${doc.name} is read in its place.`);
      return doc;
    } catch (e) {
      // The message is shown as it is: the readers word it for the underwriter.
      if (turn === sourceTurn.current) setProblem((e as Error).message);
      return null;
    } finally {
      if (turn === sourceTurn.current) setOpening(false);
    }
  };

  /** Makes typed text the source. Typing takes the place of a chosen file, and of one still being opened. */
  const typeText = (text: string) => {
    sourceTurn.current++;
    setOpening(false);
    setTyped(text);
    if (file) {
      setFile(null);
      setSwapped(`${file.name} was removed: the typed description is read in its place.`);
    }
  };

  const removeFile = () => {
    sourceTurn.current++;
    setOpening(false);
    setFile(null);
    setSwapped(null);
  };

  const source: OfferDocument | null = file ?? (typed.trim() ? typedDocument(typed) : null);

  const read = async (doc: OfferDocument) => {
    const turn = ++readTurn.current;
    setBusy(true);
    setProblem(null);
    try {
      // An offer can arrive from the Dashboard before the ward map has loaded: the read waits for it here.
      // The layers load once per page, so this is the same answer the walkthrough places the offer with.
      const layers = await loadGeo();
      // The rules find a place in free text only if they know the names to look for.
      const knownPlaces = [...(layers.wards?.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())) ?? []), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
      const run = await extractOffer(doc.text, { rulesOnly, knownPlaces });
      if (turn !== readTurn.current) return;
      onOffer({ document: doc, run, extraction: run.extraction });
      setActiveId(null);
      setInputOpen(false);
      setSwapped(null);
      const counts = statusCounts(run.extraction);
      // Counts and names only: the run log is downloaded with the audit file, and no document text belongs in it.
      onLog(
        `${doc.name} read by ${run.path === "model" ? `the model (${run.model ?? "model"}${run.ms ? `, ${(run.ms / 1000).toFixed(1)} s` : ""})` : "the fixed rules"}: ${plural(run.extraction.rows.length, "building")}, ${counts.verified} values verified, ${counts.unverified} unverified; ${run.sentToModel ? `${fmtInt(run.documentText.length)} characters sent with contact details removed` : "nothing sent to the model"}`,
      );
    } catch (e) {
      if (turn === readTurn.current) setProblem(`The offer could not be read: ${(e as Error).message}`);
    } finally {
      if (turn === readTurn.current) setBusy(false);
    }
  };

  // An offer dropped on the Dashboard: taken as the source and read at once, with no button to press.
  const takeIncoming = useEffectEvent(async (input: { file?: File; text?: string }) => {
    if (input.file) {
      const doc = await openFile(input.file);
      if (doc) await read(doc);
    } else if (input.text?.trim()) {
      sourceTurn.current++;
      setOpening(false);
      setSwapped(null);
      setFile(null);
      setTyped(input.text);
      await read(typedDocument(input.text));
    }
  });
  const incomingSeq = incoming?.seq ?? null;
  useEffect(() => {
    if (!incoming || incomingSeq === null || incomingSeq === lastIncomingSeq) return;
    lastIncomingSeq = incomingSeq;
    // Started just after the effect, not inside it: the read sets this step's busy state as it begins.
    queueMicrotask(() => void takeIncoming(incoming));
    // Keyed on seq alone: the same offer is never read twice, whatever else re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingSeq]);

  // Everything shown of the offer is worked out once, in the walkthrough (lib/offer/focus.ts): the values and
  // where each came from, the location, the price and the checks. This step edits the values and shows the rest.
  const f = offer ? offerFocus : null;

  const change = (next: OfferExtraction) => {
    if (offer && next !== offer.extraction) onOffer({ ...offer, extraction: next });
  };
  /** False when the typed value could not be read for its field, so the box can say so. */
  const edit = (ref: ValueRef, value: string | null): boolean => {
    if (!offer) return false;
    const next = editValue(offer.extraction, ref, value);
    if (next === offer.extraction) return false;
    change(next);
    return true;
  };
  const confirm = (ref: ValueRef) => {
    if (offer) change(confirmValue(offer.extraction, ref));
  };

  // What the Dashboard shows of this offer. undefined while the ward map is still loading: nothing is reported yet.
  const dashboardSummary: OfferSummary | null | undefined = !offer ? null : !offerFocus || offerFocus.status === "locating" ? undefined : offerFocus.summary;
  useEffect(() => {
    if (dashboardSummary !== undefined) onSummary?.(dashboardSummary);
  }, [dashboardSummary, onSummary]);

  // The sentences to mark in the document: one for each value that has one.
  const fields = f?.fields;
  const quotes = useMemo<DocumentQuote[]>(
    () => (fields ?? []).flatMap((x) => (x.mark && x.quote.trim() ? [{ id: x.id, quote: x.quote, label: x.row !== null && (fields ?? []).some((y) => y.row !== null && y.row !== x.row) ? `Building ${x.row + 1}, ${x.label}` : x.label, status: x.mark }] : [])),
    [fields],
  );

  // A sentence picked in the document brings its value into view in the list beside it.
  useEffect(() => {
    if (!activeId || !pickedInDocument.current) return;
    pickedInDocument.current = false;
    const row = valuesPane.current?.querySelector<HTMLElement>(`[data-field="${activeId}"]`);
    if (!row) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [activeId]);

  const takeDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) void openFile(dropped);
  };

  const showInput = !offer || inputOpen || busy || opening || problem !== null || swapped !== null;
  const fieldRow = (x: FocusField) => (
    <FieldRow key={x.id} field={x} active={x.id === activeId} onSelect={() => setActiveId(x.id)} onEdit={(v) => edit(x.ref, v)} onConfirm={() => confirm(x.ref)} />
  );
  const VALUE_GRID = "grid gap-2.5 @lg:grid-cols-2 @4xl:grid-cols-3";
  const notes = f ? f.fields.filter((x) => x.group === "note" && x.status !== "missing") : [];

  const inputCard = (
    <Card title={offer ? "Read another offer" : "The offer"} aside={<span className="text-xs text-muted">Word (.docx), PDF (.pdf), text (.txt) or typed</span>}>
      {/* A file dropped anywhere on the two inputs is taken, so one that lands on the text box is not opened by the browser as a page. */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={takeDrop}
      >
        <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border-2 border-dashed px-4 py-3 transition ${over ? "border-accent bg-accent-wash" : "border-axis bg-surface"}`}>
          <Button variant="secondary" className="whitespace-nowrap" onClick={() => picker.current?.click()}>Choose a file</Button>
          <div className="min-w-0 flex-1 basis-48 text-sm leading-relaxed text-ink-2">
            {opening ? (
              "Opening the file in this browser."
            ) : file ? (
              <>
                <span className="font-medium text-ink wrap-anywhere">{file.name}</span>
                <span className="text-muted"> · {fmtInt(file.text.length)} characters, opened in this browser</span>
              </>
            ) : (
              "A broker's memo as a Word, PDF or text file. Drop it here or choose it. It is opened in this browser."
            )}
          </div>
          {file && !opening && <SmallButton onClick={removeFile}>Remove</SmallButton>}
          <input
            ref={picker}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen) void openFile(chosen);
              e.target.value = "";
            }}
          />
        </div>

        <label htmlFor={textId} className="mt-4 block text-sm font-medium text-ink">Or describe the offer in plain English</label>
        <textarea
          id={textId}
          rows={offer ? 2 : 4}
          value={typed}
          // The box always shows what this step holds, never text a browser kept from an earlier visit.
          autoComplete="off"
          onChange={(e) => typeText(e.target.value)}
          placeholder="For example: two-storey masonry shop in Kibera worth KES 8 million"
          className={`${BOX} mt-1.5 leading-relaxed`}
        />
      </div>
      {swapped && <p role="status" className="mt-2 text-xs leading-relaxed text-ink-2 wrap-anywhere">{swapped}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {/* Enabled whenever there is a file or typed text and nothing is being read. */}
        <Button className="whitespace-nowrap" onClick={() => source && void read(source)} disabled={!source || busy || opening}>
          {busy && <StatusIcon status="running" size={16} />}
          {busy ? "Reading the offer" : offer ? "Read the offer again" : "Read the offer"}
        </Button>
        <label className="flex min-w-0 items-start gap-2 text-sm leading-snug text-ink-2">
          <input type="checkbox" checked={rulesOnly} onChange={(e) => setRulesOnly(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]" />
          <span>Fixed rules only: nothing leaves this browser</span>
        </label>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        {opening ? "Opening the file. " : source ? `${busy ? "Reading" : "Will read"} ${source.kind === "typed" ? `the typed text (${fmtInt(source.text.length)} characters)` : source.name}. ` : "Choose a file or type a description first. "}
        {rulesOnly
          ? "The fixed rules read it here, with no model."
          : modelReady === false
            ? "No key is set for the model, so the fixed rules will read it here and nothing will be sent."
            : "Email addresses, phone numbers, and contact and signature blocks are taken out first; the rest goes to the model."}
      </p>
      {problem && <div className="mt-3" role="alert"><Note tone="warn">{problem}</Note></div>}
    </Card>
  );

  return (
    <div>
      <StepHeader kicker={stepKicker("offer")} title={STEP_NAMES.offer}>
        Give a broker&apos;s memo, or describe an offer in a sentence. The model reads it into rows in the exposure file&apos;s shape, code checks every value against the document, and code alone prices it on the hazard maps already loaded.
      </StepHeader>

      {!offer && (
        <div className="grid gap-4 @5xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          {inputCard}
          <Card title="How an offer is read and priced">
            <ol className="space-y-2.5 text-sm leading-relaxed text-ink-2">
              {[
                "Contact details are taken out of the text in this browser, and you can see exactly what is left.",
                "The model lists each insured building and the flood terms, each with the sentence it came from. With no key, or if the call fails, a set of fixed rules does the reading.",
                "Code checks every value: the sentence must be in the document and the number must be in the sentence. A value that fails waits for you.",
                "Code alone reads the hazard maps at the building and works out depth, damage and loss. The model supplies no figure.",
                "The deductible and the limit stated in the document turn the ground-up loss into the gross loss. Where the document states none, example terms are used, and the screen says which.",
              ].map((line, i) => (
                <li key={line} className="flex gap-3">
                  <span className="tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs text-ink-2">{i + 1}</span>
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      )}

      {offer && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">
            <span className="min-w-0 flex-1 basis-64">
              <span className="font-semibold text-ink wrap-anywhere">{offer.document.name}</span>
              <span className="text-muted"> · {plural(offer.extraction.rows.length, "building")} read by {offer.run.path === "model" ? "the model" : "the fixed rules"}</span>
            </span>
            {busy && <span className="inline-flex items-center gap-1.5"><StatusIcon status="running" size={14} /> Reading the offer</span>}
            <SmallButton
              onClick={() => {
                setInputOpen(!showInput);
                if (showInput) {
                  setProblem(null);
                  setSwapped(null);
                }
              }}
            >
              {showInput ? "Hide the inputs" : "Read another offer"}
            </SmallButton>
          </div>
          {showInput && <div className="mb-4">{inputCard}</div>}
        </>
      )}

      {offer && f && (
        <>
          {/* The document beside the values read from it. On a narrow screen the document sits above them. */}
          <div className="grid gap-4 @5xl:grid-cols-2">
            <Card title="The document" aside={<span className="text-xs text-muted">Contact details removed</span>}>
              <DocumentQuotes
                text={f.document.text}
                quotes={quotes}
                activeId={activeId}
                onSelect={(id) => {
                  pickedInDocument.current = true;
                  setActiveId(id);
                }}
              />
              <p className="mt-2 text-xs leading-relaxed text-muted">Press a marked sentence to find its value, or the name of a value to find its sentence.</p>
            </Card>

            <Card
              title="What was read"
              aside={
                <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
                  <span className="inline-flex items-center gap-1"><StatusIcon status="pass" size={14} /> {f.counts.verified} verified</span>
                  <span className="inline-flex items-center gap-1"><StatusIcon status="warn" size={14} /> {f.counts.unverified} unverified</span>
                  {f.counts.confirmed + f.counts.edited > 0 && <span>{f.counts.confirmed + f.counts.edited} set by you</span>}
                </span>
              }
            >
              <p className="mb-3 text-sm leading-relaxed text-ink-2">
                {f.document.path === "model"
                  ? "\"AI, verified\" means the model read the value and code found its sentence in the document and the number in the sentence: it was written, not necessarily understood. \"AI, unverified\" failed that check and is not used until you confirm it or type over it."
                  : "\"Rules\" means the fixed rules read the value in this browser, with no model. A value code could not check is not used until you confirm it or type over it."}
                {" "}Every box can be changed.
              </p>

              {/* Its own scroll beside the document on a wide screen, so a value and its sentence are on screen together. */}
              <div ref={valuesPane} className="@container space-y-5 @5xl:max-h-160 @5xl:overflow-y-auto @5xl:pr-1">
                {f.extraction.rows.map((_, i) => {
                  const own = f.fields.filter((x) => x.row === i);
                  const name = own.find((x) => x.id === `row:${i}:name`)?.value;
                  return (
                    <section key={i}>
                      <h4 className={`${GROUP_TITLE} wrap-anywhere`}>
                        Building {i + 1}
                        {name ? `: ${name}` : ""}, in the exposure file&apos;s columns
                      </h4>
                      <div className={VALUE_GRID}>{own.map(fieldRow)}</div>
                    </section>
                  );
                })}
                {f.extraction.rows.length === 0 && <p className="text-sm leading-relaxed text-ink-2">No insured building was read from the document.</p>}

                {FIELD_GROUPS.map(({ group, title }) => (
                  <section key={group}>
                    <h4 className={GROUP_TITLE}>{title}</h4>
                    <div className={VALUE_GRID}>{f.fields.filter((x) => x.group === group).map(fieldRow)}</div>
                  </section>
                ))}

                <section>
                  <h4 className={GROUP_TITLE}>Flood notes from the document</h4>
                  {notes.length === 0 ? (
                    <p className="text-sm leading-relaxed text-ink-2">No note was read on plant in basements, past flood or water damage, the state of the drains, or the broker&apos;s own view of the flood risk.</p>
                  ) : (
                    <div className={VALUE_GRID}>{notes.map(fieldRow)}</div>
                  )}
                </section>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
                <Button
                  variant="secondary"
                  className="whitespace-nowrap"
                  disabled={f.rows.length === 0}
                  onClick={() => download(`offer-rows-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`, offerCsv(f.rows, offer.document.name), "text/csv")}
                >
                  Download the rows as CSV
                </Button>
                <span className="min-w-0 flex-1 basis-56 text-xs leading-relaxed text-muted">
                  {plural(f.rows.length, "row")} in the exposure file&apos;s columns, marked synthetic=false. A value that is not known, or not yet confirmed, is left blank.
                </span>
              </div>
            </Card>
          </div>

          <ReadingRecord doc={f.document} />
          <ResultCard f={f} onConfirm={confirm} onClear={(ref) => void edit(ref, null)} onOpenStep={onOpenStep} />
        </>
      )}
    </div>
  );
}
