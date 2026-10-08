"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { wrapLabel } from "@/lib/labels";
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
  /** A shorter name for the tooltip, where a long legend label would wrap. Left out, the label is used. */
  short?: string;
}

/** A large point drawn over the lines, with its own words beside it. */
export interface ChartMark {
  x: number;
  y: number;
  /** A few words written beside the marker, for example "1-in-100". */
  label?: string;
  /** The mark the call-out and the guide lines belong to: its ring is drawn heavier. */
  strong?: boolean;
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
  /**
   * A labelled box inside the plot with a leader line to one point, which is ringed. The box sits
   * along the top of the plot, or along the bottom when the point is too high to leave it room, so
   * it never covers the point; give the chart a `yMax` above the lines to keep the box clear of them.
   * The same words belong in `ariaLabel` or in the text beside the chart.
   */
  callout?: {
    x: number;
    y: number;
    title?: string;
    text: string;
    /**
     * Puts the box next to its point and not against an edge of the plot: at the nearest place inside
     * the plot where it covers no line, mark or label, above and to the right where there is a choice,
     * with a short leader. Where the plot is too small for a clear place it takes the one that covers least.
     */
    beside?: boolean;
  };
  /**
   * A stretch of the x axis shaded from the axis up to one line (`under` is that series' id). Its words
   * are written beside it where they fit clear of the lines; the legend names it in every case.
   */
  shade?: { from: number; to: number; under: string; label: string; color?: string };
  /**
   * Large ringed markers drawn over the lines, as one group with one legend entry. Each is more than
   * 12 px across and has a shape of its own (a diamond unless told otherwise), so it does not rest on colour.
   */
  marks?: { label: string; points: ChartMark[]; shape?: MarkerShape; color?: string };
  /**
   * Dashed lines from one point down to the x axis and across to the y axis, with its two values
   * written on the axes in place of the tick labels they would cover: how a figure is read off the chart.
   */
  guide?: { x: number; y: number; xText?: string; yText?: string };
}

/** Radius of a large mark and of the ring around it, in pixels. */
const MARK_R = 7;
const RING_R = 12;
/** How far apart the test points along a line are, in pixels. */
const SPACING = 6;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const grow = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });
const boxesMeet = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const holds = (b: Box, p: readonly [number, number]) => p[0] > b.x && p[0] < b.x + b.w && p[1] > b.y && p[1] < b.y + b.h;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Points every few pixels along a drawn line, for testing what a box placed on the plot would cover. */
function along(pts: [number, number][], every: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / every));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  if (pts.length > 0) out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Counts test points on a grid of 2 px cells and sums them, so that how many lie inside any box is
 * four look-ups. The call-out tries thousands of boxes on every draw, and this keeps that cheap.
 */
function tally(dots: [number, number][], w: number, h: number): (b: Box) => number {
  const cell = 2;
  const cols = Math.max(1, Math.ceil(w / cell) + 1);
  const rows = Math.max(1, Math.ceil(h / cell) + 1);
  const wide = cols + 1;
  const sum = new Int32Array(wide * (rows + 1));
  for (const [x, y] of dots) {
    const c = Math.floor(x / cell);
    const r = Math.floor(y / cell);
    if (c >= 0 && r >= 0 && c < cols && r < rows) sum[(r + 1) * wide + c + 1]++;
  }
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) sum[r * wide + c] += sum[(r - 1) * wide + c] + sum[r * wide + c - 1] - sum[(r - 1) * wide + c - 1];
  return (b) => {
    const c0 = Math.min(cols, Math.max(0, Math.ceil(b.x / cell)));
    const c1 = Math.min(cols, Math.max(0, Math.ceil((b.x + b.w) / cell)));
    const r0 = Math.min(rows, Math.max(0, Math.ceil(b.y / cell)));
    const r1 = Math.min(rows, Math.max(0, Math.ceil((b.y + b.h) / cell)));
    return c1 > c0 && r1 > r0 ? sum[r1 * wide + c1] - sum[r0 * wide + c1] - sum[r1 * wide + c0] + sum[r0 * wide + c0] : 0;
  };
}

