"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { summarise, type Check } from "@/lib/checks";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import type { DrainageState } from "@/lib/geo/drainageView";
import { loadGeo, type GeoLayers } from "@/lib/geo/layers";
import { annualChance, rpLabel } from "@/lib/labels";
import type { InsuranceTerms } from "@/lib/model/terms";
import { HOUSING_CLASSES, HOUSING_LABELS, type Dataset } from "@/lib/model/types";
import { offerChecks } from "@/lib/offer/checks";
import { extractOffer } from "@/lib/offer/client";
import { describeReading } from "@/lib/offer/coords";
import { offerCsv } from "@/lib/offer/csv";
import { readOfferFile } from "@/lib/offer/docx";
import { NOTE_LABELS } from "@/lib/offer/extraction";
import { priceOffer, pricingRows } from "@/lib/offer/price";
import { describeRemoved } from "@/lib/offer/redact";
import { fmtDistance, fmtPoint, plural } from "@/lib/offer/shared";
import { describeTerms, policyTerms } from "@/lib/offer/terms";
import {
  OUTSIDE_MAPS_MESSAGE,
  type ExtractionRun,
  type OfferDocument,
  type OfferExtraction,
  type OfferLocation,
  type OfferPricing,
  type OfferRowValues,
  type OfferTerms,
  type PolicyTerms,
  type PortfolioEffect,
  type Quoted,
  type RowPricing,
  type ValueRef,
  type ValueStatus,
  type WaitingValue,
} from "@/lib/offer/types";
import { confirmValue, editValue, statusCounts, usableValue, waitingValues } from "@/lib/offer/verify";
import { download, type Active, type Session } from "@/lib/session";
import { Button, Card, CheckList, ChecksSummary, Note, Stat, StatusIcon, StepHeader, Tag } from "../ui";

/** One offer as it stands on screen. The walkthrough keeps it, so a visit to another step does not lose it. */
export interface OfferState {
  document: OfferDocument;
  /** How the offer was read: the path, the text that was read and what was taken out of it. */
  run: ExtractionRun;
  /** What was read, with the underwriter's confirmations and edits applied. */
  extraction: OfferExtraction;
}

interface Props {
  /** The loaded dataset as every step shows it. */
  session: Session;
  active: Active;
  /** The drainage state when drainage is switched on, otherwise null. */
  drainage: DrainageState | null;
  /** Whether a key is set for the model. null while that is not known. */
  modelReady: boolean | null;
  offer: OfferState | null;
  onOffer: (next: OfferState | null) => void;
  /**
   * The policy terms of the Insurance terms panel: a deductible as a share of insured value with
   * a KES minimum, and a limit as a share of insured value. Used when the document states none.
   */
  policyDefaults: InsuranceTerms;
  /** A line for the run log. Never carries document text. */
  onLog: (message: string) => void;
}

// ---------------------------------------------------------------------------------------------
// The fields, in the order they are shown
// ---------------------------------------------------------------------------------------------

type FieldKind = "text" | "degrees" | "kes" | "area" | "percent" | "count" | "metres" | "choice";

interface FieldDef<K extends string> {
  key: K;
  label: string;
  kind: FieldKind;
  hint?: string;
  choices?: { value: string; label: string }[];
  /** What the empty choice of a list says. */
  empty?: string;
}

const ROW_FIELDS: FieldDef<keyof OfferRowValues>[] = [
  { key: "name", label: "Building name", kind: "text" },
  { key: "lat", label: "Latitude", kind: "degrees", hint: "Decimal degrees. South is negative." },
  { key: "lon", label: "Longitude", kind: "degrees", hint: "Decimal degrees. East is positive." },
  { key: "housingClass", label: "Construction class", kind: "choice", choices: HOUSING_CLASSES.map((c) => ({ value: c, label: HOUSING_LABELS[c] })), empty: "Not stated: pick one" },
  { key: "floorAreaM2", label: "Floor area (m²)", kind: "area" },
  { key: "costPerM2Kes", label: "Cost per m² (KES)", kind: "kes" },
  { key: "tivKes", label: "Insured value (KES)", kind: "kes", hint: "Left empty, it is worked out as floor area × cost per m²." },
];

const TERM_GROUPS: { title: string; fields: FieldDef<keyof OfferTerms>[] }[] = [
  {
    title: "Flood terms",
    fields: [
      { key: "floodDeductiblePct", label: "Flood deductible (%)", kind: "percent", hint: "With no percentage and no minimum, the example terms are used." },
      { key: "floodDeductibleMinKes", label: "Deductible minimum (KES)", kind: "kes", hint: "With no percentage, this is a flat deductible." },
      {
        key: "floodDeductibleBasis",
        label: "The percentage is taken of",
        kind: "choice",
        choices: [
          { value: "percent_of_loss", label: "Each loss" },
          { value: "percent_of_sum_insured", label: "The insured value" },
        ],
        empty: "Not stated: read as each loss",
      },
      { key: "floodLimitKes", label: "Flood limit (KES)", kind: "kes", hint: "Left empty, the example limit is used." },
      {
        key: "floodCover",
        label: "Flood cover",
        kind: "choice",
        choices: [
          { value: "covered", label: "Covered" },
          { value: "excluded", label: "Excluded" },
        ],
      },
      { key: "policyPeriod", label: "Policy period", kind: "text" },
    ],
  },
  {
    title: "The building and where it is",
    fields: [
      { key: "basements", label: "Basement levels", kind: "count", hint: "0 means the document says there are none." },
      {
        key: "occupancy",
        label: "Occupancy",
        kind: "choice",
        choices: [
          { value: "residential", label: "Residential" },
          { value: "commercial", label: "Commercial" },
          { value: "industrial", label: "Industrial" },
          { value: "mixed", label: "Mixed use" },
          { value: "other", label: "Other" },
        ],
      },
      { key: "placeName", label: "Place name", kind: "text", hint: "Used for a building with no coordinates: a ward or a named flood area." },
      { key: "riverName", label: "Nearest river named", kind: "text" },
      { key: "riverDistanceM", label: "Stated distance to it (m)", kind: "metres" },
    ],
  },
];

