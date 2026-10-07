import { cleanValue } from "../ingest/raster";
import type { HazardKind, Raster } from "../model/types";

export type RGB = [number, number, number];

/** Depth classes on the map, in metres: up to 0.25, 0.5, 1, 2, and deeper than 2. */
export const DEPTH_BREAKS_M = [0.25, 0.5, 1, 2];
export const DEPTH_LABELS = ["Up to 0.25 m", "0.25 to 0.5 m", "0.5 to 1 m", "1 to 2 m", "Over 2 m"];

export function depthClass(depthM: number): number {
  if (!(depthM > 0)) return -1;
  const i = DEPTH_BREAKS_M.findIndex((b) => depthM <= b);
  return i === -1 ? DEPTH_BREAKS_M.length : i;
}

/** Reads a colour token (hex or rgb()) from the page so the map follows the theme. */
export function cssColor(name: string, fallback: RGB = [0, 0, 0]): RGB {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((o) => parseInt(hex[1].slice(o, o + 2), 16)) as RGB;
  const rgb = raw.match(/rgba?\(([^)]+)\)/i);
  if (rgb) return rgb[1].split(",").slice(0, 3).map((v) => Number(v.trim())) as RGB;
  return fallback;
}

export const rgbCss = ([r, g, b]: RGB, a = 1) => (a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`);

/**
 * Paints one hazard map as a transparent PNG: dry cells clear, wet cells coloured by the
 * depth class the model would use there. Returns an object URL for a map image source.
 */
export async function hazardImageUrl(raster: Raster, kind: HazardKind, toDepth: (value: number) => number, ramp: RGB[], alpha = 210): Promise<string> {
  const { width, height, data } = raster;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  const image = ctx.createImageData(width, height);
  const px = image.data;
  for (let i = 0; i < data.length; i++) {
    const value = cleanValue(data[i], raster, kind);
    if (!(value > 0)) continue;
    const c = ramp[Math.min(ramp.length - 1, depthClass(toDepth(value)))];
    const o = i * 4;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
    px[o + 3] = alpha;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not draw the hazard map");
  return URL.createObjectURL(blob);
}

/** Corner coordinates for a raster laid on the map: top-left, top-right, bottom-right, bottom-left. */
export function rasterCorners([minLon, minLat, maxLon, maxLat]: [number, number, number, number]): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [minLon, maxLat],
    [maxLon, maxLat],
    [maxLon, minLat],
    [minLon, minLat],
  ];
}