/** Positions from 0 to max in even steps, the last one at max itself. */
function stops(max: number, step: number): number[] {
  if (!(max > 0)) return [0];
  const out: number[] = [];
  for (let v = 0; v < max; v += step) out.push(v);
  out.push(max);
  return out;
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

export function LineChart({ series, band, xScale, xTicks, xFormat, xSubFormat, yFormat, xLabel, yLabel, tooltipTitle, endLabels = false, ariaLabel, hoverXs, height = 320, fill = false, yMax, callout, shade, marks, guide }: Props) {
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
  const guideText = guide ? { x: guide.xText ?? xFormat(guide.x), y: guide.yText ?? yFormat(guide.y) } : null;
  const left = Math.max(76 * scale, yLabelWidth + 10 * scale, guideText ? guideText.y.length * charWidth * 1.1 + 14 * scale : 0);
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
    // The guide's own value takes the place of a tick label it would run into.
    if (guide && guideText && Math.abs(sx(t) - sx(guide.x)) < half + (guideText.x.length * charWidth * 1.1) / 2 + fontSize / 2) continue;
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

  // What the chart places by itself (the marks' labels, the words beside the shading, the call-out beside its point) keeps clear of the lines: these are points every few pixels along each of them.
  const lineDots = shade || marks || callout?.beside ? series.flatMap((s) => along(s.points.map((p): [number, number] => [sx(p.x), sy(p.y)]), SPACING)) : [];
  /** Pixels of line a box would cover, with a little air around it. */
  const covered = (b: Box, dots = lineDots) => {
    const g = grow(b, 3);
    let n = 0;
    for (const d of dots) if (holds(g, d)) n++;
    return n * SPACING;
  };
  const glyph = fontSize * 0.6;

  // The guide: from its point straight down to the x axis and straight across to the y axis.
  const guideAt = guide && guideText && w > 0 ? { px: sx(guide.x), py: sy(guide.y), xText: guideText.x, yText: guideText.y } : null;
  const guideDots = guideAt ? [...along([[guideAt.px, guideAt.py], [guideAt.px, h]], SPACING), ...along([[0, guideAt.py], [guideAt.px, guideAt.py]], SPACING)] : [];

  // Each mark's label goes on the first side of its marker that is inside the plot and clear: right and just below, the side a rising line leaves empty, then the others.
  // The strong mark is drawn last, so it lies on top where two marks touch.
  const markPoints = (marks?.points ?? []).map((p) => ({ ...p, px: sx(p.x), py: sy(p.y) })).sort((p, q) => Number(!!p.strong) - Number(!!q.strong));
  const rings: Box[] = markPoints.map((p) => ({ x: p.px - RING_R, y: p.py - RING_R, w: 2 * RING_R, h: 2 * RING_R }));
  const markLabels: (Box & { text: string })[] = [];
  for (const p of markPoints) {
    if (!p.label) continue;
    const tw = p.label.length * glyph;
    const off = RING_R + 5;
    const sides: Box[] = [
      { x: p.px + off, y: p.py + 1, w: tw, h: fontSize },
      { x: p.px - off - tw, y: p.py - fontSize - 1, w: tw, h: fontSize },
      { x: p.px + off, y: p.py - fontSize - 1, w: tw, h: fontSize },
      { x: p.px - off - tw, y: p.py + 1, w: tw, h: fontSize },
      { x: p.px + 8, y: p.py + RING_R + 4, w: tw, h: fontSize },
      { x: p.px - 8 - tw, y: p.py - RING_R - fontSize - 4, w: tw, h: fontSize },
      { x: p.px - tw / 2, y: p.py - RING_R - fontSize - 4, w: tw, h: fontSize },
      { x: p.px - tw / 2, y: p.py + RING_R + 4, w: tw, h: fontSize },
    ];
    let best = sides[0];
    let bestCost = Infinity;
    sides.forEach((side, i) => {
      const outside = side.x < 0 || side.y < 0 || side.x + side.w > w || side.y + side.h > h;
      const taken = [...rings, ...markLabels].filter((b) => boxesMeet(grow(side, 2), b)).length;
      const cost = i + (outside ? 5000 : 0) + 400 * taken + 4 * covered(side) + 4 * covered(side, guideDots);
      if (cost < bestCost) {
        best = side;
        bestCost = cost;
      }
    });
    markLabels.push({ ...best, text: p.label });
  }

  // The shading: from the axis up to its line. Its words sit low on the plot to the right of it, moved along until they clear the lines, and are left to the legend where they cannot.
  const shadeAt = (() => {
    const line = shade ? series.find((s) => s.id === shade.under) : undefined;
    if (!shade || !line || line.points.length < 2 || w < 80) return null;
    const from = Math.max(shade.from, line.points[0].x);
    const to = Math.min(shade.to, line.points[line.points.length - 1].x);
    if (!(to > from)) return null;
    const top = [{ x: from, y: valueAt(line.points, from, xScale) ?? 0 }, ...line.points.filter((p) => p.x > from && p.x < to), { x: to, y: valueAt(line.points, to, xScale) ?? 0 }];
    const d = `M${sx(from).toFixed(1)},${h}${top.map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("")}L${sx(to).toFixed(1)},${h}Z`;
    const lineHeight = fontSize * 1.3;
    const first = sx(to) + 10 * scale;
    const chars = Math.floor((w - first) / glyph);
    let label: { lines: string[]; box: Box; lineHeight: number } | null = null;
    if (chars >= 16) {
      const lines = wrapLabel(shade.label, Math.min(chars, 56), 3);
      const tw = Math.max(...lines.map((l) => l.length)) * glyph;
      const th = lines.length * lineHeight;
      // Words that would have to be cut short are not drawn at all.
      if (lines.join(" ").length >= shade.label.trim().length) {
        for (let x = first; x + tw <= w; x += 8) {
          const box = { x, y: h - 8 * scale - th, w: tw, h: th };
          if (covered(box) === 0 && ![...rings, ...markLabels].some((b) => boxesMeet(grow(box, 2), b))) {
            label = { lines, box, lineHeight };
            break;
          }
        }
      }
    }
    return { d, x0: sx(from), x1: sx(to), color: shade.color ?? "var(--accent)", label };
  })();

  // The call-out: its words wrapped, its box, and a leader that stops short of the ring.
  const note = (() => {
    if (!callout || w < 80) return null;
    const pad = 8 * scale;
    const lineHeight = fontSize * 1.35;
    const wrap = (maxWidth: number) => {
      const chars = Math.max(8, Math.floor((maxWidth - 2 * pad) / glyph));
      const lines = [
        ...(callout.title ? wrapLabel(callout.title, chars, 2).map((text) => ({ text, bold: true })) : []),
        ...wrapLabel(callout.text, chars, 8).map((text) => ({ text, bold: false })),
      ];
      return { lines, boxW: Math.min(maxWidth, Math.max(...lines.map((l) => l.text.length)) * glyph + 2 * pad), boxH: lines.length * lineHeight + 2 * pad - (lineHeight - fontSize) };
    };
    const px = sx(callout.x);
    const py = sy(callout.y);

    if (callout.beside) {
      // Beside its point: every place on the plot is tried, in three widths of box, and the one kept is the nearest that covers
      // no line, mark or label. Where every place covers something, what is covered counts for more than the length of the leader.
      const ring = marks ? RING_R : 9;
      const taken = [...rings, ...markLabels, ...(shadeAt?.label ? [shadeAt.label.box] : [])];
      const onLines = tally(lineDots, w, h);
      const onGuide = tally(guideDots, w, h);
      let best: ({ cost: number; box: Box } & ReturnType<typeof wrap>) | null = null;
      for (const max of [300, 200, 160]) {
        const wrapped = wrap(Math.min(w, max * scale));
        if (wrapped.boxH > h) continue;
        for (const bx of stops(w - wrapped.boxW, 8)) {
          for (const by of stops(h - wrapped.boxH, 8)) {
            const reach = Math.hypot(px - clamp(px, bx, bx + wrapped.boxW), py - clamp(py, by, by + wrapped.boxH));
            if (reach < ring + 6) continue;
            // Above and to the right is preferred where two places are as near as each other.
            const near = reach - ring + (bx + wrapped.boxW / 2 < px ? 6 : 0) + (by + wrapped.boxH / 2 > py ? 6 : 0);
            if (best && near >= best.cost) continue;
            const box = { x: bx, y: by, w: wrapped.boxW, h: wrapped.boxH };
            const aired = grow(box, 3);
            let met = 0;
            for (const b of taken) if (boxesMeet(aired, b)) met++;
            const cost = near + 1.5 * SPACING * onLines(grow(box, 7)) + SPACING * onGuide(aired) + 600 * met;
            if (!best || cost < best.cost) best = { cost, box, ...wrapped };
          }
        }
      }
      if (best) {
        const { box, lines, boxW, boxH } = best;
        const fromX = px < box.x ? box.x : px > box.x + boxW ? box.x + boxW : clamp(px, box.x + 10, box.x + boxW - 10);
        const fromY = py < box.y ? box.y : py > box.y + boxH ? box.y + boxH : clamp(py, box.y + 8, box.y + boxH - 8);
        const length = Math.hypot(px - fromX, py - fromY);
        const stop = length > ring ? (length - ring) / length : 0;
        // A mark at the point has its own ring, so the call-out draws none.
        return { lines, pad, lineHeight, boxW, boxH, bx: box.x, by: box.y, px, py, ring, ringed: !marks, fromX, fromY, toX: fromX + (px - fromX) * stop, toY: fromY + (py - fromY) * stop };
      }
    }

    // Against the top of the plot, or the bottom when the point is too high to leave it room.
    const { lines, boxW, boxH } = wrap(Math.min(w, 300 * scale));
    const ring = 9;
    const above = py - ring - 12 * scale >= boxH;
    // Above the point the box reaches to the left, below it to the right: the sides a rising line leaves empty.
    const bx = Math.min(Math.max(above ? px - boxW + 28 * scale : px - 28 * scale, 0), w - boxW);
    const by = above ? 0 : h - boxH;
    const fromX = Math.min(Math.max(px, bx + 10), bx + boxW - 10);
    const fromY = above ? boxH : by;
    const length = Math.hypot(px - fromX, py - fromY);
    const stop = length > ring ? (length - ring) / length : 0;
    return { lines, pad, lineHeight, boxW, boxH, bx, by, px, py, ring, ringed: true, fromX, fromY, toX: fromX + (px - fromX) * stop, toY: fromY + (py - fromY) * stop };
  })();

  const markColor = marks?.color ?? "var(--brand)";
  const markShape = marks?.shape ?? "diamond";
  // Chart text drawn over lines keeps a rim of the surface colour, so a line behind it never runs through the letters.
  const rim = { stroke: "var(--surface)", strokeWidth: 3, strokeLinejoin: "round" as const, paintOrder: "stroke" as const };

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
        {marks && marks.points.length > 0 && (
          <span className="inline-flex items-center gap-2">
            <svg viewBox="0 0 26 26" aria-hidden className="shrink-0" style={{ width: "1.25rem", height: "1.25rem" }}>
              <circle cx={13} cy={13} r={11.5} fill="none" stroke={markColor} strokeWidth={2} />
              <Marker shape={markShape} x={13} y={13} r={6} color={markColor} />
            </svg>
            {marks.label}
          </span>
        )}
        {shade && shadeAt && (
          <span className="inline-flex items-center gap-2">
            <svg viewBox="0 0 22 12" aria-hidden className="shrink-0" style={{ width: "1.375rem", height: "0.75rem" }}>
              <rect x={1} y={0} width={20} height={10} fill={shadeAt.color} fillOpacity={0.25} />
              <line x1={1} x2={21} y1={10.5} y2={10.5} stroke={shadeAt.color} strokeWidth={3} />
            </svg>
            {shade.label}
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
                {!(guideAt && Math.abs(sy(t) - guideAt.py) < fontSize * 1.1) && <text x={-10 * scale} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={fontSize} fill="var(--muted)" className="tabular">{yFormat(t)}</text>}
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
            {shadeAt && (
              <g pointerEvents="none">
                <path d={shadeAt.d} fill={shadeAt.color} fillOpacity={0.25} />
                <line x1={shadeAt.x0} x2={shadeAt.x1} y1={h} y2={h} stroke={shadeAt.color} strokeWidth={4} />
              </g>
            )}
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

            {shadeAt?.label && (
              <g pointerEvents="none">
                {shadeAt.label.box.x - shadeAt.x1 > 14 && <line x1={shadeAt.x1 + 3} x2={shadeAt.label.box.x - 5} y1={shadeAt.label.box.y + shadeAt.label.box.h / 2} y2={shadeAt.label.box.y + shadeAt.label.box.h / 2} stroke="var(--ink-2)" strokeWidth={1} />}
                {shadeAt.label.lines.map((text, i) => (
                  <text key={i} x={shadeAt.label!.box.x} y={shadeAt.label!.box.y + fontSize * 0.85 + i * shadeAt.label!.lineHeight} fontSize={fontSize} fontWeight={600} fill="var(--ink)" {...rim}>{text}</text>
                ))}
              </g>
            )}
            {guideAt && (
              <g pointerEvents="none">
                <line x1={guideAt.px} x2={guideAt.px} y1={guideAt.py} y2={h} stroke="var(--ink-2)" strokeWidth={1.25} strokeDasharray="4 4" />
                <line x1={0} x2={guideAt.px} y1={guideAt.py} y2={guideAt.py} stroke="var(--ink-2)" strokeWidth={1.25} strokeDasharray="4 4" />
                <line x1={guideAt.px} x2={guideAt.px} y1={h} y2={h + 6} stroke="var(--ink)" strokeWidth={1.5} />
                <line x1={-6} x2={0} y1={guideAt.py} y2={guideAt.py} stroke="var(--ink)" strokeWidth={1.5} />
                <text x={guideAt.px} y={h + 20 * scale} textAnchor="middle" fontSize={fontSize} fontWeight={700} fill="var(--ink)" className="tabular">{guideAt.xText}</text>
                <text x={-10 * scale} y={guideAt.py} dy="0.32em" textAnchor="end" fontSize={fontSize} fontWeight={700} fill="var(--ink)" className="tabular">{guideAt.yText}</text>
              </g>
            )}
            {markPoints.map((p) => (
              <g key={`${p.x}:${p.y}`} pointerEvents="none">
                <circle cx={p.px} cy={p.py} r={RING_R} fill="none" stroke="var(--surface)" strokeWidth={p.strong ? 5.5 : 4.5} />
                <circle cx={p.px} cy={p.py} r={RING_R} fill="none" stroke={markColor} strokeWidth={p.strong ? 2.5 : 1.5} />
                <Marker shape={markShape} x={p.px} y={p.py} r={MARK_R} color={markColor} />
              </g>
            ))}
            {markLabels.map((l) => (
              <text key={`${l.x}:${l.y}`} x={l.x} y={l.y + fontSize * 0.85} fontSize={fontSize} fontWeight={600} fill="var(--ink)" pointerEvents="none" {...rim}>{l.text}</text>
            ))}

            {note && (
              <g pointerEvents="none">
                <line x1={note.fromX} y1={note.fromY} x2={note.toX} y2={note.toY} stroke="var(--ink)" strokeWidth={1.5} />
                {note.ringed && <circle cx={note.px} cy={note.py} r={note.ring} fill="none" stroke="var(--ink)" strokeWidth={1.5} />}
                <rect x={note.bx} y={note.by} width={note.boxW} height={note.boxH} rx={6} fill="var(--surface)" stroke="var(--ink)" strokeWidth={1} />
                {note.lines.map((l, i) => (
                  <text key={i} x={note.bx + note.pad} y={note.by + note.pad + fontSize * 0.85 + i * note.lineHeight} fontSize={fontSize} fontWeight={l.bold ? 600 : 400} fill={l.bold ? "var(--ink)" : "var(--ink-2)"}>{l.text}</text>
                ))}
              </g>
            )}

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
              <span className="inline-flex min-w-0 items-center gap-2"><Swatch s={s} />{s.short ?? s.label}</span>
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
