import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ASSUMED_HEIGHT_M,
  ASSUMED_LEVELS,
  ASSUMED_SQUARE_M,
  buildFootprintQuery,
  buildingBlock,
  closeRing,
  distanceToEdgesM,
  distanceToFootprintM,
  findFootprint,
  FOOTPRINT_LABEL,
  footprintAreaM2,
  footprintsFromOverpass,
  heightTagM,
  LEVEL_HEIGHT_M,
  MAX_IMPLIED_LEVELS,
  nearestFootprint,
  pointInFootprint,
  SQUARE_SIDE_RANGE_M,
  type Footprint,
  type FootprintFound,
  type FootprintPolygon,
} from "../src/lib/offer/footprint";

// A point in central Nairobi, and made-up buildings laid out around it in metres.
const LAT = -1.2921;
const LON = 36.8219;
const M_LAT = 110574;
const M_LON = 111320 * Math.cos((LAT * Math.PI) / 180);
const node = (eastM: number, northM: number) => ({ lat: LAT + northM / M_LAT, lon: LON + eastM / M_LON });

/** The corners of a square, as Overpass sends a closed way: the first point repeated at the end. */
function square(eastM: number, northM: number, halfM: number) {
  const corners = [node(eastM - halfM, northM - halfM), node(eastM + halfM, northM - halfM), node(eastM + halfM, northM + halfM), node(eastM - halfM, northM + halfM)];
  return [...corners, corners[0]];
}
const way = (id: number, geometry: { lat: number; lon: number }[], tags: Record<string, string> = { building: "yes" }) => ({ type: "way", id, tags, geometry });
const polygon = (geometry: { lat: number; lon: number }[]): FootprintPolygon => ({ type: "Polygon", coordinates: [geometry.map((n) => [n.lon, n.lat])] });

// A local stand-in for the Overpass API. No public server is called.
let server: Server;
let base = "";
let sent: { path: string; type: string; query: string }[] = [];
let handler: (res: ServerResponse, path: string) => void;

const json = (res: ServerResponse, payload: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      sent.push({ path: req.url ?? "", type: req.headers["content-type"] ?? "", query: new URLSearchParams(body).get("data") ?? "" });
      handler(res, req.url ?? "");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  sent = [];
});

describe("the query", () => {
  it("holds the radius and the coordinates, and asks for building outlines with their geometry", () => {
    const query = buildFootprintQuery(LAT, LON);
    expect(query).toContain("(around:30,-1.2921,36.8219)");
    expect(query).toContain('way["building"](around:30,-1.2921,36.8219);');
    expect(query).toContain('relation["building"]["type"="multipolygon"](around:30,-1.2921,36.8219);');
    expect(query).toContain("is_in(-1.2921,36.8219)");
    expect(query).toContain("[out:json][timeout:8];");
    expect(query.trim().endsWith("out tags geom;")).toBe(true);
  });

  it("takes another radius, and writes small numbers as plain digits", () => {
    const query = buildFootprintQuery(0.0000004, -0.5, 12.5, 3);
    expect(query).toContain("(around:12.5,0.0000004,-0.5)");
    expect(query).toContain("[timeout:3]");
    expect(query).not.toMatch(/\de-\d/);
  });
});

