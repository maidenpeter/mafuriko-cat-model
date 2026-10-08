"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtKes, fmtNum } from "@/lib/format";
import type { HotspotHit } from "@/lib/model/hotspots";
import { HOUSING_LABELS, type Dataset, type Raster } from "@/lib/model/types";
import { useTheme } from "@/lib/useDisplay";

const RAMP_VARS = ["--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5"];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

/** The area the map draws: the hazard grid's own, or the buildings with a small margin when there is no grid. */
function mapBbox(raster: Raster | null, buildings: Dataset["buildings"]): Raster["bbox"] {
  if (raster) return raster.bbox;
  const lons = buildings.map((b) => b.lon);
  const lats = buildings.map((b) => b.lat);
  const pad = 0.01;
  return [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
}

/** Width of the drawn map divided by its height. The step uses it to give the map a column it fills without growing taller than the screen. */
export function hazardMapRatio(dataset: Dataset, scenarioIndex: number): number {
  const id = dataset.scenarios[scenarioIndex].id;
  const bbox = mapBbox(dataset.rasters.find((r) => r.scenarioId === id) ?? null, dataset.buildings);
  return (bbox[2] - bbox[0]) / (bbox[3] - bbox[1]);
}

export function HazardMap({ dataset, scenarioIndex, hits }: { dataset: Dataset; scenarioIndex: number; hits: HotspotHit[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(720);
  const [tip, setTip] = useState<Tip | null>(null);
  const theme = useTheme();

  const scenario = dataset.scenarios[scenarioIndex];
  const raster = dataset.rasters.find((r) => r.scenarioId === scenario.id) ?? null;
  const isScore = dataset.hazardKind === "score";

  const bbox = useMemo(() => mapBbox(raster, dataset.buildings), [raster, dataset.buildings]);

  const height = Math.round(width * ((bbox[3] - bbox[1]) / (bbox[2] - bbox[0])));
  // Colour scale top: scores run 0 to 1; depths are scaled to the deepest cell, capped so one extreme cell does not wash out the map.
  const scaleMax = useMemo(() => {
    if (isScore || !raster) return 1;
    let max = 0;
    for (let i = 0; i < raster.data.length; i++) {
      const v = raster.data[i];
      if (v > max && v < 1e6) max = v;
    }
    return Math.min(max, 5) || 1;
  }, [raster, isScore]);

  useEffect(() => {
    if (!wrap.current) return;
    // The map is as wide as its card, so nothing at its right edge is hidden on a narrow screen.
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(Math.max(240, e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!raster) return;

    const styles = getComputedStyle(document.documentElement);
    const stops = RAMP_VARS.map((v) => hexToRgb(styles.getPropertyValue(v)));

    // Each canvas pixel takes the highest cell that falls in it, so thin river channels survive downsampling.
    const peak = new Float32Array(c.width * c.height);
    for (let row = 0; row < raster.height; row++) {
      const py = Math.min(c.height - 1, Math.floor((row / raster.height) * c.height));
      for (let col = 0; col < raster.width; col++) {
        const v = raster.data[row * raster.width + col];
        if (!(v > 0) || v > 1e6) continue;
        const i = py * c.width + Math.min(c.width - 1, Math.floor((col / raster.width) * c.width));
        if (v > peak[i]) peak[i] = v;
      }
    }

    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < peak.length; i++) {
      if (peak[i] <= 0) continue;
      const t = Math.min(1, peak[i] / scaleMax) * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(t));
      const f = t - k;
      img.data[i * 4] = stops[k][0] + f * (stops[k + 1][0] - stops[k][0]);
      img.data[i * 4 + 1] = stops[k][1] + f * (stops[k + 1][1] - stops[k][1]);
      img.data[i * 4 + 2] = stops[k][2] + f * (stops[k + 1][2] - stops[k][2]);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // The ramp colours are read from the page, so the canvas is painted again when the theme changes.
  }, [raster, width, height, scaleMax, theme]);

  const px = (lon: number) => ((lon - bbox[0]) / (bbox[2] - bbox[0])) * width;
  const py = (lat: number) => ((bbox[3] - lat) / (bbox[3] - bbox[1])) * height;
  const unit = isScore ? "" : " m";

  const dry = dataset.buildings.filter((b) => !(b.hazard[scenarioIndex] > 0));
  const wet = dataset.buildings.filter((b) => b.hazard[scenarioIndex] > 0);

  return (
    <div>
      <div ref={wrap} className="relative w-full overflow-hidden rounded-xl border border-line bg-surface-2" style={{ height }}>
        <canvas ref={canvas} width={width} height={height} className="absolute inset-0" />
        <svg width={width} height={height} className="absolute inset-0" onPointerLeave={() => setTip(null)}>
          {dry.map((b) => (
            <circle key={b.locId} cx={px(b.lon)} cy={py(b.lat)} r={2} fill="var(--muted)" opacity={0.7} />
          ))}
          {wet.map((b) => (
            <circle
              key={b.locId}
              cx={px(b.lon)}
              cy={py(b.lat)}
              r={4.5}
              fill="var(--series-2)"
              stroke="var(--surface)"
              strokeWidth={1.5}
              onPointerEnter={() =>
                setTip({
                  x: px(b.lon),
                  y: py(b.lat),
                  title: b.locId,
                  lines: [HOUSING_LABELS[b.housingClass], `Insured value ${fmtKes(b.tivKes)}`, `${isScore ? "Score" : "Depth"} ${fmtNum(b.hazard[scenarioIndex], 3)}${unit}`],
                })
              }
            />
          ))}
          {hits.map((h) => (
            <g
              key={h.name}
              transform={`translate(${px(h.lon)},${py(h.lat)})`}
              onPointerEnter={() => setTip({ x: px(h.lon), y: py(h.lat), title: h.name, lines: [h.hit ? `Flagged by the hazard layer (${fmtNum(h.value, 3)}${unit})` : "Not flagged by the hazard layer"] })}
            >
              <circle r={8} fill={h.hit ? "var(--good)" : "var(--critical)"} stroke="var(--surface)" strokeWidth={2} />
              {h.hit ? (
                <path d="M-3.4 0.2l2.3 2.3 4.4-4.8" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M-2.8-2.8l5.6 5.6M2.8-2.8l-5.6 5.6" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />
              )}
            </g>
          ))}
        </svg>
        {tip && (
          // Offsets are in rem so they follow the text size: 14.5rem is the tooltip's width (w-56) plus a small gap.
          // In the lower half it is placed from the bottom, so a tall tooltip is not cut off by the map's edge.
          <div
            className="pointer-events-none absolute z-10 w-56 max-w-[calc(100%-0.5rem)] rounded-xl border border-line bg-surface p-2.5 text-sm shadow-lg"
            style={{
              left: `clamp(0.25rem, ${(tip.x + 12).toFixed(1)}px, calc(100% - 14.5rem))`,
              ...(tip.y > height / 2 ? { bottom: `max(0.25rem, calc(${(height - tip.y).toFixed(1)}px - 2rem))` } : { top: `max(0.25rem, calc(${tip.y.toFixed(1)}px - 4.375rem))` }),
            }}
          >
            <div className="font-semibold text-ink">{tip.title}</div>
            {tip.lines.map((l) => <div key={l} className="text-ink-2">{l}</div>)}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-2">
        {raster && (
          <span className="inline-flex items-center gap-2">
            <span className="tabular">0</span>
            <span className="inline-block h-2.5 w-24 shrink-0 rounded-full" style={{ background: `linear-gradient(to right, ${RAMP_VARS.map((v) => `var(${v})`).join(",")})` }} />
            <span className="tabular">{isScore ? "1.0 score" : `${fmtNum(scaleMax, 1)} m or deeper`}</span>
          </span>
        )}
        <span className="inline-flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: "var(--series-2)" }} />Building affected ({wet.length})</span>
        <span className="inline-flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--muted)" }} />Not affected ({dry.length})</span>
        {hits.length > 0 && (
          <>
            <span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: "var(--good)" }} />Known flood area, flagged ({hits.filter((h) => h.hit).length})</span>
            <span className="inline-flex items-center gap-2"><span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: "var(--critical)" }} />Known flood area, missed ({hits.filter((h) => !h.hit).length})</span>
          </>
        )}
      </div>
    </div>
  );
}
