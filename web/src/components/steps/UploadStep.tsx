"use client";

import { motion } from "motion/react";
import { useRef, useState } from "react";
import type { DatasetCandidate } from "@/lib/ingest";
import { Button, Card, Note, StatusIcon } from "../ui";

interface Props {
  /** The progress lines of a load that is running, or null when nothing is being read. */
  busy: string[] | null;
  error: string | null;
  /** The data sets found in the last upload, when it held more than one. */
  candidates: DatasetCandidate[] | null;
  /** True while the app is opening its own model data, before any model is on screen. */
  opening: boolean;
  onFiles: (files: File[]) => void;
  onPick: (c: DatasetCandidate) => void;
  /** Closes the panel and keeps the data already loaded. Left out when there is nothing loaded to go back to. */
  onCancel?: () => void;
}

/**
 * The "Replace model data" panel: a zip or loose files for a different data set. It is also what
 * the page shows while the model data opens by itself, and when that could not be done.
 */
export function ReplaceDataPanel({ busy, error, candidates, opening, onFiles, onPick, onCancel }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const loaded = !!onCancel;

  return (
    <section aria-labelledby="replace-data-title" className="flex flex-col">
      <header className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Model data</div>
        <h2 id="replace-data-title" className="mt-1 text-3xl font-semibold tracking-tight text-ink">
          {opening ? "Opening the model data" : loaded ? "Replace the model data" : "Load the model data"}
        </h2>
        <p className="mt-2 max-w-3xl text-base leading-relaxed text-ink-2">
          {opening
            ? "The hazard maps, the buildings and the named flood areas are being read. This takes a few seconds, and the Dashboard opens when it is done."
            : loaded
              ? "Drop a zip to run the model on a different data set. The data on screen stays until the new set has been read."
              : "Drop a zip of model data to open the model. It is read in your browser."}
        </p>
      </header>

      {error && <div className="mb-4"><Note tone="warn">{error}</Note></div>}

      <div
        onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); }}
        className={`flex min-h-72 flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-12 text-center transition ${over ? "border-accent bg-accent-wash" : "border-axis bg-surface"}`}
      >
        {busy ? (
          <div role="status" aria-live="polite" className="w-full max-w-md text-left">
            {busy.map((message, i) => (
              <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2.5 py-1 text-sm text-ink-2 @6xl:text-base">
                <StatusIcon status={i === busy.length - 1 ? "running" : "pass"} size={16} />
                <span className="min-w-0 wrap-anywhere">{message}</span>
              </motion.div>
            ))}
          </div>
        ) : (
          <>
            <svg className="h-10 w-10" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <div className="mt-4 text-lg font-semibold text-ink @6xl:text-2xl @6xl:tracking-tight">Drop a zip here</div>
            <div className="mt-1 max-w-xl text-sm leading-relaxed text-ink-2 @6xl:text-base">
              An exposure CSV, the hazard maps (.tif) and, if you have it, the hotspots CSV. Loose files work too. An offer (.docx or .txt) in the upload goes to the offer step.
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button onClick={() => input.current?.click()}>Choose files</Button>
              {onCancel && <Button variant="secondary" onClick={onCancel}>Keep the current data</Button>}
            </div>
            <input ref={input} type="file" multiple accept=".zip,.csv,.tif,.tiff,.docx,.txt" className="hidden" onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
          </>
        )}
      </div>

      {candidates && candidates.length > 1 && !busy && (
        <Card title="This upload holds more than one data set. Which one should run?" className="mt-6">
          <div className="grid gap-3 sm:grid-cols-2">
            {candidates.map((c) => (
              <button key={c.dir} onClick={() => onPick(c)} className="min-w-0 rounded-xl border border-line bg-surface p-4 text-left wrap-anywhere transition hover:border-axis hover:bg-surface-2">
                <div className="font-semibold text-ink">{c.name}</div>
                <div className="mt-1 text-sm text-ink-2">
                  {c.rasters.length} hazard maps, {c.hazardKind === "score" ? "susceptibility scores (0 to 1)" : "flood depths in metres"}
                  {c.hotspots ? ", with hotspots" : ""}
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}