describe("geometry", () => {
  const box = polygon(square(0, 0, 10));

  it("closes an open ring and leaves a closed one alone", () => {
    expect(closeRing([[0, 0], [1, 0], [1, 1]])).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]]);
    const closed: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 0]];
    expect(closeRing(closed)).toBe(closed);
    expect(closeRing([])).toEqual([]);
  });

  it("tells inside from outside", () => {
    expect(pointInFootprint(box, LAT, LON)).toBe(true);
    const out = node(15, 0);
    expect(pointInFootprint(box, out.lat, out.lon)).toBe(false);
  });

  it("measures to the nearest wall in metres", () => {
    const east = node(25, 0);
    expect(distanceToFootprintM(box, east.lat, east.lon)).toBeCloseTo(15, 2);
    // Off a corner the nearest point is the corner itself: 3, 4, 5.
    const corner = node(13, 14);
    expect(distanceToFootprintM(box, corner.lat, corner.lon)).toBeCloseTo(5, 2);
  });

  it("is 0 inside, where the walls are still some way off", () => {
    const inside = node(4, 0);
    expect(distanceToFootprintM(box, inside.lat, inside.lon)).toBe(0);
    expect(distanceToEdgesM(box, inside.lat, inside.lon)).toBeCloseTo(6, 2);
  });

  it("treats a courtyard as outside, and measures to its wall", () => {
    const withYard: FootprintPolygon = { type: "Polygon", coordinates: [box.coordinates[0], polygon(square(0, 0, 4)).coordinates[0]] };
    expect(pointInFootprint(withYard, LAT, LON)).toBe(false);
    expect(distanceToFootprintM(withYard, LAT, LON)).toBeCloseTo(4, 2);
    expect(footprintAreaM2(withYard)).toBeCloseTo(400 - 64, 0);
  });

  it("works out the ground area", () => {
    expect(footprintAreaM2(box)).toBeCloseTo(400, 0);
  });
});

describe("reading an Overpass reply", () => {
  it("turns a way into a closed polygon in lon, lat order, with its name and floors", () => {
    const [found] = footprintsFromOverpass({ elements: [way(7, square(0, 0, 10), { building: "office", name: " Ardhi House ", "building:levels": "12" })] })!;
    expect(found.osmId).toBe("way/7");
    expect(found.name).toBe("Ardhi House");
    expect(found.levels).toBe(12);
    const ring = found.polygon.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[0][0]).toBeCloseTo(LON, 3);
    expect(ring[0][1]).toBeCloseTo(LAT, 3);
  });

  it("closes a way that came open, and leaves name and floors null when not tagged", () => {
    const open = square(0, 0, 10).slice(0, 4);
    const [found] = footprintsFromOverpass({ elements: [way(8, open, { building: "yes", "building:levels": "several" })] })!;
    expect(found.polygon.coordinates[0]).toHaveLength(5);
    expect(found.name).toBeNull();
    expect(found.levels).toBeNull();
  });

  it("reads the height tag in metres, and leaves out what it cannot read", () => {
    expect(heightTagM("12")).toBe(12);
    expect(heightTagM(" 12.5 m ")).toBe(12.5);
    expect(heightTagM("18metres")).toBe(18);
    expect(heightTagM(9)).toBe(9);
    expect(heightTagM("40 ft")).toBeCloseTo(12.192, 3);
    for (const unread of [undefined, null, "", "tall", "0", "-4", "12'6\"", "3 storeys", "5000", { m: 12 }]) expect(heightTagM(unread), String(unread)).toBeNull();

    const [tagged, bare] = footprintsFromOverpass({ elements: [way(10, square(0, 0, 10), { building: "yes", height: "24 m", "building:levels": "7" }), way(11, square(40, 0, 10))] })!;
    expect(tagged).toMatchObject({ heightM: 24, levels: 7 });
    expect(bare).toMatchObject({ heightM: null, levels: null });
  });

  it("joins a relation's pieces into an outline with its courtyard", () => {
    const outer = square(0, 0, 10);
    const relation = {
      type: "relation",
      id: 9,
      tags: { building: "yes", type: "multipolygon" },
      members: [
        // The outer ring in two pieces, the second drawn backwards.
        { type: "way", ref: 1, role: "outer", geometry: outer.slice(0, 3) },
        { type: "way", ref: 2, role: "outer", geometry: outer.slice(2).reverse() },
        { type: "way", ref: 3, role: "inner", geometry: square(0, 0, 4) },
        { type: "node", ref: 4, role: "entrance", lat: LAT, lon: LON },
      ],
    };
    const found = footprintsFromOverpass({ elements: [relation] })!;
    expect(found).toHaveLength(1);
    expect(found[0].osmId).toBe("relation/9");
    expect(found[0].polygon.coordinates).toHaveLength(2);
    expect(found[0].polygon.coordinates[0]).toHaveLength(5);
    expect(footprintAreaM2(found[0].polygon)).toBeCloseTo(400 - 64, 0);
  });

  it("skips what is not an outline, and the same building sent twice", () => {
    const good = way(1, square(0, 0, 5));
    const found = footprintsFromOverpass({
      elements: [null, { type: "node", id: 2, lat: LAT, lon: LON }, way(3, square(0, 0, 5).slice(0, 2)), way(4, [{ lat: 200, lon: 0 }, node(0, 0), node(1, 1), node(2, 0)]), { type: "way", id: 5 }, { type: "relation", id: 6, members: "none" }, good, good],
    })!;
    expect(found.map((f) => f.osmId)).toEqual(["way/1"]);
  });

  it("returns null for something that is not an Overpass reply", () => {
    expect(footprintsFromOverpass(null)).toBeNull();
    expect(footprintsFromOverpass("busy")).toBeNull();
    expect(footprintsFromOverpass({ elements: "none" })).toBeNull();
    expect(footprintsFromOverpass({ elements: [] })).toEqual([]);
  });
});

