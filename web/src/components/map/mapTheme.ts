/** Shared between the map, its control strip and its key. Kept apart from RiskMap so they can render without loading the map library. */

import type { Position } from "@/lib/geo/layers";

/** The layers the reader can switch on and off. "buffer" is the ring around an offer building; the building itself is always shown. */
export type LayerKey = "hazard" | "drainage" | "buildings" | "wards" | "waterways" | "settlements" | "facilities" | "hotspots" | "buffer";
export type LayerState = Record<LayerKey, boolean>;
export type WardMetric = "loss" | "tiv" | "flooded" | "lossRatio";
export type Selection = { type: "building"; index: number } | { type: "ward"; index: number };
export type BasemapStatus = "loading" | "online" | "offline";

/** Where the camera is looking: centre as [longitude, latitude], zoom, tilt and compass turn. */
export interface MapCamera {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

/**
 * What a rebuilt map needs to open on the view the reader left. The basemap and the painted
 * layers take their colours when the map is created, so a theme change builds a new map.
 * The step owns one of these and the map keeps it up to date.
 */
export interface MapView {
  /** Null until a map has been shown. */
  camera: MapCamera | null;
  /** The 3D setting, selection and ward focus the camera has already moved for. A rebuilt map does not move for them again. */
  threeD: boolean | null;
  selection: Selection | null;
  focusSeq: number;
  /** The offer location the camera has already gone to. A rebuilt map does not go there again; a new offer does. */
  offerKey: string | null;
}

/** The offer building as a solid block: what it stands on and how tall it is drawn. */
export interface OfferBlock {
  /** The base as GeoJSON polygon rings, [longitude, latitude]: the building's outline, or a square standing in for it. */
  rings: Position[][];
  /** The height the block is drawn at, in metres. */
  heightM: number;
  /** The middle of the base, [longitude, latitude]: the call-out's line ends above it. */
  centre: Position;
}

/**
 * The words of the offer building's call-out. The step writes every line from figures it already
 * holds; the map only lays them out.
 */
export interface OfferCallout {
  /** The building's class and insured value. null when neither is known. */
  about: string | null;
  /** The water at the site in the event chosen, and which reading gave it: "1-in-100: 0.1 m, drain overload", or "1-in-100: dry". */
  water: string;
  /** The loss in that event. null when there is none to show. */
  loss: string | null;
  /** A short remark under the lines: "Shape approximate", "Approximate location". null when there is none. */
  note: string | null;
  /** The whole call-out as one passage, read out in place of the lines by a screen reader. */
  spoken: string;
}

/**
 * The offer building as the map draws it: always on top of every other layer.
 * At an exact position it is a solid block in the brand colour with a call-out above it; an
 * approximate location is a wide ring with the call-out and no block.
 */
export interface OfferMark {
  /** One value per offer location. The camera goes to the building once for each new key. */
  key: string;
  lat: number;
  lon: number;
  /** The building's name, at the head of its call-out and of its tooltip. */
  name: string;
  /** True when a named place stands in for coordinates the document does not give. */
  approximate: boolean;
  /** The block to draw. null for an approximate location: a ring is drawn and no block. */
  block: OfferBlock | null;
  /** The call-out's lines, under the name. */
  callout: OfferCallout;
  /** The lines of the tooltip, under the name. */
  lines: string[];
  /**
   * The buffer in force around the building, in metres: the highest map depth inside it is the depth used.
   * Drawn as a dashed ring. null when the reading at the point is in force (Depth only), and no ring is drawn.
   */
  bufferM: number | null;
  /** The lines of the ring's tooltip. */
  bufferLines: string[];
}

/**
 * The buffer ring as a closed line of [longitude, latitude] points, radiusM metres from the building.
 * Metres are turned into degrees along each axis the way the hazard grid measures them, so the ring
 * drawn is the area the buffer depth was read from.
 */
export function bufferRing(lat: number, lon: number, radiusM: number, steps = 96): Position[] {
  const perLat = 110574;
  const perLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const ring: Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((i % steps) / steps) * 2 * Math.PI;
    ring.push([lon + (radiusM * Math.cos(a)) / perLon, lat + (radiusM * Math.sin(a)) / perLat]);
  }
  return ring;
}

/**
 * How close the map opens on an offer building: OFFER_ZOOM, or further out when the buffer ring
 * would not fit. `roomPx` is the shorter side of the map on screen.
 */
export function offerZoom(lat: number, bufferM: number | null, roomPx: number): number {
  if (bufferM === null || !(bufferM > 0) || !(roomPx > 0)) return OFFER_ZOOM;
  // Metres per pixel at zoom 0 on 512 px tiles, at this latitude. The ring is given 80% of the room.
  const metresPerPixel = 78271.517 * Math.cos((lat * Math.PI) / 180);
  return Math.min(OFFER_ZOOM, Math.log2((metresPerPixel * roomPx * 0.4) / bufferM));
}

/** How close the map opens on an offer building: near enough to read its outline and its neighbours. */
export const OFFER_ZOOM = 16;
/** The tilt and the compass turn the camera takes, once, when it goes to an offer building drawn as a block, in degrees. */
export const OFFER_PITCH = 50;
export const OFFER_BEARING = -20;
/** Further out than this zoom the call-out is a small pill with the building's name. No buffer ring opens the map this far out. */
export const CALLOUT_FAR_ZOOM = 13.5;
/** The radius of the ring drawn for an approximate location, in pixels. */
export const APPROXIMATE_RING_PX = 24;

/** The point eastM metres east and northM metres north of [lon, lat], measured the way bufferRing measures. */
export function offsetPoint(lat: number, lon: number, eastM: number, northM: number): Position {
  return [lon + eastM / (111320 * Math.cos((lat * Math.PI) / 180)), lat + northM / 110574];
}
/** The offer building's colour on the map and in its key: the brand colour of the theme in force. */
export const OFFER_COLOR = "var(--brand)";

export const WATER_COLORS = { river: "#2f7ed8", stream: "#5fa2e6", canal: "#2ba0a8", drain: "#14a38b", ditch: "#14a38b" } as const;
export const FACILITY_COLORS = { hospital: "#d11242", clinic: "#e8577a", school: "#d9921a", police: "#3b5ba9", fire_station: "#f26b1d" } as const;
export const SETTLEMENT_COLOR = "#7b4fb8";
export const DRAINAGE_COLOR = "#14a38b";
export const DRAINAGE_RGB: [number, number, number] = [20, 163, 139];
export const WARD_COLOR = "#d11242";

export const WARD_METRICS: { value: WardMetric; label: string }[] = [
  { value: "loss", label: "Loss" },
  { value: "tiv", label: "Insured value" },
  { value: "flooded", label: "Buildings flooded" },
  { value: "lossRatio", label: "Loss as % of value" },
];
