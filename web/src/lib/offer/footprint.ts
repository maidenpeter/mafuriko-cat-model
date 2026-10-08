import type { Position } from "../geo/layers";
import { geometryContains } from "../geo/spatial";

/**
 * The outline of the building at an offer's coordinates, from OpenStreetMap.
 *
 * WHAT LEAVES THE BROWSER: the latitude, the longitude and the search radius, and nothing else.
 * No name, no value and no word of the document is sent. They are still the coordinates of an
 * insured building, and they go to a public server run by volunteers (overpass-api.de, and one
 * public mirror if the first fails), so the screen should say so next to the outline.
 *
 * How to use it, from a client component:
 *
 *   const outline = await findFootprint(lat, lon, { signal });
 *   if (outline.found) draw outline.polygon and show outline.label
 *   else               draw a marker at the point and show outline.reason
 *
 * findFootprint never throws and never rejects. Draw the marker straight away and add the outline
 * when it arrives: the lookup can take the whole timeout, twice over when the mirror is tried.
 * Pass an AbortSignal and abort it when the point changes or the screen goes away.
 *
 * OpenStreetMap data is open under the ODbL licence and must be credited where it is shown:
 * OSM_CREDIT holds the wording.
 *
 * The pure parts (buildFootprintQuery, footprintsFromOverpass, nearestFootprint and the distance
 * helpers) are exported so they can be tested and reused without the network.
 */

/** Shown, word for word, with every outline. */
export const FOOTPRINT_LABEL = "Footprint from OpenStreetMap, nearest to the stated coordinates";

/** The credit OpenStreetMap asks for wherever its data is shown. */
export const OSM_CREDIT = "© OpenStreetMap contributors";

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
/** A second public server with the same data, tried once when the first fails. */
export const OVERPASS_MIRROR_URL = "https://overpass.private.coffee/api/interpreter";

export const FOOTPRINT_RADIUS_M = 30;
export const FOOTPRINT_TIMEOUT_MS = 8000;

// Metres per degree, the same figures locate.ts and the drainage grid use, so distances agree across the app.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320;

/** A GeoJSON Polygon: [lon, lat] order, every ring closed, the outer ring first and any courtyards after it. */
export interface FootprintPolygon {
  type: "Polygon";
  coordinates: Position[][];
}

/** One building outline as OpenStreetMap holds it. */
export interface FootprintCandidate {
  polygon: FootprintPolygon;
  /** "way/123456" or "relation/123456": the address of the outline on openstreetmap.org. */
  osmId: string;
  /** The building's name tag. null when it has none, which is usual. */
  name: string | null;
  /** The number of floors above ground, from the building:levels tag. null when it is not recorded. */
  levels: number | null;
}

export interface FootprintFound extends FootprintCandidate {
  found: true;
  /** 0 when the point is inside the outline, otherwise metres from the point to its nearest wall. */
  distanceM: number;
  /** The page for this outline on openstreetmap.org, for a "view source" link. */
  osmUrl: string;
  label: typeof FOOTPRINT_LABEL;
}

/**
 * Why there is no outline.
 *   none       the lookup answered and there is no building in reach
 *   timeout    no answer in time
 *   failed     the server could not be reached, refused, or sent something unreadable
 *   invalid    the coordinates are not a latitude and longitude; nothing was sent
 *   cancelled  the caller's own signal was aborted
 */
export type FootprintCause = "none" | "timeout" | "failed" | "invalid" | "cancelled";

export interface FootprintMissing {
  found: false;
  cause: FootprintCause;
  /** A plain sentence the screen can show as it is. */
  reason: string;
}

export type Footprint = FootprintFound | FootprintMissing;

