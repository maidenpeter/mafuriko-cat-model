"use client";

import { useId } from "react";
import { fieldDefOf } from "@/lib/offer/fields";
import type { FocusField } from "@/lib/offer/focus";
import { BOX, SmallButton, StatusChip, TypedBox } from "./parts";
import { boxLabel, boxText, helperOf } from "./values";

interface Props {
  field: FocusField;
  /** True when this is the value picked out: its sentence is written under it and marked in the document. */
  active: boolean;
  /** True for a value the document does not state, opened to take the broker's answer. */
  answering?: boolean;
  /** Picks the value out, or lets it go: its sentence under the row and its mark in the document. */
  onSentence: () => void;
  /** False when what was typed could not be read for this value. */
  onEdit: (value: string | null) => boolean;
  onConfirm: () => void;
  /** Takes the value out: it is then one the document does not state. */
  onClear: () => void;
  /** An answer box left empty, or left with Escape (`byKey`). */
  onAbandon?: (byKey: boolean) => void;
}

/**
 * The columns of a row where there is room for one line: the name, the box, the status, the sentence button.
 * Every row of a list shares them, so the boxes, the statuses and the buttons each stand in a column.
 * In a narrower list the name and the status share a first line and the box and the button a second.
 */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 border-l-4 py-2 pl-2 pr-1 @xl:grid-cols-[minmax(0,1.2fr)_minmax(10rem,1fr)_8.25rem_5rem]";
/** What is written under a row, across its whole width: why a check failed, and the sentence. */
const UNDER = "col-span-full leading-relaxed text-ink-2 @xl:order-5";

/**
 * One value as a row: its name, its box, what code decided about it, and the sentence it was read
 * from on request. A value code could not check is laid out to be settled where it stands: why the
 * check failed, the sentence itself, and the buttons to confirm it or clear it.
 * A flood note has no box: it is a remark to accept or leave out, not a figure to type.
 */
export function ValueRow({ field, active, answering = false, onSentence, onEdit, onConfirm, onClear, onAbandon }: Props) {
  const id = useId();
  const def = fieldDefOf(field.ref);
  const isNote = field.group === "note";
  const unverified = field.status === "unverified";
  const quote = field.quote.trim();
  const helper = helperOf(field);
  const name = boxLabel(field);
  const summary = isNote && field.value && field.value !== field.label ? field.value : null;
  const nameClass = "text-sm font-medium text-ink wrap-anywhere";
  // A value waiting for a check shows its sentence without being asked: the two are read together.
  const sentenceShown = quote !== "" && (active || unverified);

  return (
    <li
      data-field={field.id}
      // Takes the keyboard only when a row with no box of its own is brought into view.
      tabIndex={-1}
      aria-current={active ? "true" : undefined}
      // The value picked out carries a rule down its side as well as the wash.
      className={`${ROW} ${active ? "border-l-accent bg-accent-wash" : "border-l-transparent"}`}
    >
      <div className={`min-w-0 @xl:order-1 @xl:pt-1.5 ${def ? "" : "@xl:col-span-2"}`}>
        {def ? <label htmlFor={id} className={nameClass}>{name}</label> : <span className={nameClass}>{name}</span>}
        {helper && <p className="text-xs leading-snug text-muted">{helper}</p>}
        {summary && <p className="mt-0.5 text-sm leading-relaxed text-ink-2 wrap-anywhere">{summary}</p>}
      </div>

      <div className="flex justify-end @xl:order-3 @xl:justify-start @xl:pt-1.5">
        <StatusChip status={field.status} />
      </div>

      {/* One line under the name in a narrow list; in a wide one the box and the button are columns of the row itself. */}
      <div className="col-span-full flex flex-wrap items-start gap-x-3 gap-y-1.5 @xl:contents">
        {def && (
          <div className="min-w-0 max-w-80 flex-1 basis-40 @xl:order-2 @xl:max-w-none">
            {def.choices ? (
              <select
                id={id}
                aria-label={field.label}
                value={typeof field.raw === "string" ? field.raw : ""}
                onChange={(e) => onEdit(e.target.value || null)}
                onBlur={() => {
                  if (answering) onAbandon?.(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && answering) onAbandon?.(true);
                }}
                className={BOX}
              >
                <option value="">{def.empty ?? "Not stated"}</option>
                {def.choices.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            ) : (
              // Keyed by what it shows, so the box starts afresh whenever the value changes underneath it.
              <TypedBox
                key={`${field.status}:${boxText(field.raw, def.kind)}`}
                id={id}
                label={field.label}
                initial={boxText(field.raw, def.kind)}
                kind={def.kind}
                placeholder={answering ? "Type the answer" : undefined}
                onCommit={onEdit}
                onAbandon={answering ? onAbandon : undefined}
              />
            )}
          </div>
        )}
        <div className="ml-auto flex shrink-0 justify-end @xl:order-4 @xl:ml-0 @xl:pt-1">
          {quote && (
            // For a value waiting for a check the sentence is already on show, so the button only picks it out in the document.
            <SmallButton
              aria-expanded={unverified ? undefined : active}
              aria-pressed={unverified ? active : undefined}
              aria-controls={unverified ? undefined : `${id}-sentence`}
              onClick={onSentence}
              look={active ? "picked" : "plain"}
            >
              Sentence
            </SmallButton>
          )}
        </div>
      </div>

      {unverified && (
        <div className={`${UNDER} flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs`}>
          <p className="min-w-0 flex-1 basis-64">
            {field.reason ?? "This value has not been checked."}{" "}
            {isNote
              ? "Not used in the checks until confirmed."
              : field.raw === null
                ? "Type the value to use it."
                : field.holdsPricing
                  ? "Pricing waits until you confirm it or type over it."
                  : "Not used until you confirm it or type over it."}
          </p>
          <span className="flex shrink-0 gap-1.5">
            {/* Only a value that is there can be accepted: one that could not be read has to be typed. */}
            {field.raw !== null && <SmallButton look="strong" onClick={onConfirm}>Confirm</SmallButton>}
            <SmallButton onClick={onClear}>{isNote ? "Leave out" : "Clear"}</SmallButton>
          </span>
        </div>
      )}
      {quote && (
        <blockquote id={`${id}-sentence`} hidden={!sentenceShown} className={`${UNDER} border-l-2 border-axis pl-2.5 text-sm wrap-anywhere`}>
          &ldquo;{quote}&rdquo;
        </blockquote>
      )}
    </li>
  );
}
