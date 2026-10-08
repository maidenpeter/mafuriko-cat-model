"use client";

import { motion } from "motion/react";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { summarise, type Check, type CheckStatus } from "@/lib/checks";

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

export function StepHeader({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <header className="@container mb-6">
      {/* Where the step has the room, the introduction sits beside the title and not under it, so the first
          screen shows more of the step. The paragraph keeps its reading width either way. */}
      <div className="@6xl:flex @6xl:items-end @6xl:justify-between @6xl:gap-12">
        <div className="@6xl:shrink-0">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{kicker}</div>
          <h2 className="mt-1 text-3xl font-semibold tracking-tight text-ink">{title}</h2>
        </div>
        {children && <p className="mt-2 max-w-3xl wrap-break-word text-base leading-relaxed text-ink-2 @6xl:mt-0 @6xl:min-w-0">{children}</p>}
      </div>
    </header>
  );
}