export interface FootprintOptions {
  /** Where the query is posted. Exists so tests can point the lookup at a local stand-in. */
  endpoint?: string;
  /**
   * Tried once when the first endpoint fails or does not answer. Defaults to the public mirror
   * when the endpoint is left at its default, and to none when an endpoint is given. null turns it off.
   */
  mirror?: string | null;
  /** How long to wait for each server, in milliseconds. */
  timeoutMs?: number;
  /** How far from the point a building may be, in metres. */
  radiusM?: number;
  /** Abort it to drop the lookup, for example when the point changes. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------------------------

/** A number as plain digits: Overpass does not read "1e-7". */
const plain = (value: number) => value.toFixed(7).replace(/\.?0+$/, "");

const validPoint = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/**
 * The Overpass QL sent for one point. It asks for building outlines (plain ways, and
 * multipolygon relations for buildings with courtyards) with a wall within the radius, and for
 * any building whose area the point is in. The second part matters for a large building: a point
 * in the middle of a warehouse can be more than 30 m from every wall. Overpass keeps areas for
 * only some buildings, so that part is a help, not a guarantee.
 */
export function buildFootprintQuery(lat: number, lon: number, radiusM = FOOTPRINT_RADIUS_M, timeoutS = FOOTPRINT_TIMEOUT_MS / 1000): string {
  const at = `${plain(lat)},${plain(lon)}`;
  const around = `(around:${plain(radiusM)},${at})`;
  return [
    `[out:json][timeout:${Math.max(1, Math.ceil(timeoutS))}];`,
    `is_in(${at})->.here;`,
    `(`,
    `  way["building"]${around};`,
    `  relation["building"]["type"="multipolygon"]${around};`,
    `  way(pivot.here)["building"];`,
    `  relation(pivot.here)["building"];`,
    `);`,
    `out tags geom;`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** The ring with its first point repeated at the end, as GeoJSON wants. A ring already closed is returned as it is. */
export function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
}

/** True when the point is inside the outline and not in one of its courtyards. */
export function pointInFootprint(polygon: FootprintPolygon, lat: number, lon: number): boolean {
  return geometryContains(polygon, lon, lat);
}

/** Metres from the origin to the nearest point of the segment a to b, on a flat local grid. */
function toSegmentM(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Metres from the point to the nearest wall of the outline, courtyard walls included.
 *
 * Degrees are turned into metres on a flat grid centred on the point (an equirectangular
 * approximation: one scale for latitude, and one for longitude shrunk by the cosine of the
 * latitude). Over tens of metres near the equator the error is far below a centimetre.
 */
export function distanceToEdgesM(polygon: FootprintPolygon, lat: number, lon: number): number {
  const mLon = M_PER_DEG_LON * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const ring of polygon.coordinates) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[Math.max(0, i - 1)];
      const b = ring[i];
      const d = toSegmentM((a[0] - lon) * mLon, (a[1] - lat) * M_PER_DEG_LAT, (b[0] - lon) * mLon, (b[1] - lat) * M_PER_DEG_LAT);
      if (d < best) best = d;
    }
  }
  return best;
}

/** 0 when the point is inside the outline, otherwise metres to its nearest wall. */
export function distanceToFootprintM(polygon: FootprintPolygon, lat: number, lon: number): number {
  return pointInFootprint(polygon, lat, lon) ? 0 : distanceToEdgesM(polygon, lat, lon);
}

/** The ground area of the outline in m², courtyards taken out. Same flat grid as the distances. */
export function footprintAreaM2(polygon: FootprintPolygon): number {
  const lat0 = polygon.coordinates[0]?.[0]?.[1] ?? 0;
  const mLon = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  const ringArea = (ring: Position[]) => {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * mLon * ring[i][1] * M_PER_DEG_LAT - ring[i][0] * mLon * ring[j][1] * M_PER_DEG_LAT;
    return Math.abs(a / 2);
  };
  return polygon.coordinates.reduce((sum, ring, i) => sum + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0);
}

/**
 * The building the point belongs to: one that contains it first, and failing that the one whose
 * wall is nearest. When the point is inside more than one outline (a kiosk drawn inside a mall),
 * the smallest is taken, as the more exact answer. Anything further than the radius is left out,
 * with a metre of slack because the server measures on a sphere and this on a flat grid.
 */
