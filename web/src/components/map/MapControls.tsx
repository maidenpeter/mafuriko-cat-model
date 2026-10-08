"use client";

import { Fragment, useId, type ReactNode } from "react";
import { annualChance, rpLabel, rpWithChance } from "@/lib/labels";
import { OFFER_COLOR, WARD_METRICS, type LayerKey, type LayerState, type WardMetric } from "./mapTheme";

/** The focus ring of the controls in the strip, and the one drawn inside a control that touches the frame's edge. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const FOCUS_INSIDE = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand";

/**
 * A mark as the map draws it, for a filter or a key entry. "depth" is the flood depth scale from
 * shallowest to deepest and takes no colour; "band" is one step of it.
 */
export function Swatch({ color, shape = "dot" }: { color?: string; shape?: "dot" | "line" | "square" | "outline" | "ring" | "dashed" | "band" | "depth" }) {
  if (shape === "line") return <span aria-hidden className="inline-block h-0.75 w-4 shrink-0 rounded-full" style={{ background: color }} />;
  if (shape === "square") return <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-[3px]" style={{ background: color }} />;
  if (shape === "outline") return <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-[3px] border" style={{ borderColor: color }} />;
  if (shape === "ring") return <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-full border-2 bg-surface" style={{ borderColor: color }} />;
  if (shape === "dashed") return <span aria-hidden className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-dashed" style={{ borderColor: color }} />;
  if (shape === "band") return <span aria-hidden className="inline-block h-2.5 w-3.5 shrink-0 rounded-sm" style={{ background: color }} />;
  if (shape === "depth") return <span aria-hidden className="inline-block h-3 w-4 shrink-0 rounded-[3px]" style={{ background: "linear-gradient(to right, var(--seq-1), var(--seq-3), var(--seq-5))" }} />;
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

/** The offer building as the map draws it: a small solid block. Drawn in rem, so it grows with the text. */
export function BlockSwatch() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill={OFFER_COLOR} stroke="var(--ink)" strokeWidth="1" strokeLinejoin="round">
      <path d="M8 1.5 14 4.5 8 7.5 2 4.5Z" fillOpacity="0.55" />
      <path d="M2 4.5 8 7.5V14.5L2 11.5Z" />
      <path d="M14 4.5 8 7.5V14.5L14 11.5Z" fillOpacity="0.8" />
    </svg>
  );
}

/** One layer filter of the strip: the layer it switches, its short name and its mark. */
export interface LayerChip {
  key: LayerKey;
  name: string;
  swatch: ReactNode;
}

/**
 * The control strip along the top of the map's frame: the return period with "Play the flood", the
 * 3D switch and the layer filters. It is solid and sits above the map, not over it, and it goes
 * fullscreen with the frame. On a narrow frame the filters stay on one line and scroll sideways.
 */
