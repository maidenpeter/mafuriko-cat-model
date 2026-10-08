"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTextScale } from "@/lib/useDisplay";

export interface Point {
  x: number;
  y: number;
}

/** The shape drawn at each point of a line, so lines can be told apart without colour. */
export type MarkerShape = "circle" | "square" | "triangle" | "diamond";

export interface Series {
  id: string;
  label: string;
  /** CSS colour, normally a var(--…) role. */
  color: string;
  points: Point[];
  /** De-emphasised context line: thinner, no markers. */
  quiet?: boolean;
  /** Round markers at each point. Use `marker` to choose another shape. */
  markers?: boolean;
  /** A marker of this shape at each point. */
  marker?: MarkerShape;
  /** SVG dash pattern such as "9 6". Left out, the line is solid. */
  dash?: string;
  /** A short name written at the right-hand end of the line, when the chart is asked for end labels and has the room. */
  endLabel?: string;
}

interface Props {
  series: Series[];
  /** Shaded range between two lines that share the chart's x scale. */
  band?: { label: string; lower: Point[]; upper: Point[] };
  xScale: "log" | "linear";
  xTicks: number[];
  xFormat: (x: number) => string;
  yFormat: (y: number) => string;
  xLabel: string;
  /** A second line under each x tick label, for example the annual chance under a return period. */
  xSubFormat?: (x: number) => string;
  /** The y axis title with its units, for example "Loss (KES)". */
  yLabel?: string;
  /** The heading of the tooltip. Left out, it is the x tick label. */
  tooltipTitle?: (x: number) => string;
  /** Writes each series' `endLabel` beside the end of its line where the chart is wide enough. */
  endLabels?: boolean;
  /** The chart's accessible name. Left out, it is made from the x axis title. */
  ariaLabel?: string;
  /** X positions the crosshair snaps to. */
  hoverXs: number[];
  /** Height at the Standard text size. The plot keeps its area; the room for labels grows with the text. */
  height?: number;
  /** Lets the plot grow past that height to fill a taller box. The caller's box must be a column flex container. */
  fill?: boolean;
  yMax?: number;
}

function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

const axisValue = (v: number, scale: "log" | "linear") => (scale === "log" ? Math.log(v) : v);

/** Value of a line at x, interpolated along the chart's own x scale. Null outside the line's range. */
export function valueAt(points: Point[], x: number, scale: "log" | "linear"): number | null {
  if (points.length === 0 || x < points[0].x || x > points[points.length - 1].x) return null;
  const t = (v: number) => (scale === "log" ? Math.log(v) : v);
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i].x) {
      const span = t(points[i].x) - t(points[i - 1].x);
      const f = span === 0 ? 0 : (t(x) - t(points[i - 1].x)) / span;
      return points[i - 1].y + f * (points[i].y - points[i - 1].y);
    }
  }
  return points[0].y;
}

const markerOf = (s: Series): MarkerShape | undefined => s.marker ?? (s.markers ? "circle" : undefined);

/** One marker, centred on (x, y). The surface-coloured edge keeps it clear of the line it sits on. */
function Marker({ shape, x, y, r, color }: { shape: MarkerShape; x: number; y: number; r: number; color: string }) {
  const edge = { fill: color, stroke: "var(--surface)", strokeWidth: 2, strokeLinejoin: "round" as const };
  if (shape === "square") return <rect x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} rx={1} {...edge} />;
  if (shape === "triangle") return <path d={`M${x},${y - r * 1.2}L${x + r * 1.15},${y + r * 0.85}L${x - r * 1.15},${y + r * 0.85}Z`} {...edge} />;
  if (shape === "diamond") return <path d={`M${x},${y - r * 1.25}L${x + r * 1.25},${y}L${x},${y + r * 1.25}L${x - r * 1.25},${y}Z`} {...edge} />;
  return <circle cx={x} cy={y} r={r} {...edge} />;
}

/** The series as it is drawn, in small: its dash pattern and its marker. Sized in rem, so it grows with the text. */
function Swatch({ s }: { s: Series }) {
  const shape = markerOf(s);
  return (
    <svg viewBox="0 0 30 12" aria-hidden className="shrink-0" style={{ width: "1.875rem", height: "0.75rem" }}>
      <line x1={1} x2={29} y1={6} y2={6} stroke={s.color} strokeWidth={s.quiet ? 1.5 : 2.5} strokeDasharray={s.dash} strokeLinecap="round" />
      {shape && <Marker shape={shape} x={15} y={6} r={3.5} color={s.color} />}
    </svg>
  );
}

