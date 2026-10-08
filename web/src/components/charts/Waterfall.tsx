"use client";

/**
 * A waterfall: how one amount becomes another, step by step. Drawn by hand in SVG like LineChart.
 *
 * How to use it (inside a ChartFrame, which gives the title, subtitle and source line):
 *   <Waterfall
 *     title="From ground-up loss to net loss"       the accessible name; repeat the frame's title
 *     yLabel="Loss in a 1-in-100 event, KES"        axis title, with units
 *     steps={[
 *       { label: "Ground-up", value: 4.2e9, kind: "total" },
 *       { label: "Minus deductibles", value: 0.4e9, kind: "decrease" },
 *       { label: "Gross", value: 3.8e9, kind: "total" },
 *       { label: "Minus quota share", value: 1.5e9, kind: "decrease" },
 *       { label: "Minus excess of loss", value: 1.1e9, kind: "decrease" },
 *       { label: "Net", value: 1.2e9, kind: "total" },
 *     ]}
 *   />
 *
 * A total is a full bar from zero. A decrease hangs from the level before it; give its size as a
 * plain amount (the sign is ignored) and the chart writes it with a minus sign. Totals are solid,
 * decreases are striped with an outline, so the two read apart without colour, and the chart draws
 * its own legend for them. The chart draws the totals it is given: it does not check that
 * "Gross" equals "Ground-up" less the deductibles, so pass figures the model has already reconciled.
 *
 * In a card too narrow for the bars and their labels, the plot scrolls sideways inside its own box;
 * the page never does.
 */

import { useEffect, useId, useRef, useState } from "react";
import { axisTicks, kes1, wrapLabel } from "@/lib/labels";
import { useTextScale } from "@/lib/useDisplay";
import { HatchPattern, Legend } from "./ChartFrame";

export interface WaterfallStep {
  /** The step's name, shown under its bar. */
  label: string;
  /** A total's level, or the size of a decrease (written with a minus sign whatever sign it is given with). */
  value: number;
  /** "total": a full bar from zero. "decrease": hangs from the previous level. */
  kind: "total" | "decrease";
}

interface Props {
  /** What the chart shows; becomes its accessible name. */
  title: string;
  steps: WaterfallStep[];
  /** Axis title with units, for example "Loss, KES". */
  yLabel: string;
  /** Writes an amount with its units: bar labels, axis ticks and the tooltip. Must put a minus sign on a negative amount, as kes1 does. */
  format?: (value: number) => string;
  /** A shorter form for the axis ticks, if `format` is too long for them. */
  tickFormat?: (value: number) => string;
  /** Legend name for the solid bars. */
  totalLabel?: string;
  /** Legend name for the striped bars. */
  decreaseLabel?: string;
  /** CSS colour token for totals. */
  totalColor?: string;
  /** CSS colour token for decreases. */
  decreaseColor?: string;
  /** Height of the plot area at the Standard text size. The room for labels around it grows with the text. */
  height?: number;
}

interface Bar extends WaterfallStep {
  /** The bar spans lo to hi on the y axis. */
  lo: number;
  hi: number;
  /** The running level once this step is done. */
  after: number;
  /** The value label above the bar. */
  text: string;
}

/** A total starts at zero; a decrease hangs from the running level and lowers it. */
function layOut(steps: WaterfallStep[], format: (value: number) => string): Bar[] {
  const bars: Bar[] = [];
  let level = 0;
  for (const s of steps) {
    if (s.kind === "total") {
      level = Number.isFinite(s.value) ? Math.max(0, s.value) : 0;
      bars.push({ ...s, lo: 0, hi: level, after: level, text: format(s.value) });
      continue;
    }
    const size = Number.isFinite(s.value) ? Math.abs(s.value) : 0;
    const hi = level;
    level -= size;
    // The label says the full amount even when the bar has to stop at zero.
    bars.push({ ...s, lo: Math.max(0, level), hi: Math.max(0, hi), after: level, text: format(-size) });
  }
  return bars;
}

