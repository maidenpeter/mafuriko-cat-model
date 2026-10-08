"use client";

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type DragEvent } from "react";
import { OFFER_FILE_TYPES_TEXT } from "@/lib/dashboard";
import { fmtInt } from "@/lib/format";
import { loadGeo } from "@/lib/geo/layers";
import { extractOffer } from "@/lib/offer/client";
import { docxToText } from "@/lib/offer/docx";
import type { OfferFocus, PricedFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { OfferDocument, OfferExtraction, OfferFile, OfferState, ValueRef } from "@/lib/offer/types";
import { confirmValue, editValue, statusCounts } from "@/lib/offer/verify";
import { ACCEPT, offerFileKind, offerFileProblem } from "@/lib/offerFiles/kind";
import { pdfToText } from "@/lib/offerFiles/pdf";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, type StepId } from "@/lib/steps";
import type { OfferSummary } from "../dashboard/Dashboard";
import { BrokerQuestions } from "../offer/BrokerQuestions";
import { OfferHeadline } from "../offer/OfferHeadline";
import { SmallButton } from "../offer/parts";
import { countValues, valueGroups } from "../offer/values";
import { ValuesPanel, type ValuesHandle } from "../offer/ValuesPanel";
import { Button, Card, Note, StatusIcon, StepLink } from "../ui";

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
   * An offer handed over by the walkthrough as a file: one found in an upload of model data, or the
   * rehearsal's test offer. When seq changes, the step opens the file and reads it straight away,
   * as if the reader had chosen it here and pressed the button.
   */
  incoming?: { file?: File; seq: number } | null;
  /** Called whenever the priced result changes, and with null when the offer is cleared. */
  onSummary?: (summary: OfferSummary | null) => void;
  /** Opens another step of the walkthrough. When it is not given, the lead to the next step is a sentence, not a button. */
  onOpenStep?: (id: StepId) => void;
}

/**
 * The seq of the last offer handed over. Kept outside the component, so coming
 * back to this step later does not read the same offer a second time.
 */
let lastIncomingSeq: number | null = null;

/**
 * True from the moment the reader asks, on another step, to price another offer, until this step has
 * opened. The step then shows its upload card although an offer is already read. Kept outside the
 * component like lastIncomingSeq, because the step is not on screen when the reader asks.
 */
let uploadAsked = false;

/** Call just before opening this step from a "Price another offer" button: the step opens on its upload card. */
export function askForUpload() {
  uploadAsked = true;
}

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

// ---------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------

/**
 * The step an offer is priced in. Before a document is read it is the upload card and nothing else. Once one
 * is read it is, from the top: the card that says what was read and whether the reader can go on
 * (OfferHeadline), the values for a person to check with the document a press away (ValuesPanel),
 * the questions for the broker, folded (BrokerQuestions), and a line pointing at the record of the reading.
 *
 * The step opens the file, has it read and takes the underwriter's changes. It locates, prices and
 * checks nothing: all of that comes ready in offerFocus.
 */
