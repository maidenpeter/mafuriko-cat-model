import { cellSizeM } from "../geo/drainage";
import type { Geometry, Position } from "../geo/layers";
import { assignPoints, geometryContains } from "../geo/spatial";
import { cleanValue } from "../ingest/raster";
import type { LocateByName, NearestWetCellM, PlaceMatch, RiverDistanceM, WardOf } from "./types";

/**
 * Where an offer is: a place name turned into a point, the ward a point falls in, the distance
 * to a named river, and the distance to the nearest flooded cell of a hazard map.
 * Geometry only. Nothing here reads the document or prices anything.
 */

// Metres per degree, the same figures the drainage grid uses, so distances agree across the app.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320;

/** A name as lower-case words: accents and apostrophes dropped, every other mark read as a space. */
function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** True when the words of `part` appear in `whole` in order, as whole words. */
const hasWords = (whole: string, part: string) => part !== "" && ` ${whole} `.includes(` ${part} `);

// ---------------------------------------------------------------------------------------------
// Place names
// ---------------------------------------------------------------------------------------------

/**
 * Ward names that are also everyday words. They match only when they are the whole place name,
 * so "next to the hospital" does not put an offer in Hospital ward.
 */
const EVERYDAY_NAMES: ReadonlySet<string> = new Set(["hospital", "pipeline", "airbase", "harambee", "california", "mountain view"]);

function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

function ringCentroid(ring: Position[]): Position | null {
  const area = ringArea(ring);
  if (!(Math.abs(area) > 0)) return null;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  return [x / (6 * area), y / (6 * area)];
}

/**
 * The centre point of an area: the centroid of its largest part. A curved or hooked area can have
 * its centroid outside its own boundary; the point then moves along the same latitude to the
 * middle of the widest stretch that is inside, so a ward's stand-in point is always in that ward.
 */
function centrePoint(g: Geometry): Position | null {
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  let largest: Position[][] | null = null;
  let largestArea = 0;
  for (const rings of polygons) {
    const area = rings.length ? Math.abs(ringArea(rings[0])) : 0;
    if (area > largestArea) {
      largest = rings;
      largestArea = area;
    }
  }
  const centroid = largest ? ringCentroid(largest[0]) : null;
  if (!largest || !centroid) return null;
  if (geometryContains(g, centroid[0], centroid[1])) return centroid;

  const lat = centroid[1];
  const crossings: number[] = [];
  for (const ring of largest) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat) crossings.push(((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    }
  }
  crossings.sort((a, b) => a - b);
  let best: Position = centroid;
  let widest = 0;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const span = crossings[i + 1] - crossings[i];
    if (span > widest) {
      widest = span;
      best = [(crossings[i] + crossings[i + 1]) / 2, lat];
    }
  }
  return best;
}

interface Candidate {
  /** Every way the name may be written: the whole name, and each side of a slash ("Parklands/Highridge"). */
  keys: string[];
  match: () => PlaceMatch | null;
}

export const locateByName: LocateByName = (name, wards, hotspots) => {
  const wanted = words(name).join(" ");
  if (!wanted) return null;

  // Wards first: on a tie the ward is used, as the ward map is the app's own geography.
  const candidates: Candidate[] = [];
  for (const f of wards?.features ?? []) {
    const full = f.properties.name ?? "";
    const keys = [...new Set([full, ...full.split("/")].map((n) => words(n).join(" ")).filter(Boolean))];
    candidates.push({
      keys,
      match: () => {
        const p = centrePoint(f.geometry);
        return p ? { lat: p[1], lon: p[0], source: "ward", matchedName: full } : null;
      },
    });
  }
  for (const h of hotspots) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
    candidates.push({ keys: [words(h.name).join(" ")].filter(Boolean), match: () => ({ lat: h.lat, lon: h.lon, source: "hotspot", matchedName: h.name }) });
  }

  // A known name has to appear in the place name as whole words ("Kibera, Nairobi" holds "Kibera";
  // "Kiberani" does not). The longest known name wins, so "Kayole North" beats "Kayole". The other
  // direction is not tried: "Eastleigh" could be either Eastleigh ward, and a guess would look exact.
  let best: { length: number; candidate: Candidate } | null = null;
  for (const candidate of candidates) {
    for (const key of candidate.keys) {
      const found = key === wanted || (hasWords(wanted, key) && !EVERYDAY_NAMES.has(key));
      if (found && (!best || key.length > best.length)) best = { length: key.length, candidate };
    }
  }
  return best ? best.candidate.match() : null;
};

