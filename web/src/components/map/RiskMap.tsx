"use client";

import { FullscreenControl, LngLat, Map as MapLibre, Marker, NavigationControl, ScaleControl, setWorkerUrl } from "maplibre-gl";
import type { ExpressionSpecification, FilterSpecification, GeoJSONSource, MapMouseEvent, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { currentTheme } from "@/lib/display";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { cssColor, hazardImageUrl, rasterCorners, rgbCss, stressImageUrl, type RGB } from "@/lib/geo/hazardImage";
import { GEO_ATTRIBUTION, type GeoLayers } from "@/lib/geo/layers";
import { geometryBBox, type AreaRow, type BBox } from "@/lib/geo/spatial";
import { hazardToDepth } from "@/lib/model/pipeline";
import { rpLabel } from "@/lib/labels";
import { HOUSING_LABELS, type BuildingScenarioResult, type HousingClass } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import {
  APPROXIMATE_RING_PX,
  bufferRing,
  CALLOUT_FAR_ZOOM,
  DRAINAGE_RGB,
  FACILITY_COLORS,
  OFFER_BEARING,
  OFFER_PITCH,
  offerZoom,
  offsetPoint,
  SETTLEMENT_COLOR,
  WARD_COLOR,
  WATER_COLORS,
  type BasemapStatus,
  type LayerKey,
  type LayerState,
  type MapCamera,
  type MapView,
  type OfferMark,
  type Selection,
  type WardMetric,
} from "./mapTheme";

setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());

const STYLE_URLS = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/**
 * MapLibre's fullscreen button never looks at the browser's answer. A browser refuses when the
 * request does not come from a real click or key press, or when the page sits in an embedded
 * preview; the refusal then surfaced as an unhandled page error and the button did nothing.
 * This one fills the browser window instead, and Escape leaves that view as it leaves real fullscreen.
 */
class FullscreenButton extends FullscreenControl {
  onAdd(map: MapLibre) {
    document.addEventListener("keydown", this.onKey);
    return super.onAdd(map);
  }

  onRemove() {
    document.removeEventListener("keydown", this.onKey);
    super.onRemove();
  }

  _requestFullscreen() {
    const fillWindow = () => {
      if (this._map && !this._isFullscreen()) this._togglePseudoFullScreen();
    };
    if (this._container.requestFullscreen) this._container.requestFullscreen().catch(fillWindow);
    else fillWindow();
  }

  _exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this._togglePseudoFullScreen();
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this._map && this._isFullscreen() && !document.fullscreenElement) this._togglePseudoFullScreen();
  };
}

interface Props {
  session: Session;
  active: Active;
  geo: GeoLayers;
  /** Index into active.result.scenarios (most frequent first). */
  k: number;
  layers: LayerState;
  threeD: boolean;
  wardMetric: WardMetric;
  /** Accumulation rows for scenario k; the first rows line up with geo.wards features. */
  wardRows: AreaRow[];
  /** Flood depth in metres at each facility, per scenario. */
  facilityDepth: number[][];
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  focus: { bbox: BBox; seq: number } | null;
  onStatus: (s: BasemapStatus) => void;
  /** Kept up to date here and read when the map is created, so a map rebuilt for a theme change opens on the same view. */
  viewRef: { current: MapView };
  /** What goes fullscreen with the map: the step's frame, which also holds the control strip and the key. */
  fullscreenHost: { current: HTMLElement | null };
  /** The offer building, drawn above everything else. null in the portfolio view. */
  offer?: OfferMark | null;
  /** Draws the portfolio's buildings smaller and fainter, as the setting around the offer building. */
  muted?: boolean;
}

/** A hover tooltip. x and y are where the pointer is; the tooltip is fitted inside the map when it is drawn. */
interface Tip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

type FC = { type: "FeatureCollection"; features: { type: "Feature"; properties: Record<string, unknown>; geometry: unknown }[] };
const fc = (features: FC["features"]): FC => ({ type: "FeatureCollection", features });
type SetDataArg = Parameters<GeoJSONSource["setData"]>[0];

function cameraOf(map: MapLibre): MapCamera {
  const c = map.getCenter();
  return { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
}

/**
 * Where a camera move that has just started will end. This is saved straight away: if the map
 * is rebuilt while the move is still running, the new map opens at the end point and not half way.
 */
const heading = (map: MapLibre, to: Partial<MapCamera>): MapCamera => ({ ...cameraOf(map), ...to });

/**
 * Where the camera goes for an offer building: on the stated point, close enough to take in the
 * buffer ring. With `tilt`, a building drawn as a block is looked at from an angle, so the block is
 * seen standing. An approximate location has no block and is looked at as the camera already is.
 */
function offerCamera(mark: OfferMark, roomPx: number, tilt: boolean): Pick<MapCamera, "center" | "zoom"> & Partial<MapCamera> {
  return { center: [mark.lon, mark.lat], zoom: offerZoom(mark.lat, mark.bufferM, roomPx), ...(tilt && mark.block ? { pitch: OFFER_PITCH, bearing: OFFER_BEARING } : {}) };
}

/** The point the call-out is tied to: the middle of the block's base, or the stated point when there is no block. */
const calloutAt = (mark: OfferMark): [number, number] => mark.block?.centre ?? [mark.lon, mark.lat];

/** Room left between the call-out and the block, and between the call-out and the edge of the map, in pixels. */
const CALLOUT_GAP = 14;
const CALLOUT_EDGE = 6;
/** The leader line meets the card at least this far in from the card's corner, in pixels. */
const LEADER_INSET = 10;

/**
 * How far above its base the roof of a block stands on screen, in pixels, for the camera as it is.
 * Two short steps on the ground, east and north, show how many pixels a metre takes across the
 * view (the direction a tilt does not shorten); the height is that scale seen from the tilt.
 * A little is added because the roof is nearer the camera than the ground is.
 */
function roofLift(map: MapLibre, at: [number, number], heightM: number): number {
  const pitch = (map.getPitch() * Math.PI) / 180;
  if (!(pitch > 0) || !(heightM > 0)) return 0;
  const stepM = 20;
  const o = map.project(at);
  const e = map.project(offsetPoint(at[1], at[0], stepM, 0));
  const n = map.project(offsetPoint(at[1], at[0], 0, stepM));
  const a = (e.x - o.x) / stepM;
  const b = (n.x - o.x) / stepM;
  const c = (e.y - o.y) / stepM;
  const d = (n.y - o.y) / stepM;
  const sum = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  const pixelsPerMetre = Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2);
  return heightM * pixelsPerMetre * Math.sin(pitch) * 1.12;
}