export function LineChart({ series, band, xScale, xTicks, xFormat, xSubFormat, yFormat, xLabel, yLabel, tooltipTitle, endLabels = false, ariaLabel, hoverXs, height = 320, fill = false, yMax }: Props) {
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [room, setRoom] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const scale = useTextScale();

  useEffect(() => {
    if (!plot.current) return;
    // The chart is as wide as its card, so it never pushes the page sideways. The floor only covers a card too narrow to draw in.
    const ro = new ResizeObserver(([e]) => {
      setWidth(Math.max(240, e.contentRect.width));
      setRoom(e.contentRect.height);
    });
    ro.observe(plot.current);
    return () => ro.disconnect();
  }, []);

  const { x0, x1, yTicks } = useMemo(() => {
    const xs = [...xTicks, ...series.flatMap((s) => s.points.map((p) => p.x))];
    const top = yMax ?? Math.max(1e-9, ...series.flatMap((s) => s.points.map((p) => p.y)), ...(band?.upper.map((p) => p.y) ?? []));
    return { x0: axisValue(Math.min(...xs), xScale), x1: axisValue(Math.max(...xs), xScale), yTicks: niceTicks(top) };
  }, [series, band, xScale, xTicks, yMax]);

  // SVG labels and the room around the plot are sized in pixels, so both are multiplied up to follow the text size.
  const fontSize = 12 * scale;
  const charWidth = fontSize * 0.55;
  // The left margin holds the widest y label, so a long figure is not clipped at the edge.
  const yLabelWidth = Math.max(...yTicks.map((t) => yFormat(t).length)) * charWidth;
  const left = Math.max(76 * scale, yLabelWidth + 10 * scale);
  // End labels need a margin of their own. On a chart too narrow to spare it they are left out; the legend still names every line.
  const labelled = endLabels ? series.filter((s) => s.endLabel && s.points.length > 0) : [];
  const endLabelWidth = labelled.length ? Math.max(...labelled.map((s) => s.endLabel!.length)) * charWidth + 20 * scale : 0;
  const showEndLabels = labelled.length > 0 && width - left - endLabelWidth >= 320 * scale;
  const m = { top: 12, right: showEndLabels ? endLabelWidth : 28 * scale, bottom: (xSubFormat ? 44 : 28) * scale, left };
  const w = Math.max(width - m.left - m.right, 0);
  // A filling chart is drawn over its box and not inside it, so the box's height never depends on the drawing.
  const hMin = height - 56;
  const h = fill ? Math.max(hMin, room - m.top - m.bottom) : hMin;

  const yTop = yTicks[yTicks.length - 1];
  const sx = (v: number) => (x1 === x0 ? w / 2 : ((axisValue(v, xScale) - x0) / (x1 - x0)) * w);
  const sy = (v: number) => h - (v / yTop) * h;

  // On a narrow chart the x labels would run into each other. A label that does not fit is left out; its tick mark stays.
  const xLabelled: number[] = [];
  let edge = -Infinity;
  for (const t of xTicks) {
    const half = (Math.max(xFormat(t).length, xSubFormat ? xSubFormat(t).length : 0) * charWidth) / 2;
    if (sx(t) - half < edge) continue;
    xLabelled.push(t);
    edge = sx(t) + half + fontSize / 2;
  }

  const path = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const bandPath = band && band.lower.length > 1 ? `${path(band.upper)}${[...band.lower].reverse().map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("")}Z` : null;

  // End labels sit level with the end of their line, moved apart just enough that they never overlap.
  const ends = showEndLabels ? labelled.map((s) => ({ s, y: sy(s.points[s.points.length - 1].y) })).sort((a, b) => a.y - b.y) : [];
  const gap = fontSize * 1.25;
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + gap);
  if (ends.length && ends[ends.length - 1].y > h) {
    ends[ends.length - 1].y = h;
    for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - gap);
  }

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = hoverXs[0];
    for (const x of hoverXs) if (Math.abs(sx(x) - px) < Math.abs(sx(best) - px)) best = x;
    setHover(best);
  };

  const readout = hover === null ? [] : series.map((s) => ({ s, v: valueAt(s.points, hover, xScale) })).filter((r) => r.v !== null);
  const bandAt = hover !== null && band ? { lo: valueAt(band.lower, hover, xScale), hi: valueAt(band.upper, hover, xScale) } : null;

  return (
    <div className={`relative w-full ${fill ? "flex grow flex-col" : ""}`}>
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
        {series.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-2">
            <Swatch s={s} />
            {s.label}
          </span>
        ))}
        {band && bandPath && (
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-5 shrink-0 rounded-sm" style={{ background: "var(--accent-wash)", border: "1px solid var(--line)" }} />
            {band.label}
          </span>
        )}
      </div>

      {yLabel && <div className="mb-1 text-xs text-ink-2">{yLabel}</div>}
      <div ref={plot} className={fill ? "relative grow" : undefined} style={fill ? { minHeight: m.top + hMin + m.bottom } : undefined}>
        <svg width={width} height={m.top + h + m.bottom} role="img" aria-label={ariaLabel ?? `${xLabel} chart`} className={fill ? "absolute left-0 top-0 block" : "block"}>
          <g transform={`translate(${m.left},${m.top})`}>
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={0} x2={w} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? "var(--axis)" : "var(--line)"} strokeWidth={1} />
                <text x={-10 * scale} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={fontSize} fill="var(--muted)" className="tabular">{yFormat(t)}</text>
              </g>
            ))}
            {xTicks.map((t) => (
              <g key={t} transform={`translate(${sx(t)},${h})`}>
                <line y2={5} stroke="var(--axis)" />
                {xLabelled.includes(t) && <text y={20 * scale} textAnchor="middle" fontSize={fontSize} fill="var(--muted)" className="tabular">{xFormat(t)}</text>}
                {xSubFormat && xLabelled.includes(t) && <text y={36 * scale} textAnchor="middle" fontSize={fontSize} fill="var(--muted)" className="tabular">{xSubFormat(t)}</text>}
              </g>
            ))}

            {bandPath && <path d={bandPath} fill="var(--accent-wash)" />}
            {series.map((s) => {
              const shape = markerOf(s);
              return (
                <g key={s.id}>
                  <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth={s.quiet ? 1.5 : 2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
                  {shape && s.points.map((p) => <Marker key={p.x} shape={shape} x={sx(p.x)} y={sy(p.y)} r={4.5} color={s.color} />)}
                </g>
              );
            })}
            {ends.map(({ s, y }) => (
              <text key={s.id} x={w + 12 * scale} y={y} dy="0.32em" fontSize={fontSize} fontWeight={600} fill="var(--ink-2)">{s.endLabel}</text>
            ))}

            {hover !== null && (
              <g pointerEvents="none">
                <line x1={sx(hover)} x2={sx(hover)} y1={0} y2={h} stroke="var(--axis)" strokeWidth={1} />
                {readout.map(({ s, v }) => <Marker key={s.id} shape={markerOf(s) ?? "circle"} x={sx(hover)} y={sy(v!)} r={5} color={s.color} />)}
              </g>
            )}
            <rect x={0} y={0} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          </g>
        </svg>
      </div>
      {/* The axis title is page text, not SVG text, so it wraps under a narrow plot instead of being clipped. */}
      <div className="mt-1 text-center text-xs text-ink-2" style={{ paddingLeft: m.left, paddingRight: m.right }}>{xLabel}</div>

      {hover !== null && (
        // 15.625rem is the tooltip's width (w-60) plus a small gap, so it stops short of the right edge at every text size.
        <div
          className="pointer-events-none absolute top-10 z-10 w-60 max-w-full rounded-xl border border-line bg-surface p-3 text-sm shadow-lg"
          style={{ left: `clamp(0px, ${(m.left + sx(hover) + 14).toFixed(1)}px, calc(100% - 15.625rem))` }}
        >
          <div className="mb-1.5 font-semibold text-ink">{(tooltipTitle ?? xFormat)(hover)}</div>
          {readout.map(({ s, v }) => (
            <div key={s.id} className="flex items-center justify-between gap-3 py-0.5 text-ink-2">
              <span className="inline-flex min-w-0 items-center gap-2"><Swatch s={s} />{s.label}</span>
              <span className="tabular whitespace-nowrap font-medium text-ink">{yFormat(v!)}</span>
            </div>
          ))}
          {bandAt && bandAt.lo !== null && bandAt.hi !== null && (
            <div className="mt-1 border-t border-line pt-1 text-ink-2">
              {band!.label}: <span className="tabular text-ink">{yFormat(bandAt.lo)} to {yFormat(bandAt.hi)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
