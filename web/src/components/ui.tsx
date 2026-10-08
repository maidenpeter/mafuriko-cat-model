"use client";

import { motion } from "motion/react";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { summarise, type Check, type CheckStatus } from "@/lib/checks";
import { insuredValueFlag, PLACEHOLDER_BADGE } from "@/lib/labels";
import type { OfferFocus } from "@/lib/offer/focus";
import { STEP_NAMES, type StepId } from "@/lib/steps";

/** `size` is the icon's size in pixels at the Standard text size. It is drawn in rem, so it grows with the text beside it. */
export function StatusIcon({ status, size = 18 }: { status: CheckStatus | "running" | "idle"; size?: number }) {
  const rem = `${size / 16}rem`;
  const common = { viewBox: "0 0 20 20", "aria-hidden": true, style: { width: rem, height: rem } } as const;
  if (status === "running") {
    return (
      <svg {...common} className="spinner shrink-0">
        <circle cx="10" cy="10" r="7" fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "idle") {
    return (
      <svg {...common} className="shrink-0">
        <circle cx="10" cy="10" r="7" fill="none" stroke="var(--axis)" strokeWidth="2" />
      </svg>
    );
  }
  if (status === "pass") {
    return (
      <svg {...common} className="shrink-0">
        <circle cx="10" cy="10" r="9" fill="var(--good)" />
        <path d="M5.8 10.3l2.8 2.8 5.6-6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "warn") {
    return (
      <svg {...common} className="shrink-0">
        <path d="M10 1.8l8.6 15.4H1.4z" fill="var(--warning)" />
        <path d="M10 7.2v4.6M10 14.4v.2" stroke="#0b0b0b" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common} className="shrink-0">
      <circle cx="10" cy="10" r="9" fill="var(--critical)" />
      <path d="M6.6 6.6l6.8 6.8M13.4 6.6l-6.8 6.8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const STATUS_WORD: Record<CheckStatus, string> = { pass: "Pass", warn: "Warning", fail: "Fail" };

export type TagKind = "real" | "proxy" | "synthetic" | "assumption" | "ai" | "none";

const TAGS: Record<TagKind, { label: string; glyph: string }> = {
  real: { label: "Real data", glyph: "●" },
  proxy: { label: "Derived proxy", glyph: "◐" },
  synthetic: { label: "Synthetic", glyph: "○" },
  assumption: { label: "Assumption", glyph: "△" },
  ai: { label: "AI-proposed", glyph: "✦" },
  none: { label: "Not used", glyph: "-" },
};

/**
 * Says where a number or file comes from. Shape and word carry the meaning, not colour.
 * It stays on one line where there is room; a label wider than its box wraps inside the pill.
 */
export function Tag({ kind, children }: { kind: TagKind; children?: ReactNode }) {
  return (
    <span className="inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-ink-2">
      <span aria-hidden className="shrink-0">{TAGS[kind].glyph}</span>
      {children ?? TAGS[kind].label}
    </span>
  );
}

/** The badge on the cost of capital and the minimum flood rate: the Assumption badge's look, with the words that say who sets them. */
export function PlaceholderBadge() {
  return <Tag kind="assumption">{PLACEHOLDER_BADGE}</Tag>;
}

/**
 * The flag beside a total of insured values when the file's values are not what their own formula gives.
 * `ratio` is session.report.tivRatio?.median. Draws nothing when the values agree with the formula.
 * `inline` draws the short form beside a figure, with the full sentence on hover; otherwise the full sentence and where it is explained.
 */
export function InsuredValueFlag({ ratio, inline = false, className = "" }: { ratio: number | null | undefined; inline?: boolean; className?: string }) {
  const flag = insuredValueFlag(ratio);
  if (!flag) return null;
  if (inline) {
    return (
      <span title={`${flag.full} ${flag.where}`} className={`inline-flex items-center gap-1 text-xs font-medium text-ink-2 ${className}`}>
        <span aria-hidden>△</span>
        <span aria-hidden>{flag.short}</span>
        <span className="sr-only">{`${flag.full} ${flag.where}`}</span>
      </span>
    );
  }
  return (
    <p className={`flex items-start gap-1.5 text-xs leading-relaxed text-ink-2 ${className}`}>
      <span aria-hidden className="shrink-0">△</span>
      <span className="min-w-0"><strong className="font-semibold text-ink">{flag.full}</strong> {flag.where}</span>
    </p>
  );
}

export function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-line bg-surface p-5 ${className}`}>
      {(title || aside) && (
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h3 className="min-w-0 text-base font-semibold text-ink">{title}</h3>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, note, hero = false, className = "" }: { label: string; value: ReactNode; note?: ReactNode; hero?: boolean; className?: string }) {
  return (
    <div className={`rounded-2xl border border-line bg-surface p-5 ${className}`}>
      <div className="text-sm text-ink-2">{label}</div>
      <div className={`mt-1 font-semibold tracking-tight text-ink ${hero ? "text-5xl" : "text-2xl"}`}>{value}</div>
      {note && <div className="mt-1.5 text-xs leading-relaxed text-muted">{note}</div>}
    </div>
  );
}

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const styles = {
    primary: "bg-ink text-surface hover:opacity-90",
    secondary: "border border-axis bg-surface text-ink hover:bg-surface-2",
    ghost: "text-ink-2 hover:bg-surface-2",
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    />
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-full border border-line bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 text-sm transition ${o.value === value ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-2 hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ChecksSummary({ checks }: { checks: Check[] }) {
  const s = summarise(checks);
  return (
    <span className="inline-flex items-center gap-3 text-sm text-ink-2">
      <span className="inline-flex items-center gap-1"><StatusIcon status="pass" size={14} /> {s.pass} passed</span>
      {s.warn > 0 && <span className="inline-flex items-center gap-1"><StatusIcon status="warn" size={14} /> {s.warn} warning{s.warn > 1 ? "s" : ""}</span>}
      {s.fail > 0 && <span className="inline-flex items-center gap-1"><StatusIcon status="fail" size={14} /> {s.fail} failed</span>}
    </span>
  );
}

/**
 * Checks ticking off one after another. The results are computed before this
 * renders; the stagger only paces how they are revealed.
 */
export function CheckList({ checks, stagger = 160 }: { checks: Check[]; stagger?: number }) {
  const key = checks.map((c) => c.id + c.status).join("|");
  const [state, setState] = useState({ key, shown: 0 });
  const shown = state.key === key ? state.shown : 0;

  useEffect(() => {
    if (shown >= checks.length) return;
    const t = setTimeout(() => setState({ key, shown: shown + 1 }), stagger);
    return () => clearTimeout(t);
  }, [shown, checks.length, stagger, key]);

  return (
    <ul className="divide-y divide-line">
      {checks.map((c, i) => {
        const done = i < shown;
        return (
          <li key={c.id} className="flex gap-3 py-2.5">
            <span className="mt-0.5">
              <StatusIcon status={done ? c.status : i === shown ? "running" : "idle"} />
            </span>
            <div className="min-w-0 wrap-anywhere">
              <div className={`text-sm ${done ? "text-ink" : "text-muted"}`}>
                {c.title}
                {done && c.status !== "pass" && <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-ink-2">{STATUS_WORD[c.status]}</span>}
              </div>
              {done && (
                <motion.div initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} className="mt-0.5 text-sm leading-relaxed text-ink-2">
                  {c.detail}
                </motion.div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface-2 p-3.5 text-sm leading-relaxed text-ink-2">
      {tone === "warn" && <span className="mt-0.5"><StatusIcon status="warn" /></span>}
      <div className="min-w-0 wrap-anywhere">{children}</div>
    </div>
  );
}

export function StepHeader({ title, children }: { kicker?: string; title: string; children?: ReactNode }) {
  // The step number and name are shown in the top bar, so the page does not print them again:
  // the heading stays for screen readers and the introduction leads the step.
  return (
    <header className="mb-6">
      <h2 className="sr-only">{title}</h2>
      {children && <p className="max-w-5xl wrap-break-word text-lg leading-relaxed text-ink-2">{children}</p>}
    </header>
  );
}

/** How every step points at the one Offer / Portfolio switch: the side by its own name, and the switch by its caption in the bar. */
export const selectView = (view: "Offer" | "Portfolio"): string => `Select ${view} under "View" in the bar above`;

/** A step's name inside a sentence, as a link that opens it. */
export function StepLink({ to, onOpenStep }: { to: StepId; onOpenStep?: (id: StepId) => void }) {
  if (!onOpenStep) return <>{STEP_NAMES[to]}</>;
  return (
    <button type="button" onClick={() => onOpenStep(to)} className="font-medium text-ink underline underline-offset-2 hover:text-brand">
      {STEP_NAMES[to]}
    </button>
  );
}

/** A step's checks in one line. The lists themselves are on the Audit step. */
export function ChecksLine({ checks, what, onOpenStep, className = "" }: { checks: Check[]; what: string; onOpenStep?: (id: StepId) => void; className?: string }) {
  if (checks.length === 0) return null;
  const s = summarise(checks);
  const passed = s.pass === checks.length ? `${s.pass} ${s.pass === 1 ? "check" : "checks"} on ${what} ${s.pass === 1 ? "passes" : "pass"}` : `${s.pass} of ${checks.length} checks on ${what} pass`;
  const rest = [s.warn > 0 ? `${s.warn} ${s.warn === 1 ? "warning" : "warnings"}` : "", s.fail > 0 ? `${s.fail} failed` : ""].filter(Boolean).join(", ");
  return (
    <p className={`flex items-start gap-2 text-sm leading-relaxed text-ink-2 ${className}`}>
      <span className="mt-0.5"><StatusIcon status={s.fail > 0 ? "fail" : s.warn > 0 ? "warn" : "pass"} size={16} /></span>
      <span className="min-w-0">{passed}{rest ? `, ${rest}` : ""}. See <StepLink to="audit" onOpenStep={onOpenStep} />.</span>
    </p>
  );
}

/**
 * Shown while a step is on its portfolio view although an offer has been read: why the step is not
 * following the building. `what` finishes the sentence 'Select Offer under "View" in the bar above to see ...'.
 */
export function OfferNotice({ offerFocus, what, onOpenStep }: { offerFocus: OfferFocus | null | undefined; what: string; onOpenStep?: (id: StepId) => void }) {
  if (!offerFocus) return null;
  const held = offerFocus.outside || offerFocus.waiting.length > 0;
  return (
    <div className="mb-5 max-w-4xl">
      <Note tone={held ? "warn" : "info"}>
        {offerFocus.outside ? (
          <><strong className="font-semibold text-ink">{offerFocus.outsideMessage}.</strong> {offerFocus.coverage} This step shows the portfolio.</>
        ) : offerFocus.waiting.length > 0 ? (
          <>{offerFocus.statusLine} That is settled in the <StepLink to="offer" onOpenStep={onOpenStep} /> step. Until then this step shows the portfolio.</>
        ) : offerFocus.status === "priced" ? (
          <>An offer is loaded: {offerFocus.line.insured ?? offerFocus.documentName}. {selectView("Offer")} to see {what}.</>
        ) : (
          <>{offerFocus.statusLine} This step shows the portfolio.</>
        )}
      </Note>
    </div>
  );
}

/**
 * Detail a reader can open when they want it: the working behind a figure, a full table, the
 * sources of a card. Closed unless `open` is set, so a page shows its answer first. The summary
 * is a real disclosure, so it works from the keyboard and reads its state to a screen reader.
 */
export function Fold({ summary, children, open = false, className = "" }: { summary: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  return (
    <details open={open} className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 text-sm font-medium text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className="shrink-0 transition-transform group-open:rotate-90">
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{summary}</span>
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
