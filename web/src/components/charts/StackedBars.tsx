"use client";

/**
 * Stacked bars, and the one look of the six loss drivers wherever they are drawn.
 *
 * How to use it:
 *   <ChartFrame title="Loss by driver" subtitle="..." sources={[...]}>
 *     <StackedBars
 *       title="Loss by driver"
 *       yLabel="Loss from one event, ground-up (KES)"
 *       series={driverSeries(drivers.lines)}
 *       markerLabel="Gross loss"
 *       columns={rows.map((r) => ({ key: r.id, label: "1-in-100", title: "1-in-100 flood", parts: r.groundUpKes, marker: r.grossKes }))}
 *     />
 *   </ChartFrame>
 *
 * StackedBars draws its own legend, so do not pass one to the ChartFrame. StackStrip is one loss as
 * a single horizontal strip with the amounts written under it, for a small space.
 *
 * DRIVER_LOOK is the colour and pattern of each driver, keyed by driver id. driverSeries gives the
 * bands of an offer: the drivers that take part in the price, each under the name its line carries
 * (its `label`), so a driver that is off is never drawn or listed. PORTFOLIO_SERIES is the four
 * parts the portfolio's loss is split into, with one set of names. Take a driver's look and name
 * from here and nowhere else, so it is the same on every screen. DriverSwatch is a driver's look
 * in small, for a table heading or a list.
 */

import { useEffect, useId, useRef, useState } from "react";
import { axisTicks, kes1 } from "@/lib/labels";
import { DRIVER_LABELS, type DriverId, type DriverLine } from "@/lib/offer/drivers";
import { useTextScale } from "@/lib/useDisplay";

/** How a band is filled. Each differs by pattern as well as by colour, so the bands read apart in grey. */
export type StackFill = "solid" | "hatch" | "backhatch" | "dots" | "bars" | "cross" | "outline";

/** A band's colour (always a token such as var(--series-1)) and its pattern. */
export interface StackLook {
  color: string;
  fill: StackFill;
}

export interface StackSeries extends StackLook {
  id: string;
  /** The band's name in the legend and the tooltip. */
  label: string;
}

export interface StackColumn {
  key: string;
  /** Under the bar: "1-in-100". */
  label: string;
  /** A second line under the bar: "1% a year". */
  sub?: string;
  /** The tooltip's heading: "1-in-100 (1% a year) flood". */
  title: string;
  /** The size of each band, by series id. A band that is missing or not above zero is not drawn. */
  parts: Partial<Record<string, number>>;
  /** The bar's total as the engine gives it, written above the bar. Left out, it is the sum of the bands. */
  total?: number;
  /** A level marked across the bar, such as the gross loss. */
  marker?: number | null;
  /** More lines for the tooltip, already written out. */
  extra?: { label: string; value: string }[];
}

/** The six loss drivers, each with its own colour and its own pattern. */
export const DRIVER_LOOK: Record<DriverId, StackLook> = {
  surrounding: { color: "var(--series-1)", fill: "solid" },
  ponding: { color: "var(--series-3)", fill: "hatch" },
  overload: { color: "var(--series-4)", fill: "dots" },
  basement: { color: "var(--series-2)", fill: "bars" },
  interruption: { color: "var(--accent)", fill: "cross" },
  uncertainty: { color: "var(--ink-2)", fill: "outline" },
};

/**
 * The drivers that take part in the price as the bands of a stacked bar, in the order they are
 * added up. Each band carries the name its line carries, so with Depth only the first is "Depth
 * at the point", and a driver that is off is neither drawn nor listed.
 */
export function driverSeries(lines: readonly DriverLine[]): (StackSeries & { id: DriverId })[] {
  return lines.filter((line) => line.on).map((line) => ({ id: line.id, label: line.label, ...DRIVER_LOOK[line.id] }));
}

/** The four parts of the portfolio's loss, in the order they are added up. */
export type PortfolioPartId = "point" | "surrounding" | "ponding" | "overload";

/**
 * The portfolio's loss is split four ways: Surrounding flooding in its two parts (the depth at the
 * point, then what the buffer adds), then ponding and drain overload. Each part carries its
 * driver's colour; the two parts of Surrounding flooding differ by pattern.
 */
