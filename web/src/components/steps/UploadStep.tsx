"use client";

import { motion } from "motion/react";
import { useRef, useState } from "react";
import type { DatasetCandidate } from "@/lib/ingest";
import { Button, Card, Note, StatusIcon, StepHeader } from "../ui";

const STAGES = [
  { name: "Hazard", text: "Where it floods, and how badly." },
  { name: "Vulnerability", text: "How much damage that causes." },
  { name: "Exposure", text: "What is there, and what it is worth." },
  { name: "Financial engine", text: "The loss, and how often to expect it." },
];

interface Props {
  busy: string[] | null;
  error: string | null;
  candidates: DatasetCandidate[] | null;
  onFiles: (files: File[]) => void;
  onSample: () => void;
  onPick: (c: DatasetCandidate) => void;
}

export function UploadStep({ busy, error, candidates, onFiles, onSample, onPick }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    // Beside the step list the page fills the screen below the header, so the first screen has no blank lower half.
    // This step never shows the Back and Next bar, so the room the page keeps free for that bar is taken back.
    <div className="flex flex-col lg:-mb-28 lg:min-h-[calc(100dvh-var(--header-height,9rem)-3.5rem)]">
      <StepHeader kicker="Step 0" title="Upload the data">
        Drop the hackathon data as a zip. The model reads it in your browser, then walks through every stage and shows how each number was produced.
      </StepHeader>

      {/* With room for two columns the upload sits on the left and the four stages on the right, both the full height.
          The columns are measured in rem of the chosen text size, so a larger size goes back to one column sooner. */}
      <div className="grid flex-1 gap-8 @3xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] @3xl:gap-4 @6xl:gap-6">
        <div className="flex min-w-0 flex-col">
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}
            className={`flex flex-1 flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition ${over ? "border-accent bg-accent-wash" : "border-axis bg-surface"}`}
          >
            {busy ? (
              <div className="w-full max-w-md text-left">
                {busy.map((message, i) => (
                  <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2.5 py-1 text-sm text-ink-2 @6xl:text-base">
                    <StatusIcon status={i === busy.length - 1 ? "running" : "pass"} size={16} />
                    <span className="min-w-0 wrap-anywhere">{message}</span>
                  </motion.div>
                ))}
              </div>
            ) : (
              <>
                <svg className="h-10 w-10 @6xl:h-16 @6xl:w-16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
                </svg>
                <div className="mt-4 text-lg font-semibold text-ink @6xl:mt-6 @6xl:text-3xl @6xl:tracking-tight">Drop a zip here</div>
                <div className="mt-1 max-w-xl text-sm text-ink-2 @6xl:mt-3 @6xl:text-lg @6xl:leading-relaxed">An exposure CSV, the hazard maps (.tif) and, if you have it, the hotspots CSV. Loose files work too.</div>
                <div className="mt-6 flex flex-wrap justify-center gap-3 @6xl:mt-8 @6xl:gap-4">
                  <Button className="@6xl:px-6 @6xl:py-3 @6xl:text-base" onClick={() => input.current?.click()}>Choose files</Button>
                  <Button variant="secondary" className="@6xl:px-6 @6xl:py-3 @6xl:text-base" onClick={onSample}>Use the starter kit</Button>
                </div>
                <input ref={input} type="file" multiple accept=".zip,.csv,.tif,.tiff" className="hidden" onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
              </>
            )}
          </div>

          {error && <div className="mt-4"><Note tone="warn">{error}</Note></div>}

          {candidates && candidates.length > 1 && !busy && (
            <Card title="This upload holds more than one dataset. Which one should run?" className="mt-6">
              <div className="grid gap-3 sm:grid-cols-2">
                {candidates.map((c) => (
                  <button key={c.dir} onClick={() => onPick(c)} className="min-w-0 rounded-xl border border-line bg-surface p-4 text-left wrap-anywhere transition hover:border-axis hover:bg-surface-2">
                    <div className="font-semibold text-ink">{c.name}</div>
                    <div className="mt-1 text-sm text-ink-2">
                      {c.rasters.length} hazard maps · {c.hazardKind === "score" ? "susceptibility scores (0 to 1)" : "flood depths in metres"}
                      {c.hotspots ? " · hotspots" : ""}
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          {/* In the side column the stages stack and share the height, each with its number beside it. */}
          <div className="grid gap-3 sm:grid-cols-2 @3xl:flex @3xl:flex-1 @3xl:flex-col @3xl:gap-2 @6xl:gap-4">
            {STAGES.map((s, i) => (
              <div key={s.name} className="rounded-2xl border border-line bg-surface p-4 @3xl:flex @3xl:flex-1 @3xl:items-center @3xl:gap-4 @3xl:py-3 @6xl:gap-6 @6xl:px-8 @6xl:py-4">
                <div className="text-xs font-semibold text-muted @3xl:flex @3xl:h-9 @3xl:w-9 @3xl:shrink-0 @3xl:items-center @3xl:justify-center @3xl:rounded-full @3xl:bg-surface-2 @3xl:text-sm @3xl:text-ink-2 @6xl:h-14 @6xl:w-14 @6xl:text-xl">{i + 1}</div>
                <div className="min-w-0">
                  <div className="mt-1 font-semibold text-ink @3xl:mt-0 @6xl:text-2xl @6xl:tracking-tight">{s.name}</div>
                  <div className="mt-1 text-sm leading-relaxed text-ink-2 @6xl:text-lg">{s.text}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted @6xl:mt-6 @6xl:text-base">
            Three AI agents set the model&apos;s assumptions and argue for them. Code does every calculation, and each stage runs its own checks on screen.
          </p>
        </div>
      </div>
    </div>
  );
}