export function OfferStep({ session, modelReady, offer, onOffer, offerFocus, focus, onLog, incoming, onSummary, onOpenStep }: Props) {
  const { dataset } = session;

  // The file chosen as the offer, once it has been opened in this browser. An offer is always given as a file.
  const [file, setFile] = useState<OfferDocument | null>(offer?.document ?? null);
  const [rulesOnly, setRulesOnly] = useState(false);
  /** A file is being opened in this browser. */
  const [opening, setOpening] = useState(false);
  /** The offer is being read into rows. */
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  /** Once an offer is read, the upload folds away behind a button so the offer has the room. */
  const [inputOpen, setInputOpen] = useState(() => uploadAsked);
  /** How many documents this visit has read. Each reading starts the list of values afresh: its filter, its folds, its open answers. */
  const [reads, setReads] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const uploadBox = useRef<HTMLDivElement>(null);
  const uploadId = useId();
  const values = useRef<ValuesHandle>(null);
  // The request is answered once, by the visit it was made for: the upload card is open, and the keyboard is on its first button.
  useEffect(() => {
    if (uploadAsked) uploadBox.current?.querySelector<HTMLElement>("button")?.focus();
    uploadAsked = false;
  }, []);
  // Each choice of a file and each read takes a number. Only the latest of each may change the screen,
  // so a slow file or a slow answer can never overwrite what the reader did after it.
  const sourceTurn = useRef(0);
  const readTurn = useRef(0);

  /** Opens a file in this browser and makes it the offer to read. Resolves to the document, or null when it could not be opened or something newer took its place. */
  const openFile = async (chosen: OfferFile & { type?: string }): Promise<OfferDocument | null> => {
    const turn = ++sourceTurn.current;
    setProblem(null);
    setOpening(true);
    try {
      const doc = await openOfferFile(chosen);
      if (turn !== sourceTurn.current) return null;
      setFile(doc);
      return doc;
    } catch (e) {
      // The message is shown as it is: the readers word it for the underwriter.
      if (turn === sourceTurn.current) setProblem((e as Error).message);
      return null;
    } finally {
      if (turn === sourceTurn.current) setOpening(false);
    }
  };

  const removeFile = () => {
    sourceTurn.current++;
    setOpening(false);
    setFile(null);
  };

  const read = async (doc: OfferDocument) => {
    const turn = ++readTurn.current;
    setBusy(true);
    setProblem(null);
    try {
      // An offer can be handed over before the ward map has loaded: the read waits for it here.
      // The layers load once per page, so this is the same answer the walkthrough places the offer with.
      const layers = await loadGeo();
      // The rules find a place in free text only if they know the names to look for.
      const knownPlaces = [...(layers.wards?.features.flatMap((f) => (f.properties.name ?? "").split("/").map((n) => n.trim())) ?? []), ...dataset.hotspots.map((h) => h.name)].filter(Boolean);
      const run = await extractOffer(doc.text, { rulesOnly, knownPlaces });
      if (turn !== readTurn.current) return;
      onOffer({ document: doc, run, extraction: run.extraction });
      setReads((n) => n + 1);
      setInputOpen(false);
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

  // An offer handed over by the walkthrough: opened and read at once, with no button to press.
  const takeIncoming = useEffectEvent(async (input: { file?: File }) => {
    if (!input.file) return;
    const doc = await openFile(input.file);
    if (doc) await read(doc);
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

  // The same values group by group, as the list shows them, and the one count every card of the step quotes.
  const fields = f?.fields;
  const buildingsRead = f?.extraction.rows.length ?? 0;
  const groups = useMemo(() => valueGroups(fields ?? [], buildingsRead), [fields, buildingsRead]);
  const counts = useMemo(() => countValues(groups), [groups]);

  const takeDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) void openFile(dropped);
  };

  const showInput = !offer || inputOpen || busy || opening || problem !== null;

  // The one place an offer is given to be read. The Dashboard's call-out opens this step on this card.
  const inputCard = (
    <Card title={offer ? "Price another offer" : STEP_NAMES.offer} aside={<span className="text-xs text-muted">{OFFER_FILE_TYPES_TEXT}</span>}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={takeDrop}
        // With nothing read yet the card is the whole step, so the place to drop a file is given room.
        className={`flex rounded-2xl border-2 border-dashed px-4 transition ${offer ? "flex-wrap items-center gap-x-4 gap-y-2 py-3" : "flex-col items-center gap-3 py-10 text-center"} ${over ? "border-accent bg-accent-wash" : "border-axis bg-surface"}`}
      >
        <Button variant="secondary" className="whitespace-nowrap" onClick={() => picker.current?.click()}>Choose a file</Button>
        <div className={`min-w-0 text-sm leading-relaxed text-ink-2 ${offer ? "flex-1 basis-48" : "max-w-xl"}`}>
          {opening ? (
            "Opening the file in this browser."
          ) : file ? (
            <>
              <span className="font-medium text-ink wrap-anywhere">{file.name}</span>
              <span className="text-muted"> · {fmtInt(file.text.length)} characters, opened in this browser</span>
            </>
          ) : (
            "A broker's placement memo as a Word, PDF or text file. Drop it here or choose it. It is opened in this browser."
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

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {/* Enabled whenever a file has been opened and nothing is being read. */}
        <Button className="whitespace-nowrap" onClick={() => file && void read(file)} disabled={!file || busy || opening}>
          {busy && <StatusIcon status="running" size={16} />}
          {busy ? "Reading the offer" : "Price this offer"}
        </Button>
        <label className="flex min-w-0 items-start gap-2 text-sm leading-snug text-ink-2">
          <input type="checkbox" checked={rulesOnly} onChange={(e) => setRulesOnly(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]" />
          <span>Fixed rules only: nothing leaves this browser</span>
        </label>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        {opening ? "Opening the file. " : file ? `${busy ? "Reading" : "Will read"} ${file.name}. ` : "Choose a file first. "}
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
      {/* The step's number and name are in the top bar. The heading stays here for a screen reader. */}
      <h2 className="sr-only">{STEP_NAMES.offer}</h2>

      {offer && f && (
        <OfferHeadline
          f={f}
          counts={counts}
          inBar={focus !== null && focus !== undefined}
          uploadOpen={showInput}
          uploadId={uploadId}
          onToggleUpload={() => {
            setInputOpen(!showInput);
            if (showInput) setProblem(null);
          }}
          onCheck={() => {
            const first = f.waiting[0];
            if (first) values.current?.goTo(first.fieldId);
          }}
          onShowNotStated={() => values.current?.showNotStated()}
          onOpenStep={onOpenStep}
        />
      )}

      {/* Before a document is read this card is the whole step. After, it unfolds here when another offer is to be priced. */}
      <div id={uploadId} ref={uploadBox} hidden={!showInput} className={offer ? "mt-4" : ""}>
        {showInput && inputCard}
      </div>

      {offer && f && (
        <>
          <ValuesPanel key={reads} ref={values} f={f} groups={groups} counts={counts} documentName={offer.document.name} onEdit={edit} onConfirm={confirm} />
          {f.status !== "locating" && <BrokerQuestions f={f} documentName={offer.document.name} onOpenStep={onOpenStep} />}
          {/* What was sent and what came back has one home, the Audit step. */}
          <p className="mt-5 text-sm leading-relaxed text-ink-2">
            {f.document.sentToModel ? "What was sent to the model and what came back are" : "Nothing was sent to the model. The text the fixed rules read is"} recorded in <StepLink to="audit" onOpenStep={onOpenStep} />.
          </p>
        </>
      )}
    </div>
  );
}