export const PORTFOLIO_PART_LOOK: Record<PortfolioPartId, StackLook> = {
  point: DRIVER_LOOK.surrounding,
  surrounding: { color: DRIVER_LOOK.surrounding.color, fill: "backhatch" },
  ponding: DRIVER_LOOK.ponding,
  overload: DRIVER_LOOK.overload,
};

/**
 * The four parts of the portfolio's loss as bands, with the one set of names every screen uses:
 * `label` in a legend or tooltip, `column` as a table heading, `key` the field of a scenario's
 * `byDriver` that holds the amount.
 */
export const PORTFOLIO_SERIES: (StackSeries & { id: PortfolioPartId; column: string; key: "pointKes" | "surroundingKes" | "pondingKes" | "overloadKes" })[] = [
  { id: "point", key: "pointKes", label: "Depth at the point", column: "Depth at the point", ...PORTFOLIO_PART_LOOK.point },
  { id: "surrounding", key: "surroundingKes", label: "Added by water within the buffer", column: "Added within the buffer", ...PORTFOLIO_PART_LOOK.surrounding },
  { id: "ponding", key: "pondingKes", label: `Added by ${DRIVER_LABELS.ponding.toLowerCase()}`, column: "Added by ponding", ...PORTFOLIO_PART_LOOK.ponding },
  { id: "overload", key: "overloadKes", label: `Added by ${DRIVER_LABELS.overload.toLowerCase()}`, column: "Added by drain overload", ...PORTFOLIO_PART_LOOK.overload },
];

/** A React id made safe to use inside url(#...) in SVG. */
const safeId = (raw: string) => raw.replace(/[^a-zA-Z0-9_-]/g, "");

/** The pattern of one band. Put it inside <defs>; solid and outline bands need none. */
function StackPattern({ id, look, size }: { id: string; look: StackLook; size: number }) {
  const { fill, color } = look;
  if (fill === "solid" || fill === "outline") return null;
  const turn = fill === "hatch" ? "rotate(45)" : fill === "backhatch" ? "rotate(-45)" : undefined;
  return (
    <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse" patternTransform={turn}>
      <rect width={size} height={size} fill="var(--surface)" />
      {(fill === "hatch" || fill === "backhatch") && <line x1={0} y1={0} x2={0} y2={size} stroke={color} strokeWidth={size * 0.55} />}
      {(fill === "bars" || fill === "cross") && <line x1={0} y1={size / 2} x2={size} y2={size / 2} stroke={color} strokeWidth={size * 0.3} />}
      {fill === "cross" && <line x1={size / 2} y1={0} x2={size / 2} y2={size} stroke={color} strokeWidth={size * 0.3} />}
      {fill === "dots" && <circle cx={size / 2} cy={size / 2} r={size * 0.26} fill={color} />}
    </pattern>
  );
}

const bandFill = (look: StackLook, patternId: string) => (look.fill === "solid" ? look.color : look.fill === "outline" ? "var(--surface)" : `url(#${patternId})`);

/** One band as it is drawn, in small, for a legend, a tooltip or a table heading. Sized in rem, so it grows with the text. */
export function StackSwatch({ color, fill }: StackLook) {
  const id = `stack-swatch-${safeId(useId())}`;
  return (
    <svg viewBox="0 0 22 12" aria-hidden className="shrink-0" style={{ width: "1.375rem", height: "0.75rem" }}>
      <defs>
        <StackPattern id={id} look={{ color, fill }} size={4} />
      </defs>
      <rect x={1} y={1} width={20} height={10} rx={2} fill={bandFill({ color, fill }, id)} stroke={color} strokeWidth={1.5} strokeDasharray={fill === "outline" ? "3 2" : undefined} />
    </svg>
  );
}

/** A loss driver as it is drawn in every chart, in small. */
export const DriverSwatch = ({ id }: { id: DriverId }) => <StackSwatch {...DRIVER_LOOK[id]} />;

/** The mark across a bar, in small: a line with a diamond on it. */
function MarkerSwatch() {
  return (
    <svg viewBox="0 0 22 12" aria-hidden className="shrink-0" style={{ width: "1.375rem", height: "0.75rem" }}>
      <line x1={1} x2={21} y1={6} y2={6} stroke="var(--ink)" strokeWidth={2.5} />
      <path d="M11 1.5l4.5 4.5-4.5 4.5L6.5 6z" fill="var(--surface)" stroke="var(--ink)" strokeWidth={1.75} strokeLinejoin="round" />
    </svg>
  );
}