export function nearestFootprint(candidates: readonly FootprintCandidate[], lat: number, lon: number, radiusM = FOOTPRINT_RADIUS_M): { candidate: FootprintCandidate; distanceM: number } | null {
  let best: { candidate: FootprintCandidate; distanceM: number; areaM2: number } | null = null;
  for (const candidate of candidates) {
    const distanceM = distanceToFootprintM(candidate.polygon, lat, lon);
    if (!(distanceM <= radiusM + 1)) continue;
    const areaM2 = footprintAreaM2(candidate.polygon);
    if (!best || distanceM < best.distanceM || (distanceM === best.distanceM && areaM2 < best.areaM2)) best = { candidate, distanceM, areaM2 };
  }
  return best ? { candidate: best.candidate, distanceM: best.distanceM } : null;
}

// ---------------------------------------------------------------------------------------------
// Reading the reply
// ---------------------------------------------------------------------------------------------

interface OverpassElement {
  type?: unknown;
  id?: unknown;
  tags?: Record<string, unknown>;
  geometry?: unknown;
  members?: unknown;
}

/** The points of one way as [lon, lat]. Empty when any of it is unreadable. */
function positions(geometry: unknown): Position[] {
  if (!Array.isArray(geometry)) return [];
  const out: Position[] = [];
  for (const node of geometry as ({ lat?: unknown; lon?: unknown } | null)[]) {
    if (!node || typeof node.lat !== "number" || typeof node.lon !== "number" || !validPoint(node.lat, node.lon)) return [];
    out.push([node.lon, node.lat]);
  }
  return out;
}

const samePoint = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

/**
 * The closed rings made by a relation's member ways. One ring is often drawn as several ways laid
 * end to end, in either direction, so pieces are joined where their ends meet. A piece that never
 * closes is dropped.
 */
