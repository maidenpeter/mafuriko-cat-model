"use client";

import { useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import type { FieldKind } from "@/lib/offer/fields";
import type { ValueStatus } from "@/lib/offer/types";
import { StatusIcon } from "../ui";
import { wantedFor } from "./values";

/** The small pieces the cards of the offer step share: a small button, a fold mark, a status chip and the box a value is typed into. */

export const BOX = "w-full min-w-0 rounded-lg border border-axis bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted";

const SMALL_LOOKS = {
  plain: "border-axis bg-surface text-ink hover:bg-surface-2",
  strong: "border-ink bg-ink text-surface hover:opacity-90",
  picked: "border-accent bg-accent-wash text-ink",
};

/**
 * A small button beside a value. `look` is "strong" for the one press a row is waiting for, and
 * "picked" while the thing the button shows is on show.
 */
export function SmallButton({ look = "plain", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { look?: keyof typeof SMALL_LOOKS }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition ${SMALL_LOOKS[look]} ${className}`}
    />
  );
}

/** The mark on a fold: it points down when the fold is open and to the side when it is shut. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 4.5l5.5 5.5-5.5 5.5" />
    </svg>
  );
}

const CHIP_WORDS: Record<ValueStatus, string> = {
  verified: "Verified",
  unverified: "Check this",
  confirmed: "Confirmed by you",
  edited: "Typed by you",
  missing: "Not stated",
};

/**
 * What code decided about a value, as a shape and a word, so it never rests on colour. Only the
 * value that waits for the underwriter is drawn as a pill: the eye goes to it first.
 */
export function StatusChip({ status }: { status: ValueStatus }) {
  const drawn = (children: ReactNode) => (
    <svg viewBox="0 0 20 20" aria-hidden className="h-3.5 w-3.5 shrink-0" fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
  const icon =
    status === "verified" ? (
      <StatusIcon status="pass" size={14} />
    ) : status === "unverified" ? (
      <StatusIcon status="warn" size={14} />
    ) : status === "missing" ? (
      <StatusIcon status="idle" size={14} />
    ) : status === "confirmed" ? (
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
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs ${status === "unverified" ? "rounded-full border border-axis bg-surface px-2 py-0.5 font-semibold text-ink" : "py-0.5 font-medium text-ink-2"}`}>
      {icon}
      {CHIP_WORDS[status]}
    </span>
  );
}

interface TypedBoxProps {
  id: string;
  /** The value's name, read out with the box. */
  label: string;
  initial: string;
  kind: FieldKind;
  placeholder?: string;
  /** Takes what was typed, or null for an emptied box. False when it could not be read for this value. */
  onCommit: (text: string | null) => boolean;
  /**
   * For a box opened to take an answer: called when it is left with nothing typed, or Escape is
   * pressed in it. `byKey` is true for Escape, when the keyboard has to be put somewhere else.
   */
  onAbandon?: (byKey: boolean) => void;
}

/**
 * A box the underwriter types into. The value is taken when they leave the box or press Enter,
 * and only when it differs from what was there: looking at a verified value does not make it "edited".
 * Escape puts back what was there. A box for text grows with what is in it where the browser can
 * do that, so a long name or period is read whole and not cut off at the edge of the box.
 */
export function TypedBox({ id, label, initial, kind, placeholder, onCommit, onAbandon }: TypedBoxProps) {
  const [draft, setDraft] = useState(initial);
  const [refused, setRefused] = useState(false);
  /** Set by Escape, so leaving the box straight after it takes nothing. */
  const dropped = useRef(false);
  const commit = () => {
    if (dropped.current) {
      dropped.current = false;
      return;
    }
    if (draft.trim() === initial.trim()) {
      setRefused(false);
      if (!draft.trim()) onAbandon?.(false);
      return;
    }
    setRefused(!onCommit(draft.trim() ? draft : null));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      // In a box for text Enter would start a new line: it takes the value, as in every other box.
      e.preventDefault();
      e.currentTarget.blur();
    }
    if (e.key !== "Escape") return;
    setDraft(initial);
    setRefused(false);
    if (onAbandon) {
      dropped.current = true;
      onAbandon(true);
    }
  };
  const shared = { id, "aria-label": label, value: draft, onBlur: commit, onKeyDown: onKey, "aria-invalid": refused, placeholder };
  return (
    <>
      {kind === "text" ? (
        // A pasted line break becomes a space: the value is one line of text.
        <textarea {...shared} rows={1} onChange={(e) => setDraft(e.target.value.replace(/\s*[\r\n]+\s*/g, " "))} className={`${BOX} block resize-none field-sizing-content`} />
      ) : (
        <input {...shared} onChange={(e) => setDraft(e.target.value)} inputMode={kind === "degrees" ? "text" : "decimal"} className={`${BOX} tabular`} />
      )}
      {refused && (
        <p role="alert" className="mt-1 flex items-start gap-1.5 text-xs leading-relaxed text-ink-2">
          <span className="mt-0.5"><StatusIcon status="fail" size={12} /></span>
          Not taken: this box needs {wantedFor(kind)}.
        </p>
      )}
    </>
  );
}
