/** Shared between the map and its legend. Kept apart from RiskMap so the legend can render without loading the map library. */

import type { Position } from "@/lib/geo/layers";

export type LayerKey = "hazard" | "drainage" | "buildings" | "wards" | "waterways" | "settlements" | "facilities" | "hotspots";
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

/**
 * The offer building as the map draws it: always on top of every other layer.
 * With an outline it is a filled shape in the brand colour; without one a marker at the point;
 * an approximate location is a marker inside a ring.
 */
export interface OfferMark {
  /** One value per offer location. The camera goes to the building once for each new key. */
  key: string;
  lat: number;
  lon: number;
  /** The building's name, written beside the mark and at the head of its tooltip. */
  name: string;
  /** True when a named place stands in for coordinates the document does not give. */
  approximate: boolean;
  /** The building's outline as GeoJSON polygon rings, [longitude, latitude]. null while it is looked up or when there is none. */
  outline: Position[][] | null;
  /** The lines of the tooltip, under the name. */
  lines: string[];
}

/** How close the map opens on an offer building: near enough to read its outline and its neighbours. */
export const OFFER_ZOOM = 16;
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