export const wardOf: WardOf = (point, wards) => {
  if (!wards || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  const index = assignPoints([point], wards)[0];
  if (index < 0) return null;
  const { name, subcounty } = wards.features[index].properties;
  return { index, name, subcounty };
};

// ---------------------------------------------------------------------------------------------
// Rivers
// ---------------------------------------------------------------------------------------------

/** Words that say "this is a river" in English or Swahili and carry no name of their own. */
const RIVER_WORDS: ReadonlySet<string> = new Set(["river", "rivers", "mto", "the", "stream"]);

/** "Nairobi River", "Nairobi river", "River Nairobi" and "Mto Nairobi" all become "nairobi". */
const riverKey = (name: string) => words(name).filter((w) => !RIVER_WORDS.has(w)).join(" ");

/** Metres from the origin to the nearest point of the segment a to b, on a flat local grid. */
function toSegmentM(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export const riverDistanceM: RiverDistanceM = (point, riverName, waterways) => {
  const wanted = riverKey(riverName);
  if (!waterways || !wanted || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;

  const named = waterways.features.flatMap((f) => {
    const key = f.properties.name ? riverKey(f.properties.name) : "";
    return key ? [{ feature: f, key }] : [];
  });
  // The same name first. Failing that, a name that holds the other as whole words
  // ("Kirichwa" for "Kirichwa Dogo River").
  let matches = named.filter((n) => n.key === wanted);
  if (matches.length === 0) matches = named.filter((n) => hasWords(n.key, wanted) || hasWords(wanted, n.key));
  if (matches.length === 0) return null;

  // Degrees to metres around the point: accurate to well under 1% over the distances that matter here.
  const mLon = M_PER_DEG_LON * Math.cos((point.lat * Math.PI) / 180);
  let distanceM = Infinity;
  let matchedName = "";
  for (const { feature } of matches) {
    const g = feature.geometry;
    const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Point" ? [[g.coordinates]] : [];
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const a = line[Math.max(0, i - 1)];
        const b = line[i];
        const d = toSegmentM((a[0] - point.lon) * mLon, (a[1] - point.lat) * M_PER_DEG_LAT, (b[0] - point.lon) * mLon, (b[1] - point.lat) * M_PER_DEG_LAT);
        if (d < distanceM) {
          distanceM = d;
          matchedName = feature.properties.name ?? "";
        }
      }
    }
  }
  return Number.isFinite(distanceM) ? { distanceM, matchedName } : null;
};

// ---------------------------------------------------------------------------------------------
// Nearest flooded cell
// ---------------------------------------------------------------------------------------------

/**
 * Searches outward from the point's own cell, one square ring of cells at a time. No cell in
 * ring k can be nearer than (k - 0.5) cells, so the search stops at the first ring that cannot
 * beat the best found. A dry site next to water is answered after a handful of rings; only a map
 * with no water at all is read in full.
 */
export const nearestWetCellM: NearestWetCellM = (raster, lon, lat, kind) => {
  const { width, height, data } = raster;
  const [minLon, minLat, maxLon, maxLat] = raster.bbox;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const x = ((lon - minLon) / (maxLon - minLon)) * width;
  const y = ((maxLat - lat) / (maxLat - minLat)) * height;
  const c0 = Math.floor(x);
  const r0 = Math.floor(y);
  if (c0 < 0 || r0 < 0 || c0 >= width || r0 >= height) return null;

  const wet = (r: number, c: number) => cleanValue(data[r * width + c], raster, kind) > 0;
  if (wet(r0, c0)) return 0;

  const size = cellSizeM(raster);
  // Where the point sits inside its own cell, measured in cells from that cell's centre.
  const fx = x - (c0 + 0.5);
  const fy = y - (r0 + 0.5);
  const smallest = Math.min(size.x, size.y);
  let best = Infinity;
  const visit = (r: number, c: number) => {
    if (!wet(r, c)) return;
    const d = Math.hypot((c - c0 - fx) * size.x, (r - r0 - fy) * size.y);
    if (d < best) best = d;
  };

  const lastRing = Math.max(r0, height - 1 - r0, c0, width - 1 - c0);
  for (let k = 1; k <= lastRing; k++) {
    if (best <= (k - 0.5) * smallest) break;
    const cFrom = Math.max(0, c0 - k);
    const cTo = Math.min(width - 1, c0 + k);
    if (r0 - k >= 0) for (let c = cFrom; c <= cTo; c++) visit(r0 - k, c);
    if (r0 + k < height) for (let c = cFrom; c <= cTo; c++) visit(r0 + k, c);
    const rFrom = Math.max(0, r0 - k + 1);
    const rTo = Math.min(height - 1, r0 + k - 1);
    if (c0 - k >= 0) for (let r = rFrom; r <= rTo; r++) visit(r, c0 - k);
    if (c0 + k < width) for (let r = rFrom; r <= rTo; r++) visit(r, c0 + k);
  }
  return Number.isFinite(best) ? best : null;
};