const TERM_FIELDS = TERM_GROUPS.flatMap((g) => g.fields);

const STATUS_WORDS: Record<ValueStatus, string> = {
  verified: "Verified",
  unverified: "Unverified",
  confirmed: "Confirmed by you",
  edited: "Edited by you",
  missing: "Not stated",
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** "1-in-100" with its annual chance beside it, as every table in the app writes a return period. */
function ReturnPeriod({ years }: { years: number }) {
  return (
    <>
      {rpLabel(years)} <span className="text-xs text-muted">{annualChance(years)}</span>
    </>
  );
}

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
  if (kind === "kes" && Math.abs(value) >= 1e6) return fmtKes(value);
  if (kind === "metres" && value >= 1000) return fmtDistance(value);
  return null;
}

/** A value in words, for a sentence: a choice by its label, a figure with its separators. */
function inWords(value: string | number | null, field: FieldDef<string>): string {
  if (value === null) return "nothing readable";
  return field.choices?.find((c) => c.value === value)?.label ?? boxText(value, field.kind);
}

/** A value pricing is waiting for, with the box it belongs to. The list itself comes from waitingValues. */
interface HoldUp extends WaitingValue {
  where: string;
  field: FieldDef<string>;
}

function holdUps(extraction: OfferExtraction): HoldUp[] {
  return waitingValues(extraction).flatMap((w): HoldUp[] => {
    const { ref } = w;
    const field: FieldDef<string> | undefined = ref.scope === "row" ? ROW_FIELDS.find((f) => f.key === ref.key) : ref.scope === "terms" ? TERM_FIELDS.find((f) => f.key === ref.key) : undefined;
    return field ? [{ ...w, field, where: ref.scope === "row" ? `Building ${ref.row + 1}` : "Offer" }] : [];
  });
}

/** The ground the loaded hazard maps cover, in words. */
function coverage(dataset: Dataset): string | null {
  const boxes = dataset.rasters.map((r) => r.bbox);
  if (boxes.length === 0) return null;
  const minLon = Math.max(...boxes.map((b) => b[0]));
  const minLat = Math.max(...boxes.map((b) => b[1]));
  const maxLon = Math.min(...boxes.map((b) => b[2]));
  const maxLat = Math.min(...boxes.map((b) => b[3]));
  const lat = (v: number) => `${fmtNum(Math.abs(v), 2)}° ${v < 0 ? "S" : "N"}`;
  const lon = (v: number) => `${fmtNum(Math.abs(v), 2)}° ${v < 0 ? "W" : "E"}`;
  return `The maps loaded (${dataset.name}) cover ${lat(minLat)} to ${lat(maxLat)} and ${lon(minLon)} to ${lon(maxLon)}.`;
}

// ---------------------------------------------------------------------------------------------
// One value: its box, its status, its sentence
// ---------------------------------------------------------------------------------------------

const BOX = "w-full min-w-0 rounded-lg border border-axis bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted";

function SmallButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex shrink-0 items-center rounded-full border border-axis bg-surface px-3 py-1 text-xs font-medium text-ink transition hover:bg-surface-2">
      {children}
    </button>
  );
}

/** The status of a value, by shape and by word, so it does not rest on colour. */
function StatusMark({ status }: { status: ValueStatus }) {
  const icon =
    status === "verified" ? (
      <StatusIcon status="pass" size={14} />
    ) : status === "unverified" ? (
      <StatusIcon status="warn" size={14} />
    ) : status === "missing" ? (
      <StatusIcon status="idle" size={14} />
    ) : (
      <svg viewBox="0 0 20 20" aria-hidden className="h-3.5 w-3.5 shrink-0" fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {status === "confirmed" ? (
          <>
            <rect x="2.5" y="2.5" width="15" height="15" rx="3" />
            <path d="M6 10.3l2.8 2.8 5.4-6" />
          </>
        ) : (
          <path d="M3 17l1-4L14 3l3 3L7 16z" />
        )}
      </svg>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ink-2">
      {icon}
      {STATUS_WORDS[status]}
    </span>
  );
}

/**
 * A box the underwriter types into. The value is taken when they leave the box or press Enter,
 * and only when it differs from what was there: looking at a verified value does not make it "edited".
 */