describe("choosing the building", () => {
  const far = { polygon: polygon(square(20, 0, 5)), osmId: "way/1", name: null, levels: null, heightM: null };
  const near = { polygon: polygon(square(0, 12, 4)), osmId: "way/2", name: null, levels: null, heightM: null };
  const around = { polygon: polygon(square(0, 0, 10)), osmId: "way/3", name: null, levels: null, heightM: null };
  const kiosk = { polygon: polygon(square(0, 0, 2)), osmId: "way/4", name: null, levels: null, heightM: null };

  it("takes the nearer wall", () => {
    const chosen = nearestFootprint([far, near], LAT, LON)!;
    expect(chosen.candidate.osmId).toBe("way/2");
    expect(chosen.distanceM).toBeCloseTo(8, 2);
  });

  it("takes the building the point is in over a nearer wall next door", () => {
    // The point is 1 m inside the big building's east wall; the neighbour's wall is 2 m away.
    const neighbour = { polygon: polygon(square(15, 0, 4)), osmId: "way/5", name: null, levels: null, heightM: null };
    const p = node(9, 0);
    expect(nearestFootprint([neighbour, around], p.lat, p.lon)).toMatchObject({ candidate: { osmId: "way/3" }, distanceM: 0 });
  });

  it("takes the smallest outline when the point is inside more than one", () => {
    expect(nearestFootprint([around, kiosk], LAT, LON)!.candidate.osmId).toBe("way/4");
  });

  it("leaves out anything beyond the radius", () => {
    expect(nearestFootprint([far, near], LAT, LON, 5)).toBeNull();
    expect(nearestFootprint([], LAT, LON)).toBeNull();
  });
});

