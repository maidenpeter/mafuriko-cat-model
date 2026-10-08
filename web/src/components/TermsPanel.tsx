"use client";

/**
 * The one place the insurance terms are edited: the policy deductible and limit that apply to each
 * building, then the quota share and the excess of loss that apply to the portfolio.
 *
 * How to use it:
 *   <TermsPanel terms={termsResult} onChange={setTerms} />
 *
 * `terms` is what applyTerms returned, so the panel can show the excess of loss figures actually in
 * force when those two boxes are left empty. Every edit goes through sanitiseTerms before it is
 * handed back, so a share never leaves 0 to 100% and an amount is never below zero.
 */

import { useId, useState, type ReactNode } from "react";
import { fmtInt, fmtNum } from "@/lib/format";
import { kes1 } from "@/lib/labels";
import { DEFAULT_TERMS, sanitiseTerms, XOL_DEFAULT_ATTACHMENT_RP, XOL_DEFAULT_EXHAUSTION_RP, type InsuranceTerms, type TermsResult } from "@/lib/model/terms";
import { SourceBadge } from "./charts/ChartFrame";
import { Button, Card } from "./ui";

const BOX = "tabular w-full min-w-0 rounded-lg border border-axis bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-muted";

interface FieldProps {
  label: string;
  /** Written after the box: "% of insured value", "KES". */
  unit: string;
  /** The value in force, in the units the reader types (percent, not a fraction). null is an empty box. */
  value: number | null;
  /** Called with the typed number, or null when the box is emptied. */
  onCommit: (value: number | null) => void;
  step: number;
  max?: number;
  /** Shown in the empty box. */
  placeholder?: string;
  /** The line under the box. */
  hint: ReactNode;
  /** A control that sits beside the hint, such as "Use the default". */
  action?: ReactNode;
}

/**
 * A number box with its label and units. What is typed is kept as typed while the box has the focus
 * and takes effect at once; on leaving the box it shows the value in force, which may have been clamped.
 */
function Field({ label, unit, value, onCommit, step, max, placeholder, hint, action }: FieldProps) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : fmtNum(value, 4));
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-ink">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          max={max}
          step={step}
          value={shown}
          placeholder={placeholder}
          aria-describedby={`${id}-unit ${id}-hint`}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
            if (text.trim() === "") onCommit(null);
            else if (Number.isFinite(Number(text))) onCommit(Number(text));
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className={BOX}
        />
        <span id={`${id}-unit`} className="shrink-0 text-sm text-ink-2">{unit}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p id={`${id}-hint`} className="min-w-0 text-xs leading-relaxed text-muted wrap-anywhere">{hint}</p>
        {action}
      </div>
    </div>
  );
}

function UseDefault({ what, onClick }: { what: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`Use the default ${what}`} className="shrink-0 rounded-full border border-axis px-2.5 py-0.5 text-xs font-medium text-ink hover:bg-surface-2">
      Use the default
    </button>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</legend>
      <p className="mt-1 text-sm leading-relaxed text-ink-2">{note}</p>
      <div className="mt-3 grid gap-x-5 gap-y-4 @md:grid-cols-2 @3xl:grid-cols-3">{children}</div>
    </fieldset>
  );
}

export function TermsPanel({ terms: result, onChange, className = "" }: { terms: TermsResult; onChange: (t: InsuranceTerms) => void; className?: string }) {
  const t = result.terms;
  const { xol } = result;
  const set = (patch: Partial<InsuranceTerms>) => onChange(sanitiseTerms({ ...t, ...patch }));
  // An emptied percent or minimum box keeps the value it had; only the two excess of loss boxes mean something when empty.
  const share = (key: "deductibleShare" | "limitShare" | "quotaShareCeded") => (v: number | null) => {
    if (v !== null) set({ [key]: v / 100 });
  };
  const isExample = (Object.keys(DEFAULT_TERMS) as (keyof InsuranceTerms)[]).every((k) => t[k] === DEFAULT_TERMS[k]);

  return (
    <Card title="Insurance terms" aside={<SourceBadge kind="assumption" />} className={className}>
      <div className="@container">
        <p className="-mt-2 mb-4 text-sm font-medium text-ink">Example terms, not from any real policy or treaty</p>

        <div className="grid gap-6 @5xl:grid-cols-2 @5xl:gap-10">
          <Group title="Each policy" note="Applied building by building. Ground-up loss less the deductible, capped at the limit, is the gross loss.">
            <Field
              label="Deductible"
              unit="% of insured value"
              value={t.deductibleShare * 100}
              onCommit={share("deductibleShare")}
              step={0.5}
              max={100}
              hint="The part of each loss the policyholder keeps."
            />
            <Field
              label="Deductible minimum"
              unit="KES"
              value={t.deductibleMinKes}
              onCommit={(v) => {
                if (v !== null) set({ deductibleMinKes: v });
              }}
              step={10_000}
              hint={`The deductible is never less than this: ${kes1(t.deductibleMinKes)}.`}
            />
            <Field
              label="Limit"
              unit="% of insured value"
              value={t.limitShare * 100}
              onCommit={share("limitShare")}
              step={5}
              max={100}
              hint="The most a policy pays for one building in one event."
            />
          </Group>

          <Group title="Reinsurance" note="Applied to the portfolio total of each event. The quota share comes first, then the excess of loss on what the insurer retains.">
            <Field
              label="Quota share ceded"
              unit="%"
              value={t.quotaShareCeded * 100}
              onCommit={share("quotaShareCeded")}
              step={5}
              max={100}
              hint="The share of every gross loss passed to reinsurers."
            />
            <Field
              label="Excess of loss attachment"
              unit="KES"
              value={t.xolAttachmentKes}
              onCommit={(v) => set({ xolAttachmentKes: v })}
              step={1_000_000}
              placeholder={fmtInt(xol.attachmentKes)}
              hint={
                xol.attachmentIsDefault
                  ? `default: the retained 1-in-${XOL_DEFAULT_ATTACHMENT_RP} loss, ${kes1(xol.attachmentKes)}`
                  : `Typed in: ${kes1(xol.attachmentKes)}. The default is the retained 1-in-${XOL_DEFAULT_ATTACHMENT_RP} loss.`
              }
              action={xol.attachmentIsDefault ? undefined : <UseDefault what="excess of loss attachment" onClick={() => set({ xolAttachmentKes: null })} />}
            />
            <Field
              label="Excess of loss limit"
              unit="KES"
              value={t.xolLimitKes}
              onCommit={(v) => set({ xolLimitKes: v })}
              step={1_000_000}
              placeholder={fmtInt(xol.limitKes)}
              hint={
                xol.limitIsDefault
                  ? `default: the retained 1-in-${XOL_DEFAULT_EXHAUSTION_RP} loss less the attachment, ${kes1(xol.limitKes)}`
                  : `Typed in: ${kes1(xol.limitKes)}. The default is the retained 1-in-${XOL_DEFAULT_EXHAUSTION_RP} loss less the attachment.`
              }
              action={xol.limitIsDefault ? undefined : <UseDefault what="excess of loss limit" onClick={() => set({ xolLimitKes: null })} />}
            />
          </Group>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
          <Button variant="secondary" disabled={isExample} onClick={() => onChange(DEFAULT_TERMS)}>Reset to the example terms</Button>
          <p className="min-w-0 text-xs leading-relaxed text-muted">
            {isExample ? "The example terms are in force." : "At least one term has been changed from the example."} Every figure below follows these terms as you type.
          </p>
        </div>
      </div>
    </Card>
  );
}
