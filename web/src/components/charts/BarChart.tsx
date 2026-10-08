"use client";

/**
 * Horizontal bars, one row per category, drawn by hand in SVG like LineChart.
 *
 * How to use it (inside a ChartFrame, which gives the title, subtitle and source line):
 *   <BarChart
 *     title="Loss by housing class"                 the accessible name; repeat the frame's title
 *     rows={[{ label: "Permanent", value: 2.1e9, share: 0.62 }, ...]}
 *     xLabel="Loss in a 1-in-100 event, KES"        axis title, with units
 *     format={kes1}                                 value labels, axis ticks and the tooltip
 *     valueLabel="Loss"                             the bars' name in the tooltip and the legend
 *     mark={{ label: "Share of insured value", scale: "ofTotal", format: pct1 }}
 *   />
 *
 * The optional second mark is a hollow diamond (or a tick) beside each bar, read from row.share.
 * With scale "axis" (the default) share is in the bars' own units. With scale "ofTotal" share is a
 * fraction between 0 and 1 and the mark sits at that fraction of the bars' total: where the bar
 * would end if the row took the same share of the total as it has of, say, insured value. A bar
 * that runs past its mark has more than its share.
 *
 * When a mark is given the chart draws its own two-entry legend, so do not repeat it on the frame.
 * Values below zero are drawn as zero: this chart is for amounts and shares, not for changes.
 */

import { useEffect, useRef, useState } from "react";
import { axisTicks, wrapLabel } from "@/lib/labels";
import { useTextScale } from "@/lib/useDisplay";
import { Legend } from "./ChartFrame";

export interface BarRow {
  /** The category name, shown to the left of the bar. */
  label: string;
  /** The bar's length, in the units the axis title names. */
  value: number;
  /** A short second line under the label, also shown in the tooltip (for example "1,240 buildings"). */
  note?: string;
  /** The second mark's value for this row. See `mark`. */
  share?: number;
  /** CSS colour token for this row, for categorical data. Rows are labelled, so colour is never the only cue. */
  color?: string;
}

export interface BarMark {
  /** The mark's name in the legend and the tooltip, for example "Share of insured value". */
  label: string;
  /** How to write row.share in the tooltip. Defaults to the chart's `format`. */
  format?: (share: number) => string;
  /** "axis": share is in the bars' units. "ofTotal": share is a fraction of the bars' total. */
  scale?: "axis" | "ofTotal";
  /** A hollow diamond (default) or an upright tick. */
  shape?: "diamond" | "tick";
  /** CSS colour token. Defaults to the ink colour, so it stands apart from any bar. */
  color?: string;
}

interface Props {
  /** What the chart shows; becomes its accessible name. */
  title: string;
  rows: BarRow[];
  /** Axis title with units, for example "Loss, KES". */
  xLabel: string;
  /** Writes a value with its units: bar-end labels, axis ticks and the tooltip. */
  format: (value: number) => string;
  /** A shorter form for the axis ticks, if `format` is too long for them. */
  tickFormat?: (value: number) => string;
  /** The bars' name in the tooltip and the legend. */
  valueLabel?: string;
  /** An optional second mark per row, read from row.share. */
  mark?: BarMark;
  /** Bar colour when a row has none of its own. */
  color?: string;
  /** Fix the right-hand end of the axis, for example 1 for shares that should run to 100%. */
  xMax?: number;
}