export function Waterfall({
  title,
  steps,
  yLabel,
  format = kes1,
  tickFormat = format,
  totalLabel = "Amount",
  decreaseLabel = "Taken off",
  totalColor = "var(--accent)",
  decreaseColor = "var(--series-2)",
  height = 260,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const scale = useTextScale();
  // React ids can hold characters that are not safe inside url(#...).
  const hatch = `waterfall-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // The same outer element as the chart below, so the width observer carries over when steps arrive.
  if (steps.length === 0) return <div ref={wrap} className="w-full text-sm text-muted">Nothing to show yet.</div>;

  const bars = layOut(steps, format);

  // SVG labels and the room around the plot are sized in pixels, so both are multiplied up to follow the text size.
  const fontSize = 12 * scale;
  const charWidth = fontSize * 0.58;
  const lineHeight = fontSize * 1.3;

  const yTicks = axisTicks(Math.max(1e-9, ...bars.map((b) => b.hi)));
  const yTop = yTicks[yTicks.length - 1];
  // The left margin holds the widest y label, so a long figure is not clipped at the edge.
  const yLabelWidth = Math.max(...yTicks.map((t) => tickFormat(t).length)) * charWidth;
  const left = yLabelWidth + 14 * scale;
  const right = 28 * scale;

  // A bar needs room for its value label above and its name below. Past that the plot scrolls inside its own box.
  const minBand = Math.max(64 * scale, Math.max(...bars.map((b) => b.text.length)) * charWidth + 8 * scale);
  const inner = Math.max(width, left + right + bars.length * minBand);
  const w = inner - left - right;
  const band = w / bars.length;
  const barWidth = Math.min(band * 0.64, 96 * scale);

  const names = bars.map((b) => wrapLabel(b.label, Math.max(4, Math.floor((band - 6 * scale) / charWidth)), 3));
  const m = { top: fontSize + 12 * scale, right, bottom: Math.max(...names.map((n) => n.length)) * lineHeight + 12 * scale, left };
  const h = height;

  const sy = (v: number) => h - (v / yTop) * h;
  const cx = (i: number) => i * band + band / 2;

  const describe = (b: Bar) => (b.kind === "total" ? `${b.label}: ${b.text}` : `${b.label}: ${b.text}, leaving ${format(b.after)}`);
  const hovered = active !== null && active < bars.length ? bars[active] : null;
  const kinds = new Set(bars.map((b) => b.kind));

  return (
    <div ref={wrap} className="w-full">
      {kinds.size > 1 && (
        <Legend
          className="mb-2"
          items={[
            { label: totalLabel, color: totalColor, mark: "bar" },
            { label: decreaseLabel, color: decreaseColor, mark: "hatch" },
          ]}
        />
      )}
      {/* The axis title is page text, not SVG text, so it wraps above a narrow plot instead of being clipped. */}
      <div className="mb-1 text-xs text-ink-2">{yLabel}</div>

      <div className="overflow-x-auto">
        <div className="relative" style={{ width: inner }}>
          <svg width={inner} height={m.top + h + m.bottom} role="img" aria-label={`${title}. ${bars.map(describe).join(". ")}`} className="block" onPointerLeave={() => setActive(null)}>
            <defs>
              <HatchPattern id={hatch} color={decreaseColor} size={6 * scale} />
            </defs>
            <g transform={`translate(${m.left},${m.top})`}>
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={0} x2={w} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? "var(--axis)" : "var(--line)"} strokeWidth={1} />
                  <text x={-10 * scale} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={fontSize} fill="var(--muted)" className="tabular">{tickFormat(t)}</text>
                </g>
              ))}

              {/* A connector carries each bar's closing level across to the next bar. */}
              {bars.slice(0, -1).map((b, i) => (
                <line
                  key={i}
                  x1={cx(i) + barWidth / 2}
                  x2={cx(i + 1) - barWidth / 2}
                  y1={sy(Math.max(0, b.after))}
                  y2={sy(Math.max(0, b.after))}
                  stroke="var(--ink-2)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
              ))}

              {bars.map((b, i) => {
                const y = sy(b.hi);
                // A step of no size still shows a hairline, so it does not vanish from the row.
                const barHeight = Math.max(sy(b.lo) - y, 1.5);
                return (
                  <g
                    key={i}
                    tabIndex={0}
                    role="img"
                    aria-label={describe(b)}
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive((a) => (a === i ? null : a))}
                  >
                    {/* The whole column, name included, is the hover and focus target. */}
                    <rect x={i * band} y={-m.top} width={band} height={m.top + h + m.bottom} fill={active === i ? "var(--surface-2)" : "transparent"} opacity={0.6} />
                    {b.kind === "total" ? (
                      <rect x={cx(i) - barWidth / 2} y={y} width={barWidth} height={barHeight} rx={2} fill={totalColor} />
                    ) : (
                      <rect x={cx(i) - barWidth / 2} y={y} width={barWidth} height={barHeight} rx={2} fill={`url(#${hatch})`} stroke={decreaseColor} strokeWidth={1.5} />
                    )}
                    <text x={cx(i)} y={y - 7 * scale} textAnchor="middle" fontSize={fontSize} fontWeight={b.kind === "total" ? 600 : 400} fill="var(--ink)" className="tabular">{b.text}</text>
                    <text textAnchor="middle" fontSize={fontSize} fill="var(--ink-2)">
                      {/* A name cut short keeps its full wording in a title. */}
                      {names[i].join(" ") !== b.label.trim().replace(/\s+/g, " ") && <title>{b.label}</title>}
                      {names[i].map((line, n) => (
                        <tspan key={n} x={cx(i)} y={h + 8 * scale + (n + 0.75) * lineHeight}>{line}</tspan>
                      ))}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          {hovered && active !== null && (
            // 15.625rem is the tooltip's width (w-60) plus a small gap, so it stops short of the right edge at every text size.
            <div
              className="pointer-events-none absolute z-10 w-60 max-w-full rounded-xl border border-line bg-surface p-3 text-sm shadow-lg"
              style={{ top: m.top, left: `clamp(0px, ${(m.left + cx(active) + barWidth / 2 + 10).toFixed(1)}px, calc(100% - 15.625rem))` }}
            >
              <div className="mb-1.5 wrap-anywhere font-semibold text-ink">{hovered.label}</div>
              <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
                <span>{hovered.kind === "total" ? totalLabel : decreaseLabel}</span>
                <span className="tabular whitespace-nowrap font-medium text-ink">{hovered.text}</span>
              </div>
              {hovered.kind === "decrease" && (
                <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
                  <span>Leaves</span>
                  <span className="tabular whitespace-nowrap font-medium text-ink">{format(hovered.after)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