function joinRings(pieces: Position[][]): Position[][] {
  const left = pieces.filter((p) => p.length >= 2);
  const rings: Position[][] = [];
  while (left.length > 0) {
    let ring = left.shift()!;
    while (!samePoint(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const next = left.findIndex((p) => samePoint(p[0], end) || samePoint(p[p.length - 1], end));
      if (next < 0) break;
      const [piece] = left.splice(next, 1);
      ring = [...ring, ...(samePoint(piece[0], end) ? piece : [...piece].reverse()).slice(1)];
    }
    // A closed ring needs three corners and the repeat of the first.
    if (ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function candidateOf(type: string, id: number, tags: Record<string, unknown> | undefined, rings: Position[][]): FootprintCandidate {
  const name = typeof tags?.name === "string" && tags.name.trim() ? tags.name.trim() : null;
  const levels = Number.parseFloat(String(tags?.["building:levels"] ?? ""));
  return { polygon: { type: "Polygon", coordinates: rings }, osmId: `${type}/${id}`, name, levels: Number.isFinite(levels) && levels > 0 ? levels : null };
}

/**
 * Every building outline in an Overpass reply. An element that cannot be read as an outline is
 * skipped. Returns null when the reply is not an Overpass reply at all.
 *
 * A relation with several separate outer rings (one building record for a group of blocks)
 * becomes one candidate per ring, each with the courtyards that fall inside it, so the result
 * is always a single Polygon.
 */
export function footprintsFromOverpass(payload: unknown): FootprintCandidate[] | null {
  const elements = (payload as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return null;
  const out: FootprintCandidate[] = [];
  const seen = new Set<string>();
  for (const element of elements as (OverpassElement | null)[]) {
    if (!element || typeof element.id !== "number" || (element.type !== "way" && element.type !== "relation")) continue;
    // The same building can come back from both halves of the query.
    const key = `${element.type}/${element.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (element.type === "way") {
      const ring = closeRing(positions(element.geometry));
      if (ring.length >= 4) out.push(candidateOf("way", element.id, element.tags, [ring]));
      continue;
    }
    const members = (Array.isArray(element.members) ? element.members : []) as ({ type?: unknown; role?: unknown; geometry?: unknown } | null)[];
    const ways = members.filter((m) => m?.type === "way");
    const outers = joinRings(ways.filter((m) => m!.role !== "inner").map((m) => positions(m!.geometry)));
    const inners = joinRings(ways.filter((m) => m!.role === "inner").map((m) => positions(m!.geometry)));
    for (const outer of outers) {
      const shell: FootprintPolygon = { type: "Polygon", coordinates: [outer] };
      const holes = inners.filter((inner) => geometryContains(shell, inner[0][0], inner[0][1]));
      out.push(candidateOf("relation", element.id, element.tags, [outer, ...holes]));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------------------------

const metres = (m: number) => plain(Number(m.toFixed(1)));

const REASONS = {
  none: (radiusM: number) => `OpenStreetMap has no building within ${metres(radiusM)} m of these coordinates`,
  timeout: "The OpenStreetMap lookup did not answer in time",
  failed: "The OpenStreetMap lookup failed, so the outline could not be fetched",
  invalid: "These coordinates are not a latitude and longitude, so no outline was looked up",
  cancelled: "The OpenStreetMap lookup was cancelled",
};

const missing = (cause: Exclude<FootprintCause, "none">): FootprintMissing => ({ found: false, cause, reason: REASONS[cause] });

type Asked = { ok: true; payload: unknown } | { ok: false; cause: "timeout" | "failed" | "cancelled" };

/** One post to one server. The timeout covers the whole exchange, the reading of the reply included. */
async function ask(endpoint: string, query: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<Asked> {
  if (signal?.aborted) return { ok: false, cause: "cancelled" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel);
  try {
    // A form post with no extra headers: the browser sends it without asking the server's leave first.
    const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: `data=${encodeURIComponent(query)}`, signal: controller.signal });
    if (!res.ok) return { ok: false, cause: "failed" };
    return { ok: true, payload: JSON.parse(await res.text()) };
  } catch {
    return { ok: false, cause: timedOut ? "timeout" : signal?.aborted ? "cancelled" : "failed" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * The nearest OpenStreetMap building within 30 m of the point, or the reason there is none.
 * Sends the coordinates and the radius only. Never throws.
 */
export async function findFootprint(lat: number, lon: number, options: FootprintOptions = {}): Promise<Footprint> {
  try {
    if (!validPoint(lat, lon)) return missing("invalid");
    const radiusM = options.radiusM !== undefined && options.radiusM > 0 ? options.radiusM : FOOTPRINT_RADIUS_M;
    const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : FOOTPRINT_TIMEOUT_MS;
    const mirror = options.mirror !== undefined ? options.mirror : options.endpoint ? null : OVERPASS_MIRROR_URL;
    const endpoints = [options.endpoint || OVERPASS_URL, ...(mirror ? [mirror] : [])];
    const query = buildFootprintQuery(lat, lon, radiusM, timeoutMs / 1000);

    let cause: "timeout" | "failed" = "failed";
    for (const endpoint of endpoints) {
      const asked = await ask(endpoint, query, timeoutMs, options.signal);
      if (!asked.ok) {
        if (asked.cause === "cancelled") return missing("cancelled");
        cause = asked.cause;
        continue;
      }
      const candidates = footprintsFromOverpass(asked.payload);
      const remark = (asked.payload as { remark?: unknown } | null)?.remark;
      // Overpass reports a query it gave up on with status 200, an empty list and a remark.
      // That is not the same as "no building here", and must not be shown as one.
      if (!candidates || (candidates.length === 0 && typeof remark === "string" && /error|timed out/i.test(remark))) {
        cause = typeof remark === "string" && /timed out/i.test(remark) ? "timeout" : "failed";
        continue;
      }
      const nearest = nearestFootprint(candidates, lat, lon, radiusM);
      if (!nearest) return { found: false, cause: "none", reason: REASONS.none(radiusM) };
      return { found: true, ...nearest.candidate, distanceM: nearest.distanceM, osmUrl: `https://www.openstreetmap.org/${nearest.candidate.osmId}`, label: FOOTPRINT_LABEL };
    }
    return missing(cause);
  } catch {
    // Nothing above is expected to throw. The outline is a courtesy, so even a surprise ends in the marker.
    return missing("failed");
  }
}