/**
 * Puts the call-out's card and its leader line in place for the camera as it is. Everything is
 * measured in pixels from the marker's own point, which the map keeps on the middle of the block's
 * base. The card goes above the block and never over it; where the map has no room above, it goes
 * to the right, to the left, or underneath. The line runs from the card to the middle of the roof.
 */
function placeCallout(map: MapLibre, mark: OfferMark, card: HTMLElement, line: HTMLElement) {
  const at = calloutAt(mark);
  const origin = map.project(at);
  // What the call-out must stay clear of: the block as it stands on screen, or the ring of an approximate location.
  const ring = APPROXIMATE_RING_PX + 3;
  let left = -ring;
  let right = ring;
  let top = -ring;
  let bottom = ring;
  let roof = 0;
  if (mark.block) {
    roof = -roofLift(map, at, mark.block.heightM);
    left = right = bottom = 0;
    top = roof;
    for (const corner of mark.block.rings[0]) {
      const p = map.project(corner);
      left = Math.min(left, p.x - origin.x);
      right = Math.max(right, p.x - origin.x);
      top = Math.min(top, p.y - origin.y + roof);
      bottom = Math.max(bottom, p.y - origin.y);
    }
  }
  const host = map.getContainer();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  // How far the card's top left corner may go and still be inside the map.
  const minX = CALLOUT_EDGE - origin.x;
  const maxX = host.clientWidth - CALLOUT_EDGE - origin.x - w;
  const minY = CALLOUT_EDGE - origin.y;
  const maxY = host.clientHeight - CALLOUT_EDGE - origin.y - h;
  const within = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const beside = right + CALLOUT_GAP <= maxX ? "right" : left - CALLOUT_GAP - w >= minX ? "left" : null;
  const where = top - CALLOUT_GAP - h >= minY ? "above" : (beside ?? (bottom + CALLOUT_GAP <= maxY ? "below" : "above"));
  let x: number;
  let y: number;
  let box: { x: number; y: number; w: number; h: number };
  if (where === "above" || where === "below") {
    // Centred over the block, and moved sideways only as far as keeps it inside the map and over its own line.
    x = Math.min(-LEADER_INSET, Math.max(LEADER_INSET - w, within(-w / 2, minX, maxX)));
    y = where === "above" ? top - CALLOUT_GAP - h : bottom + CALLOUT_GAP;
    box = where === "above" ? { x: -1, y: y + h, w: 2, h: roof - (y + h) } : { x: -1, y: bottom, w: 2, h: CALLOUT_GAP };
  } else {
    x = where === "right" ? right + CALLOUT_GAP : left - CALLOUT_GAP - w;
    y = Math.min(roof - LEADER_INSET, Math.max(roof + LEADER_INSET - h, within(roof - h / 2, minY, maxY)));
    box = where === "right" ? { x: 0, y: roof - 1, w: x, h: 2 } : { x: x + w, y: roof - 1, w: -(x + w), h: 2 };
  }
  card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  line.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
  line.style.width = `${Math.max(0, Math.round(box.w))}px`;
  line.style.height = `${Math.max(0, Math.round(box.h))}px`;
}