export function BarChart({ title, rows, xLabel, format, tickFormat = format, valueLabel = "Value", mark, color = "var(--accent)", xMax }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const scale = useTextScale();

  useEffect(() => {
    if (!wrap.current) return;
    // The chart is as wide as its card, so it never pushes the page sideways. The floor only covers a card too narrow to draw in.
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // The same outer element as the chart below, so the width observer carries over when rows arrive.
  if (rows.length === 0) return <div ref={wrap} className="w-full text-sm text-muted">Nothing to show yet.</div>;

  const amount = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const total = rows.reduce((sum, r) => sum + amount(r.value), 0);
  // Where a row's second mark sits on the axis, or null when the row has none.
  const markAt = (r: BarRow) => (mark && r.share !== undefined && Number.isFinite(r.share) ? amount(mark.scale === "ofTotal" ? r.share * total : r.share) : null);
  const markFormat = mark?.format ?? format;
  const markColor = mark?.color ?? "var(--ink)";

  // SVG labels and the room around the plot are sized in pixels, so both are multiplied up to follow the text size.
  const fontSize = 12 * scale;
  const charWidth = fontSize * 0.58;
  const lineHeight = fontSize * 1.3;
  const gap = 12 * scale;
  const markRadius = 6 * scale;

  // The label column takes what its longest label needs, up to two fifths of the chart. Longer labels wrap onto a second line.
  const longest = Math.max(...rows.map((r) => Math.max(r.label.length, r.note?.length ?? 0)));
  const labelWidth = Math.min(longest * charWidth + gap, width * 0.4);
  const maxChars = Math.max(4, Math.floor((labelWidth - gap) / charWidth));
  const text = rows.map((r) => ({ label: wrapLabel(r.label, maxChars, 2), note: r.note ? wrapLabel(r.note, maxChars, 1)[0] : null }));
  const textLines = Math.max(...text.map((t) => t.label.length + (t.note ? 1 : 0)));

  const barHeight = 18 * scale;
  const rowHeight = Math.max(barHeight + 14 * scale, textLines * lineHeight + 10 * scale);
  // The right margin holds the widest value label, which sits past the end of its bar.
  const valueWidth = Math.max(...rows.map((r) => format(r.value).length)) * charWidth;
  const m = { top: 4, right: valueWidth + gap + (mark ? markRadius : 0), bottom: 28 * scale, left: labelWidth };
  const w = Math.max(width - m.left - m.right, 24);
  const h = rows.length * rowHeight;

  const ticks = axisTicks(xMax ?? Math.max(1e-9, ...rows.map((r) => Math.max(amount(r.value), markAt(r) ?? 0))));
  const top = xMax ?? ticks[ticks.length - 1];
  const sx = (v: number) => Math.min(1, v / top) * w;

  // On a narrow chart the tick labels would run into each other. A label that does not fit is left out; its grid line stays.
  const labelled: number[] = [];
  let edge = -Infinity;
  for (const t of ticks.filter((t) => t <= top)) {
    const half = (tickFormat(t).length * charWidth) / 2;
    if (sx(t) - half < edge) continue;
    labelled.push(t);
    edge = sx(t) + half + fontSize / 2;
  }

  const describe = (r: BarRow) => {
    const share = mark && r.share !== undefined ? `, ${mark.label} ${markFormat(r.share)}` : "";
    return `${r.label}: ${valueLabel} ${format(r.value)}${share}${r.note ? `, ${r.note}` : ""}`;
  };

  const svgHeight = m.top + h + m.bottom;
  const hovered = active !== null && active < rows.length ? rows[active] : null;

  return (
    <div ref={wrap} className="w-full">
      {mark && (
        <Legend
          className="mb-2"
          items={[
            { label: valueLabel, color, mark: "bar" },
            { label: mark.label, color: markColor, mark: mark.shape ?? "diamond" },
          ]}
        />
      )}

      <div className="relative">
        <svg width={width} height={svgHeight} role="img" aria-label={`${title}. ${rows.map(describe).join(". ")}`} className="block" onPointerLeave={() => setActive(null)}>
          <g transform={`translate(${m.left},${m.top})`}>
            {ticks.filter((t) => t <= top).map((t) => (
              <g key={t} transform={`translate(${sx(t)},0)`}>
                <line y1={0} y2={h} stroke={t === 0 ? "var(--axis)" : "var(--line)"} strokeWidth={1} />
                <line y1={h} y2={h + 5} stroke="var(--axis)" />
                {labelled.includes(t) && <text y={h + 20 * scale} textAnchor="middle" fontSize={fontSize} fill="var(--muted)" className="tabular">{tickFormat(t)}</text>}
              </g>
            ))}

            {rows.map((r, i) => {
              const mid = i * rowHeight + rowHeight / 2;
              const end = sx(amount(r.value));
              const at = markAt(r);
              const markX = at === null ? null : sx(at);
              const lines = text[i].label.length + (text[i].note ? 1 : 0);
              const firstLine = mid - ((lines - 1) * lineHeight) / 2;
              return (
                <g
                  key={i}
                  tabIndex={0}
                  role="img"
                  aria-label={describe(r)}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                >
                  {/* The band is the hover and focus target for the whole row, label included. */}
                  <rect x={-m.left} y={i * rowHeight} width={width} height={rowHeight} fill={active === i ? "var(--surface-2)" : "transparent"} />
                  <text x={-gap} textAnchor="end" fontSize={fontSize}>
                    {/* A label cut short keeps its full wording in a title. */}
                    {text[i].label.join(" ") !== r.label.trim().replace(/\s+/g, " ") && <title>{r.label}</title>}
                    {text[i].label.map((line, n) => (
                      <tspan key={n} x={-gap} y={firstLine + n * lineHeight} dy="0.32em" fill="var(--ink)">{line}</tspan>
                    ))}
                    {text[i].note && <tspan x={-gap} y={firstLine + text[i].label.length * lineHeight} dy="0.32em" fill="var(--muted)">{text[i].note}</tspan>}
                  </text>
                  {/* A value above zero always shows at least a sliver, so a small row does not read as empty. */}
                  <rect x={0} y={mid - barHeight / 2} width={amount(r.value) > 0 ? Math.max(end, 2) : 0} height={barHeight} rx={3} fill={r.color ?? color} />
                  {markX !== null && (mark?.shape === "tick" ? (
                    <line x1={markX} x2={markX} y1={mid - barHeight / 2 - 4 * scale} y2={mid + barHeight / 2 + 4 * scale} stroke={markColor} strokeWidth={3} />
                  ) : (
                    <path
                      d={`M${markX},${mid - markRadius}l${markRadius},${markRadius}l${-markRadius},${markRadius}l${-markRadius},${-markRadius}z`}
                      fill="var(--surface)"
                      stroke={markColor}
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                  ))}
                  {/* The value label clears both the bar and the mark, whichever reaches further. */}
                  <text x={Math.max(end, markX === null ? 0 : markX + markRadius) + 6 * scale} y={mid} dy="0.32em" fontSize={fontSize} fill="var(--ink)" className="tabular">{format(r.value)}</text>
                </g>
              );
            })}
          </g>
        </svg>

        {hovered && active !== null && (
          // Rows in the top half show the tooltip under them, the rest above, so it stays inside the chart.
          // 15.625rem is the tooltip's width (w-60) plus a small gap, so it stops short of the right edge at every text size.
          <div
            className="pointer-events-none absolute z-10 w-60 max-w-full rounded-xl border border-line bg-surface p-3 text-sm shadow-lg"
            style={{
              left: `clamp(0px, ${(m.left + 8).toFixed(1)}px, calc(100% - 15.625rem))`,
              ...(active < rows.length / 2 ? { top: m.top + (active + 1) * rowHeight } : { bottom: svgHeight - (m.top + active * rowHeight) }),
            }}
          >
            <div className="mb-1.5 wrap-anywhere font-semibold text-ink">{hovered.label}</div>
            <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
              <span>{valueLabel}</span>
              <span className="tabular whitespace-nowrap font-medium text-ink">{format(hovered.value)}</span>
            </div>
            {mark && hovered.share !== undefined && (
              <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
                <span>{mark.label}</span>
                <span className="tabular whitespace-nowrap font-medium text-ink">{markFormat(hovered.share)}</span>
              </div>
            )}
            {hovered.note && <div className="mt-1 border-t border-line pt-1 wrap-anywhere text-ink-2">{hovered.note}</div>}
          </div>
        )}
      </div>
      {/* The axis title is page text, not SVG text, so it wraps under a narrow plot instead of being clipped. */}
      <div className="mt-1 text-center text-xs text-ink-2" style={{ paddingLeft: m.left, paddingRight: m.right }}>{xLabel}</div>
    </div>
  );
}
