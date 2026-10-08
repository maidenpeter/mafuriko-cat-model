"use client";

/**
 * A small map of the wards, shaded by loss in one event, with the wards that lose the most
 * outlined and numbered. Plain SVG drawn from the ward outlines: no tiles, no panning.
 *
 * How to use it (inside a ChartFrame, beside the bars it shares its numbers with):
 *   <WardMap
 *     title="Wards shaded by loss in a 1-in-100 event"   the accessible name
 *     wards={geo.wards}
 *     rows={wardRows}                                    wardAccumulation() for the event
 *     top={topWards(wardRows)}                           the numbered wards
 *     valueLabel="Ground-up loss"
 *     marker={{ lat, lon, label: "This offer" }}         optional: one point drawn over the wards, as a diamond
 *   />
 *
 * The shade is a second reading of the bars, never the only one: the numbered wards carry
 * their rank on the map and their figure in the bar chart, and pointing at any ward reads out
 * its name, its loss and its buildings under the map.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { shadeLevel, type RankedWard, type WardLoss } from "@/lib/dashboard";
import { fmtInt } from "@/lib/format";
import type { GeoCollection, Position, WardProps } from "@/lib/geo/layers";
import { geometryBBox } from "@/lib/geo/spatial";
import { kes1 } from "@/lib/labels";
import { useTextScale } from "@/lib/useDisplay";

/** Shades from least to most loss. The tokens swap in the dark theme, so more loss always stands further from the card. */
const SHADES = ["var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)"];
const NO_LOSS = "var(--surface-2)";

interface Props {
  /** What the map shows; becomes its accessible name. */
  title: string;
  wards: GeoCollection<WardProps>;
  /** One row per ward for the event on show. Rows with index -1 (outside the ward map) have no shape and are skipped. */
  rows: WardLoss[];
  /** The wards to outline and number, largest loss first. */
  top: RankedWard[];
  /** What the figure is called in the readout, for example "Ground-up loss". */
  valueLabel: string;
  format?: (value: number) => string;
  /** The tallest the map may be at the Standard text size. */
  maxHeight?: number;
  /** One point to pick out on the map, such as the building of an offer. Left off when it lies outside the ward outlines. */
  marker?: { lat: number; lon: number; label: string } | null;
}