/** The legend of a stacked bar: every band with its pattern, then the mark across the bar. */
function StackLegend({ series, markerLabel, className = "" }: { series: StackSeries[]; markerLabel?: string; className?: string }) {
  return (
    <ul aria-label="Legend" className={`flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2 ${className}`}>
      {series.map((s) => (
        <li key={s.id} className="inline-flex min-w-0 items-center gap-2">
          <StackSwatch color={s.color} fill={s.fill} />
          <span className="min-w-0 wrap-anywhere">{s.label}</span>
        </li>
      ))}
      {markerLabel && (
        <li className="inline-flex min-w-0 items-center gap-2">
          <MarkerSwatch />
          <span className="min-w-0 wrap-anywhere">{markerLabel}</span>
        </li>
      )}
    </ul>
  );
}

/**
 * One loss as a single stacked strip, with every band's name and amount written under it, so nothing
 * rests on hovering. For a small space such as the dashboard; StackedBars is the full chart.
 */
export function StackStrip({
  title,
  parts,
  series,
  format = kes1,
}: {
  /** What the strip shows; becomes its accessible name. */
  title: string;
  /** The bands in order: share is each one's part of the whole, 0 to 1. */
  parts: { id: string; label: string; kes: number; share: number }[];
  series: StackSeries[];
  format?: (value: number) => string;
}) {
  const base = `strip-${safeId(useId())}`;
  const rows = parts.flatMap((part) => {
    const band = series.find((x) => x.id === part.id);
    return band ? [{ part, band }] : [];
  });
  const drawn = rows.filter(({ part }) => part.kes > 0);
  return (
    <div className="min-w-0">
      <div role="img" aria-label={`${title}. ${parts.map((part) => `${part.label} ${format(part.kes)}`).join(", ")}`} className="flex h-6 w-full overflow-hidden rounded-md border border-axis bg-surface">
        {drawn.map(({ part, band }) => (
          <div key={part.id} className="h-full min-w-1" style={{ flex: `${part.share} 1 0%` }}>
            <svg aria-hidden className="block h-full w-full">
              <defs>
                <StackPattern id={`${base}-${safeId(part.id)}`} look={band} size={7} />
              </defs>
              <rect width="100%" height="100%" fill={bandFill(band, `${base}-${safeId(part.id)}`)} stroke={band.color} strokeWidth={2} strokeDasharray={band.fill === "outline" ? "4 3" : undefined} />
            </svg>
          </div>
        ))}
      </div>
      <ul aria-label="Legend, with each amount" className="mt-2 grid gap-x-6 gap-y-1 text-sm grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))]">
        {rows.map(({ part, band }) => (
          <li key={part.id} className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="inline-flex min-w-0 items-center gap-2 text-ink-2">
              <StackSwatch color={band.color} fill={band.fill} />
              <span className="min-w-0 wrap-anywhere">{part.label}</span>
            </span>
            <span className={`tabular whitespace-nowrap ${part.kes > 0 ? "font-semibold text-ink" : "text-muted"}`}>{format(part.kes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** An amount that can be drawn: a missing, negative or non-finite one counts as nothing. */
const amount = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Stacked bars, drawn by hand in SVG like the other charts. Use it inside a ChartFrame, which gives
 * the title, the line on how to read it and the sources. It draws its own legend, with each band's
 * pattern, writes each bar's total above it, and lists every band with its value in the tooltip.
 * Each bar takes keyboard focus and shows the same tooltip as on hover.
 * In a card too narrow for the bars the plot scrolls sideways inside its own box; the page never does.
 */
export function StackedBars({
  title,
  columns,
  series,
  yLabel,
  xLabel,
  format = kes1,
  totalLabel = "Total",
  markerLabel,
  height = 300,
}: {
  /** What the chart shows; becomes its accessible name. */
  title: string;
  columns: StackColumn[];
  /** The bands, in the order they are stacked from the bottom up. */
  series: StackSeries[];
  /** Axis title with units. */
  yLabel: string;
  /** What the columns are, written under the plot. */
  xLabel?: string;
  /** How a value is written, units included, on the axis, above a bar and in the tooltip. */
  format?: (value: number) => string;
  /** What a bar's full height is called in the tooltip. */
  totalLabel?: string;
  /** What the mark across a bar is called. Left out, no mark is drawn. */
  markerLabel?: string;
  /** Height of the plot area at the Standard text size. */
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const scale = useTextScale();
  const patternBase = `stack-${safeId(useId())}`;

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  if (columns.length === 0) return <div ref={wrap} className="w-full text-sm text-muted">Nothing to show yet.</div>;

  const bars = columns.map((column) => {
    let level = 0;
    const bands = series.map((s) => {
      const size = amount(column.parts[s.id]);
      const lo = level;
      level += size;
      return { series: s, size, lo, hi: level };
    });
    const marker = markerLabel && typeof column.marker === "number" && Number.isFinite(column.marker) ? Math.max(0, column.marker) : null;
    // `top` is where the bands end; `total` is the figure written, the engine's own when it is given.
    return { column, bands, top: level, total: column.total ?? level, marker };
  });

  // SVG labels and the room around the plot are sized in pixels, so both are multiplied up to follow the text size.
  const fontSize = 12 * scale;
  const charWidth = fontSize * 0.58;
  const lineHeight = fontSize * 1.3;

  const yTicks = axisTicks(Math.max(1e-9, ...bars.map((b) => Math.max(b.top, amount(b.total), b.marker ?? 0))));
  const yTop = yTicks[yTicks.length - 1];
  const left = Math.max(...yTicks.map((t) => format(t).length)) * charWidth + 14 * scale;
  const right = 20 * scale;

  // A bar needs room for its total above and its name below. Past that the plot scrolls inside its own box.
  const minBand = Math.max(64 * scale, Math.max(...bars.map((b) => Math.max(format(b.total).length, b.column.label.length, b.column.sub?.length ?? 0))) * charWidth + 8 * scale);
  const inner = Math.max(width, left + right + bars.length * minBand);
  const w = inner - left - right;
  const band = w / bars.length;
  const barWidth = Math.min(band * 0.62, 104 * scale);
  const m = { top: fontSize + 12 * scale, bottom: (bars.some((b) => b.column.sub) ? 2 : 1) * lineHeight + 12 * scale };
  const h = height;
  const sy = (v: number) => h - (v / yTop) * h;
  const cx = (i: number) => i * band + band / 2;

  const describe = (b: (typeof bars)[number]) =>
    `${b.column.title}: ${totalLabel.toLowerCase()} ${format(b.total)}${b.bands.filter((x) => x.size > 0).map((x) => `, ${x.series.label} ${format(x.size)}`).join("")}${b.marker !== null && markerLabel ? `, ${markerLabel.toLowerCase()} ${format(b.marker)}` : ""}`;
  const hovered = active !== null && active < bars.length ? bars[active] : null;

  return (
    <div ref={wrap} className="w-full">
      <StackLegend series={series} markerLabel={markerLabel} className="mb-2" />
      {/* The axis title is page text, not SVG text, so it wraps above a narrow plot instead of being clipped. */}
      <div className="mb-1 text-xs text-ink-2">{yLabel}</div>

      <div className="overflow-x-auto">
        <div className="relative" style={{ width: inner }}>
          <svg width={inner} height={m.top + h + m.bottom} role="img" aria-label={`${title}. ${bars.map(describe).join(". ")}`} className="block" onPointerLeave={() => setActive(null)}>
            <defs>
              {series.map((s) => (
                <StackPattern key={s.id} id={`${patternBase}-${safeId(s.id)}`} look={s} size={7 * scale} />
              ))}
            </defs>
            <g transform={`translate(${left},${m.top})`}>
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={0} x2={w} y1={sy(t)} y2={sy(t)} stroke={t === 0 ? "var(--axis)" : "var(--line)"} strokeWidth={1} />
                  <text x={-10 * scale} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={fontSize} fill="var(--muted)" className="tabular">{format(t)}</text>
                </g>
              ))}

              {bars.map((b, i) => {
                const x = cx(i) - barWidth / 2;
                return (
                  <g
                    key={b.column.key}
                    tabIndex={0}
                    role="img"
                    aria-label={describe(b)}
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive((a) => (a === i ? null : a))}
                  >
                    {/* The whole column, name included, is the hover and focus target. */}
                    <rect x={i * band} y={-m.top} width={band} height={m.top + h + m.bottom} fill={active === i ? "var(--surface-2)" : "transparent"} opacity={0.6} />
                    {/* A bar with no loss still shows a hairline on the axis, so it does not vanish from the row. */}
                    {b.top <= 0 && <rect x={x} y={h - 1.5} width={barWidth} height={1.5} fill="var(--axis)" />}
                    {b.bands
                      .filter((x2) => x2.size > 0)
                      .map((x2) => (
                        <rect
                          key={x2.series.id}
                          x={x}
                          y={sy(x2.hi)}
                          width={barWidth}
                          height={Math.max(sy(x2.lo) - sy(x2.hi), 1)}
                          fill={bandFill(x2.series, `${patternBase}-${safeId(x2.series.id)}`)}
                          stroke={x2.series.color}
                          strokeWidth={1.5}
                          strokeDasharray={x2.series.fill === "outline" ? "4 3" : undefined}
                        />
                      ))}
                    {b.marker !== null && b.top > 0 && (
                      <g>
                        <line x1={x - 6 * scale} x2={x + barWidth + 6 * scale} y1={sy(b.marker)} y2={sy(b.marker)} stroke="var(--surface)" strokeWidth={5} />
                        <line x1={x - 6 * scale} x2={x + barWidth + 6 * scale} y1={sy(b.marker)} y2={sy(b.marker)} stroke="var(--ink)" strokeWidth={2.5} />
                        <path
                          d={`M${cx(i)} ${sy(b.marker) - 5 * scale}l${5 * scale} ${5 * scale}-${5 * scale} ${5 * scale}-${5 * scale}-${5 * scale}z`}
                          fill="var(--surface)"
                          stroke="var(--ink)"
                          strokeWidth={1.75}
                          strokeLinejoin="round"
                        />
                      </g>
                    )}
                    <text x={cx(i)} y={sy(Math.max(b.top, b.marker ?? 0)) - 7 * scale} textAnchor="middle" fontSize={fontSize} fontWeight={600} fill="var(--ink)" className="tabular">{format(b.total)}</text>
                    <text x={cx(i)} y={h + 8 * scale + 0.75 * lineHeight} textAnchor="middle" fontSize={fontSize} fill="var(--ink)" className="tabular">{b.column.label}</text>
                    {b.column.sub && <text x={cx(i)} y={h + 8 * scale + 1.75 * lineHeight} textAnchor="middle" fontSize={fontSize} fill="var(--muted)" className="tabular">{b.column.sub}</text>}
                  </g>
                );
              })}
            </g>
          </svg>

          {hovered && active !== null && (
            // 20.625rem is the tooltip's width (w-80) plus a small gap, so it stops short of the right edge at every text size.
            <div
              className="pointer-events-none absolute z-10 w-80 max-w-full rounded-xl border border-line bg-surface p-3 text-sm shadow-lg"
              style={{ top: m.top, left: `clamp(0px, ${(left + cx(active) + barWidth / 2 + 12).toFixed(1)}px, calc(100% - 20.625rem))` }}
            >
              <div className="mb-1.5 wrap-anywhere font-semibold text-ink">{hovered.column.title}</div>
              {hovered.bands.map((x) => (
                <div key={x.series.id} className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <StackSwatch color={x.series.color} fill={x.series.fill} />
                    <span className="min-w-0 wrap-anywhere">{x.series.label}</span>
                  </span>
                  <span className="tabular whitespace-nowrap font-medium text-ink">{format(x.size)}</span>
                </div>
              ))}
              <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-line pt-1.5 text-ink">
                <span className="font-semibold">{totalLabel}</span>
                <span className="tabular whitespace-nowrap font-semibold">{format(hovered.total)}</span>
              </div>
              {hovered.marker !== null && markerLabel && (
                <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink">
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <MarkerSwatch />
                    <span className="min-w-0 wrap-anywhere font-semibold">{markerLabel}</span>
                  </span>
                  <span className="tabular whitespace-nowrap font-semibold">{format(hovered.marker)}</span>
                </div>
              )}
              {hovered.column.extra?.map((line) => (
                <div key={line.label} className="flex items-baseline justify-between gap-3 py-0.5 text-xs text-ink-2">
                  <span className="min-w-0 wrap-anywhere">{line.label}</span>
                  <span className="tabular whitespace-nowrap">{line.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {xLabel && <div className="mt-1 text-center text-xs text-ink-2">{xLabel}</div>}
    </div>
  );
}
