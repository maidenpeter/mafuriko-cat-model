"use client";

/**
 * The frame every chart sits in, so each one carries the same labelling: a title in plain
 * words, a subtitle that says how to read it, a legend when there is more than one series,
 * an optional line of help, and a source line with the shared badges.
 *
 * How to use it:
 *   <ChartFrame
 *     title="Loss by housing class"
 *     subtitle="Each bar is the loss to that class in a 1-in-100 event"
 *     sources={[
 *       { kind: "real", text: "Hazard maps supplied with the starter kit" },
 *       { kind: "synthetic", text: "Portfolio of insured buildings" },
 *     ]}
 *   >
 *     <BarChart title="Loss by housing class" ... />
 *   </ChartFrame>
 *
 * For the exceedance curve pass help={EP_HELP} (from lib/labels) and a legend:
 *   legend={[{ label: "Gross", color: "var(--series-1)", mark: "line" }, { label: "Net", color: "var(--series-2)", mark: "dash" }]}
 * LineChart draws its own colour-only legend above the plot, so this legend is the one that also tells the
 * series apart by shape. BarChart and Waterfall draw their own legend with <Legend>; do not repeat it here.
 *
 * Also exported for use on their own: SourceBadge (the badge beside any figure), SourceLine,
 * Legend, LegendMark and HatchPattern (the diagonal hatching charts use as a second cue beside colour).
 */

import { useId, type ReactNode } from "react";
import { Tag } from "@/components/ui";
import { SOURCE_LABELS, type SourceKind } from "@/lib/labels";

/**
 * How a series is drawn in the legend. Each differs by shape or dash, not only by colour:
 * bar (solid block), hatch (striped block), outline (hollow block), line (solid line),
 * dash (dashed line), dot (line with a round marker), diamond (hollow diamond), tick (upright tick).
 */
export type LegendMarkKind = "bar" | "hatch" | "outline" | "line" | "dash" | "dot" | "diamond" | "tick";

export interface LegendItem {
  /** The series name as the reader should see it. */
  label: string;
  /** CSS colour, always a token such as var(--series-1). */
  color: string;
  /** The shape that tells this series apart without colour. */
  mark: LegendMarkKind;
}

export interface ChartSource {
  /** Which of the four badges. */
  kind: SourceKind;
  /** A few words on what the source is, for example "Hazard maps supplied with the starter kit". */
  text: ReactNode;
}

/** A React id made safe to use inside url(#...) in SVG. */
function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/**
 * Diagonal stripes in one colour on the card's surface. Put it inside <defs> and fill a shape
 * with url(#id). `size` is the gap between stripes in SVG units.
 */
export function HatchPattern({ id, color, size = 6 }: { id: string; color: string; size?: number }) {
  return (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={size} height={size} fill="var(--surface)" />
      <line x1={0} y1={0} x2={0} y2={size} stroke={color} strokeWidth={size * 0.55} />
    </pattern>
  );
}

/** The small drawing beside a legend label. Sized in rem, so it grows with the text. */
export function LegendMark({ mark, color }: { mark: LegendMarkKind; color: string }) {
  const hatch = useSvgId("legend-hatch-");
  return (
    <svg viewBox="0 0 22 12" aria-hidden className="shrink-0" style={{ width: "1.375rem", height: "0.75rem" }}>
      {mark === "hatch" && <defs><HatchPattern id={hatch} color={color} size={4} /></defs>}
      {mark === "bar" && <rect x={1} y={1} width={20} height={10} rx={2} fill={color} />}
      {mark === "hatch" && <rect x={1} y={1} width={20} height={10} rx={2} fill={`url(#${hatch})`} stroke={color} strokeWidth={1.5} />}
      {mark === "outline" && <rect x={1} y={1} width={20} height={10} rx={2} fill="var(--surface)" stroke={color} strokeWidth={2} />}
      {(mark === "line" || mark === "dot") && <line x1={1} x2={21} y1={6} y2={6} stroke={color} strokeWidth={2.5} strokeLinecap="round" />}
      {mark === "dash" && <line x1={1} x2={21} y1={6} y2={6} stroke={color} strokeWidth={2.5} strokeDasharray="5 3" />}
      {mark === "dot" && <circle cx={11} cy={6} r={4} fill={color} stroke="var(--surface)" strokeWidth={1.5} />}
      {mark === "diamond" && <path d="M11 1l5 5-5 5-5-5z" fill="var(--surface)" stroke={color} strokeWidth={2} strokeLinejoin="round" />}
      {mark === "tick" && <line x1={11} x2={11} y1={0.5} y2={11.5} stroke={color} strokeWidth={3} />}
    </svg>
  );
}

/** A row of series names, each with its mark. Wraps onto more lines in a narrow card. */
export function Legend({ items, className = "" }: { items: LegendItem[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Legend" className={`flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2 ${className}`}>
      {items.map((item) => (
        <li key={item.label} className="inline-flex min-w-0 items-center gap-2">
          <LegendMark mark={item.mark} color={item.color} />
          <span className="min-w-0 wrap-anywhere">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The badge that says where a figure comes from: "Real data", "Synthetic", "Assumption" or "AI".
 * Each kind has its own glyph as well as its word, so it reads without colour. Use this one
 * everywhere a figure needs its source; do not write the words by hand.
 */
export function SourceBadge({ kind }: { kind: SourceKind }) {
  return <Tag kind={kind}>{SOURCE_LABELS[kind]}</Tag>;
}

/** The line under a chart: each source as its badge and a few words. */
export function SourceLine({ sources, className = "" }: { sources: ChartSource[]; className?: string }) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label="Sources" className={`flex flex-wrap gap-x-5 gap-y-2 text-xs leading-relaxed text-muted ${className}`}>
      {sources.map((source, i) => (
        <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <SourceBadge kind={source.kind} />
          <span className="min-w-0 wrap-anywhere">{source.text}</span>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  /** What the chart shows, in plain words. Also the frame's accessible name. */
  title: string;
  /** How to read it, for example "Each bar is the loss to that class in a 1-in-100 event". */
  subtitle: string;
  /** The chart itself. */
  children: ReactNode;
  /** Needed whenever there is more than one series and the chart does not draw its own legend. */
  legend?: LegendItem[];
  /** One line of plain-language help under the chart, for example EP_HELP. */
  help?: ReactNode;
  /** Where the figures come from. Every chart has at least one. */
  sources: ChartSource[];
  /** Anything that belongs beside the title, such as a control that switches the return period. */
  aside?: ReactNode;
  /** Leave out the card border and padding when the frame already sits inside a Card. */
  bare?: boolean;
  className?: string;
}

export function ChartFrame({ title, subtitle, children, legend, help, sources, aside, bare = false, className = "" }: Props) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={`min-w-0 ${bare ? "" : "rounded-2xl border border-line bg-surface p-5"} ${className}`}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 id={titleId} className="text-base font-semibold text-ink">{title}</h3>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">{subtitle}</p>
        </div>
        {aside}
      </header>
      {legend && legend.length > 0 && <Legend items={legend} className="mb-3" />}
      {children}
      {help && <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-2">{help}</p>}
      <SourceLine sources={sources} className="mt-4 border-t border-line pt-3" />
    </section>
  );
}
