"use client";

/**
 * The offer card on the dashboard: give a broker's offer as a file, or describe one in a sentence,
 * and press one button. The card reads nothing itself. It hands the file or the text to the
 * walkthrough, which opens the "Read the offer" step and reads it there.
 *
 * How to use it (Walkthrough.tsx passes it to the Dashboard as offerCard):
 *   <OfferDropCard
 *     onOffer={(input) => ...}        { file } or { text }: open the offer step and read it
 *     onReplaceData={(zip) => ...}    a .zip given here is model data, not an offer
 *   />
 *
 * To accept another kind of document, add it to OFFER_FILE_TYPES below and nowhere else.
 */

import { useId, useRef, useState } from "react";
import { droppedFileKind } from "@/lib/dashboard";
import { STEP_NAMES, stepIndex } from "@/lib/steps";
import { Button, Card, StatusIcon } from "../ui";

/** The documents this card takes as an offer. The picker, the sorting and the wording all read this list. */
const OFFER_FILE_TYPES: readonly { ext: string; name: string }[] = [
  { ext: ".docx", name: "Word (.docx)" },
  { ext: ".txt", name: "text (.txt)" },
];
const OFFER_EXTENSIONS = OFFER_FILE_TYPES.map((t) => t.ext);
/** A zip is model data. The picker offers it too, so a different data set can be given from here. */
const MODEL_DATA_EXTENSION = ".zip";
const PICKER_ACCEPT = [...OFFER_EXTENSIONS, MODEL_DATA_EXTENSION].join(",");
const EXAMPLE = "two-storey masonry shop in Kibera worth KES 8 million";

/** "Word (.docx) or text (.txt)", "A, B or C". */
function listed(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
const OFFER_TYPES_TEXT = listed(OFFER_FILE_TYPES.map((t) => t.name));

interface Props {
  /** The reader pressed "Read this offer". Exactly one of file and text is set. */
  onOffer: (input: { file?: File; text?: string }) => void;
  /** A .zip was dropped or chosen here: it replaces the model data. */
  onReplaceData: (zip: File) => void;
}

export function OfferDropCard({ onOffer, onReplaceData }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [over, setOver] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "warn"; text: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textId = useId();
  const nextId = useId();

  const offerStep = `step ${stepIndex("offer")}, ${STEP_NAMES.offer}`;
  const typed = text.trim();
  const ready = file !== null || typed.length > 0;

  function take(given: File | undefined, others = 0) {
    if (!given) return;
    const extra = others > 0 ? ` Only the first of the ${others + 1} files was taken.` : "";
    const kind = droppedFileKind(given.name, OFFER_EXTENSIONS);
    if (kind === "model-data") {
      setMessage({ tone: "info", text: `${given.name} is a zip, so it is taken as model data, not as an offer. It replaces the model data now.${extra}` });
      onReplaceData(given);
    } else if (kind === "old-word") {
      setMessage({ tone: "warn", text: "Old Word format, please save as .docx" });
    } else if (kind === "unsupported") {
      setMessage({ tone: "warn", text: `${given.name} cannot be read here. An offer is a ${OFFER_TYPES_TEXT} file, or a description typed in the box.` });
    } else {
      setFile(given);
      // One source at a time: a chosen file takes the place of typed words.
      setText("");
      setMessage(extra ? { tone: "info", text: extra.trim() } : null);
    }
  }

  function read() {
    if (file) onOffer({ file });
    else if (typed) onOffer({ text: typed });
  }

  return (
    <Card title="Price an offer" aside={<span className="text-xs text-muted">{OFFER_TYPES_TEXT}, or typed</span>} className="h-full">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files[0], e.dataTransfer.files.length - 1);
        }}
        className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border-2 border-dashed px-4 py-4 transition ${over ? "border-accent bg-accent-wash" : "border-axis bg-surface"}`}
      >
        <Button type="button" variant="secondary" className="whitespace-nowrap" onClick={() => picker.current?.click()}>
          Choose a file
        </Button>
        <div className="min-w-0 flex-1 basis-48 text-sm leading-relaxed text-ink-2">
          {file ? (
            <>
              <span className="wrap-anywhere font-medium text-ink">{file.name}</span>
              <span className="text-muted"> is ready to be read</span>
            </>
          ) : (
            `Drop a broker's offer here, or choose it: a ${OFFER_TYPES_TEXT} file.`
          )}
        </div>
        {file && (
          <button
            type="button"
            onClick={() => setFile(null)}
            className="inline-flex shrink-0 items-center rounded-full border border-axis bg-surface px-3 py-1 text-xs font-medium text-ink transition hover:bg-surface-2"
          >
            Remove
          </button>
        )}
        <input
          ref={picker}
          type="file"
          accept={PICKER_ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      <div aria-live="polite">
        {message && (
          <p className="mt-2 flex gap-2 text-sm leading-relaxed text-ink-2">
            {message.tone === "warn" && (
              <span className="mt-0.5">
                <StatusIcon status="warn" size={16} />
              </span>
            )}
            <span className="min-w-0 wrap-anywhere">{message.text}</span>
          </p>
        )}
      </div>

      <label htmlFor={textId} className="mt-4 block text-sm font-medium text-ink">
        Or describe the offer in plain English
      </label>
      <textarea
        id={textId}
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // One source at a time: typing takes the place of a chosen file.
          if (file) setFile(null);
          if (message) setMessage(null);
        }}
        onKeyDown={(e) => {
          // Ctrl or Cmd with Enter reads the offer without leaving the box.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ready) {
            e.preventDefault();
            read();
          }
        }}
        placeholder={EXAMPLE}
        aria-describedby={nextId}
        className="mt-1.5 w-full min-w-0 rounded-lg border border-axis bg-surface px-2.5 py-1.5 text-sm leading-relaxed text-ink placeholder:text-muted"
      />

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <Button type="button" className="whitespace-nowrap" onClick={read} disabled={!ready}>
          Read this offer
        </Button>
        <span className="min-w-0 text-sm leading-snug text-ink-2">
          {ready ? `Opens ${offerStep}.` : "Choose a file or type a description first."}
        </span>
      </div>
      <p id={nextId} className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-2">
        The offer opens in {offerStep}: the model reads it into rows, code checks every value against the document and prices it.
      </p>
      <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-muted">A .zip given here is model data, not an offer: it replaces the data set the model runs on.</p>
    </Card>
  );
}