export function MapStrip({
  events,
  index,
  onIndex,
  playing,
  onPlay,
  threeD,
  onThreeD,
  chips,
  layers,
  onLayer,
  wardMetric,
  onWardMetric,
}: {
  /** The modelled events, most frequent first. */
  events: { id: string; returnPeriod: number }[];
  /** The event shown, as an index into `events`. */
  index: number;
  onIndex: (i: number) => void;
  playing: boolean;
  onPlay: () => void;
  threeD: boolean;
  onThreeD: (v: boolean) => void;
  chips: LayerChip[];
  layers: LayerState;
  onLayer: (key: LayerKey, v: boolean) => void;
  wardMetric: WardMetric;
  onWardMetric: (m: WardMetric) => void;
}) {
  const shown = events[index];
  return (
    <div role="group" aria-label="Map controls" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-3 py-2">
      {/* One unit on a wide frame. On a narrow one its three parts wrap with the rest of the strip, so the 3D switch sits beside the slider. */}
      <div className="contents @3xl:flex @3xl:flex-none @3xl:items-center @3xl:gap-x-3">
        <button type="button" onClick={onPlay} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-axis bg-surface px-3 py-1 text-xs font-medium text-ink transition hover:bg-surface-2 ${FOCUS}`}>
          <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3 shrink-0" fill="currentColor">
            {playing ? <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" /> : <path d="M3 1.5v9l7-4.5z" />}
          </svg>
          {playing ? "Pause" : "Play the flood"}
        </button>
        <span className="tabular min-w-32 whitespace-nowrap text-xs text-muted">
          <span className="font-display text-base font-semibold text-ink">{rpLabel(shown.returnPeriod)}</span>, {annualChance(shown.returnPeriod)}
        </span>
        <input
          aria-label="Event return period, in years"
          aria-valuetext={rpWithChance(shown.returnPeriod)}
          title={`Return period, from ${rpLabel(events[0].returnPeriod)} (most frequent) to ${rpLabel(events[events.length - 1].returnPeriod)} (rarest)`}
          type="range"
          min={0}
          max={events.length - 1}
          step={1}
          value={index}
          onChange={(e) => onIndex(Number(e.target.value))}
          className={`h-5 min-w-24 flex-[1_1_8rem] rounded-full accent-brand @3xl:w-44 @3xl:flex-none ${FOCUS}`}
        />
      </div>

      <button type="button" role="switch" aria-checked={threeD} onClick={() => onThreeD(!threeD)} className={`inline-flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 text-xs font-medium text-ink ${FOCUS}`}>
        {/* The knob moves across, so the state does not rest on colour. */}
        <span aria-hidden className={`relative inline-block h-4 w-7 shrink-0 rounded-full border transition-colors ${threeD ? "border-ink bg-ink" : "border-axis bg-surface-2"}`}>
          <span className={`absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full transition-all ${threeD ? "left-[calc(100%-0.75rem)] bg-surface" : "left-0.5 bg-ink-2"}`} />
        </span>
        3D view
      </button>

      {/* The padding leaves room for the focus ring, which a scrolling box would otherwise cut off. */}
      <div role="group" aria-label="Layers shown on the map" className="-m-1 flex min-w-0 flex-[1_1_40rem] items-center gap-1.5 overflow-x-auto p-1 scrollbar-thin @md:flex-wrap @md:overflow-visible">
        {chips.map((chip) => {
          const on = layers[chip.key];
          return (
            <Fragment key={chip.key}>
              {/* A layer that is off is told apart by its dashed edge and the line through its name, not by colour alone. */}
              <button
                type="button"
                aria-pressed={on}
                title={`${on ? "Hide" : "Show"}: ${chip.name}`}
                onClick={() => onLayer(chip.key, !on)}
                className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium transition ${FOCUS} ${on ? "border-axis bg-surface-2 text-ink" : "border-dashed border-axis bg-surface text-muted line-through hover:text-ink-2"}`}
              >
                <span className={`inline-flex shrink-0 items-center ${on ? "" : "opacity-40"}`}>{chip.swatch}</span>
                {chip.name}
              </button>
              {chip.key === "wards" && on && (
                <select aria-label="Shade the wards by" title="Shade the wards by" value={wardMetric} onChange={(e) => onWardMetric(e.target.value as WardMetric)} className={`shrink-0 rounded-full border border-axis bg-surface py-1 pl-2 pr-1 text-xs text-ink ${FOCUS}`}>
                  {WARD_METRICS.map((m) => (
                    <option key={m.value} value={m.value}>
                      By {m.label.charAt(0).toLowerCase() + m.label.slice(1)}
                    </option>
                  ))}
                </select>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

const Chevron = ({ className }: { className: string }) => (
  <svg aria-hidden viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 ${className}`}>
    <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * The key beside the map, inside the map's frame, so it is in view with the map and goes fullscreen
 * with it. On a frame of 48rem or wider it is a narrow panel on the right; on a narrower one it
 * opens over the lower part of the map. It folds to a thin tab and back. `open` is null until the
 * reader has folded or opened it: the key is then open on a wide frame and folded on a narrow one.
 */
export function MapKey({ open, onOpen, children }: { open: boolean | null; onOpen: (v: boolean) => void; children: ReactNode }) {
  const id = useId();
  const panel = open === null ? "hidden @3xl:flex" : open ? "flex" : "hidden";
  const tab = open === null ? "flex @3xl:hidden" : open ? "hidden" : "flex";
  return (
    <>
      <section
        id={id}
        aria-label="Map key"
        className={`${panel} absolute inset-x-0 bottom-0 z-10 max-h-[60%] flex-col border-t border-line bg-surface @3xl:static @3xl:max-h-none @3xl:w-56 @3xl:shrink-0 @3xl:border-l @3xl:border-t-0`}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line py-1 pl-3 pr-1">
          <h3 className="text-sm font-semibold text-ink">Map key</h3>
          <button type="button" aria-expanded aria-controls={id} onClick={() => onOpen(false)} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink ${FOCUS_INSIDE}`}>
            Hide
            <Chevron className="rotate-90 @3xl:rotate-0" />
          </button>
        </div>
        {/* It can be scrolled with the keyboard when the layers switched on need more room than the map is tall. */}
        <div tabIndex={0} role="group" aria-label="Layers shown and their marks" className={`grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(11rem,100%),1fr))] content-start gap-x-4 gap-y-3 overflow-y-auto px-3 py-2.5 scrollbar-thin ${FOCUS_INSIDE}`}>
          {children}
        </div>
      </section>
      <button
        type="button"
        aria-expanded={false}
        aria-controls={id}
        onClick={() => onOpen(true)}
        className={`${tab} shrink-0 items-center justify-center gap-1.5 border-t border-line bg-surface px-3 py-1 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink @3xl:w-8 @3xl:flex-col @3xl:border-l @3xl:border-t-0 @3xl:px-0 @3xl:py-3 ${FOCUS_INSIDE}`}
      >
        <Chevron className="-rotate-90 @3xl:rotate-180" />
        <span className="@3xl:[writing-mode:vertical-rl]">Map key</span>
      </button>
    </>
  );
}

/** One layer in the key: its name, its marks, and a few words where the marks need them. */
export function KeyEntry({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold text-ink">{title}</div>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{children}</ul>
      {note && <p className="mt-1 text-xs leading-snug text-muted">{note}</p>}
    </div>
  );
}

/** One mark of a layer, with the words that say what it is. */
export function KeyRow({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-1.5 text-xs leading-snug text-ink-2">
      <span className="flex h-[1.375em] w-4 shrink-0 items-center justify-center">{swatch}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
