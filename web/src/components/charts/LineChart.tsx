"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface Point {
  x: number;
  y: number;
}

export interface Series {
  id: string;
  label: string;
  /** CSS colour, normally a var(--…) role. */
  color: string;
  points: Point[];
  /** De-emphasised context line: thinner, no markers. */
  quiet?: boolean;
  markers?: boolean;
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
  /** X positions the crosshair snaps to. */
  hoverXs: number[];
  height?: number;
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

export function LineChart({ series, band, xScale, xTicks, xFormat, yFormat, xLabel, hoverXs, height = 320, yMax }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const m = { top: 12, right: 20, bottom: 44, left: 76 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;

  const { sx, sy, yTicks } = useMemo(() => {
    const xs = [...xTicks, ...series.flatMap((s) => s.points.map((p) => p.x))];
    const t = (v: number) => (xScale === "log" ? Math.log(v) : v);
    const x0 = t(Math.min(...xs));
    const x1 = t(Math.max(...xs));
    const top = yMax ?? Math.max(1e-9, ...series.flatMap((s) => s.points.map((p) => p.y)), ...(band?.upper.map((p) => p.y) ?? []));
    const ticks = niceTicks(top);
    const yTop = ticks[ticks.length - 1];
    return {
      sx: (v: number) => (x1 === x0 ? w / 2 : ((t(v) - x0) / (x1 - x0)) * w),
      sy: (v: number) => h - (v / yTop) * h,
      yTicks: ticks,
    };
  }, [series, band, xScale, xTicks, w, h, yMax]);

  const path = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  const bandPath = band && band.lower.length > 1 ? `${path(band.upper)}${[...band.lower].reverse().map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("")}Z` : null;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = hoverXs[0];
    for (const x of hoverXs) if (Math.abs(sx(x) - px) < Math.abs(sx(best) - px)) best = x;
    setHover(best);
  };

  const readout = hover === null ? [] : series.map((s) => ({ s, v: valueAt(s.points, hover, xScale) })).filter((r) => r.v !== null);
  const bandAt = hover !== null && band ? { lo: valueAt(band.lower, hover, xScale), hi: valueAt(band.upper, hover, xScale) } : null;
  const tipLeft = hover !== null ? Math.min(Math.max(m.left + sx(hover) + 14, 0), width - 250) : 0;

  return (
    <div ref={wrap} className="relative w-full">
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-2">
        {series.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-2">
            <span className="inline-block h-0.5 w-5 rounded-full" style={{ background: s.color, height: s.quiet ? 1.5 : 2.5 }} />
            {s.label}
          </span>
        ))}
        {band && bandPath && (
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-3 w-5 rounded-sm" style={{ background: "var(--accent-wash)", border: "1px solid var(--line)" }} />
            {band.label}
          </span>
        )}
      </div>

      <svg width={width} height={height} role="img" aria-label={`${xLabel} chart`} className="block">
        <g transform={`translate(${m.left},${m.top})`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={0} x2={w} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? "var(--axis)" : "var(--line)"} strokeWidth={1} />
              <text x={-10} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--muted)" className="tabular">{yFormat(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={t} transform={`translate(${sx(t)},${h})`}>
              <line y2={5} stroke="var(--axis)" />
              <text y={20} textAnchor="middle" fontSize={12} fill="var(--muted)" className="tabular">{xFormat(t)}</text>
            </g>
          ))}
          <text x={w / 2} y={h + 40} textAnchor="middle" fontSize={12} fill="var(--ink-2)">{xLabel}</text>

          {bandPath && <path d={bandPath} fill="var(--accent-wash)" />}
          {series.map((s) => (
            <g key={s.id}>
              <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth={s.quiet ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
              {s.markers && s.points.map((p) => <circle key={p.x} cx={sx(p.x)} cy={sy(p.y)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />)}
            </g>
          ))}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={sx(hover)} x2={sx(hover)} y1={0} y2={h} stroke="var(--axis)" strokeWidth={1} />
              {readout.map(({ s, v }) => <circle key={s.id} cx={sx(hover)} cy={sy(v!)} r={5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />)}
            </g>
          )}
          <rect x={0} y={0} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </g>
      </svg>

      {hover !== null && (
        <div className="pointer-events-none absolute top-10 z-10 w-60 rounded-xl border border-line bg-surface p-3 text-[13px] shadow-lg" style={{ left: tipLeft }}>
          <div className="mb-1.5 font-semibold text-ink">{xFormat(hover)}</div>
          {readout.map(({ s, v }) => (
            <div key={s.id} className="flex items-center justify-between gap-3 py-0.5 text-ink-2">
              <span className="inline-flex items-center gap-2"><span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
              <span className="tabular font-medium text-ink">{yFormat(v!)}</span>
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