function TypedBox({ id, initial, kind, onCommit }: { id: string; initial: string; kind: FieldKind; onCommit: (text: string | null) => boolean }) {
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

function ValueField({ field, quoted, onEdit, onConfirm }: { field: FieldDef<string>; quoted: Quoted<string | number>; onEdit: (value: string | null) => boolean; onConfirm: () => void }) {
  const id = useId();
  const text = boxText(quoted.value, field.kind);
  const short = plainer(quoted.value, field.kind);
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label htmlFor={id} className="text-sm font-medium text-ink">{field.label}</label>
        <StatusMark status={quoted.status} />
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        {field.choices ? (
          <select id={id} value={typeof quoted.value === "string" ? quoted.value : ""} onChange={(e) => onEdit(e.target.value || null)} className={BOX}>
            <option value="">{field.empty ?? "Not stated"}</option>
            {field.choices.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        ) : (
          // Keyed by what it shows, so the box starts afresh whenever the value changes underneath it.
          <TypedBox key={`${quoted.status}:${text}`} id={id} initial={text} kind={field.kind} onCommit={onEdit} />
        )}
        {quoted.status === "unverified" && quoted.value !== null && <SmallButton onClick={onConfirm}>Confirm</SmallButton>}
      </div>
      {(short || field.hint) && <p className="mt-1 text-xs leading-relaxed text-muted">{[short, field.hint].filter(Boolean).join(" · ")}</p>}
      {quoted.status === "unverified" && (
        <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
          {quoted.reason ?? "This value has not been checked."} {quoted.value !== null ? "Not used until you confirm it or type over it." : "Type the value to use it."}
        </p>
      )}
      {quoted.quote.trim() && (
        <details className="mt-1.5 text-xs text-muted">
          <summary className="cursor-pointer select-none hover:text-ink-2">{quoted.status === "edited" ? "Sentence first given for it" : "Source sentence"}</summary>
          <blockquote className="mt-1 border-l-2 border-axis pl-2.5 leading-relaxed whitespace-pre-wrap wrap-anywhere text-ink-2">{quoted.quote}</blockquote>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Where a building is taken to be
// ---------------------------------------------------------------------------------------------

function LocationLine({ location }: { location: OfferLocation }) {
  let body: ReactNode;
  if (location.kind === "exact") {
    const r = location.reading;
    body = (
      <>
        <Tag kind="real">Exact coordinates</Tag>
        <span className="min-w-0 flex-1 basis-64">
          {fmtPoint(location.lat, location.lon)}. {r ? <>Read from &ldquo;{r.raw}&rdquo; as {describeReading(r)}.</> : "Typed by you, not read from the document."}
        </span>
        {r?.writtenBothWays && !r.conflict && (
          <span className="flex basis-full items-start gap-2">
            <span className="mt-0.5"><StatusIcon status="warn" size={14} /></span>
            Written both ways: the document gives a minus sign and a hemisphere letter for the same number. They say the same thing, so the point is used as read.
          </span>
        )}
        {r?.conflict && (
          <span className="flex basis-full items-start gap-2">
            <span className="mt-0.5"><StatusIcon status="warn" size={14} /></span>
            The minus sign and the hemisphere letter disagree. The letter was used, and you confirmed the point.
          </span>
        )}
      </>
    );
  } else if (location.kind === "approximate") {
    const from = location.source === "ward" ? `the centre of ${location.matchedName} ward` : `the point of the named flood area "${location.matchedName}"`;
    body = (
      <>
        <Tag kind="assumption">Approximate location</Tag>
        <span className="min-w-0 flex-1 basis-64">
          No usable coordinates, so &ldquo;{location.placeName}&rdquo; stands in: {from}, at {fmtPoint(location.lat, location.lon)}. Every figure for this building depends on that stand-in point.
        </span>
      </>
    );
  } else {
    body = (
      <>
        <span className="mt-0.5"><StatusIcon status="warn" size={16} /></span>
        <span className="min-w-0 flex-1 basis-64">
          <span className="font-semibold text-ink">Not located.</span> {location.reason} Type a latitude and longitude above, or give a ward or a named flood area as the place name under the terms.
        </span>
      </>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-xl border border-line p-3 text-sm leading-relaxed text-ink-2">
      <span className="font-semibold text-ink">Location</span>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// What was sent
// ---------------------------------------------------------------------------------------------

const PRE = "mt-1 max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-2 p-2.5 font-mono text-xs leading-relaxed text-ink-2";

function SentCard({ offer }: { offer: OfferState }) {
  const { run, document } = offer;
  const byModel = run.path === "model";
  const chars = `${fmtInt(run.documentText.length)} characters`;
  const tokens = run.usage?.promptTokens ? `, ${fmtInt(run.usage.promptTokens)} tokens read and ${fmtInt(run.usage.outputTokens ?? 0)} written` : "";
  return (
    <Card
      title={run.sentToModel ? "What was sent to the model" : "Nothing was sent to the model"}
      aside={<Tag kind={byModel ? "ai" : "none"}>{byModel ? "Read by the model" : "Read by the fixed rules"}</Tag>}
    >
      <div className="space-y-3 text-sm leading-relaxed text-ink-2">
        {byModel ? (
          <p>
            The text of <span className="font-medium text-ink">{document.name}</span> went to {run.model ?? "the model"}, which listed the buildings and the terms{run.ms ? ` in ${(run.ms / 1000).toFixed(1)} s` : ""}{tokens}. Code then checked every value against the same text.
          </p>
        ) : run.sentToModel ? (
          <Note tone="warn">
            The text of {document.name} was sent to the model, but its answer could not be used, so the fixed rules read the offer in this browser. {run.fallbackReason}
          </Note>
        ) : (
          <p>
            <span className="font-medium text-ink">{document.name}</span> did not leave this browser. {run.fallbackReason}
          </p>
        )}
        <p>
          {describeRemoved(run.removed, run.sentToModel)}
          {run.removed.emails + run.removed.phones + run.removed.blocks.length > 0 ? " This was done in this browser, and a marker in square brackets shows where each one was." : ""}
        </p>
        <details>
          <summary className="cursor-pointer select-none font-medium text-ink-2 hover:text-ink">
            {run.sentToModel ? `Show the exact text sent (${chars})` : `Show the text the rules read (${chars})`}
          </summary>
          {run.prompt ? (
            <>
              <div className="mt-2 text-xs font-semibold text-ink-2">Instructions</div>
              <pre className={PRE}>{run.prompt.system}</pre>
              <div className="mt-2 text-xs font-semibold text-ink-2">Message, with the document as sent</div>
              <pre className={PRE}>{run.prompt.user}</pre>
            </>
          ) : (
            <>
              <div className="mt-2 text-xs font-semibold text-ink-2">The document, with contact details removed</div>
              <pre className={PRE}>{run.documentText}</pre>
              {run.sentToModel && <p className="mt-1 text-xs text-muted">The instructions sent around it were not reported back by the server.</p>}
            </>
          )}
        </details>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------

function PricedBuilding({ priced, pricing, isScore }: { priced: Extract<RowPricing, { status: "priced" }>; pricing: OfferPricing; isScore: boolean }) {
  const drainage = pricing.drainageOn;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-2">
        <span className="font-semibold text-ink">{priced.name}</span>
        <span>{HOUSING_LABELS[priced.housingClass]}</span>
        <span>
          Insured value {fmtKes(priced.tivKes)}
          {priced.tivFrom === "area_times_cost" ? " (floor area × cost per m², as none is stated)" : ""}
        </span>
        <span>{priced.ward ? `Falls in ${priced.ward.name} ward, ${priced.ward.subcounty}` : "Outside the ward map"}</span>
        {priced.location.kind === "approximate" && <Tag kind="assumption">Approximate location</Tag>}
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className={`w-full text-sm ${drainage ? "min-w-190" : "min-w-160"}`}>
          <thead className="text-xs text-muted">
            <tr>
              <th className="pb-2 text-left font-medium">Return period</th>
              <th className="pb-2 pl-3 text-right font-medium">Terrain depth (m)</th>
              {drainage && <th className="pb-2 pl-3 text-right font-medium">Drainage ponding (m)</th>}
              <th className="pb-2 pl-3 text-right font-medium">Damage ratio (%)</th>
              <th className="pb-2 pl-3 text-right font-medium">Ground-up loss (KES)</th>
              <th className="pb-2 pl-3 text-right font-medium">Gross loss (KES)</th>
              <th className="pb-2 pl-3 text-right font-medium">Nearest water on the terrain map</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {priced.scenarios.map((s) => {
              const wet = s.hazard > 0;
              return (
                <tr key={s.id}>
                  <td className="tabular py-2 text-ink">
                    <ReturnPeriod years={s.returnPeriod} />
                    {isScore && <span className="ml-1.5 text-xs text-muted">{s.label}</span>}
                  </td>
                  <td className="tabular py-2 pl-3 text-right text-ink-2">{wet ? (s.terrainM >= 0.005 ? `${fmtNum(s.terrainM, 2)} m` : "under 0.01 m") : "Dry"}</td>
                  {drainage && <td className="tabular py-2 pl-3 text-right text-ink-2">{s.drainageM > 0 ? `${fmtNum(s.drainageM, 2)} m` : "None"}</td>}
                  <td className="tabular py-2 pl-3 text-right text-ink-2">{fmtPct(s.damageRatio, 1)}</td>
                  <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{fmtKes(s.groundUpKes)}</td>
                  <td className="tabular whitespace-nowrap py-2 pl-3 text-right font-semibold text-ink">{fmtKes(s.grossKes)}</td>
                  <td className="tabular py-2 pl-3 text-right text-ink-2">{wet ? "Wet here" : s.nearestWetM === null ? "No water on this map" : `${fmtDistance(s.nearestWetM)} away`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {priced.dryInEveryTier && (
        <div className="mt-3">
          <Note>
            This point is dry on every terrain map, so the terrain adds no loss here. That is the model&apos;s answer for this exact point, not a finding that the site cannot flood: the last column shows how close the mapped water comes.
          </Note>
        </div>
      )}
    </div>
  );
}

/** Which label a term taken from the offer carries: read from the document, or typed over by the underwriter. */
function termOrigin(used: Quoted<unknown>[]): { label: string; quotes: string[] } {
  const typed = used.filter((q) => q.status === "edited").length;
  const quotes = [...new Set(used.filter((q) => q.status !== "edited").map((q) => q.quote.trim()).filter(Boolean))];
  return { label: typed === 0 ? "From the document" : typed === used.length ? "Typed by you" : "From the document, with a figure typed by you", quotes };
}

function TermLine({ name, text, origin }: { name: string; text: string; origin: { label: string; quotes: string[] } | null }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="text-sm font-semibold text-ink">{name}</span>
        {origin ? <Tag kind={origin.label === "Typed by you" ? "none" : "real"}>{origin.label}</Tag> : <Tag kind="assumption">Example terms</Tag>}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{text}</p>
      {origin?.quotes.map((quote) => (
        <blockquote key={quote} className="mt-1.5 border-l-2 border-axis pl-2.5 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-ink-2">{quote}</blockquote>
      ))}
      {!origin && <p className="mt-1.5 text-xs leading-relaxed text-muted">The document states none, so the Insurance terms panel in the Loss engine step is used.</p>}
    </div>
  );
}

/** The deductible and the limit the gross loss was worked out with, and where each one came from. */
function TermsUsed({ terms, stated, several }: { terms: PolicyTerms; stated: OfferTerms; several: boolean }) {
  const words = describeTerms(terms);
  const usable = (list: Quoted<unknown>[]) => list.filter((q) => usableValue(q) !== null);
  const fromDocument = terms.deductible.source === "document" || terms.limit.source === "document";
  const fromExample = terms.deductible.source === "example" || terms.limit.source === "example";
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Deductible and limit used for the gross loss</div>
      <div className="grid gap-3 @3xl:grid-cols-2">
        <TermLine
          name="Deductible"
          text={words.deductible}
          origin={terms.deductible.source === "document" ? termOrigin(usable([stated.floodDeductiblePct, stated.floodDeductibleMinKes, stated.floodDeductibleBasis])) : null}
        />
        <TermLine name="Limit" text={words.limit} origin={terms.limit.source === "document" ? termOrigin(usable([stated.floodLimitKes])) : null} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        Gross loss is the ground-up loss less the deductible, capped at the limit. It is what the insurer would pay, before any reinsurance.
        {fromExample ? " Example terms, not from any real policy or treaty: they are applied building by building, as for the portfolio." : ""}
        {fromDocument && several ? " A term from the document is applied once per flood to the whole offer and shared between its buildings in proportion to their loss." : ""}
      </p>
    </div>
  );
}

function PortfolioCard({ effect, matchesHeader }: { effect: PortfolioEffect; matchesHeader: boolean }) {
  const a = effect.without;
  const b = effect.with;
  const loss = (f: PortfolioEffect["with"]) => (f.loss100Kes === null ? "not modelled" : `${fmtKes(f.loss100Kes)}${f.loss100Extrapolated ? " †" : ""}`);
  const added = (before: number, after: number) => {
    const diff = after - before;
    if (Math.abs(diff) < 0.5) return "no change";
    return `${diff > 0 ? "+" : "-"}${fmtKes(Math.abs(diff))}${before > 0 ? ` (${diff > 0 ? "+" : "-"}${fmtPct(Math.abs(diff) / before, 3)})` : ""}`;
  };
  const cell = "tabular whitespace-nowrap py-2 pl-3 text-right";
  return (
    <Card title="Effect on the portfolio" aside={<Tag kind="synthetic">Synthetic portfolio</Tag>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-120 text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="pb-2 text-left font-medium">Ground-up, before any terms</th>
              <th className="pb-2 pl-3 text-right font-medium">Without the offer</th>
              <th className="pb-2 pl-3 text-right font-medium">With the offer</th>
              <th className="pb-2 pl-3 text-right font-medium">Added</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="py-2 text-ink">Buildings</td>
              <td className={`${cell} text-ink-2`}>{fmtInt(a.buildings)}</td>
              <td className={`${cell} font-semibold text-ink`}>{fmtInt(b.buildings)}</td>
              <td className={`${cell} text-ink-2`}>+{fmtInt(b.buildings - a.buildings)}</td>
            </tr>
            <tr>
              <td className="py-2 text-ink">Insured value</td>
              <td className={`${cell} text-ink-2`}>{fmtKes(a.totalTivKes)}</td>
              <td className={`${cell} font-semibold text-ink`}>{fmtKes(b.totalTivKes)}</td>
              <td className={`${cell} text-ink-2`}>{added(a.totalTivKes, b.totalTivKes)}</td>
            </tr>
            <tr>
              <td className="py-2 text-ink"><ReturnPeriod years={100} /> loss</td>
              <td className={`${cell} text-ink-2`}>{loss(a)}</td>
              <td className={`${cell} font-semibold text-ink`}>{loss(b)}</td>
              <td className={`${cell} text-ink-2`}>{a.loss100Kes !== null && b.loss100Kes !== null ? added(a.loss100Kes, b.loss100Kes) : "n/a"}</td>
            </tr>
            <tr>
              <td className="py-2 text-ink">Average annual loss</td>
              <td className={`${cell} text-ink-2`}>{fmtKes(a.aalKes)}</td>
              <td className={`${cell} font-semibold text-ink`}>{fmtKes(b.aalKes)}</td>
              <td className={`${cell} text-ink-2`}>{added(a.aalKes, b.aalKes)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        The offer&apos;s buildings are added to the loaded buildings and the same engine is run on the longer list. These are ground-up figures: before any deductible, limit or reinsurance.
        {matchesHeader ? " The figures without the offer are the ones in the bar at the top of the page." : ""}
        {a.loss100Extrapolated || b.loss100Extrapolated ? " † held flat beyond the rarest modelled scenario." : ""}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------

export function OfferStep({ session, active, drainage, modelReady, offer, onOffer, policyDefaults, onLog }: Props) {
  const { dataset } = session;
  const isScore = dataset.hazardKind === "score";

  const [geo, setGeo] = useState<GeoLayers | null>(null);
  const [file, setFile] = useState<OfferDocument | null>(offer && offer.document.kind !== "typed" ? offer.document : null);
  const [typed, setTyped] = useState(offer?.document.kind === "typed" ? offer.document.text : "");
  const [rulesOnly, setRulesOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const textId = useId();

  // Ward names and the waterways: for place names, the ward a point falls in and the river check.
  useEffect(() => {
    loadGeo().then(setGeo);
  }, []);

  const chooseFile = (chosen: File | undefined) => {
    if (!chosen) return;
    setProblem(null);
    // Opened here, in the browser. Nothing is sent anywhere until the button is pressed.
    readOfferFile(chosen)
      .then((doc) => {
        setFile(doc);
        setTyped("");
      })
      .catch((e: Error) => {
        setFile(null);
        setProblem(e.message);
      });
  };

  const source: OfferDocument | null = file ?? (typed.trim() ? { name: "typed text", kind: "typed", text: typed } : null);

  const read = async () => {
    if (!source || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const layers = geo ?? (await loadGeo());
      // The rules find a place in free text only if they know the names to look for.
      const knownPlaces = [...(layers.wards?.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())) ?? []), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
      const run = await extractOffer(source.text, { rulesOnly, knownPlaces });
      onOffer({ document: source, run, extraction: run.extraction });
      const counts = statusCounts(run.extraction);
      // Counts and names only: the run log is downloaded with the audit file, and no document text belongs in it.
      onLog(
        `${source.name} read by ${run.path === "model" ? `the model (${run.model ?? "model"}${run.ms ? `, ${(run.ms / 1000).toFixed(1)} s` : ""})` : "the fixed rules"}: ${plural(run.extraction.rows.length, "building")}, ${counts.verified} values verified, ${counts.unverified} unverified; ${run.sentToModel ? `${fmtInt(run.documentText.length)} characters sent with contact details removed` : "nothing sent to the model"}`,
      );
    } catch (e) {
      setProblem(`The offer could not be read: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const extraction = offer?.extraction ?? null;
  const wards = geo?.wards ?? null;
  const waterways = geo?.waterways ?? null;

  // Everything below is code only. The rows hold usable values and nothing else: pricingRows leaves an
  // unverified value out and blocks the row it belongs to, so nothing is priced around it.
  const rows = useMemo(() => (extraction && geo ? pricingRows(extraction, wards, dataset.hotspots) : []), [extraction, geo, wards, dataset]);
  const pricing = useMemo(
    () => (extraction && geo ? priceOffer({ dataset, params: active.params, drainage, rows, terms: policyTerms(extraction.terms, policyDefaults), wards }) : null),
    [extraction, geo, dataset, active.params, drainage, rows, wards, policyDefaults],
  );
  const waiting = useMemo(() => (extraction ? holdUps(extraction) : []), [extraction]);
  const held = waiting.length > 0;
  const checks = useMemo<Check[]>(() => {
    if (!extraction || !pricing) return [];
    const all = offerChecks({ extraction, rows, pricing, dataset, waterways });
    // While pricing waits, the checks that rest on a price or a location wait with it.
    return held ? all.filter((c) => c.id === "offer-values") : all;
  }, [extraction, pricing, rows, dataset, waterways, held]);

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
  const confirm = (ref: ValueRef) => offer && change(confirmValue(offer.extraction, ref));

  const counts = extraction ? statusCounts(extraction) : null;
  const notes = extraction ? extraction.notes.map((note, index) => ({ note, index })).filter((n) => n.note.status !== "missing") : [];
  const priced = pricing ? pricing.rows.filter((r): r is Extract<RowPricing, { status: "priced" }> => r.status === "priced") : [];
  const totals = pricing?.totals ?? null;
  const floodCover = extraction ? usableValue(extraction.terms.floodCover) : null;
  const covered = coverage(dataset);
  const matchesHeader = !!pricing?.portfolio && Math.abs(pricing.portfolio.without.aalKes - active.result.aalKes) <= 1e-6 * Math.max(1, active.result.aalKes);
  const summary = summarise(checks);

  return (
    <div>
      <StepHeader kicker="Step 8" title="Price an offer">
        Give a broker&apos;s memo, or describe an offer in a sentence. The model turns it into rows in the exposure file&apos;s shape, code checks every value against the document, and code alone works out the damage and the loss on the maps and assumptions already loaded.
      </StepHeader>

      <div className="grid gap-4 @5xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card title="The offer" aside={<span className="text-xs text-muted">Word (.docx), text (.txt) or typed</span>}>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              chooseFile(e.dataTransfer.files[0]);
            }}
            className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border-2 border-dashed px-4 py-3 transition ${over ? "border-accent bg-accent-wash" : "border-axis bg-surface"}`}
          >
            <Button variant="secondary" className="whitespace-nowrap" onClick={() => picker.current?.click()}>Choose a file</Button>
            <div className="min-w-0 flex-1 basis-48 text-sm leading-relaxed text-ink-2">
              {file ? (
                <>
                  <span className="font-medium text-ink wrap-anywhere">{file.name}</span>
                  <span className="text-muted"> · {fmtInt(file.text.length)} characters, opened in this browser</span>
                </>
              ) : (
                "A broker's memo as a Word or text file. Drop it here or choose it. It is opened in this browser."
              )}
            </div>
            {file && <SmallButton onClick={() => setFile(null)}>Remove</SmallButton>}
            <input
              ref={picker}
              type="file"
              accept=".docx,.txt"
              className="hidden"
              onChange={(e) => {
                chooseFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          <label htmlFor={textId} className="mt-4 block text-sm font-medium text-ink">Or describe the offer in plain English</label>
          <textarea
            id={textId}
            rows={4}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              // One source at a time: typing takes the place of a chosen file.
              if (file) setFile(null);
            }}
            placeholder="For example: two-storey masonry shop in Kibera worth KES 8 million"
            className={`${BOX} mt-1.5 leading-relaxed`}
          />

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <Button className="whitespace-nowrap" onClick={read} disabled={!source || busy}>
              {busy && <StatusIcon status="running" size={16} />}
              {busy ? "Reading the offer" : offer ? "Read the offer again" : "Read the offer"}
            </Button>
            <label className="flex min-w-0 items-start gap-2 text-sm leading-snug text-ink-2">
              <input type="checkbox" checked={rulesOnly} onChange={(e) => setRulesOnly(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]" />
              <span>Fixed rules only: nothing leaves this browser</span>
            </label>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {source ? `Will read ${source.kind === "typed" ? `the typed text (${fmtInt(source.text.length)} characters)` : source.name}. ` : "Choose a file or type a description first. "}
            {rulesOnly
              ? "The fixed rules read it here, with no model."
              : modelReady === false
                ? "No key is set for the model, so the fixed rules will read it here and nothing will be sent."
                : "Email addresses, phone numbers, and contact and signature blocks are taken out first; the rest goes to the model."}
          </p>
          {problem && <div className="mt-3"><Note tone="warn">{problem}</Note></div>}
        </Card>

        {offer ? (
          <SentCard offer={offer} />
        ) : (
          <Card title="How an offer is priced">
            <ol className="space-y-2.5 text-sm leading-relaxed text-ink-2">
              {[
                "Contact details are taken out of the text in this browser, and you can see exactly what is left.",
                "The model lists each insured building and the flood terms, each with the sentence it came from. With no key, or if the call fails, a set of fixed rules does the reading.",
                "Code checks every value: the sentence must be in the document and the number must be in the sentence. A value that fails waits for you.",
                "Code alone reads the hazard maps at the building and works out depth, damage and loss. The model supplies no figure.",
                "The deductible and the limit stated in the document turn the ground-up loss into the gross loss. Where the document states none, the example terms of the Insurance terms panel are used, and the screen says which.",
              ].map((line, i) => (
                <li key={line} className="flex gap-3">
                  <span className="tabular flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs text-ink-2">{i + 1}</span>
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ol>
          </Card>
        )}
      </div>

      {offer && extraction && counts && (
        <Card
          title="What was read"
          className="mt-4"
          aside={
            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
              <span className="inline-flex items-center gap-1"><StatusIcon status="pass" size={14} /> {counts.verified} verified</span>
              <span className="inline-flex items-center gap-1"><StatusIcon status="warn" size={14} /> {counts.unverified} unverified</span>
              {counts.confirmed + counts.edited > 0 && <span>{counts.confirmed + counts.edited} set by you</span>}
            </span>
          }
        >
          <p className="mb-4 max-w-4xl text-sm leading-relaxed text-ink-2">
            Verified means code found the sentence in the document and the number in the sentence. It shows the value was written, not that it was understood, so the sentence sits under every value. An unverified value is not used until you confirm it or type over it. Every box can be changed.
          </p>

          <div className="space-y-4">
            {extraction.rows.map((row, i) => {
              const name = usableValue(row.name);
              return (
                <section key={i} className="rounded-2xl border border-line p-4">
                  <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <h4 className="min-w-0 text-sm font-semibold text-ink wrap-anywhere">
                      Building {i + 1}
                      {name ? `: ${name}` : ""}
                    </h4>
                    <Tag kind={row.path === "model" ? "ai" : "none"}>{row.path === "model" ? "Read by the model" : "Read by the fixed rules"}</Tag>
                  </header>
                  <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3 @7xl:grid-cols-4">
                    {ROW_FIELDS.map((f) => {
                      const ref: ValueRef = { scope: "row", row: i, key: f.key };
                      return <ValueField key={f.key} field={f} quoted={row[f.key]} onEdit={(v) => edit(ref, v)} onConfirm={() => confirm(ref)} />;
                    })}
                  </div>
                  {rows[i] && <LocationLine location={rows[i].location} />}
                </section>
              );
            })}
          </div>

          {TERM_GROUPS.map((group) => (
            <div key={group.title} className="mt-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{group.title}</div>
              <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3 @7xl:grid-cols-4">
                {group.fields.map((f) => {
                  const ref: ValueRef = { scope: "terms", key: f.key };
                  return <ValueField key={f.key} field={f} quoted={extraction.terms[f.key]} onEdit={(v) => edit(ref, v)} onConfirm={() => confirm(ref)} />;
                })}
              </div>
            </div>
          ))}

          <div className="mt-5">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Flood notes from the document</div>
            {notes.length === 0 ? (
              <p className="text-sm leading-relaxed text-ink-2">No note was read on plant in basements, past flood or water damage, the state of the drains, or the broker&apos;s own view of the flood risk.</p>
            ) : (
              <ul className="grid gap-3 @4xl:grid-cols-2">
                {notes.map(({ note, index }) => (
                  <li key={index} className="min-w-0 rounded-xl border border-line bg-surface-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="text-sm font-medium text-ink">{NOTE_LABELS[note.kind]}</span>
                      <StatusMark status={note.status} />
                    </div>
                    {note.value && note.value !== NOTE_LABELS[note.kind] && <p className="mt-1 text-sm leading-relaxed text-ink-2 wrap-anywhere">{note.value}</p>}
                    {note.quote.trim() && <blockquote className="mt-1.5 border-l-2 border-axis pl-2.5 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-ink-2">{note.quote}</blockquote>}
                    {note.status === "unverified" && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs leading-relaxed text-ink-2">
                        <span className="min-w-0 flex-1 basis-48">{note.reason ?? "This note has not been checked."} Not used in the checks until confirmed.</span>
                        {note.value !== null && <SmallButton onClick={() => confirm({ scope: "note", index })}>Confirm</SmallButton>}
                        <SmallButton onClick={() => edit({ scope: "note", index }, null)}>Leave out</SmallButton>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {offer && extraction && !pricing && (
        <div className="mt-4"><Note>Loading the ward map before the offer is placed.</Note></div>
      )}

      {offer && extraction && pricing && (
        <>
          <div className="mt-4 grid gap-4 @6xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <Card
              title="Flood price, worked out by code"
              aside={
                <span className="inline-flex flex-wrap gap-2">
                  <Tag kind={isScore ? "proxy" : "real"}>{isScore ? "Proxy hazard, not measured" : "Published depth maps"}</Tag>
                  {pricing.drainageOn && <Tag kind="assumption">Drainage ponding assumed</Tag>}
                  <Tag kind={active.source === "ai" ? "ai" : "assumption"}>{active.source === "ai" ? "Agreed assumptions" : "Reference assumptions"}</Tag>
                </span>
              }
            >
              {held && (
                <Note tone="warn">
                  <div className="font-semibold text-ink">Pricing is waiting for {plural(waiting.length, "value")}</div>
                  <p className="mt-0.5">Code could not verify {waiting.length === 1 ? "this value" : "these values"} against the document, so {waiting.length === 1 ? "it is" : "they are"} not used. Confirm each one, clear it, or type the right value in its box above.</p>
                  <ul className="mt-2 space-y-2">
                    {waiting.map((h) => (
                      <li key={`${h.where}:${h.field.key}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="min-w-0 flex-1 basis-64">
                          <span className="font-medium text-ink">{h.where}, {h.field.label.toLowerCase()}:</span> {inWords(h.quoted.value, h.field)}. {h.quoted.reason ?? "Not checked."}
                        </span>
                        <span className="inline-flex gap-2">
                          {h.quoted.value !== null && <SmallButton onClick={() => confirm(h.ref)}>Confirm</SmallButton>}
                          <SmallButton onClick={() => edit(h.ref, null)}>Clear</SmallButton>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Note>
              )}

              <div className={`space-y-5 ${held ? "mt-4" : ""}`}>
                {pricing.rows.map((r) => {
                  // An answer of "outside" needs nothing but the location. A location that still waits on
                  // the underwriter is never "outside": pricingRows gives it no point at all.
                  if (r.status === "outside") {
                    return (
                      <Note key={r.locId} tone="warn">
                        <div className="font-semibold text-ink">{r.name}: {OUTSIDE_MAPS_MESSAGE}.</div>
                        <p className="mt-0.5">
                          {r.location.kind !== "none" ? `The building is at ${fmtPoint(r.location.lat, r.location.lon)}${r.location.kind === "approximate" ? " (approximate)" : ""}. ` : ""}
                          {covered ?? "No hazard maps are loaded."} No depth, damage or loss is shown for it: a figure of zero would be wrong. Load the hazard maps for that area to price it.
                        </p>
                      </Note>
                    );
                  }
                  if (held) return null;
                  if (r.status === "not_ready") {
                    return (
                      <Note key={r.locId} tone="warn">
                        <div className="font-semibold text-ink">{r.name}: not priced yet</div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5">
                          {r.blockers.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>
                      </Note>
                    );
                  }
                  return <PricedBuilding key={r.locId} priced={r} pricing={pricing} isScore={isScore} />;
                })}
              </div>

              {!held && totals && (
                <>
                  {priced.length > 1 && (
                    <div className="mt-5 overflow-x-auto">
                      <table className="w-full min-w-120 text-sm">
                        <thead className="text-xs text-muted">
                          <tr>
                            <th className="pb-2 text-left font-medium">All {fmtInt(priced.length)} priced buildings</th>
                            <th className="pb-2 pl-3 text-right font-medium">Ground-up loss (KES)</th>
                            <th className="pb-2 pl-3 text-right font-medium">Gross loss (KES)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {totals.scenarios.map((s) => (
                            <tr key={s.id}>
                              <td className="tabular py-2 text-ink"><ReturnPeriod years={s.returnPeriod} /></td>
                              <td className="tabular whitespace-nowrap py-2 pl-3 text-right text-ink-2">{fmtKes(s.groundUpKes)}</td>
                              <td className="tabular whitespace-nowrap py-2 pl-3 text-right font-semibold text-ink">{fmtKes(s.grossKes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <TermsUsed terms={pricing.terms} stated={extraction.terms} several={priced.length > 1} />
                  {floodCover !== "excluded" && (
                    <p className="mt-3 text-sm leading-relaxed text-ink-2">{floodCover === "covered" ? "The document asks for flood to be covered." : "The document does not say whether flood is to be covered."}</p>
                  )}
                  {floodCover === "excluded" && (
                    <div className="mt-3">
                      <Note tone="warn">The document asks for flood to be excluded. The figures here are what flood would cost if it were covered.</Note>
                    </div>
                  )}

                  <div className="mt-4 grid gap-4 @2xl:grid-cols-3">
                    <Stat label="Average annual loss, ground-up" value={fmtKes(totals.aalGroundUpKes)} note={`Before any terms. ${fmtRate(totals.ratePerMilleGroundUp)} of the insured value of ${fmtKes(totals.tivKes)}`} />
                    <Stat label="Average annual loss, gross" value={fmtKes(totals.aalGrossKes)} note={`After the deductible and the limit. ${fmtRate(totals.ratePerMilleGross)} of insured value`} />
                    <Stat
                      label="Pure flood rate, gross"
                      value={fmtRate(totals.ratePerMilleGross)}
                      note={<>Gross average annual loss ÷ insured value × 1000. Ground-up: {fmtRate(totals.ratePerMilleGroundUp)}. Before expense, profit and uncertainty loadings, and before any reinsurance.</>}
                    />
                  </div>

                  <p className="mt-3 text-xs leading-relaxed text-muted">
                    Every figure in this card comes from the loss engine: the hazard maps read at the building, the damage curve for its class, and its insured value. None comes from the model.
                    {isScore ? " Depth is worked out from a 0 to 1 susceptibility score and the assumed depth scale, and the return periods are assumed: it is not a measured depth." : ""}
                    {pricing.drainageOn ? " Drainage ponding is an assumed depth near open drains and informal settlements; the damage is read at the deeper of the two." : ""}
                  </p>
                </>
              )}
            </Card>

            <div className="grid content-start gap-4">
              {!held && pricing.portfolio && <PortfolioCard effect={pricing.portfolio} matchesHeader={matchesHeader} />}
              <Card title="The rows as an exposure file">
                <p className="text-sm leading-relaxed text-ink-2">
                  {plural(rows.length, "row")} in the exposure file&apos;s columns, marked synthetic=false and source=offer:{offer.document.name}. A value that is not known, or not yet confirmed, is left blank.
                </p>
                <div className="mt-3">
                  <Button variant="secondary" onClick={() => download(`offer-rows-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`, offerCsv(rows, offer.document.name), "text/csv")}>
                    Download the rows as CSV
                  </Button>
                </div>
              </Card>
            </div>
          </div>

          <Card title="Checks on this offer" className="mt-4" aside={<ChecksSummary checks={checks} />}>
            <CheckList checks={checks} stagger={90} />
            <p className="mt-3 text-xs leading-relaxed text-muted">
              {held
                ? "The checks on location, river distance, value per m², basements, flood history and the damage curve run once the values above are settled."
                : summary.warn + summary.fail > 0
                  ? "A warning is something to weigh before quoting. A limit of the model is shown as a warning, never as a failure of the offer."
                  : "Every check passed."}
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
