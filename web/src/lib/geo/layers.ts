/**
 * Open map layers for Nairobi, served from web/public/geo (see SOURCES.md there for
 * where each one comes from and its licence). Every layer is optional: if a file is
 * missing the map simply leaves that layer out.
 */

export type Position = [number, number];

export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

export interface GeoFeature<P> {
  type: "Feature";
  properties: P;
  geometry: Geometry;
}

export interface GeoCollection<P> {
  type: "FeatureCollection";
  features: GeoFeature<P>[];
}

export interface NameProps {
  name: string;
}
export interface WardProps {
  name: string;
  subcounty: string;
}
export type WaterwayKind = "river" | "stream" | "canal" | "drain" | "ditch";
export interface WaterwayProps {
  kind: WaterwayKind;
  name: string | null;
}
export interface SettlementProps {
  name: string | null;
  source_tags?: string;
}
export type FacilityKind = "hospital" | "clinic" | "school" | "fire_station" | "police";
export interface FacilityProps {
  kind: FacilityKind;
  name: string | null;
}

export interface GeoLayers {
  county: GeoCollection<NameProps> | null;
  subcounties: GeoCollection<NameProps> | null;
  wards: GeoCollection<WardProps> | null;
  waterways: GeoCollection<WaterwayProps> | null;
  settlements: GeoCollection<SettlementProps> | null;
  facilities: GeoCollection<FacilityProps> | null;
}

const FILES: Record<keyof GeoLayers, string> = {
  county: "nairobi-county.geojson",
  subcounties: "subcounties.geojson",
  wards: "wards.geojson",
  waterways: "waterways.geojson",
  settlements: "informal-settlements.geojson",
  facilities: "facilities.geojson",
};

export const GEO_ATTRIBUTION =
  "Map data © OpenStreetMap contributors (ODbL) · Ward boundaries: Omare & Omare 2017, CC BY 4.0 · Terrain: Mapzen Terrain Tiles";

let pending: Promise<GeoLayers> | null = null;

async function fetchLayer<P>(file: string): Promise<GeoCollection<P> | null> {
  try {
    const res = await fetch(`/geo/${file}`);
    if (!res.ok) return null;
    const json = (await res.json()) as GeoCollection<P>;
    return json?.type === "FeatureCollection" && Array.isArray(json.features) ? json : null;
  } catch {
    return null;
  }
}

/** Loads every layer once per page; later calls share the same result. */
export function loadGeo(): Promise<GeoLayers> {
  if (!pending) {
    const keys = Object.keys(FILES) as (keyof GeoLayers)[];
    pending = Promise.all(keys.map((k) => fetchLayer(FILES[k]))).then(
      (parts) => Object.fromEntries(keys.map((k, i) => [k, parts[i]])) as unknown as GeoLayers,
    );
  }
  return pending;
}
