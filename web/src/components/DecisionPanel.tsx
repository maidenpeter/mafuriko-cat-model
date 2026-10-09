"use client";

/**
 * Where the underwriter records the decision on an offer: one of the four choices, a note, and the
 * time it was recorded. The tool never fills in the choice.
 *
 * How to use it:
 *   <DecisionPanel decision={decision} onDecision={setDecision} conditionIds={conditions.map((c) => c.id)}>
 *     <Button>Download decision note</Button>
 *   </DecisionPanel>
 *
 * The record lives with the caller, so it survives leaving the step. Any change to the choice or the
 * note turns a recorded decision back into a draft; "Record decision" checks it with validateDecision
 * and stamps the time. `children` sit at the foot of the panel: the buttons that export the note.
 */

import { useId, useState, type ReactNode } from "react";
import { DECISION_CHOICES, DECISION_LABELS, DECISION_STANCE, stampDecision, validateDecision, type DecisionChoice, type DecisionRecord } from "@/lib/decision";
import { fmtNoteDate } from "@/lib/decisionNote";
import { Button, Card, StatusIcon } from "./ui";

/** What each choice asks of the underwriter before it can be recorded. */
const CHOICE_NEEDS: Record<DecisionChoice, string> = {
  accept: "A note is optional.",
  accept_with_conditions: "Tick at least one suggested condition.",
  refer: "Say why in the note.",
  decline: "Say why in the note.",
};

interface Props {
  decision: DecisionRecord;
  onDecision: (next: DecisionRecord) => void;
  /** Ids of the suggested conditions on screen: ticks for conditions no longer suggested do not count. */
  conditionIds: string[];
  /** One line on which assumptions move the answer most, pointing at the tornado drawn above the panel. */
  movers?: ReactNode;
  /** The export buttons, shown at the foot of the panel. */
  children?: ReactNode;
  className?: string;
}

export function DecisionPanel({ decision, onDecision, conditionIds, movers, children, className = "" }: Props) {
  const id = useId();
  // Messages appear once the underwriter has tried to record, not while the form is still being filled in.
  const [tried, setTried] = useState(false);
  const problems = validateDecision(decision, conditionIds);
  const ticked = decision.conditions.filter((c) => conditionIds.includes(c)).length;
  const recorded = decision.recordedAt !== null;

  const change = (patch: Partial<DecisionRecord>) => onDecision({ ...decision, ...patch, recordedAt: null });
  const record = () => {
    if (problems.length > 0) return setTried(true);
    setTried(false);
    onDecision(stampDecision(decision));
  };

  return (
    <Card title="The underwriter's decision" className={className}>
      <p className="-mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">{DECISION_STANCE}</p>
      {movers && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-2">{movers}</p>}

      {/* Where there is room the note sits beside the four choices, so the whole panel fits on one screen. */}
      <div className="mt-4 grid gap-x-8 gap-y-4 @4xl:grid-cols-2">
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium text-ink">Decision</legend>
          <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))] gap-2">
            {DECISION_CHOICES.map((choice) => {
              const on = decision.choice === choice;
              return (
                <label key={choice} className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border p-3 ${on ? "border-ink bg-surface-2" : "border-line bg-surface hover:bg-surface-2"}`}>
                  <input type="radio" name={`${id}-choice`} checked={on} onChange={() => change({ choice })} className="mt-0.5 size-4 shrink-0 accent-accent" />
                  <span className="min-w-0">
                    <span className={`block text-sm text-ink ${on ? "font-semibold" : "font-medium"}`}>{DECISION_LABELS[choice]}</span>
                    <span className="block text-xs leading-relaxed text-muted">{CHOICE_NEEDS[choice]}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="min-w-0">
          <label htmlFor={`${id}-note`} className="block text-sm font-medium text-ink">Note</label>
          <textarea
            id={`${id}-note`}
            value={decision.note}
            onChange={(e) => change({ note: e.target.value })}
            rows={4}
            placeholder="Why this decision, and anything the next reader should know."
            className="mt-2 block w-full rounded-xl border border-axis bg-surface p-3 text-sm leading-relaxed text-ink placeholder:text-muted"
          />
          <p className="mt-2 text-sm text-ink-2">
            Suggested conditions ticked: <span className="tabular font-semibold text-ink">{ticked}</span> of {conditionIds.length}.
          </p>
      </div>
      </div>

      {tried && problems.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1.5">
          {problems.map((problem) => (
            <li key={problem} className="flex gap-2 text-sm leading-relaxed text-ink">
              <span className="mt-0.5"><StatusIcon status="warn" size={16} /></span>
              <span className="min-w-0">{problem}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button onClick={record} disabled={recorded}>{recorded ? "Decision recorded" : "Record decision"}</Button>
        <p aria-live="polite" className="flex min-w-0 items-start gap-2 text-sm leading-relaxed text-ink-2">
          {recorded && decision.choice ? (
            <>
              <span className="mt-0.5"><StatusIcon status="pass" size={16} /></span>
              <span className="min-w-0">
                <span className="font-semibold text-ink">{DECISION_LABELS[decision.choice]}</span>, recorded {fmtNoteDate(decision.recordedAt)}. Changing anything turns it back into a draft.
              </span>
            </>
          ) : (
            <span className="min-w-0">Draft: nothing is recorded yet.</span>
          )}
        </p>
      </div>

      {children && <div className="mt-4 border-t border-line pt-4">{children}</div>}
    </Card>
  );
}