describe("the building as a block", () => {
  // A 20 m by 20 m outline around the point: 400 m² on the ground.
  const found = (tags: { levels?: number | null; heightM?: number | null } = {}): FootprintFound => ({
    found: true,
    polygon: polygon(square(0, 0, 10)),
    osmId: "way/7",
    name: null,
    levels: tags.levels ?? null,
    heightM: tags.heightM ?? null,
    distanceM: 0,
    osmUrl: "https://www.openstreetmap.org/way/7",
    label: FOOTPRINT_LABEL,
  });
  const none: Footprint = { found: false, cause: "none", reason: "OpenStreetMap has no building within 30 m of these coordinates" };

  it("stands on the OpenStreetMap outline when there is one, anchored at its middle", () => {
    const outline = found();
    const block = buildingBlock(LAT, LON, outline, null);
    expect(block.shape).toBe("osm");
    expect(block.sideM).toBeNull();
    expect(block.polygon).toBe(outline.polygon);
    expect(block.polygon.coordinates[0]).toHaveLength(5);
    expect(block.areaM2).toBeCloseTo(400, 0);
    expect(block.centre[0]).toBeCloseTo(LON, 9);
    expect(block.centre[1]).toBeCloseTo(LAT, 9);
    // An outline off to one side is anchored where it is, not at the stated point.
    const aside = buildingBlock(LAT, LON, { ...found(), polygon: polygon(square(25, 0, 5)), distanceM: 20 }, null);
    expect((aside.centre[0] - LON) * M_LON).toBeCloseTo(25, 3);
  });

  it("takes OpenStreetMap's own height before anything else", () => {
    expect(buildingBlock(LAT, LON, found({ heightM: 41, levels: 3 }), 8000)).toMatchObject({ heightM: 41, heightFrom: "osm_height", levels: null });
  });

  it("then OpenStreetMap's levels at 3.2 m each", () => {
    const block = buildingBlock(LAT, LON, found({ levels: 12 }), 800);
    expect(block).toMatchObject({ heightFrom: "osm_levels", levels: 12 });
    expect(block.heightM).toBeCloseTo(12 * LEVEL_HEIGHT_M, 9);
  });

  it("then the levels the stated floor area implies over the outline, never fewer than one", () => {
    // 2,000 m² of floor over 400 m² of ground is five levels.
    const block = buildingBlock(LAT, LON, found(), 2000);
    expect(block).toMatchObject({ heightFrom: "floor_area", levels: 5 });
    expect(block.heightM).toBeCloseTo(16, 9);
    expect(buildingBlock(LAT, LON, found(), 1900)).toMatchObject({ levels: 5 });
    expect(buildingBlock(LAT, LON, found(), 90)).toMatchObject({ heightFrom: "floor_area", levels: 1, heightM: LEVEL_HEIGHT_M });
  });

  it("assumes 12 m when nothing says how tall it is", () => {
    expect(buildingBlock(LAT, LON, found(), null)).toMatchObject({ shape: "osm", heightM: ASSUMED_HEIGHT_M, heightFrom: "assumed", levels: null });
    expect(buildingBlock(LAT, LON, found(), 0)).toMatchObject({ heightFrom: "assumed" });
    expect(buildingBlock(LAT, LON, found(), Number.NaN)).toMatchObject({ heightFrom: "assumed" });
  });

  it("does not stack a floor area that cannot be one building's onto a small outline", () => {
    // 400 m² of ground would need 100 levels to hold 40,000 m².
    expect(buildingBlock(LAT, LON, found(), 40000)).toMatchObject({ heightM: ASSUMED_HEIGHT_M, heightFrom: "assumed", levels: null });
    expect(buildingBlock(LAT, LON, found(), 400 * MAX_IMPLIED_LEVELS)).toMatchObject({ heightFrom: "floor_area", levels: MAX_IMPLIED_LEVELS });
  });

  it("draws a square on the stated point when there is no outline, sized from the floor area", () => {
    // 3,600 m² of floor over the assumed four levels is 900 m² of ground: 30 m a side.
    expect(ASSUMED_LEVELS).toBe(4);
    for (const missing of [none, null, { found: false, cause: "timeout", reason: "The OpenStreetMap lookup did not answer in time" } as Footprint]) {
      const block = buildingBlock(LAT, LON, missing, 3600);
      expect(block).toMatchObject({ shape: "approximate", heightM: ASSUMED_HEIGHT_M, heightFrom: "assumed", levels: 4, centre: [LON, LAT] });
      expect(block.sideM).toBeCloseTo(30, 9);
      expect(block.areaM2).toBeCloseTo(900, 6);
      const ring = block.polygon.coordinates[0];
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual(ring[4]);
      expect(footprintAreaM2(block.polygon)).toBeCloseTo(900, 0);
      expect(pointInFootprint(block.polygon, LAT, LON)).toBe(true);
    }
  });

  it("draws a plain 30 m square when no floor area is stated, and keeps a square within sensible sides", () => {
    expect(buildingBlock(LAT, LON, none, null)).toMatchObject({ shape: "approximate", sideM: ASSUMED_SQUARE_M, heightFrom: "assumed" });
    expect(buildingBlock(LAT, LON, none, 40).sideM).toBe(SQUARE_SIDE_RANGE_M.min);
    expect(buildingBlock(LAT, LON, none, 4_000_000).sideM).toBe(SQUARE_SIDE_RANGE_M.max);
  });
});

