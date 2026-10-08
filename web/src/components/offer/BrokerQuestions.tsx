"use client";

import { useId, useState } from "react";
import { LOSS_MODE_LABELS } from "@/lib/labels";
import { DRIVER_LABELS } from "@/lib/offer/drivers";
import { settersOf, settersText, type OfferFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import { OUTSIDE_MAPS_MESSAGE, type BrokerAssumption, type BrokerQuestion } from "@/lib/offer/types";
import { download } from "@/lib/session";
import type { StepId } from "@/lib/steps";
import { Button, StepLink } from "../ui";
import { Chevron, SmallButton } from "./parts";

/**
 * What the price uses until one question is answered: the question's own `assumes`, which the library
 * pairs with it. The one line added here is for a basement the document already shows without a count
 * of levels: the driver is priced then, and the count is all that is missing.
 */
function untilAnswered(q: BrokerQuestion, f: OfferFocus): { text: string; keys: BrokerAssumption["keys"] } {
  if (q.assumes) return { text: q.assumes.text, keys: q.assumes.keys };
  const basement = f.drivers?.basement;
  if (q.id === "basements" && f.mode === "all_drivers" && basement?.present) {
    return { text: `${DRIVER_LABELS.basement} is already priced from what the document places below ground (${basement.what.toLowerCase()}). Only the number of levels is missing.`, keys: [] };
  }
  return { text: "Nothing is assumed in its place.", keys: [] };
}

/**
 * What the document leaves out, as questions to send to the broker. This step is their home, and
 * they stay folded until asked for: one line with their number and the download. Unfolded, each
 * question is a row with what the price uses until the answer arrives, and why it matters on a
 * further press. Nothing here is a guess at an answer.
 */
export function BrokerQuestions({ f, documentName, onOpenStep }: { f: OfferFocus; documentName: string; onOpenStep?: (id: StepId) => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  /** The questions whose "why it matters" is on show. */
  const [why, setWhy] = useState<string[]>([]);
  const { questions } = f;
  // Outside the maps nothing is priced, so no assumption stands in for an answer.
  const priced = !f.outside;
  const asText = () => [`Questions for the broker on ${documentName}`, "", ...questions.map((q, i) => `${i + 1}. ${q.question}`)].join("\n");

  if (questions.length === 0) {
    return (
      <section className="mt-4 rounded-2xl border border-line bg-surface px-5 py-3 text-sm leading-relaxed text-ink-2">
        <h3 className="inline font-semibold text-ink">No questions for the broker.</h3> The document states every value the price and its loss drivers read.
      </section>
    );
  }

  // One row per question: its number, the question, what stands in for the answer, and the press for why it matters.
  // The last column has a set width, so the line of headings above the rows shares their columns.
  const columns = priced ? "@4xl:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,1fr)_7.5rem]" : "@4xl:grid-cols-[1.75rem_minmax(0,1fr)_7.5rem]";
  return (
    <section className="mt-4 rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <h3 className="min-w-0 flex-1 basis-56">
          <button type="button" aria-expanded={open} aria-controls={`${uid}-questions`} onClick={() => setOpen(!open)} className="-ml-1 flex w-full items-center gap-2 rounded-lg py-1 pl-1 text-left text-base font-semibold text-ink hover:bg-surface-2">
            <Chevron open={open} />
            {plural(questions.length, "question")} for the broker
          </button>
        </h3>
        <Button variant="secondary" className="whitespace-nowrap" onClick={() => download(`broker-questions-${new Date().toISOString().slice(0, 10)}.txt`, asText(), "text/plain")}>
          Download the questions
        </Button>
      </div>

      <div id={`${uid}-questions`} hidden={!open} className="border-t border-line px-5 pb-4 pt-3">
        {open && (
          <>
            {!priced && <p className="mb-2 text-sm leading-relaxed text-ink-2">{f.outsideMessage ?? OUTSIDE_MAPS_MESSAGE}, so nothing stands in for an answer.</p>}
            {priced && f.mode === "depth_only" && (
              <p className="mb-2 text-sm leading-relaxed text-ink-2">With {LOSS_MODE_LABELS.depth_only} selected under &quot;Losses from&quot; in the bar above, the assumptions for the loss drivers beyond depth are not in the figures.</p>
            )}
            <div aria-hidden className={`hidden gap-x-6 pb-1.5 text-xs font-semibold text-muted @4xl:grid ${columns}`}>
              <span />
              <span>Question (the answer that could move the price most comes first)</span>
              {priced && <span>Until it is answered</span>}
              <span />
            </div>
            <ol className="divide-y divide-line border-t border-line">
              {questions.map((q, i) => {
                const s = untilAnswered(q, f);
                const setters = settersOf(f.judgement, s.keys);
                const shown = why.includes(q.id);
                return (
                  <li key={q.id} className={`grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 py-2.5 text-sm leading-relaxed @4xl:gap-x-6 ${columns}`}>
                    <span className="tabular text-ink-2">{i + 1}.</span>
                    <p className="min-w-0 font-medium text-ink">{q.question}</p>
                    {priced && (
                      <p className="col-start-2 min-w-0 text-ink-2 @4xl:col-start-auto">
                        <span className="font-medium text-ink @4xl:sr-only">Until it is answered: </span>
                        {s.text}
                        {setters.length > 0 ? ` Set by: ${settersText(f.judgement, s.keys)}.` : ""}
                      </p>
                    )}
                    <span className="col-start-2 @4xl:col-start-auto">
                      <SmallButton look={shown ? "picked" : "plain"} aria-expanded={shown} aria-controls={`${uid}-why-${i}`} onClick={() => setWhy(shown ? why.filter((id) => id !== q.id) : [...why, q.id])}>
                        Why it matters
                      </SmallButton>
                    </span>
                    <p id={`${uid}-why-${i}`} hidden={!shown} className="col-start-2 -col-end-1 min-w-0 border-l-2 border-axis pl-2.5 text-ink-2">
                      {q.why}
                    </p>
                  </li>
                );
              })}
            </ol>
            {priced && (
              <p className="mt-3 text-xs leading-relaxed text-muted">
                An answer typed under &quot;What was read&quot; takes the assumption&apos;s place. Each assumption, its allowed range and who set it are in <StepLink to="agents" onOpenStep={onOpenStep} />.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