export function WardMap({ title, wards, rows, top, valueLabel, format = kes1, maxHeight = 340, marker = null }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [active, setActive] = useState<number | null>(null);
  const scale = useTextScale();

  useEffect(() => {
    if (!wrap.current) return;
    // The map is as wide as its box, so it never pushes the page sideways.
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // The outlines in map units, worked out once per ward layer: x is longitude narrowed by the latitude, y runs down from the north edge.
  const shapes = useMemo(() => {
    const boxes = wards.features.map((f) => geometryBBox(f.geometry));
    const found = boxes.filter((b) => Number.isFinite(b[0]) && Number.isFinite(b[1]) && Number.isFinite(b[2]) && Number.isFinite(b[3]));
    if (found.length === 0) return null;
    const minLon = Math.min(...found.map((b) => b[0]));
    const minLat = Math.min(...found.map((b) => b[1]));
    const maxLon = Math.max(...found.map((b) => b[2]));
    const maxLat = Math.max(...found.map((b) => b[3]));
    const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
    const x = (lon: number) => (lon - minLon) * k;
    const y = (lat: number) => maxLat - lat;
    const items = wards.features.map((f, i) => {
      const g = f.geometry;
      const polygons: Position[][][] = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      const b = boxes[i];
      return {
        rings: polygons.flatMap((rings) => rings.map((ring) => ring.map(([lon, lat]) => [x(lon), y(lat)] as Position))),
        // The middle of the ward's own box: near enough for a rank label.
        centre: [x((b[0] + b[2]) / 2), y((b[1] + b[3]) / 2)] as Position,
      };
    });
    const inside = (lon: number, lat: number) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    return { spanX: Math.max(1e-9, (maxLon - minLon) * k), spanY: Math.max(1e-9, maxLat - minLat), items, x, y, inside };
  }, [wards]);

  const byIndex = useMemo(() => new Map(rows.filter((r) => r.index >= 0).map((r) => [r.index, r])), [rows]);

  if (!shapes) return <div ref={wrap} className="w-full text-sm text-muted">The ward outlines could not be drawn.</div>;

  const pad = 6 * scale;
  const unit = Math.min((width - 2 * pad) / shapes.spanX, (maxHeight * scale - 2 * pad) / shapes.spanY);
  const mapWidth = shapes.spanX * unit;
  const height = shapes.spanY * unit + 2 * pad;
  // When the height limit decides the size, the map sits in the middle of its box.
  const left = (width - mapWidth) / 2;
  const px = (v: number) => left + v * unit;
  const py = (v: number) => pad + v * unit;
  const pathOf = (rings: Position[][]) => rings.map((ring) => `${ring.map(([vx, vy], n) => `${n ? "L" : "M"}${px(vx).toFixed(1)},${py(vy).toFixed(1)}`).join("")}Z`).join("");

  const maxLoss = Math.max(0, ...rows.filter((r) => r.index >= 0).map((r) => r.lossKes));
  const fillOf = (index: number) => {
    const level = shadeLevel(byIndex.get(index)?.lossKes ?? 0, maxLoss, SHADES.length);
    return level === 0 ? NO_LOSS : SHADES[level - 1];
  };
  const ranked = top.filter((w) => w.index >= 0 && w.index < shapes.items.length);
  const rankOf = new Map(ranked.map((w) => [w.index, w.rank]));

  const fontSize = 12 * scale;
  const badge = 10 * scale;
  // The marked point, in pixels. null when there is none or it lies outside the ward outlines.
  const point = marker && shapes.inside(marker.lon, marker.lat) ? { x: px(shapes.x(marker.lon)), y: py(shapes.y(marker.lat)), label: marker.label } : null;
  const diamond = 8 * scale;
  const hovered = active !== null ? byIndex.get(active) : undefined;
  const describe = (r: WardLoss) => `${r.name}${r.subcounty ? `, ${r.subcounty}` : ""}: ${valueLabel} ${format(r.lossKes)}, ${fmtInt(r.flooded)} of ${fmtInt(r.buildings)} buildings flooded`;

  return (
    <div ref={wrap} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${title}. ${ranked.length > 0 ? `Most loss: ${ranked.map((w) => `${w.rank}, ${w.name}, ${format(w.lossKes)}`).join("; ")}.` : "No ward has a loss in this event."}${point ? ` The diamond marks ${point.label.toLowerCase()}.` : ""}`}
        className="block"
        onPointerLeave={() => setActive(null)}
      >
        {shapes.items.map((shape, i) => {
          const row = byIndex.get(i);
          return (
            <path key={i} d={pathOf(shape.rings)} fillRule="evenodd" fill={fillOf(i)} stroke="var(--surface)" strokeWidth={1} strokeLinejoin="round" onPointerEnter={() => setActive(i)}>
              <title>{row ? describe(row) : wards.features[i].properties.name}</title>
            </path>
          );
        })}

        {/* The outlines of the numbered wards go over the shading, so a neighbour never hides them. */}
        <g pointerEvents="none">
          {ranked.map((w) => (
            <path key={w.index} d={pathOf(shapes.items[w.index].rings)} fillRule="evenodd" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" />
          ))}
          {active !== null && shapes.items[active] && !rankOf.has(active) && (
            <path d={pathOf(shapes.items[active].rings)} fillRule="evenodd" fill="none" stroke="var(--ink-2)" strokeWidth={2} strokeDasharray="4 3" strokeLinejoin="round" />
          )}
          {/* Drawn from the last rank to the first, so where two labels meet the higher rank stays on top. */}
          {[...ranked].reverse().map((w) => {
            const [cx, cy] = shapes.items[w.index].centre;
            return (
              <g key={w.index} transform={`translate(${px(cx).toFixed(1)},${py(cy).toFixed(1)})`}>
                <circle r={badge} fill="var(--surface)" stroke="var(--ink)" strokeWidth={1.5} />
                <text textAnchor="middle" dy="0.34em" fontSize={fontSize} fontWeight={600} fill="var(--ink)" className="tabular">{w.rank}</text>
              </g>
            );
          })}
          {/* The marked point goes on last. It is a diamond, so it is told from the round rank labels by shape. */}
          {point && (
            <g transform={`translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`}>
              <path d={`M0,${-diamond}L${diamond},0L0,${diamond}L${-diamond},0Z`} fill="var(--brand)" stroke="var(--surface)" strokeWidth={2} strokeLinejoin="round" />
              <path d={`M0,${-diamond - 2}L${diamond + 2},0L0,${diamond + 2}L${-diamond - 2},0Z`} fill="none" stroke="var(--ink)" strokeWidth={1} strokeLinejoin="round" />
            </g>
          )}
        </g>
      </svg>

      {/* The readout keeps its room when nothing is pointed at, so the card does not change height. */}
      <p aria-live="polite" className="mt-2 min-h-[2.75rem] wrap-anywhere text-sm leading-snug text-ink-2">
        {hovered ? (
          <>
            <span className="font-semibold text-ink">{rankOf.has(hovered.index) ? `${rankOf.get(hovered.index)}. ` : ""}{hovered.name}</span>
            {hovered.subcounty ? `, ${hovered.subcounty}` : ""}: {valueLabel.toLowerCase()} <span className="tabular font-medium text-ink">{format(hovered.lossKes)}</span>, {fmtInt(hovered.flooded)} of {fmtInt(hovered.buildings)} buildings flooded
          </>
        ) : (
          "Point at a ward to read its loss. The numbers match the bars."
        )}
      </p>

      <ul aria-label="Legend" className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-2">
        <li className="inline-flex items-center gap-2">
          <span aria-hidden className="inline-block h-3 w-5 shrink-0 rounded-sm border border-line" style={{ background: NO_LOSS }} />
          No loss
        </li>
        <li className="inline-flex flex-wrap items-center gap-2">
          <span>Less</span>
          <span aria-hidden className="inline-flex shrink-0 overflow-hidden rounded-sm border border-line">
            {SHADES.map((shade) => <span key={shade} className="inline-block h-3 w-4" style={{ background: shade }} />)}
          </span>
          <span>More loss{maxLoss > 0 ? `, up to ${format(maxLoss)}` : ""}</span>
        </li>
        <li className="inline-flex items-center gap-2">
          <svg viewBox="0 0 22 22" aria-hidden className="shrink-0" style={{ width: "1.25rem", height: "1.25rem" }}>
            <circle cx={11} cy={11} r={9} fill="var(--surface)" stroke="var(--ink)" strokeWidth={2} />
          </svg>
          Numbered and outlined: most loss
        </li>
        {point && (
          <li className="inline-flex items-center gap-2">
            <svg viewBox="0 0 22 22" aria-hidden className="shrink-0" style={{ width: "1.25rem", height: "1.25rem" }}>
              <path d="M11,2L20,11L11,20L2,11Z" fill="var(--brand)" stroke="var(--ink)" strokeWidth={1.5} strokeLinejoin="round" />
            </svg>
            Diamond: {point.label.toLowerCase()}
          </li>
        )}
      </ul>
    </div>
  );
}
