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
    <div>
      <StepHeader kicker="Step 0" title="Upload the data">
        Drop the hackathon data as a zip. The model reads it in your browser, then walks through every stage and shows how each number was produced.
      </StepHeader>

      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); }}
        className={`flex flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition ${over ? "border-accent bg-accent-wash" : "border-axis bg-surface"}`}
      >
        {busy ? (
          <div className="w-full max-w-md text-left">
            {busy.map((message, i) => (
              <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2.5 py-1 text-sm text-ink-2">
                <StatusIcon status={i === busy.length - 1 ? "running" : "pass"} size={16} />
                {message}
              </motion.div>
            ))}
          </div>
        ) : (
          <>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <div className="mt-4 text-lg font-semibold text-ink">Drop a zip here</div>
            <div className="mt-1 text-sm text-ink-2">An exposure CSV, the hazard maps (.tif) and, if you have it, the hotspots CSV. Loose files work too.</div>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button onClick={() => input.current?.click()}>Choose files</Button>
              <Button variant="secondary" onClick={onSample}>Use the starter kit</Button>
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
              <button key={c.dir} onClick={() => onPick(c)} className="rounded-xl border border-line bg-surface p-4 text-left transition hover:border-axis hover:bg-surface-2">
                <div className="font-semibold text-ink">{c.name}</div>
                <div className="mt-1 text-sm text-ink-2">
                  {c.rasters.length} hazard maps · {c.hazardKind === "score" ? "susceptibility scores (0–1)" : "flood depths in metres"}
                  {c.hotspots ? " · hotspots" : ""}
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((s, i) => (
          <div key={s.name} className="rounded-2xl border border-line bg-surface p-4">
            <div className="text-xs font-semibold text-muted">{i + 1}</div>
            <div className="mt-1 font-semibold text-ink">{s.name}</div>
            <div className="mt-1 text-sm leading-relaxed text-ink-2">{s.text}</div>
          </div>
        ))}
      </div>
      <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted">
        Three AI agents set the model&apos;s assumptions and argue for them. Code does every calculation, and each stage runs its own checks on screen.
      </p>
    </div>
  );
}
