"use client";

import { FullscreenControl, LngLat, Map as MapLibre, NavigationControl, ScaleControl, setWorkerUrl } from "maplibre-gl";
import type { ExpressionSpecification, FilterSpecification, GeoJSONSource, MapMouseEvent, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentTheme } from "@/lib/display";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { cssColor, hazardImageUrl, rasterCorners, rgbCss, stressImageUrl, type RGB } from "@/lib/geo/hazardImage";
import { GEO_ATTRIBUTION, type GeoLayers } from "@/lib/geo/layers";
import { geometryBBox, type AreaRow, type BBox } from "@/lib/geo/spatial";
import { hazardToDepth } from "@/lib/model/pipeline";
import { rpLabel } from "@/lib/labels";
import { HOUSING_LABELS, type HousingClass } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { DRAINAGE_RGB, FACILITY_COLORS, SETTLEMENT_COLOR, WARD_COLOR, WATER_COLORS, OFFER_ZOOM, type BasemapStatus, type LayerKey, type LayerState, type MapCamera, type MapView, type OfferMark, type Selection, type WardMetric } from "./mapTheme";

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
  const { session, active, geo, k, layers, threeD, wardMetric, wardRows, facilityDepth, selection, focus, viewRef, offer = null, muted = false } = props;
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
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
      // offer building when there is one, and is marked as having gone there so no effect moves it again;
      // otherwise it opens on the county.
      const saved = viewRef.current.camera;
      const mark = latest.current.offer ?? null;
      if (!saved && mark) viewRef.current.offerKey = mark.key;
      const opening = saved ?? (mark ? { center: [mark.lon, mark.lat] as [number, number], zoom: OFFER_ZOOM } : null);
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
      // The frame goes fullscreen, not the map alone, so the hover tooltips come with it.
      map.addControl(new FullscreenButton({ container: frame.current ?? undefined }), "top-right");
      map.addControl(new ScaleControl({ unit: "metric" }), "bottom-left");

      const keepCamera = () => {
        if (map && !disposed) viewRef.current.camera = cameraOf(map);
      };
      map.on("moveend", keepCamera);
      map.on("load", () => {
        if (!map || disposed) return;
        addStaticLayers(map, latest.current, online);
        bindInteractions(map, latest, setTip);
        keepCamera();
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
    // tilt and turn it had, so it gets its terrain back and is otherwise left alone.
    const view = viewRef.current;
    const moved = view.threeD === threeD;
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

  // ---- the offer building: its outline or marker, filled in again on every rebuilt map -----------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const mode = !offer ? "" : offer.approximate ? "approximate" : offer.outline ? "outline" : "marker";
    const point = offer ? [{ type: "Feature" as const, properties: { mode, label: offer.approximate ? `${offer.name} (approximate)` : offer.name }, geometry: { type: "Point", coordinates: [offer.lon, offer.lat] } }] : [];
    const outline = offer?.outline && !offer.approximate ? [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon", coordinates: offer.outline } }] : [];
    (map.getSource("offer-point") as GeoJSONSource | undefined)?.setData(fc(point) as unknown as SetDataArg);
    (map.getSource("offer-outline") as GeoJSONSource | undefined)?.setData(fc(outline) as unknown as SetDataArg);
  }, [ready, offer]);

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
    if (!at) return;
    const to = { center: [at.lon, at.lat] as [number, number], zoom: Math.max(map.getZoom(), OFFER_ZOOM) };
    map.easeTo({ ...to, duration: 1100 });
    view.camera = heading(map, to);
  }, [ready, offerKey, viewRef]);

  // The tooltip is measured as drawn and kept inside the map, so it is not cut off at the right
  // or bottom edge at any text size, in the page or in fullscreen.
  useLayoutEffect(() => {
    const el = tipBox.current;
    const host = frame.current;
    if (!tip || !el || !host) return;
    const left = Math.max(4, Math.min(tip.x + 14, host.clientWidth - el.offsetWidth - 4));
    const below = tip.y + 14;
    // With no room under the pointer the tooltip opens above it.
    const top = below + el.offsetHeight > host.clientHeight - 4 ? Math.max(4, tip.y - 10 - el.offsetHeight) : below;
    el.style.transform = `translate(${left}px, ${top}px)`;
  }, [tip]);

  // The frame fills the box the map step gives it; that box sets the height.
  return (
    <div ref={frame} className="relative h-full w-full overflow-hidden rounded-xl border border-line bg-surface-2">
      <div ref={box} className="h-full w-full" />
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
  return map.getStyle().layers.find((l) => l.type === "symbol" && !["wards-label", "hotspots-label", "offer-label"].includes(l.id))?.id;
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
  const isMode = (mode: string): FilterSpecification => ["==", ["get", "mode"], mode];
  const marker = { "circle-radius": 7, "circle-color": brand, "circle-stroke-color": surface, "circle-stroke-width": 2.5 };
  map.addSource("offer-outline", { type: "geojson", data: empty });
  map.addSource("offer-point", { type: "geojson", data: empty });
  map.addLayer({ id: "offer-outline-fill", type: "fill", source: "offer-outline", paint: { "fill-color": brand, "fill-opacity": 0.22 } });
  map.addLayer({ id: "offer-outline-line", type: "line", source: "offer-outline", layout: { "line-join": "round" }, paint: { "line-color": brand, "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2, 18, 4.5] } });
  // An approximate location keeps its ring at every zoom: the ring says "somewhere about here".
  map.addLayer({ id: "offer-ring", type: "circle", source: "offer-point", filter: isMode("approximate"), paint: { "circle-radius": 24, "circle-color": rgbCss(brandRgb, 0.12), "circle-stroke-color": brand, "circle-stroke-width": 2.5 } });
  // From far away an outline is a speck, so an exact location gets a ring and a marker until the map is close.
  map.addLayer({ id: "offer-ring-far", type: "circle", source: "offer-point", maxzoom: 15, filter: ["!=", ["get", "mode"], "approximate"], paint: { "circle-radius": 17, "circle-color": rgbCss(brandRgb, 0), "circle-stroke-color": brand, "circle-stroke-width": 2.5 } });
  map.addLayer({ id: "offer-point-far", type: "circle", source: "offer-point", maxzoom: 15, filter: isMode("outline"), paint: marker });
  map.addLayer({ id: "offer-point", type: "circle", source: "offer-point", filter: ["!=", ["get", "mode"], "outline"], paint: marker });
  if (online) {
    map.addLayer({
      id: "offer-label",
      type: "symbol",
      source: "offer-point",
      layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-offset": [0, 1.5], "text-anchor": "top", "text-max-width": 12, "text-allow-overlap": true, "text-ignore-placement": true },
      paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 2 },
    });
  }
}

const OFFER_LAYERS = ["offer-point", "offer-point-far", "offer-ring", "offer-ring-far", "offer-outline-fill"];
const INTERACTIVE = [...OFFER_LAYERS, "buildings", "columns", "hotspots", "facilities", "settlements-fill", "wards-fill"];

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
    } else if (hit.layer.id === "buildings" || hit.layer.id === "columns") {
      const i = Number(props.i);
      const b = p.session.dataset.buildings[i];
      const t = p.active.result.buildings[i].perScenario[p.k];
      setTip({
        ...place(e),
        title: `${b.locId} · ${HOUSING_LABELS[b.housingClass as HousingClass]}`,
        lines: [
          `Insured value ${fmtKes(b.tivKes, 2)} (synthetic)`,
          t.depthM > 0 ? `${event}: ${fmtNum(t.depthM)} m of water${t.drainageM > 0 && t.drainageM >= t.depthM ? " (drainage ponding)" : ""}, ${fmtPct(t.damageRatio, 1)} damage` : `${event}: dry`,
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
