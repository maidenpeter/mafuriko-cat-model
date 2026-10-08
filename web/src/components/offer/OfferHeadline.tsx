"use client";

import type { ReactNode } from "react";
import type { FocusBuilding, OfferFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import { OUTSIDE_MAPS_MESSAGE } from "@/lib/offer/types";
import { STEP_NAMES, stepIndex, type StepId } from "@/lib/steps";
import { Button, ChecksLine, StatusIcon, StepLink, Tag } from "../ui";
import { buildingFacts, type ValueCounts } from "./values";

interface Props {
  /** The offer as the walkthrough worked it out: located, priced and checked there, by code. */
  f: OfferFocus;
  /** How its values stand: see countValues. */
  counts: ValueCounts;
  /** True while the row of figures under the bar shows this offer's: "View" is on Offer and the offer is priced. */
  inBar: boolean;
  /** Whether the upload card is unfolded, and the id of the box that holds it. */
  uploadOpen: boolean;
  uploadId: string;
  onToggleUpload: () => void;
  /** Puts the keyboard on the first value pricing waits for. */
  onCheck: () => void;
  /** Shows the values the document does not state. */
  onShowNotStated: () => void;
  /** Opens another step of the walkthrough. When it is not given, the lead to the next step is a sentence, not a button. */
  onOpenStep?: (id: StepId) => void;
}

/** A building of the offer other than the one in the heading, in one line. */
function otherBuilding(b: FocusBuilding, offerPriced: boolean): string {
  const state = b.status === "outside" ? `. ${OUTSIDE_MAPS_MESSAGE}` : b.status === "not_ready" && offerPriced ? ". Not priced yet" : "";
  return `${b.name}: ${buildingFacts(b)}${state}`;
}

/**
 * The first card of the step once a document is read. It answers two questions, "what did we get"
 * and "can I go on": the building and where it is, who read the file, where pricing stands, how
 * many values need a person's eye, and one button for whatever comes next.
 *
 * Nothing is worked out here. The status, the checks and the building all come from the focus.
 */
export function OfferHeadline({ f, counts, inBar, uploadOpen, uploadId, onToggleUpload, onCheck, onShowNotStated, onOpenStep }: Props) {
  const b = f.building;
  const byModel = f.document.path === "model";
  const waiting = f.waiting.length;

  // Where pricing stands: an icon, the word for it, and what follows from it.
  let icon: ReactNode = <StatusIcon status="warn" size={18} />;
  let word: string;
  let rest: ReactNode = null;
  if (f.status === "priced") {
    icon = <StatusIcon status="pass" size={18} />;
    word = "Priced by code";
    // The figures have one home each: the row under the bar above and the Results step.
    rest = inBar ? <> on the hazard maps loaded. The figures are in the row above.</> : <> on the hazard maps loaded. The figures are in <StepLink to="results" onOpenStep={onOpenStep} />.</>;
  } else if (f.status === "waiting") {
    word = `Waiting for ${plural(waiting, "value")} you need to check`;
    rest = " before the offer is priced.";
  } else if (f.status === "outside") {
    // Outside the maps there is the sentence and nothing further. A figure of zero would be wrong.
    word = `${f.outsideMessage ?? OUTSIDE_MAPS_MESSAGE}.`;
    rest = f.coverage ? ` ${f.coverage}` : null;
  } else if (f.status === "not_ready") {
    const blockers = f.buildings.flatMap((x) => x.blockers.map((text) => (f.several ? `${x.name}: ${text}` : text)));
    word = "Not priced yet.";
    rest = ` ${blockers.length > 0 ? blockers.join(" ") : f.statusLine.replace(/^Not priced yet\.\s*/, "")}`;
  } else {
    icon = <StatusIcon status="running" size={18} />;
    word = f.statusLine;
  }

  const others = f.several && b ? f.buildings.filter((x) => x.locId !== b.locId) : [];
  const hazardStep = `step ${stepIndex("hazard")}, ${STEP_NAMES.hazard}`;

  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <div className="grid items-start gap-x-8 gap-y-4 @4xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            <span className="min-w-0 wrap-anywhere">{f.documentName}</span>
            <Tag kind={byModel ? "ai" : "none"}>{byModel ? "Read by the model" : "Read by the fixed rules"}</Tag>
          </p>

          <h3 className="mt-1.5 text-xl font-semibold text-ink wrap-anywhere">{b?.name ?? f.line.insured ?? (f.extraction.rows.length === 0 ? "No insured building was read" : "The offer")}</h3>
          {b && (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm leading-relaxed text-ink-2">
              <span className="min-w-0 wrap-anywhere">{buildingFacts(b)}</span>
              {b.approximate && <Tag kind="assumption">Approximate location</Tag>}
            </p>
          )}
          {others.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-sm leading-relaxed text-ink-2">
              {others.map((x) => (
                <li key={x.locId} className="wrap-anywhere">{otherBuilding(x, f.status === "priced")}</li>
              ))}
            </ul>
          )}
          {f.severalLine && <p className="mt-1 text-sm leading-relaxed text-ink-2">{f.severalLine}</p>}

          <p role="status" className="mt-4 flex items-start gap-2 text-base leading-relaxed text-ink-2">
            <span className="mt-1 shrink-0">{icon}</span>
            <span className="min-w-0 wrap-anywhere">
              <strong className="font-semibold text-ink">{word}</strong>
              {rest}
            </span>
          </p>

          <p className="tabular mt-1.5 text-sm leading-relaxed text-ink-2">
            <strong className="font-semibold text-ink">{plural(counts.read, "value")} read:</strong> {counts.verified} verified, {counts.toCheck} {counts.toCheck === 1 ? "needs" : "need"} your check
            {/* Not every value to check holds the price up: where the two counts differ, the line says which is which. */}
            {waiting > 0 && waiting < counts.toCheck ? ` (pricing waits for ${waiting})` : ""}
            {counts.byYou > 0 ? `, ${counts.byYou} set by you` : ""}, {counts.notStated} not stated
          </p>
          <ChecksLine checks={f.checks} what="the offer" onOpenStep={onOpenStep} className="mt-1.5" />

          {/* The one thing kept here of how the document was read: the model was asked and its answer could not be used. */}
          {!byModel && f.document.sentToModel && (
            <p className="mt-1.5 flex items-start gap-2 text-sm leading-relaxed text-ink-2">
              <span className="mt-0.5 shrink-0"><StatusIcon status="warn" size={16} /></span>
              <span className="min-w-0 wrap-anywhere">The model was asked, but its answer could not be used, so the fixed rules read the document. {f.document.why}</span>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 @4xl:flex-col @4xl:items-stretch">
          {f.status === "priced" &&
            (onOpenStep ? (
              // Left free to wrap: on a phone at the largest text size the words are wider than the card.
              <Button onClick={() => onOpenStep("hazard")}>See the building on the hazard map</Button>
            ) : (
              <span className="text-sm font-semibold text-ink">Next: see the building on the hazard map, in {hazardStep}.</span>
            ))}
          {f.status === "waiting" && <Button className="whitespace-nowrap" onClick={onCheck}>Check {plural(waiting, "value")}</Button>}
          {f.status === "not_ready" && counts.notStated > 0 && <Button className="whitespace-nowrap" onClick={onShowNotStated}>Show what is not stated</Button>}
          <Button variant="secondary" className="whitespace-nowrap" aria-expanded={uploadOpen} aria-controls={uploadId} onClick={onToggleUpload}>
            {uploadOpen ? "Hide the upload" : "Price another offer"}
          </Button>
        </div>
      </div>
    </section>
  );
}