/** Fetches the open basemap style; falls back to a plain background when there is no connection. */
async function loadStyle(dark: boolean, plane: string): Promise<{ style: StyleSpecification; online: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4500);
  try {
    const res = await fetch(dark ? STYLE_URLS.dark : STYLE_URLS.light, { signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return { style: (await res.json()) as StyleSpecification, online: true };
  } catch {
    return { style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": plane } }] }, online: false };
  } finally {
    clearTimeout(timer);
  }
}

export function RiskMap(props: Props) {
  const { session, active, geo, k, layers, threeD, wardMetric, wardRows, facilityDepth, selection, focus, viewRef, fullscreenHost, offer = null, muted = false } = props;
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tipBox = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const onlineRef = useRef(false);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const [ready, setReady] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const hazardUrls = useRef<string[]>([]);
  const [hazardReady, setHazardReady] = useState(0);
  // The offer building's call-out is drawn by React into an element the map moves about as a marker.
  // Pointer events pass through it, so a drag or a scroll that starts on the call-out still reaches the map.
  const [calloutHost] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const el = document.createElement("div");
    el.className = "pointer-events-none";
    return el;
  });
  const calloutCard = useRef<HTMLDivElement>(null);
  const calloutLine = useRef<HTMLDivElement>(null);
  const calloutMarker = useRef<Marker | null>(null);
  const placeNow = useRef<(() => void) | null>(null);
  // True when the map is zoomed far out: the call-out is then a small pill with the name.
  const [far, setFar] = useState(false);

  const { dataset } = session;
  const r = active.result;

  // ---- one-time map set-up -------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let map: MapLibre | null = null;
    (async () => {
      const plane = rgbCss(cssColor("--plane", [236, 240, 244]));
      const { style, online } = await loadStyle(currentTheme() === "dark", plane);
      if (disposed || !box.current) return;
      onlineRef.current = online;
      latest.current.onStatus(online ? "online" : "offline");

      // A map rebuilt for a theme change opens where the last one was looking. The first map opens on the
      // offer building when there is one, tilted so its block is seen standing, and is marked as having
      // gone there so no effect moves it again; otherwise it opens on the county.
      const saved = viewRef.current.camera;
      const mark = latest.current.offer ?? null;
      if (!saved && mark) viewRef.current.offerKey = mark.key;
      const opening = saved ?? (mark ? offerCamera(mark, Math.min(box.current.clientWidth, box.current.clientHeight), !latest.current.threeD) : null);
      const start = geo.county?.features[0] ? geometryBBox(geo.county.features[0].geometry) : rasterBox(session);
      map = new MapLibre({
        container: box.current,
        style,
        ...(opening ?? {
          bounds: [
            [start[0], start[1]],
            [start[2], start[3]],
          ],
          fitBoundsOptions: { padding: 24 },
        }),
        maxPitch: 75,
        attributionControl: { compact: true, customAttribution: GEO_ATTRIBUTION },
        cooperativeGestures: false,
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
      // The step's frame goes fullscreen, not the map alone, so the control strip and the key come with it.
      map.addControl(new FullscreenButton({ container: fullscreenHost.current ?? undefined }), "top-right");
      map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");

      const keepCamera = () => {
        if (map && !disposed) viewRef.current.camera = cameraOf(map);
      };
      map.on("moveend", keepCamera);
      const watchZoom = () => {
        if (map && !disposed) setFar(map.getZoom() < CALLOUT_FAR_ZOOM);
      };
      map.on("zoom", watchZoom);
      map.on("load", () => {
        if (!map || disposed) return;
        addStaticLayers(map, latest.current, online);
        bindInteractions(map, latest, setTip);
        keepCamera();
        watchZoom();
        setReady(true);
      });
      map.on("error", (e) => {
        // Tile or glyph failures after a lost connection should not break the page.
        if (process.env.NODE_ENV !== "production") console.warn("map:", e.error?.message ?? e);
      });
    })();
    return () => {
      disposed = true;
      map?.remove();
      mapRef.current = null;
      hazardUrls.current.forEach((u) => URL.revokeObjectURL(u));
      hazardUrls.current = [];
    };
    // The map is created once; later changes flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- hazard overlays: one image per scenario, redrawn when the assumptions change ----
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    let cancelled = false;
    const ramp: RGB[] = ["--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5"].map((v) => cssColor(v));
    // Above the ward shading, below the outlines, water lines and labels.
    const before = map.getLayer("wards-line") ? "wards-line" : map.getLayer("settlements-fill") ? "settlements-fill" : firstSymbolId(map);
    (async () => {
      const urls: string[] = [];
      for (let i = 0; i < r.scenarios.length; i++) {
        const s = r.scenarios[i];
        const raster = dataset.rasters.find((x) => x.scenarioId === s.id);
        const id = `haz-${i}`;
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
        if (!raster) continue;
        // With drainage on, a cell shows whichever is deeper: terrain flooding or drainage ponding.
        const d = dataset.drainage;
        const src = dataset.scenarios.findIndex((x) => x.id === s.id);
        const ponding = d && d.grid.width === raster.width && d.grid.height === raster.height ? (d.depthM[src] ?? 0) : 0;
        const url = await hazardImageUrl(raster, dataset.hazardKind, (v, cell) => Math.max(hazardToDepth(v, dataset, r.params, s.tierSlope), ponding > 0 ? d!.grid.stress[cell] * ponding : 0), ramp);
        // The map was rebuilt or the assumptions changed while this image was being painted.
        // The map may be gone, so it is not touched again, and nothing from this pass is kept.
        if (cancelled) {
          [...urls, url].forEach((u) => URL.revokeObjectURL(u));
          return;
        }
        urls.push(url);
        map.addSource(id, { type: "image", url, coordinates: rasterCorners(raster.bbox) });
        map.addLayer(
          { id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-fade-duration": 0, "raster-resampling": "nearest", "raster-opacity-transition": { duration: 450, delay: 0 } } },
          before,
        );
      }
      hazardUrls.current.forEach((u) => URL.revokeObjectURL(u));
      hazardUrls.current = urls;
      setHazardReady((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, r, dataset]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    r.scenarios.forEach((_, i) => {
      const id = `haz-${i}`;
      if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", layers.hazard && i === k ? 0.85 : 0);
    });
  }, [ready, hazardReady, k, layers.hazard, r.scenarios]);

  // ---- drainage zone: where ponding can occur, shaded by drainage stress ---------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const id = "drainage-zone";
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
    const d = dataset.drainage;
    if (!d) return;
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      const painted = await stressImageUrl(d.grid, DRAINAGE_RGB);
      // Painted too late: the map was rebuilt or the data changed in the meantime.
      if (cancelled) return URL.revokeObjectURL(painted);
      url = painted;
      map.addSource(id, { type: "image", url, coordinates: rasterCorners(d.grid.bbox) });
      map.addLayer(
        { id, type: "raster", source: id, layout: { visibility: latest.current.layers.drainage ? "visible" : "none" }, paint: { "raster-opacity": 0.8, "raster-fade-duration": 0, "raster-resampling": "nearest" } },
        map.getLayer("wards-line") ? "wards-line" : firstSymbolId(map),
      );
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ready, dataset]);

  // ---- portfolio points and 3D loss columns ----------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const maxTiv = Math.max(...dataset.buildings.map((b) => b.tivKes), 1);
    const rarest = r.scenarios.length - 1;
    const maxLoss = Math.max(...r.buildings.map((b) => b.perScenario[rarest]?.lossKes ?? 0), 1);
    const points = dataset.buildings.map((b, i) => {
      const p = r.buildings[i].perScenario[k];
      return {
        type: "Feature" as const,
        properties: { i, cls: b.housingClass, rad: Math.sqrt(b.tivKes / maxTiv), wet: p.depthM > 0 ? 1 : 0, loss: p.lossKes },
        geometry: { type: "Point", coordinates: [b.lon, b.lat] },
      };
    });
    const half = 0.0011;
    const columns = dataset.buildings.flatMap((b, i) => {
      const loss = r.buildings[i].perScenario[k].lossKes;
      if (!(loss > 0)) return [];
      const ring = [
        [b.lon - half, b.lat - half],
        [b.lon + half, b.lat - half],
        [b.lon + half, b.lat + half],
        [b.lon - half, b.lat + half],
        [b.lon - half, b.lat - half],
      ];
      return [{ type: "Feature" as const, properties: { i, cls: b.housingClass, h: 60 + (loss / maxLoss) * 2600 }, geometry: { type: "Polygon", coordinates: [ring] } }];
    });
    (map.getSource("buildings") as GeoJSONSource | undefined)?.setData(fc(points) as unknown as SetDataArg);
    (map.getSource("columns") as GeoJSONSource | undefined)?.setData(fc(columns) as unknown as SetDataArg);
  }, [ready, k, r, dataset]);

  // ---- wards: accumulation choropleth ------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !geo.wards) return;
    const value = (row: AreaRow) =>
      wardMetric === "loss" ? row.lossKes : wardMetric === "tiv" ? row.tivKes : wardMetric === "flooded" ? row.flooded : row.tivKes > 0 ? row.lossKes / row.tivKes : 0;
    const values = geo.wards.features.map((_, i) => (wardRows[i] ? value(wardRows[i]) : 0));
    const max = Math.max(...values, 0);
    const features = geo.wards.features.map((f, i) => ({
      type: "Feature" as const,
      properties: { i, name: f.properties.name, n: max > 0 ? values[i] / max : 0 },
      geometry: f.geometry,
    }));
    (map.getSource("wards") as GeoJSONSource | undefined)?.setData(fc(features) as unknown as SetDataArg);
  }, [ready, geo.wards, wardRows, wardMetric]);

  // ---- hotspots: hit or missed under the hazard view in force --------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features = session.hits.map((h) => ({ type: "Feature" as const, properties: { name: h.name, hit: h.hit ? 1 : 0 }, geometry: { type: "Point", coordinates: [h.lon, h.lat] } }));
    (map.getSource("hotspots") as GeoJSONSource | undefined)?.setData(fc(features) as unknown as SetDataArg);
  }, [ready, session.hits]);

  // ---- facilities: flagged when the flood reaches them -------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !geo.facilities) return;
    const features = geo.facilities.features.map((f, i) => ({
      type: "Feature" as const,
      properties: { i, kind: f.properties.kind, wet: (facilityDepth[i]?.[k] ?? 0) > 0 ? 1 : 0 },
      geometry: f.geometry,
    }));
    (map.getSource("facilities") as GeoJSONSource | undefined)?.setData(fc(features) as unknown as SetDataArg);
  }, [ready, geo.facilities, facilityDepth, k]);

  // ---- selection highlight and camera --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const none: FilterSpecification = ["==", ["get", "i"], -1];
    map.setFilter("buildings-selected", selection?.type === "building" ? ["==", ["get", "i"], selection.index] : none);
    if (map.getLayer("wards-selected")) map.setFilter("wards-selected", selection?.type === "ward" ? ["==", ["get", "i"], selection.index] : none);
    // The camera goes to a building once, when it is picked. A rebuilt map shows the same
    // selection again and opens where the camera already was, so it stays highlighted without a move.
    const view = viewRef.current;
    const moved = view.selection === selection;
    view.selection = selection;
    if (selection?.type === "building" && !moved) {
      const b = dataset.buildings[selection.index];
      if (b) {
        const to = { center: [b.lon, b.lat] as [number, number], zoom: Math.max(map.getZoom(), 13.2) };
        map.easeTo({ ...to, duration: 900 });
        view.camera = heading(map, to);
      }
    }
  }, [ready, selection, dataset, viewRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focus) return;
    // Each ward pick is fitted once, so a rebuilt map does not fly back to a ward picked earlier.
    const view = viewRef.current;
    if (view.focusSeq === focus.seq) return;
    view.focusSeq = focus.seq;
    const bounds: [[number, number], [number, number]] = [
      [focus.bbox[0], focus.bbox[1]],
      [focus.bbox[2], focus.bbox[3]],
    ];
    const fit = { padding: 70, maxZoom: 14.5 };
    const end = map.cameraForBounds(bounds, fit);
    map.fitBounds(bounds, { ...fit, duration: 1100 });
    if (end?.center) {
      const c = LngLat.convert(end.center);
      view.camera = heading(map, { center: [c.lng, c.lat], zoom: end.zoom ?? map.getZoom(), bearing: end.bearing ?? 0 });
    }
  }, [ready, focus, viewRef]);

  // ---- layer switches -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const groups: Record<Exclude<LayerKey, "hazard">, string[]> = {
      drainage: ["drainage-zone"],
      buildings: ["buildings-selected"],
      wards: ["wards-fill", "wards-line", "wards-hover", "wards-selected", "wards-label", "subcounties-line"],
      waterways: ["waterways-line"],
      settlements: ["settlements-fill", "settlements-line"],
      facilities: ["facilities"],
      hotspots: ["hotspots", "hotspots-label"],
      buffer: ["offer-buffer-casing", "offer-buffer-line"],
    };
    for (const [key, ids] of Object.entries(groups) as [Exclude<LayerKey, "hazard">, string[]][]) {
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", layers[key] ? "visible" : "none");
    }
    // In 3D the loss columns replace the building dots.
    if (map.getLayer("columns")) map.setLayoutProperty("columns", "visibility", threeD && layers.buildings ? "visible" : "none");
    if (map.getLayer("buildings")) map.setLayoutProperty("buildings", "visibility", !threeD && layers.buildings ? "visible" : "none");
  }, [ready, layers, threeD]);

  // ---- 3D: terrain from open elevation tiles, tilted camera ------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    // The camera tilts or flattens only when the 3D switch changes. A rebuilt map opens with the
    // tilt and turn it had, so it gets its terrain back and is otherwise left alone. A first map
    // with the switch off has nothing to flatten: it opens flat, or on the tilt an offer building gives it.
    const view = viewRef.current;
    const moved = view.threeD === threeD || (view.threeD === null && !threeD);
    view.threeD = threeD;
    if (!threeD) map.setTerrain(null);
    else if (onlineRef.current && map.getSource("dem")) map.setTerrain({ source: "dem", exaggeration: 1.8 });
    if (moved) return;
    const to = threeD ? { pitch: 62, bearing: -18, zoom: Math.max(map.getZoom(), 11) } : { pitch: 0, bearing: 0 };
    map.easeTo({ ...to, duration: threeD ? 1400 : 900 });
    view.camera = heading(map, to);
  }, [ready, threeD, viewRef]);

  // ---- portfolio buildings as the setting around an offer: smaller and fainter -------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("buildings")) return;
    const paint = buildingPaint(muted);
    map.setPaintProperty("buildings", "circle-radius", paint.radius);
    map.setPaintProperty("buildings", "circle-opacity", paint.opacity);
    map.setPaintProperty("buildings", "circle-stroke-width", paint.strokeWidth);
  }, [ready, muted]);

  // ---- the offer building: its block or its ring, filled in again on every rebuilt map -----------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    // An exact position is a block standing on its base. An approximate one is a ring and no block.
    const block = offer?.block && !offer.approximate ? [{ type: "Feature" as const, properties: { h: offer.block.heightM }, geometry: { type: "Polygon", coordinates: offer.block.rings } }] : [];
    const point = offer?.approximate ? [{ type: "Feature" as const, properties: {}, geometry: { type: "Point", coordinates: [offer.lon, offer.lat] } }] : [];
    (map.getSource("offer-block") as GeoJSONSource | undefined)?.setData(fc(block) as unknown as SetDataArg);
    (map.getSource("offer-point") as GeoJSONSource | undefined)?.setData(fc(point) as unknown as SetDataArg);
    // The buffer ring is drawn again whenever its radius changes. With the point reading in force there is none.
    const ring = offer && offer.bufferM !== null && offer.bufferM > 0 ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString", coordinates: bufferRing(offer.lat, offer.lon, offer.bufferM) } }] : [];
    (map.getSource("offer-buffer") as GeoJSONSource | undefined)?.setData(fc(ring) as unknown as SetDataArg);
  }, [ready, offer]);

  // ---- the offer building's call-out: a marker the map keeps on the building ------------------------
  const hasOffer = offer !== null;
  useEffect(() => {
    const map = mapRef.current;
    const mark = latest.current.offer;
    if (!ready || !map || !calloutHost || !mark) return;
    // The terrain of the 3D view never fades the call-out: it stays readable wherever the camera is.
    const marker = new Marker({ element: calloutHost, anchor: "center", opacityWhenCovered: 1 }).setLngLat(calloutAt(mark)).addTo(map);
    const place = () => {
      const now = latest.current.offer;
      if (now && calloutCard.current && calloutLine.current) placeCallout(map, now, calloutCard.current, calloutLine.current);
    };
    calloutMarker.current = marker;
    placeNow.current = place;
    // The card changes size with its words, the text size and the zoom. Each time, it is put back in its place.
    const watch = new ResizeObserver(place);
    if (calloutCard.current) watch.observe(calloutCard.current);
    map.on("move", place);
    map.on("resize", place);
    map.on("terrain", place);
    place();
    return () => {
      map.off("move", place);
      map.off("resize", place);
      map.off("terrain", place);
      watch.disconnect();
      marker.remove();
      calloutMarker.current = null;
      placeNow.current = null;
    };
  }, [ready, hasOffer, calloutHost]);

  // The call-out follows the block: to a new building, and to an outline or a height that arrives later.
  useEffect(() => {
    if (!offer) return;
    calloutMarker.current?.setLngLat(calloutAt(offer));
    placeNow.current?.();
  }, [ready, offer, far]);

  // This effect comes after the others that move the camera, so on a new offer its move is the one that stands.
  const offerKey = offer?.key ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    // The camera goes to an offer building once. A rebuilt map, and an outline that arrives later, do not move it again.
    const view = viewRef.current;
    if (view.offerKey === offerKey) return;
    view.offerKey = offerKey;
    const at = latest.current.offer;
    if (!at) {
      // The offer is no longer followed. The tilt this effect gave is taken back, unless the reader has changed it or the 3D view is on.
      if (!latest.current.threeD && Math.abs(map.getPitch() - OFFER_PITCH) < 0.5 && Math.abs(map.getBearing() - OFFER_BEARING) < 0.5) {
        const flat = { pitch: 0, bearing: 0 };
        map.easeTo({ ...flat, duration: 900 });
        view.camera = heading(map, flat);
      }
      return;
    }
    // The camera tilts once, so the block is seen standing. With the 3D view on, the tilt of that view is kept.
    const size = map.getContainer();
    const to = offerCamera(at, Math.min(size.clientWidth, size.clientHeight), !latest.current.threeD);
    map.easeTo({ ...to, duration: 1100 });
    view.camera = heading(map, to);
  }, [ready, offerKey, viewRef]);

  // The tooltip is measured as drawn and kept inside the map, so it is not cut off at the right
  // or bottom edge at any text size, in the page or in fullscreen.
  useLayoutEffect(() => {
    const el = tipBox.current;
    const host = stage.current;
    if (!tip || !el || !host) return;
    const left = Math.max(4, Math.min(tip.x + 14, host.clientWidth - el.offsetWidth - 4));
    const below = tip.y + 14;
    // With no room under the pointer the tooltip opens above it.
    const top = below + el.offsetHeight > host.clientHeight - 4 ? Math.max(4, tip.y - 10 - el.offsetHeight) : below;
    el.style.transform = `translate(${left}px, ${top}px)`;
  }, [tip]);

  // The map fills the box the map step gives it, beside the key and under the control strip. It is a
  // container, so the call-out can drop lines on a narrow map whatever the text size.
  return (
    <div ref={stage} className="@container absolute inset-0 overflow-hidden bg-surface-2">
      <div ref={box} className="h-full w-full" />
      {/* The offer building's call-out. The map holds the element and moves it; placeCallout sets the card and the line.
          On a narrow map it keeps the name and the water line, and from far out it is a pill with the name and a small square where the building is. */}
      {calloutHost &&
        offer &&
        createPortal(
          <>
            <div ref={calloutLine} aria-hidden className="absolute left-0 top-0 rounded-full bg-brand ring-1 ring-surface" />
            {far && offer.block && <span aria-hidden className="absolute left-0 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border border-surface bg-brand" />}
            <div
              ref={calloutCard}
              role="img"
              aria-label={offer.callout.spoken}
              className={`absolute left-0 top-0 w-max max-w-[min(17rem,calc(100cqw-1rem))] bg-surface font-sans text-xs leading-snug shadow-lg ${far ? "rounded-full border border-brand px-2.5 py-0.5" : "rounded-lg border border-l-4 border-line border-l-brand px-2.5 py-1.5"}`}
            >
              <div className={`truncate font-semibold text-ink ${far ? "" : "text-sm"}`}>{offer.name}</div>
              {!far && (
                <>
                  {offer.callout.about && <div className="hidden text-ink-2 @md:block">{offer.callout.about}</div>}
                  <div className="tabular text-ink">{offer.callout.water}</div>
                  {offer.callout.loss && <div className="tabular hidden text-ink-2 @md:block">{offer.callout.loss}</div>}
                  {offer.callout.note && <div className="hidden text-muted @md:block">{offer.callout.note}</div>}
                </>
              )}
            </div>
          </>,
          calloutHost,
        )}
      {/* The notice fades in after a moment, so a quick rebuild for a theme change does not flash it. */}
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-2 transition-opacity delay-300 duration-200 starting:opacity-0">
          <span className="spinner mr-2 inline-block h-4 w-4 shrink-0 rounded-full border-2 border-line border-t-ink" /> Loading the map
        </div>
      )}
      {tip && (
        <div ref={tipBox} className="pointer-events-none absolute left-0 top-0 z-10 max-w-[min(16.25rem,calc(100%-0.5rem))] wrap-break-word rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
          <div className="font-semibold text-ink">{tip.title}</div>
          {tip.lines.map((l) => (
            <div key={l} className="tabular text-ink-2">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function rasterBox(session: Session): BBox {
  const r = session.dataset.rasters[0];
  if (r) return r.bbox;
  const lons = session.dataset.buildings.map((b) => b.lon);
  const lats = session.dataset.buildings.map((b) => b.lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

function firstSymbolId(map: MapLibre): string | undefined {
  return map.getStyle().layers.find((l) => l.type === "symbol" && !["wards-label", "hotspots-label"].includes(l.id))?.id;
}

/** How the portfolio's building dots are drawn: at full strength, or smaller and fainter around an offer building. */
function buildingPaint(muted: boolean): { radius: ExpressionSpecification; opacity: ExpressionSpecification; strokeWidth: ExpressionSpecification } {
  const size = muted ? 0.6 : 1;
  return {
    radius: ["interpolate", ["linear"], ["zoom"], 10, ["+", 2.5 * size, ["*", ["get", "rad"], 9 * size]], 15, ["+", 5 * size, ["*", ["get", "rad"], 20 * size]]],
    opacity: ["case", ["==", ["get", "wet"], 1], muted ? 0.6 : 0.95, muted ? 0.28 : 0.45],
    strokeWidth: ["case", [">", ["get", "loss"], 0], muted ? 1.2 : 2, 0.8],
  };
}

/** Adds every source and layer once. Data that changes with the scenario is filled in by the effects. */
function addStaticLayers(map: MapLibre, p: Props, online: boolean) {
  const empty = fc([]) as unknown as SetDataArg;
  const before = firstSymbolId(map);
  const ink = rgbCss(cssColor("--ink", [13, 27, 46]));
  const surface = rgbCss(cssColor("--surface", [255, 255, 255]));
  const navyLine = rgbCss(cssColor("--navy-line"));
  const series = ["--series-1", "--series-2", "--series-3", "--series-4"].map((v) => rgbCss(cssColor(v)));
  const classColor = ["match", ["get", "cls"], "informal_iron_sheet", series[0], "semi_permanent", series[1], "permanent_masonry", series[2], "concrete_rcc", series[3], "#888888"] as unknown as ExpressionSpecification;

  if (online) {
    map.addSource("dem", { type: "raster-dem", tiles: [TERRAIN_TILES], tileSize: 256, encoding: "terrarium", maxzoom: 15, attribution: "Terrain: Mapzen Terrain Tiles on AWS" });
    map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.28, "hillshade-shadow-color": currentTheme() === "dark" ? "#000814" : "#33475f" } }, before);
  } else if (p.geo.county) {
    map.addSource("county-fill-src", { type: "geojson", data: p.geo.county as unknown as SetDataArg });
    map.addLayer({ id: "county-fill", type: "fill", source: "county-fill-src", paint: { "fill-color": surface } });
  }

  if (p.geo.wards) {
    map.addSource("wards", { type: "geojson", data: empty });
    map.addLayer({ id: "wards-fill", type: "fill", source: "wards", paint: { "fill-color": WARD_COLOR, "fill-opacity": ["interpolate", ["linear"], ["get", "n"], 0, 0.02, 1, 0.55] } }, before);
    map.addLayer({ id: "wards-line", type: "line", source: "wards", paint: { "line-color": navyLine, "line-opacity": 0.35, "line-width": 0.7 } }, before);
    map.addLayer({ id: "wards-hover", type: "line", source: "wards", filter: ["==", ["get", "i"], -1], paint: { "line-color": WARD_COLOR, "line-width": 2.2 } });
    map.addLayer({ id: "wards-selected", type: "line", source: "wards", filter: ["==", ["get", "i"], -1], paint: { "line-color": ink, "line-width": 3 } });
  }
  if (p.geo.settlements) {
    map.addSource("settlements", { type: "geojson", data: p.geo.settlements as unknown as SetDataArg });
    map.addLayer({ id: "settlements-fill", type: "fill", source: "settlements", paint: { "fill-color": SETTLEMENT_COLOR, "fill-opacity": 0.22 } }, before);
    map.addLayer({ id: "settlements-line", type: "line", source: "settlements", paint: { "line-color": SETTLEMENT_COLOR, "line-width": 1.2, "line-dasharray": [2, 1.5] } }, before);
  }
  if (p.geo.waterways) {
    map.addSource("waterways", { type: "geojson", data: p.geo.waterways as unknown as SetDataArg });
    map.addLayer(
      {
        id: "waterways-line",
        type: "line",
        source: "waterways",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["match", ["get", "kind"], "river", WATER_COLORS.river, "stream", WATER_COLORS.stream, "canal", WATER_COLORS.canal, WATER_COLORS.drain],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "kind"], "river", 1.8, "canal", 1.2, 0.6], 15, ["match", ["get", "kind"], "river", 5, "canal", 3, 2]],
          "line-opacity": 0.9,
        },
      },
      before,
    );
  }
  if (p.geo.subcounties) {
    map.addSource("subcounties", { type: "geojson", data: p.geo.subcounties as unknown as SetDataArg });
    map.addLayer({ id: "subcounties-line", type: "line", source: "subcounties", paint: { "line-color": navyLine, "line-width": 1.6, "line-opacity": 0.75 } }, before);
  }
  if (p.geo.county) {
    map.addSource("county", { type: "geojson", data: p.geo.county as unknown as SetDataArg });
    map.addLayer({ id: "county-line", type: "line", source: "county", paint: { "line-color": navyLine, "line-width": 2.6 } }, before);
  }
  if (p.geo.facilities) {
    map.addSource("facilities", { type: "geojson", data: empty });
    map.addLayer({
      id: "facilities",
      type: "circle",
      source: "facilities",
      minzoom: 11,
      paint: {
        "circle-color": ["match", ["get", "kind"], "hospital", FACILITY_COLORS.hospital, "clinic", FACILITY_COLORS.clinic, "school", FACILITY_COLORS.school, "police", FACILITY_COLORS.police, FACILITY_COLORS.fire_station],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["case", ["==", ["get", "wet"], 1], 4, 2], 16, ["case", ["==", ["get", "wet"], 1], 9, 5]],
        "circle-stroke-color": ["case", ["==", ["get", "wet"], 1], ink, surface],
        "circle-stroke-width": ["case", ["==", ["get", "wet"], 1], 1.8, 0.8],
        "circle-opacity": ["case", ["==", ["get", "wet"], 1], 1, 0.7],
      },
    });
  }

  map.addSource("buildings", { type: "geojson", data: empty });
  map.addSource("columns", { type: "geojson", data: empty });
  map.addLayer({
    id: "columns",
    type: "fill-extrusion",
    source: "columns",
    layout: { visibility: "none" },
    paint: { "fill-extrusion-color": classColor, "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.88 },
  });
  const dots = buildingPaint(p.muted ?? false);
  map.addLayer({
    id: "buildings",
    type: "circle",
    source: "buildings",
    paint: {
      "circle-color": classColor,
      "circle-radius": dots.radius,
      "circle-opacity": dots.opacity,
      "circle-stroke-color": ["case", [">", ["get", "loss"], 0], WARD_COLOR, surface],
      "circle-stroke-width": dots.strokeWidth,
    },
  });
  map.addLayer({ id: "buildings-selected", type: "circle", source: "buildings", filter: ["==", ["get", "i"], -1], paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 16, "circle-stroke-color": ink, "circle-stroke-width": 3 } });

  if (p.session.hits.length) {
    const hotspots = fc(p.session.hits.map((h) => ({ type: "Feature" as const, properties: { name: h.name, hit: h.hit ? 1 : 0 }, geometry: { type: "Point", coordinates: [h.lon, h.lat] } })));
    map.addSource("hotspots", { type: "geojson", data: hotspots as unknown as SetDataArg });
    map.addLayer({
      id: "hotspots",
      type: "circle",
      source: "hotspots",
      paint: {
        "circle-radius": 7,
        "circle-color": ["case", ["==", ["get", "hit"], 1], navyLine, surface],
        "circle-stroke-color": ["case", ["==", ["get", "hit"], 1], surface, WARD_COLOR],
        "circle-stroke-width": ["case", ["==", ["get", "hit"], 1], 2, 3],
      },
    });
    if (online) {
      map.addLayer({
        id: "hotspots-label",
        type: "symbol",
        source: "hotspots",
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 1.25], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 1.6 },
      });
    }
  }
  if (online && p.geo.wards) {
    map.addLayer({
      id: "wards-label",
      type: "symbol",
      source: "wards",
      minzoom: 12,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-optional": true },
      paint: { "text-color": navyLine, "text-halo-color": surface, "text-halo-width": 1.4, "text-opacity": 0.85 },
    });
  }

  // The offer building goes on last, so it lies above every other layer. The sources start empty and are
  // filled by an effect, which runs again on a rebuilt map.
  const brandRgb = cssColor("--brand", [209, 18, 66]);
  const brand = rgbCss(brandRgb);
  map.addSource("offer-block", { type: "geojson", data: empty });
  map.addSource("offer-point", { type: "geojson", data: empty });
  map.addSource("offer-buffer", { type: "geojson", data: empty });
  // The buffer ring: a dashed line, so it is told apart from the solid ring of an approximate location by its
  // shape as well as its size. A pale line under it keeps it readable over deep water and on either basemap.
  const ringWidth: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 2.5];
  const casingWidth: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 11, 4, 16, 5.5];
  map.addLayer({ id: "offer-buffer-casing", type: "line", source: "offer-buffer", paint: { "line-color": surface, "line-opacity": 0.85, "line-width": casingWidth } });
  map.addLayer({ id: "offer-buffer-line", type: "line", source: "offer-buffer", paint: { "line-color": brand, "line-width": ringWidth, "line-dasharray": [3, 2] } });
  // The block's base: a dark line on a pale one, drawn under the block. Seen from straight above, the block is a
  // filled shape and the line is its edge, so it reads in the flat view; seen from a tilt, the walls rise from it.
  const baseWidth: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 13, 3, 18, 6];
  const baseCasingWidth: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 13, 6, 18, 10];
  map.addLayer({ id: "offer-block-casing", type: "line", source: "offer-block", layout: { "line-join": "round" }, paint: { "line-color": surface, "line-width": baseCasingWidth } });
  map.addLayer({ id: "offer-block-line", type: "line", source: "offer-block", layout: { "line-join": "round" }, paint: { "line-color": ink, "line-width": baseWidth } });
  // The building itself: one solid block in the brand colour, as tall as the step says. Its name is in the call-out, not in a map label.
  map.addLayer({ id: "offer-block", type: "fill-extrusion", source: "offer-block", paint: { "fill-extrusion-color": brand, "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 1 } });
  // An approximate location has no block. It keeps its ring at every zoom: the ring says "somewhere about here".
  map.addLayer({ id: "offer-ring", type: "circle", source: "offer-point", paint: { "circle-radius": APPROXIMATE_RING_PX, "circle-color": rgbCss(brandRgb, 0.12), "circle-stroke-color": brand, "circle-stroke-width": 2.5 } });
}

const OFFER_LAYERS = ["offer-ring", "offer-block", "offer-block-line"];
const BUFFER_LAYER = "offer-buffer-casing";
const INTERACTIVE = [...OFFER_LAYERS, BUFFER_LAYER, "buildings", "columns", "hotspots", "facilities", "settlements-fill", "wards-fill"];

/** Where the water at a portfolio building comes from, in the words used across the app. */
function waterFrom(t: BuildingScenarioResult): string {
  const d = t.drivers;
  // Depth only: the terrain depth at the point, or drainage ponding where that is deeper.
  if (!d) return t.drainageM > 0 && t.drainageM >= t.depthM ? " (drainage ponding)" : " at the point";
  if (d.pointM >= d.surfaceM) return " at the point";
  if (d.bufferM >= d.surfaceM) return " within the buffer";
  if (d.pondingM >= d.surfaceM) return " (drainage ponding)";
  return " (drain overload)";
}

/** Hover tooltips and clicks. Reads the latest props through a ref so the handlers are bound once. */
function bindInteractions(map: MapLibre, latest: { current: Props }, setTip: (t: Tip | null) => void) {
  const layersPresent = () => INTERACTIVE.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none");

  const place = (e: MapMouseEvent) => ({ x: e.point.x, y: e.point.y });

  map.on("mousemove", (e: MapMouseEvent) => {
    const p = latest.current;
    const hit = map.queryRenderedFeatures(e.point, { layers: layersPresent() })[0];
    map.getCanvas().style.cursor = hit && ["buildings", "columns", "wards-fill"].includes(hit.layer.id) ? "pointer" : "";
    const hoverWard = hit?.layer.id === "wards-fill" ? Number(hit.properties.i) : -1;
    if (map.getLayer("wards-hover")) map.setFilter("wards-hover", ["==", ["get", "i"], hoverWard]);
    if (!hit) return setTip(null);
    const props = hit.properties as Record<string, unknown>;
    const s = p.active.result.scenarios[p.k];
    const event = `${rpLabel(s.returnPeriod)} event`;
    if (OFFER_LAYERS.includes(hit.layer.id)) {
      if (!p.offer) return setTip(null);
      setTip({ ...place(e), title: p.offer.name, lines: p.offer.lines });
    } else if (hit.layer.id === BUFFER_LAYER) {
      if (!p.offer || p.offer.bufferM === null) return setTip(null);
      setTip({ ...place(e), title: `Buffer of ${fmtInt(p.offer.bufferM)} m`, lines: p.offer.bufferLines });
    } else if (hit.layer.id === "buildings" || hit.layer.id === "columns") {
      const i = Number(props.i);
      const b = p.session.dataset.buildings[i];
      const t = p.active.result.buildings[i].perScenario[p.k];
      setTip({
        ...place(e),
        title: `${b.locId} · ${HOUSING_LABELS[b.housingClass as HousingClass]}`,
        lines: [
          `Insured value ${fmtKes(b.tivKes, 2)} (synthetic)`,
          t.depthM > 0 ? `${event}: ${fmtNum(t.depthM)} m of water${waterFrom(t)}, ${fmtPct(t.damageRatio, 1)} damage` : `${event}: dry`,
          `Ground-up loss ${fmtKes(t.lossKes, 2)}`,
          "Click to trace the loss",
        ],
      });
    } else if (hit.layer.id === "wards-fill") {
      const row = p.wardRows[Number(props.i)];
      if (!row) return setTip(null);
      setTip({
        ...place(e),
        title: `${row.name} ward · ${row.subcounty}`,
        lines: [
          `${fmtInt(row.buildings)} insured buildings (synthetic), ${fmtKes(row.tivKes)} insured value`,
          `${event}: ${fmtInt(row.flooded)} buildings flooded, ground-up loss ${fmtKes(row.lossKes)}`,
          `Loss is ${fmtPct(row.tivKes > 0 ? row.lossKes / row.tivKes : 0, 1)} of the ward's insured value`,
          "Click to see what the ward holds",
        ],
      });
    } else if (hit.layer.id === "facilities") {
      const i = Number(props.i);
      const f = p.geo.facilities?.features[i];
      const d = p.facilityDepth[i]?.[p.k] ?? 0;
      setTip({ ...place(e), title: f?.properties.name ?? "Unnamed facility", lines: [`${String(props.kind).replace("_", " ")} (OpenStreetMap)`, d > 0 ? `${event}: ${fmtNum(d)} m of water` : `${event}: dry`] });
    } else if (hit.layer.id === "hotspots") {
      setTip({ ...place(e), title: String(props.name), lines: ["County-named flood area", Number(props.hit) === 1 ? (p.session.dataset.drainage ? "Flagged by terrain or the drainage zone" : "Flagged by the hazard proxy") : "Missed: drainage-driven flooding the open maps cannot see"] });
    } else if (hit.layer.id === "settlements-fill") {
      setTip({ ...place(e), title: (props.name as string) || "Informal settlement", lines: ["Informal settlement (OpenStreetMap)"] });
    }
  });
  map.on("mouseout", () => setTip(null));
  map.on("click", (e: MapMouseEvent) => {
    const hit = map.queryRenderedFeatures(e.point, { layers: layersPresent().filter((id) => id === "buildings" || id === "columns" || id === "wards-fill") })[0];
    if (!hit) return latest.current.onSelect(null);
    const i = Number(hit.properties.i);
    latest.current.onSelect(hit.layer.id === "wards-fill" ? { type: "ward", index: i } : { type: "building", index: i });
  });
}