describe("the lookup", () => {
  it("hands back the height and the levels OpenStreetMap records, from the one reply", async () => {
    handler = (res) => json(res, { elements: [way(401, square(0, 0, 10), { building: "office", height: "36", "building:levels": "10" })] });
    const result = await findFootprint(LAT, LON, { endpoint: `${base}/api` });
    expect(result).toMatchObject({ found: true, osmId: "way/401", heightM: 36, levels: 10 });
    expect(sent).toHaveLength(1);
    expect(buildingBlock(LAT, LON, result, 9000)).toMatchObject({ shape: "osm", heightM: 36, heightFrom: "osm_height" });
  });

  it("returns the building that contains the point, at distance 0", async () => {
    handler = (res) => json(res, { elements: [way(101, square(40, 0, 5)), way(102, square(0, 0, 10), { building: "commercial", name: "Made-up Plaza", "building:levels": "6" })] });
    const result = await findFootprint(LAT, LON, { endpoint: `${base}/api` });
    expect(result).toMatchObject({ found: true, osmId: "way/102", name: "Made-up Plaza", levels: 6, distanceM: 0, label: FOOTPRINT_LABEL, osmUrl: "https://www.openstreetmap.org/way/102" });
    if (!result.found) return;
    expect(result.label).toBe("Footprint from OpenStreetMap, nearest to the stated coordinates");
    expect(result.polygon.type).toBe("Polygon");
    const ring = result.polygon.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("sends the coordinates and the radius as a form post, and nothing else", async () => {
    handler = (res) => json(res, { elements: [] });
    await findFootprint(LAT, LON, { endpoint: `${base}/api` });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toContain("application/x-www-form-urlencoded");
    expect(sent[0].query).toBe(buildFootprintQuery(LAT, LON));
    expect(sent[0].query).toContain("around:30,-1.2921,36.8219");
  });

  it("chooses the nearer of two buildings nearby", async () => {
    handler = (res) => json(res, { elements: [way(201, square(20, 0, 5)), way(202, square(0, 12, 4))] });
    const result = await findFootprint(LAT, LON, { endpoint: `${base}/api` });
    expect(result).toMatchObject({ found: true, osmId: "way/202", name: null, levels: null, heightM: null });
    if (result.found) expect(result.distanceM).toBeCloseTo(8, 2);
  });

  it("says so when there is no building in reach", async () => {
    handler = (res) => json(res, { version: 0.6, elements: [] });
    expect(await findFootprint(LAT, LON, { endpoint: `${base}/api` })).toEqual({ found: false, cause: "none", reason: "OpenStreetMap has no building within 30 m of these coordinates" });
    expect(await findFootprint(LAT, LON, { endpoint: `${base}/api`, radiusM: 50 })).toMatchObject({ reason: "OpenStreetMap has no building within 50 m of these coordinates" });
    expect(sent[1].query).toContain("around:50,");
  });

  it("reports a server error without throwing", async () => {
    handler = (res) => json(res, "<html>Too many requests</html>", 429);
    const result = await findFootprint(LAT, LON, { endpoint: `${base}/api` });
    expect(result).toMatchObject({ found: false, cause: "failed" });
    if (!result.found) expect(result.reason).toMatch(/^The OpenStreetMap lookup failed/);
    // An endpoint given on its own has no mirror: nothing else was tried.
    expect(sent).toHaveLength(1);
  });

  it("tries the mirror once when the first server fails", async () => {
    handler = (res, path) => (path === "/main" ? json(res, { error: "busy" }, 504) : json(res, { elements: [way(301, square(0, 0, 10))] }));
    const result = await findFootprint(LAT, LON, { endpoint: `${base}/main`, mirror: `${base}/mirror` });
    expect(result).toMatchObject({ found: true, osmId: "way/301" });
    expect(sent.map((s) => s.path)).toEqual(["/main", "/mirror"]);
  });

  it("does not try the mirror when the first server answers that there is nothing", async () => {
    handler = (res) => json(res, { elements: [] });
    expect(await findFootprint(LAT, LON, { endpoint: `${base}/main`, mirror: `${base}/mirror` })).toMatchObject({ found: false, cause: "none" });
    expect(sent.map((s) => s.path)).toEqual(["/main"]);
  });

  it("gives up when the server does not answer in time", async () => {
    handler = () => {};
    const started = Date.now();
    const result = await findFootprint(LAT, LON, { endpoint: `${base}/api`, timeoutMs: 150 });
    expect(result).toEqual({ found: false, cause: "timeout", reason: "The OpenStreetMap lookup did not answer in time" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives up when the reply starts but never finishes", async () => {
    handler = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"elements":[');
    };
    expect(await findFootprint(LAT, LON, { endpoint: `${base}/api`, timeoutMs: 150 })).toMatchObject({ found: false, cause: "timeout" });
  });

  it("reports a malformed reply as a failed lookup, not as no building", async () => {
    for (const reply of ["this is not JSON", '{"elements":[{"type":"way"', JSON.stringify({ elements: "none" }), JSON.stringify({ hello: "world" }), "null"]) {
      handler = (res) => json(res, reply);
      expect(await findFootprint(LAT, LON, { endpoint: `${base}/api` }), reply).toMatchObject({ found: false, cause: "failed" });
    }
  });

  it("does not read a query the server gave up on as no building", async () => {
    handler = (res) => json(res, { elements: [], remark: "runtime error: Query timed out in \"query\" at line 4 after 9 seconds." });
    expect(await findFootprint(LAT, LON, { endpoint: `${base}/api` })).toMatchObject({ found: false, cause: "timeout" });
    handler = (res) => json(res, { elements: [], remark: "runtime error: out of memory" });
    expect(await findFootprint(LAT, LON, { endpoint: `${base}/api` })).toMatchObject({ found: false, cause: "failed" });
  });

  it("reports a server that cannot be reached", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await findFootprint(LAT, LON, { endpoint: `http://localhost:${port}/api` })).toMatchObject({ found: false, cause: "failed" });
  });

  it("sends nothing for coordinates that are not a latitude and longitude", async () => {
    handler = (res) => json(res, { elements: [] });
    for (const [lat, lon] of [[Number.NaN, LON], [LAT, Number.POSITIVE_INFINITY], [91, LON], [LAT, 181]]) {
      expect(await findFootprint(lat, lon, { endpoint: `${base}/api` })).toMatchObject({ found: false, cause: "invalid" });
    }
    expect(sent).toHaveLength(0);
  });

  it("stops when the caller cancels", async () => {
    handler = () => {};
    const controller = new AbortController();
    const pending = findFootprint(LAT, LON, { endpoint: `${base}/main`, mirror: `${base}/mirror`, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toMatchObject({ found: false, cause: "cancelled" });
    // The mirror is not tried after a cancel.
    expect(sent.map((s) => s.path)).toEqual(["/main"]);

    const already = new AbortController();
    already.abort();
    expect(await findFootprint(LAT, LON, { endpoint: `${base}/api`, signal: already.signal })).toMatchObject({ found: false, cause: "cancelled" });
  });
});
