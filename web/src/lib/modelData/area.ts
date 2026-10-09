/**
 * What is known about each area before a manifest exists, and how a file's role is told from its
 * name and header. Used by the server to present a folder with no manifest as one version, and
 * by the tests to check what scripts/make-version.mjs wrote (the script reads areas.json itself:
 * it runs in plain Node and cannot import this file).
 *
 * areas.json holds, per area id: its name, hazard kind, the return periods per score tier (the
 * reference parameters in src/lib/model/params.ts, a test keeps the two equal) and the source
 * sentence for each file role. The map centre, zoom and extent are not in it: they are read from
 * the hazard maps themselves.
 */
import known from "./areas.json";
import { SCORE_TIERS } from "../model/types";
import type { AreaHazardKind, Extent, FileProvenance, FileRole, ModelDataArea } from "./version";

export interface KnownArea {
  name: string;
  hazardKind: AreaHazardKind;
  returnPeriodsByTier?: Record<string, number>;
  /** One sentence per file role, for the manifest's sources. */
  sources: Partial<Record<FileRole, string>>;
}

export const KNOWN_AREAS: Record<string, KnownArea> = known as Record<string, KnownArea>;

/** The first known area whose id appears in any of the paths ("team_a_nairobi/exposure.csv" says nairobi), else null. */
export function knownAreaIn(paths: readonly string[]): string | null {
  const lower = paths.map((p) => p.toLowerCase());
  return Object.keys(KNOWN_AREAS).find((id) => lower.some((p) => p.includes(id))) ?? null;
}

/** The middle of an extent, [longitude, latitude], to six decimals. */
export function extentCentre(extent: Extent): [number, number] {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return [round((extent[0] + extent[2]) / 2), round((extent[1] + extent[3]) / 2)];
}

/**
 * The zoom at which an extent fits a map `widthPx` by `heightPx` pixels, to one decimal, on the
 * Web Mercator projection with 512 px tiles as the map library uses. The default box is about what
 * the map gets on the 1366 by 768 screen the app must fit. The same arithmetic is in
 * scripts/make-version.mjs.
 */
export function fitZoom(extent: Extent, widthPx = 1000, heightPx = 600): number {
  const mercator = (lat: number) => (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
  const lonSpan = extent[2] - extent[0];
  const latSpan = mercator(extent[3]) - mercator(extent[1]);
  if (!(lonSpan > 0) || !(latSpan > 0)) return 0;
  const zoom = Math.min(Math.log2((widthPx * 360) / (512 * lonSpan)), Math.log2((heightPx * 360) / (512 * latSpan)));
  return Math.max(0, Math.min(22, Math.round(zoom * 10) / 10));
}

/** The smallest extent holding every given one, or null when there is none. */
export function unionExtent(extents: readonly Extent[]): Extent | null {
  if (extents.length === 0) return null;
  return extents.reduce((u, e) => [Math.min(u[0], e[0]), Math.min(u[1], e[1]), Math.max(u[2], e[2]), Math.max(u[3], e[3])]);
}

const TIER_IN_NAME = new RegExp(`(?:^|[^a-z])(${SCORE_TIERS.join("|")})(?:[^a-z]|$)`);
const RP_IN_NAME = /rp[_-]?(\d+)\s*y?/;

/**
 * A file's role and provenance from its name and, for a CSV, its header columns (lower case).
 * The same reading as src/lib/ingest: an exposure CSV has lat, lon and tiv_kes; a hotspots CSV
 * has name, lat and lon; a hazard raster is named by tier (a proxy score) or by return period
 * (a depth map); ward, waterway and settlement layers are real open map data.
 */
export function roleFor(name: string, csvHeader: readonly string[] = []): { role: FileRole; provenance: FileProvenance } {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base.endsWith(".tif") || base.endsWith(".tiff")) {
    if (TIER_IN_NAME.test(base)) return { role: "hazard", provenance: "proxy" };
    if (RP_IN_NAME.test(base)) return { role: "hazard", provenance: "real" };
    return { role: "other", provenance: "proxy" };
  }
  if (base.endsWith(".csv")) {
    const has = (c: string) => csvHeader.includes(c);
    if (has("lat") && has("lon") && has("tiv_kes")) return { role: "exposure", provenance: "synthetic" };
    if (has("name") && has("lat") && has("lon")) return { role: "hotspots", provenance: "real" };
    return { role: "other", provenance: "synthetic" };
  }
  if (base.endsWith(".geojson") || base.endsWith(".json")) {
    if (/ward/.test(base)) return { role: "wards", provenance: "real" };
    if (/waterway|drain|settlement/.test(base)) return { role: "drainage", provenance: "real" };
    return { role: "other", provenance: "real" };
  }
  return { role: "other", provenance: "real" };
}

/** The columns of a CSV's first line, trimmed and lower case, quotes removed. Enough to tell its role. */
export function csvColumns(firstLine: string): string[] {
  return firstLine
    .replace(/^﻿/, "")
    .split(",")
    .map((c) => c.trim().replace(/^"|"$/g, "").trim().toLowerCase());
}

/** The hazard kind the file names say: "depth" when a raster is named by return period, else "score". */
export function hazardKindOf(hazardFiles: readonly string[]): AreaHazardKind {
  return hazardFiles.some((n) => RP_IN_NAME.test(n.toLowerCase()) && !TIER_IN_NAME.test(n.toLowerCase())) ? "depth" : "score";
}

export interface AreaInput {
  name: string;
  role: FileRole;
  /** The raster's extent, when the file is one and its header gave it. */
  extent?: Extent | null;
}

/**
 * The area facts for a set of files: the known area's name, hazard kind and return periods when
 * `areaId` is known, the map centre, zoom and extent from the hazard maps, and the hotspots file.
 * With no hazard map the centre is [0, 0] at zoom 0 and the notes say the area is unknown, so a
 * screen falls back to fitting the data as it does today.
 */
export function areaFromFiles(areaId: string | null, files: readonly AreaInput[], fallbackName: string): { area: ModelDataArea; notes: string[] } {
  const knownArea = areaId ? KNOWN_AREAS[areaId] : undefined;
  const id = areaId ?? "unknown";
  const hazard = files.filter((f) => f.role === "hazard");
  const extent = unionExtent(hazard.flatMap((f) => (f.extent ? [f.extent] : [])));
  const notes: string[] = [];
  const area: ModelDataArea = {
    id,
    name: knownArea?.name ?? (areaId ? areaId[0].toUpperCase() + areaId.slice(1) : fallbackName),
    centre: extent ? extentCentre(extent) : [0, 0],
    zoom: extent ? fitZoom(extent) : 0,
    hazardKind: knownArea?.hazardKind ?? hazardKindOf(hazard.map((f) => f.name)),
  };
  if (extent) area.extent = extent;
  else notes.push("No hazard map gave an extent, so the map centre and zoom are not known: fit the map to the data.");
  if (!knownArea) notes.push(`The area "${id}" is not known to the app: its name and return periods are not set.`);
  if (knownArea?.returnPeriodsByTier && area.hazardKind === "score") area.returnPeriodsByTier = { ...knownArea.returnPeriodsByTier };
  const hotspots = files.find((f) => f.role === "hotspots");
  if (hotspots) area.hotspotsFile = hotspots.name;
  return { area, notes };
}

/** The source sentence for a file role in a known area, or undefined. */
export function sourceFor(areaId: string | null, role: FileRole): string | undefined {
  return areaId ? KNOWN_AREAS[areaId]?.sources[role] : undefined;
}
