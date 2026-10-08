"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { DEPTH_LABELS } from "@/lib/geo/hazardImage";
import { loadGeo, type FacilityKind, type GeoLayers } from "@/lib/geo/layers";
import { SETTER_LABELS } from "@/lib/export";
import { annualChance, kes1, LOSS_MODE_LABELS, rpLabel, rpWithChance, selectMode } from "@/lib/labels";
import { assignPoints, facilityDepths, geometryBBox, wardAccumulation, type AreaRow, type BBox } from "@/lib/geo/spatial";
import { HOUSING_CLASSES, HOUSING_LABELS, type BuildingScenarioResult } from "@/lib/model/types";
import { DRIVER_LABELS, type DriverReturnPeriod } from "@/lib/offer/drivers";
import { FREQUENT_FLOOD_RP, type FocusReturnPeriod, type PricedFocus } from "@/lib/offer/focus";
import { buildingBlock, findFootprint, FOOTPRINT_LABEL, FOOTPRINT_RADIUS_M, LEVEL_HEIGHT_M, OSM_CREDIT, type BuildingBlock, type Footprint } from "@/lib/offer/footprint";
import { fmtDistance, fmtPoint, plural } from "@/lib/offer/shared";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, type StepId } from "@/lib/steps";
import { useTheme } from "@/lib/useDisplay";
import { DRAINAGE_COLOR, FACILITY_COLORS, OFFER_COLOR, SETTLEMENT_COLOR, WARD_COLOR, WARD_METRICS, WATER_COLORS, type BasemapStatus, type LayerKey, type LayerState, type MapView, type OfferMark, type Selection, type WardMetric } from "../map/mapTheme";
import { BlockSwatch, KeyEntry, KeyRow, MapKey, MapStrip, Swatch, type LayerChip } from "../map/MapControls";
import { ChartFrame, SourceLine, type ChartSource } from "../charts/ChartFrame";
import { Card, Fold, Note, Segmented, Tag } from "../ui";
import { CLASS_COLORS } from "./DataStep";

const RiskMap = dynamic(() => import("../map/RiskMap").then((m) => m.RiskMap), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-surface-2" />,
});

/**
 * The height of the map and its key, under the control strip. On a wide screen it is about 70% of
 * the window's height, and never more than what is left under the page header once the control
 * strip and the Back / Next bar have their room, so the strip, the map and the key are on one screen
 * together. It is never much taller than the map is wide (14rem is the key). On a short screen it
 * keeps a height the map can be read at. In fullscreen the frame fills the screen and this box
 * takes all the strip leaves, whatever the height given here.
 */
const MAP_HEIGHT = "h-[clamp(22rem,60dvh,min(36rem,150cqw))] lg:h-[clamp(24rem,min(70dvh,100dvh_-_var(--header-height,9rem)_-_12.5rem),max(24rem,100cqw_-_14rem))]";

const FACILITY_GROUPS: { label: string; kinds: FacilityKind[] }[] = [
  { label: "Hospitals and clinics", kinds: ["hospital", "clinic"] },
  { label: "Schools", kinds: ["school"] },
  { label: "Police stations", kinds: ["police"] },
  { label: "Fire stations", kinds: ["fire_station"] },
];

/** A side card: as wide as its row allows when the cards wrap, its own height when they are stacked. */
const SIDE_CARD = "flex-[1_1_18rem] @3xl:flex-none";

/** Water deeper than this at a facility is counted as serious flooding. */
const DEEP_M = 0.5;

const metricValue = (row: AreaRow, m: WardMetric) => (m === "loss" ? row.lossKes : m === "tiv" ? row.tivKes : m === "flooded" ? row.flooded : row.tivKes > 0 ? row.lossKes / row.tivKes : 0);
/** A ward measure written out with its unit. The key uses it for the two ends of the ward shading. */
const metricAmount = (v: number, m: WardMetric) => (m === "loss" || m === "tiv" ? kes1(v) : m === "flooded" ? `${fmtInt(v)} buildings` : fmtPct(v, 1));
const metricText = (row: AreaRow, m: WardMetric) => metricAmount(metricValue(row, m), m);

/** What each ward measure is counted in, for column heads and the note on the ward layer. */
const METRIC_UNITS: Record<WardMetric, string> = { loss: "KES", tiv: "KES", flooded: "buildings", lossRatio: "% of insured value" };

/** The facility dots on the map, named one by one so the key does not lean on colour alone. */
const FACILITY_KEY: { label: string; kind: FacilityKind }[] = [
  { label: "hospital", kind: "hospital" },
  { label: "clinic", kind: "clinic" },
  { label: "school", kind: "school" },
  { label: "police", kind: "police" },
  { label: "fire station", kind: "fire_station" },
];

/** One layer in the fold under the map: its name, its badge and what the map shows of it, in full. */
function LayerNote({ name, aside, children }: { name: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-ink">
        {name}
        {aside}
      </dt>
      <dd className="mt-0.5 text-xs leading-relaxed text-ink-2">{children}</dd>
    </div>
  );
}

/**
 * The layers shown when the map opens. Around an offer building the map starts quiet: the flood depth,
 * the portfolio's buildings drawn faint, the rivers and drains, and the buffer ring. The portfolio view starts with everything on.
 */
const defaultLayers = (forOffer: boolean): LayerState => ({ hazard: true, drainage: !forOffer, buildings: true, wards: !forOffer, waterways: true, settlements: !forOffer, facilities: !forOffer, hotspots: !forOffer, buffer: true });

/**
 * Outline lookups by location, so each offer location is asked about once however often the step is opened.
 * A lookup that got no answer (a timeout or a failed request) is dropped, so opening the step again tries again.
 */
const footprintLookups = new Map<string, Promise<Footprint>>();

function lookUpFootprint(key: string, lat: number, lon: number): Promise<Footprint> {
  let lookup = footprintLookups.get(key);
  if (!lookup) {
    lookup = findFootprint(lat, lon);
    footprintLookups.set(key, lookup);
    lookup.then((result) => {
      if (!result.found && result.cause !== "none") footprintLookups.delete(key);
    });
  }
  return lookup;
}

const metres = (m: number) => `${fmtNum(m)} m`;

/** Which reading gave the water at the site, in the words used on every step. */
const WATER_FROM: Record<DriverReturnPeriod["surfaceFrom"], string> = {
  point: "the map at the point",
  buffer: "the map within the buffer",
  ponding: "drainage ponding",
  overload: "drain overload",
  dry: "",
};

/** The same, as the short note beside a depth. */
const WATER_NOTE: Record<DriverReturnPeriod["surfaceFrom"], string> = { point: "at the point", buffer: "within the buffer", ponding: "ponding", overload: "drain overload", dry: "" };

/** Where the offer block's height came from, as the short clause the map key shows. */
const HEIGHT_FROM: Record<BuildingBlock["heightFrom"], string> = {
  osm_height: "height from OpenStreetMap",
  osm_levels: "height from OpenStreetMap",
  floor_area: "height estimated from the floor area",
  assumed: "height assumed",
};

/** True when the block's height is not a measurement: it then carries the Assumption badge. */
const heightIsAssumption = (block: BuildingBlock) => block.heightFrom === "floor_area" || block.heightFrom === "assumed";

/** The block's height and how it was arrived at, in one clause: "38.4 m, height from OpenStreetMap (12 levels of 3.2 m)". */
function heightText(block: BuildingBlock): string {
  const levels = block.levels !== null ? `${fmtNum(block.levels, 1)} ${block.levels === 1 ? "level" : "levels"} of ${fmtNum(LEVEL_HEIGHT_M, 1)} m` : "";
  const how =
    block.heightFrom === "osm_height"
      ? "its own height record"
      : block.heightFrom === "osm_levels"
        ? `${levels} recorded`
        : block.heightFrom === "floor_area"
          ? `the stated floor area over the outline's ${fmtInt(block.areaM2)} m² gives ${levels}`
          : "nothing states it";
  return `${fmtNum(block.heightM, 1)} m, ${HEIGHT_FROM[block.heightFrom]} (${how})`;
}

/** What the hazard at the site means for the decision, in one or two plain sentences. Every figure is the focus's own. */
function siteVerdict(offer: PricedFocus): string {
  const d = offer.drivers;
  const b = offer.price.building;
  const all = d.mode === "all_drivers";
  const rows = d.perReturnPeriod;
  const rarest = rows[rows.length - 1];
  const first = rows.find((r) => r.depths.surfaceM > 0);
  if (!first || !rarest) {
    const near = b.nearestWetM !== null && b.nearestWetM > 0 ? ` The nearest mapped flood water is ${fmtDistance(b.nearestWetM)} from the point.` : "";
    const where = all
      ? `the maps are dry at the point and within the ${fmtInt(d.bufferRadiusM)} m buffer${offer.drainageOn ? ", there is no drainage ponding" : ""} and the drains are not overloaded`
      : `the maps are dry at the point${offer.drainageOn ? " and there is no drainage ponding" : ""}`;
    return `No water at the site at any modelled return period: ${where}.${near} The model puts no flood loss on this building, so the decision rests on how far the hazard layer can be trusted at this site.`;
  }
  const event = rpWithChance(first.returnPeriod);
  const depth = metres(first.depths.surfaceM);
  const opening =
    first.surfaceFrom === "point"
      ? `Water reaches the building at the point from the ${event} event (${depth} on the map).`
      : first.surfaceFrom === "buffer"
        ? `The map is dry at the point in the ${event} event, but shows ${depth} of water within the ${fmtInt(d.bufferRadiusM)} m buffer, and that depth is the one used. The buffer is an assumption.`
        : first.surfaceFrom === "ponding"
          ? `Drainage ponding reaches the building from the ${event} event (${depth}). That water is an assumption about ground near mapped drains, not a mapped flood.`
          : `The maps are dry at the point and within the buffer, but the ${event} event is rarer than the ${rpLabel(d.drainDesign.returnPeriod)} event the drains are ${d.drainDesign.source.kind === "offer" ? "stated to be" : "taken to be"} designed for, so the site is taken to have ${depth} of water. That depth is an assumption.`;
  const deepest = rarest === first ? "" : ` By the ${rpLabel(rarest.returnPeriod)} event the water at the site is ${metres(rarest.depths.surfaceM)}, from ${WATER_FROM[rarest.surfaceFrom]}.`;
  const pointOnly = all && b.dryAtPointEveryReturnPeriod ? " Read at the point alone, as Depth only does, this building would price at zero." : "";
  const frequent = first.returnPeriod <= FREQUENT_FLOOD_RP ? ` Water this often is raised as a flag in ${STEP_NAMES.results}.` : "";
  return `${opening}${deepest}${pointOnly}${frequent}`;
}

/** How many of the portfolio's buildings each driver puts water at, in one event. Counted from the model result's driver split. */
interface DriverCounts {
  point: number;
  buffer: number;
  ponding: number;
  overload: number;
  /** Wet from drain overload and nothing else. */
  overloadAlone: number;
}

function driverCounts(rows: BuildingScenarioResult[]): DriverCounts | null {
  const out: DriverCounts = { point: 0, buffer: 0, ponding: 0, overload: 0, overloadAlone: 0 };
  for (const row of rows) {
    const d = row.drivers;
    if (!d) return null;
    if (d.pointM > 0) out.point += 1;
    if (d.bufferM > 0) out.buffer += 1;
    if (d.pondingM > 0) out.ponding += 1;
    if (d.overloaded && d.overloadM > 0) {
      out.overload += 1;
      if (!(d.bufferM > 0) && !(d.pondingM > 0)) out.overloadAlone += 1;
    }
  }
  return out;
}

/**
 * The interactive risk map with its control strip, its key and its side panel. The Hazard map step renders it.
 * With an offer it opens on that building and the side panel is about the building; without one it is the portfolio's map.
 */
export function MapStep({ session, active, offer = null, onOpenStep }: { session: Session; active: Active; offer?: PricedFocus | null; onOpenStep?: (id: StepId) => void }) {
  const { dataset } = session;
  const r = active.result;
  const isScore = dataset.hazardKind === "score";
  const last = r.scenarios.length - 1;
  const initialK = Math.max(0, r.scenarios.findIndex((s) => s.returnPeriod === 100));

  const [geo, setGeo] = useState<GeoLayers | null>(null);
  const [k, setK] = useState(initialK === -1 ? last : initialK);
  const [playing, setPlaying] = useState(false);
  const forOffer = offer !== null;
  const [layers, setLayers] = useState<LayerState>(() => defaultLayers(forOffer));
  // Going from the offer to the portfolio, or back, starts from that view's own layers.
  const [layersFor, setLayersFor] = useState(forOffer);
  if (layersFor !== forOffer) {
    setLayersFor(forOffer);
    setLayers(defaultLayers(forOffer));
  }
  const [threeD, setThreeD] = useState(false);
  const [wardMetric, setWardMetric] = useState<WardMetric>("loss");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<{ bbox: BBox; seq: number } | null>(null);
  const [status, setStatus] = useState<BasemapStatus>("loading");
  // The map takes its basemap and colours when it is created, so a theme change builds a new one.
  // Everything above lives here and carries over; the camera carries over through this record.
  const theme = useTheme();
  const mapView = useRef<MapView>({ camera: null, threeD: null, selection: null, focusSeq: 0, offerKey: null });
  // The frame around the control strip, the map and the key: the element that goes fullscreen.
  const frame = useRef<HTMLDivElement>(null);
  // null until the reader folds or opens the key: it then follows the width, open on a wide map and folded on a narrow one.
  const [keyOpen, setKeyOpen] = useState<boolean | null>(null);

  // The offer building's outline, looked up once for each location. An approximate location has no outline to look up.
  const siteLat = offer?.site.lat ?? null;
  const siteLon = offer?.site.lon ?? null;
  const pointKey = siteLat !== null && siteLon !== null ? `${siteLat},${siteLon}` : null;
  const exactKey = offer && !offer.site.approximate ? pointKey : null;
  const [outline, setOutline] = useState<{ key: string; result: Footprint } | null>(null);
  useEffect(() => {
    if (exactKey === null || siteLat === null || siteLon === null) return;
    let live = true;
    lookUpFootprint(exactKey, siteLat, siteLon).then((result) => {
      if (live) setOutline({ key: exactKey, result });
    });
    return () => {
      live = false;
    };
  }, [exactKey, siteLat, siteLon]);
  const footprint = exactKey !== null && outline?.key === exactKey ? outline.result : null;
  const footprintLoading = exactKey !== null && footprint === null;
  // The building as a solid block, at an exact position only: on its OpenStreetMap outline, or on a square of
  // approximate shape while the outline is looked up and when there is none. An approximate location has no block.
  const floorAreaM2 = offer?.building.floorAreaM2 ?? null;
  const block = useMemo(() => (exactKey !== null && siteLat !== null && siteLon !== null ? buildingBlock(siteLat, siteLon, footprint, floorAreaM2) : null), [exactKey, siteLat, siteLon, footprint, floorAreaM2]);

  useEffect(() => {
    loadGeo().then(setGeo);
  }, []);

  // Play: step through the events from most frequent to rarest, then stop.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setK((cur) => {
        if (cur >= last) {
          setPlaying(false);
          return cur;
        }
        return cur + 1;
      });
    }, 1700);
    return () => clearInterval(t);
  }, [playing, last]);

  const ki = Math.min(k, last);
  const s = r.scenarios[ki];

  const wardOf = useMemo(() => (geo?.wards ? assignPoints(dataset.buildings, geo.wards) : []), [geo, dataset]);
  const wardRows = useMemo(() => (geo?.wards ? wardAccumulation(dataset, r, wardOf, geo.wards, ki) : []), [geo, dataset, r, wardOf, ki]);
  const facilityDepth = useMemo(() => (geo?.facilities ? facilityDepths(dataset, r, geo.facilities) : []), [geo, dataset, r]);

  const facilitiesWet = useMemo(() => {
    const kinds = geo?.facilities?.features.map((f) => f.properties.kind) ?? [];
    return FACILITY_GROUPS.map((g) => ({
      ...g,
      total: kinds.filter((x) => g.kinds.includes(x)).length,
      wet: kinds.filter((x, i) => g.kinds.includes(x) && (facilityDepth[i]?.[ki] ?? 0) > 0).length,
      deep: kinds.filter((x, i) => g.kinds.includes(x) && (facilityDepth[i]?.[ki] ?? 0) > DEEP_M).length,
    }));
  }, [geo, facilityDepth, ki]);

  const outside = wardRows.find((w) => w.index === -1) ?? null;
  const ranked = useMemo(() => [...wardRows].filter((w) => w.index >= 0 && w.buildings > 0).sort((a, b) => metricValue(b, wardMetric) - metricValue(a, wardMetric)), [wardRows, wardMetric]);
  const topWards = ranked.slice(0, 12);
  const maxMetric = Math.max(...topWards.map((w) => metricValue(w, wardMetric)), 1e-9);

  const focusWard = (index: number) => {
    const f = geo?.wards?.features[index];
    if (!f) return;
    setSelection({ type: "ward", index });
    setFocus((prev) => ({ bbox: geometryBBox(f.geometry), seq: (prev?.seq ?? 0) + 1 }));
  };

  const setLayer = (key: LayerKey, v: boolean) => setLayers((l) => ({ ...l, [key]: v }));
  const drainage = dataset.drainage;
  const event = rpLabel(s.returnPeriod);
  const eventWithChance = rpWithChance(s.returnPeriod);
  const metricLabel = WARD_METRICS.find((m) => m.value === wardMetric)?.label ?? "";
  const pondingM = drainage ? (drainage.depthM[dataset.scenarios.findIndex((x) => x.id === s.id)] ?? 0) : 0;
  // Where the numbers on this step come from, in the four shared badges.
  const hazardSource: ChartSource = { kind: "real", text: isScore ? "Hazard maps from the starter kit. The score on them is a derived proxy for flooding, not a measured depth" : "Flood depth maps from the starter kit" };
  const portfolioSource: ChartSource = { kind: "synthetic", text: "Portfolio of insured buildings, placed at random" };
  const assumptionSource: ChartSource = { kind: "assumption", text: `${isScore ? "Return periods, the scale that turns the score into metres, " : "Damage curves, "}fragility and caps${drainage ? ", drainage ponding" : ""}` };
  // The offer building at the event picked, and the mark the map draws for it.
  const atBuilding = offer ? (offer.price.building.perReturnPeriod.find((p) => p.id === s.id) ?? null) : null;
  // The same event in the offer's loss drivers: the depths at the point, within the buffer, from ponding and from drain overload.
  const atSite = offer ? (offer.drivers.perReturnPeriod.find((p) => p.id === s.id) ?? null) : null;
  // The buffer in force around the offer building. null with Depth only: the point reading is in force and no ring is drawn.
  const allDrivers = offer ? offer.drivers.mode === "all_drivers" : r.mode === "all_drivers";
  const bufferM = offer && allDrivers && offer.drivers.bufferRadiusM > 0 ? offer.drivers.bufferRadiusM : null;
  const bufferText = bufferM !== null ? `Buffer: the highest map depth within ${fmtInt(bufferM)} m of the building is used` : "";
  const counts = useMemo(() => (r.mode === "all_drivers" ? driverCounts(r.buildings.map((b) => b.perScenario[ki])) : null), [r, ki]);
  const offerMark = useMemo<OfferMark | null>(() => {
    if (!offer || pointKey === null || siteLat === null || siteLon === null) return null;
    const water = !atSite ? null : atSite.depths.surfaceM > 0 ? `${metres(atSite.depths.surfaceM)} of water at the site, from ${WATER_FROM[atSite.surfaceFrom]}` : "no water at the site";
    const dryOrDepth = (m: number) => (m > 0 ? metres(m) : "dry");
    // The call-out's lines. Every figure is one the step already holds for the event picked: the building's class and
    // insured value, the water at the site with the reading that gave it, and this building's own ground-up loss.
    const about = [offer.building.housingLabel, offer.building.tivKes !== null ? `${kes1(offer.building.tivKes)} insured` : null].filter((x): x is string => !!x).join(" · ") || null;
    const calloutWater = !atSite ? `${event}: no reading` : atSite.depths.surfaceM > 0 ? `${event}: ${metres(atSite.depths.surfaceM)}, ${WATER_NOTE[atSite.surfaceFrom]}` : `${event}: dry`;
    const calloutLoss = atBuilding ? `Loss in that flood: ${kes1(atBuilding.groundUpKes)} ground-up` : null;
    const note = offer.site.approximate ? "Approximate location" : block?.shape === "approximate" ? "Shape approximate" : null;
    const spoken = [
      `Offer building: ${offer.building.name}${offer.site.approximate ? ", at an approximate location" : ""}.`,
      ...(about ? [`${about.replace(" · ", ", ")}.`] : []),
      `${eventWithChance} event: ${water ?? "no reading"}.`,
      ...(atBuilding ? [`Ground-up loss in that flood: ${kes1(atBuilding.groundUpKes)}.`] : []),
      ...(note === "Shape approximate" ? ["The block's shape is approximate."] : []),
    ].join(" ");
    return {
      key: pointKey,
      lat: siteLat,
      lon: siteLon,
      name: offer.building.name,
      approximate: offer.site.approximate,
      block: block ? { rings: block.polygon.coordinates, heightM: block.heightM, centre: block.centre } : null,
      callout: { about, water: calloutWater, loss: calloutLoss, note, spoken },
      lines: [
        offer.site.approximate ? "The offer building, approximate location" : "The offer building",
        ...(offer.building.housingLabel ? [offer.building.housingLabel] : []),
        ...(water ? [`${event} event: ${water}`] : []),
        ...(atSite && bufferM !== null ? [`At the point: ${dryOrDepth(atSite.depths.pointM)}. Within the buffer: ${dryOrDepth(atSite.depths.bufferM)}`] : []),
      ],
      bufferM,
      bufferLines: bufferM !== null ? [bufferText, ...(atSite ? [`${event} event: ${dryOrDepth(atSite.depths.bufferM)} within the buffer, ${dryOrDepth(atSite.depths.pointM)} at the point`] : []), "The buffer radius is an assumption"] : [],
    };
  }, [offer, pointKey, siteLat, siteLon, atSite, atBuilding, bufferM, bufferText, block, event, eventWithChance]);
  // What the key says of the offer building: what is drawn, where its shape came from and where its height came from.
  const offerKeyText = !offer
    ? ""
    : !block
      ? "A wide ring and no block: the location is approximate, read from a place name, so no shape or height is drawn"
      : `A solid block standing where the building stands. Shape: ${
          block.shape === "osm"
            ? `the building's outline from OpenStreetMap, nearest to the stated coordinates (${OSM_CREDIT})`
            : `approximate, a square of ${fmtInt(block.sideM ?? 0)} m a side centred on the stated coordinates${footprintLoading ? " while the outline is looked up on OpenStreetMap" : ""}`
        }. Height: ${heightText(block)}`;
  const tierNote = `${isScore ? `the "${s.id}" map, assumed to be a ${event} event` : `the published ${event} depth map`}${drainage ? `, plus drainage ponding up to ${fmtNum(drainage.depthM[dataset.scenarios.findIndex((x) => x.id === s.id)] ?? 0)} m near drains and in informal settlements` : ""}`;

  const pickEvent = (i: number) => {
    setPlaying(false);
    setK(i);
  };
  // The layer filters of the control strip, in the order they are read. A layer the data does not hold has no filter.
  const held = (layer: unknown) => geo === null || layer != null;
  const chipList: (LayerChip | false)[] = [
    { key: "hazard", name: "Flood depth", swatch: <Swatch shape="depth" /> },
    { key: "buildings", name: "Buildings", swatch: <Swatch color={CLASS_COLORS[HOUSING_CLASSES[0]]} /> },
    held(geo?.wards) && { key: "wards", name: "Wards", swatch: <Swatch shape="square" color={WARD_COLOR} /> },
    held(geo?.waterways) && { key: "waterways", name: "Rivers and drains", swatch: <Swatch shape="line" color={WATER_COLORS.river} /> },
    !!drainage && { key: "drainage", name: "Drainage zone", swatch: <Swatch shape="square" color={DRAINAGE_COLOR} /> },
    held(geo?.settlements) && { key: "settlements", name: "Settlements", swatch: <Swatch shape="square" color={SETTLEMENT_COLOR} /> },
    held(geo?.facilities) && { key: "facilities", name: "Services", swatch: <Swatch color={FACILITY_COLORS.school} /> },
    session.hits.length > 0 && { key: "hotspots", name: "Flood areas", swatch: <Swatch color="var(--navy-line)" /> },
    bufferM !== null && { key: "buffer", name: "Buffer ring", swatch: <Swatch shape="dashed" color={OFFER_COLOR} /> },
  ];
  const chips = chipList.filter((c): c is LayerChip => c !== false);
  const shadedBy = metricLabel.charAt(0).toLowerCase() + metricLabel.slice(1);

  return (
    <>
      {/* Two columns where the step has the room at the chosen text size: the map with its controls and its key, and the panel beside it. */}
      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem] @6xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {/* The frame holds the control strip, the map and the key, and the frame is what goes fullscreen, so all three are
              in reach there. Its class list never changes: the map adds a class of its own to it when it fills the window. */}
          <div ref={frame} className="@container isolate flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
            <MapStrip
              events={r.scenarios}
              index={ki}
              onIndex={pickEvent}
              playing={playing}
              onPlay={() => {
                if (!playing && ki >= last) setK(0);
                setPlaying((p) => !p);
              }}
              threeD={threeD}
              onThreeD={setThreeD}
              chips={chips}
              layers={layers}
              onLayer={setLayer}
              wardMetric={wardMetric}
              onWardMetric={setWardMetric}
            />
            <div className={`relative flex min-h-0 flex-auto flex-col @3xl:flex-row ${MAP_HEIGHT}`}>
              <div className="relative z-0 min-h-0 min-w-0 flex-1">
                {geo ? (
                  <RiskMap
                    key={theme}
                    session={session}
                    active={active}
                    geo={geo}
                    k={ki}
                    layers={layers}
                    threeD={threeD}
                    wardMetric={wardMetric}
                    wardRows={wardRows}
                    facilityDepth={facilityDepth}
                    selection={selection}
                    onSelect={setSelection}
                    focus={focus}
                    onStatus={setStatus}
                    viewRef={mapView}
                    fullscreenHost={frame}
                    offer={offerMark}
                    muted={forOffer}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-surface-2 text-sm text-ink-2">Loading map layers</div>
                )}
              </div>
              {/* Only the layers that are switched on, each with the marks the map draws for it at the event picked. */}
              <MapKey open={keyOpen} onOpen={setKeyOpen}>
                {offer && (
                  <KeyEntry title="Offer building" note="Always shown, above every layer. Its call-out gives the water at the site.">
                    {block ? (
                      <KeyRow swatch={<BlockSwatch />}>
                        Solid block. {block.shape === "osm" ? "Shape from its OpenStreetMap outline" : "Shape approximate, a square"}; {fmtNum(block.heightM, 1)} m tall, {HEIGHT_FROM[block.heightFrom]}.
                      </KeyRow>
                    ) : (
                      <KeyRow swatch={<Swatch shape="ring" color={OFFER_COLOR} />}>Wide ring and no block: the location is approximate.</KeyRow>
                    )}
                    {bufferM !== null && layers.buffer && (
                      <KeyRow swatch={<Swatch shape="dashed" color={OFFER_COLOR} />}>
                        Buffer ring, {fmtInt(bufferM)} m: the highest map depth inside it is used. An assumption.
                      </KeyRow>
                    )}
                  </KeyEntry>
                )}
                {layers.hazard && (
                  <KeyEntry title={`Flood depth, metres${isScore ? " (score converted)" : ""}`} note={allDrivers ? `Water from ${DRIVER_LABELS.overload.toLowerCase()} is not shaded.` : undefined}>
                    {DEPTH_LABELS.map((l, i) => (
                      <KeyRow key={l} swatch={<Swatch shape="band" color={`var(--seq-${i + 1})`} />}>
                        {l}
                      </KeyRow>
                    ))}
                  </KeyEntry>
                )}
                {layers.buildings && (
                  <KeyEntry
                    title={`${offer ? "The portfolio's buildings" : "Insured buildings"} (synthetic)`}
                    note={threeD ? "A column stands where a building takes a loss; a taller column is a larger loss." : "A larger dot is a larger insured value; a faint dot is dry."}
                  >
                    {HOUSING_CLASSES.map((c) => (
                      <KeyRow key={c} swatch={<Swatch color={CLASS_COLORS[c]} />}>
                        {HOUSING_LABELS[c]}
                      </KeyRow>
                    ))}
                    {!threeD && <KeyRow swatch={<Swatch shape="ring" color={WARD_COLOR} />}>Takes a loss</KeyRow>}
                  </KeyEntry>
                )}
                {layers.wards && geo?.wards && (
                  <KeyEntry title={`Wards shaded by ${shadedBy}`} note="A deeper shade is a ward with more.">
                    <KeyRow swatch={<Swatch shape="outline" color={WARD_COLOR} />}>Lowest: {metricAmount(0, wardMetric)}</KeyRow>
                    <KeyRow swatch={<Swatch shape="square" color={WARD_COLOR} />}>Highest: {topWards[0] ? `${metricText(topWards[0], wardMetric)}, ${topWards[0].name}` : "no ward holds a building"}</KeyRow>
                  </KeyEntry>
                )}
                {layers.waterways && geo?.waterways && (
                  <KeyEntry title="Rivers and drains">
                    <KeyRow swatch={<Swatch shape="line" color={WATER_COLORS.river} />}>River</KeyRow>
                    <KeyRow swatch={<Swatch shape="line" color={WATER_COLORS.stream} />}>Stream</KeyRow>
                    <KeyRow swatch={<Swatch shape="line" color={WATER_COLORS.drain} />}>Drain or ditch</KeyRow>
                  </KeyEntry>
                )}
                {drainage && layers.drainage && (
                  <KeyEntry title="Drainage zone">
                    <KeyRow swatch={<Swatch shape="square" color={DRAINAGE_COLOR} />}>Ponding of up to {fmtNum(pondingM)} m assumed here; darker is closer to a drain.</KeyRow>
                  </KeyEntry>
                )}
                {layers.settlements && geo?.settlements && (
                  <KeyEntry title="Settlements">
                    <KeyRow swatch={<Swatch shape="square" color={SETTLEMENT_COLOR} />}>Informal settlement</KeyRow>
                  </KeyEntry>
                )}
                {layers.facilities && geo?.facilities && (
                  <KeyEntry title="Services" note="A larger dot with a dark edge stands in water. Zoom in to see them.">
                    {FACILITY_KEY.map((f) => (
                      <KeyRow key={f.kind} swatch={<Swatch color={FACILITY_COLORS[f.kind]} />}>
                        {f.label}
                      </KeyRow>
                    ))}
                  </KeyEntry>
                )}
                {layers.hotspots && session.hits.length > 0 && (
                  <KeyEntry title="County-named flood areas">
                    <KeyRow swatch={<Swatch color="var(--navy-line)" />}>Flagged by the proxy</KeyRow>
                    <KeyRow swatch={<Swatch shape="ring" color={WARD_COLOR} />}>Missed</KeyRow>
                  </KeyEntry>
                )}
                {!offer && !chips.some((c) => layers[c.key]) && <p className="text-xs leading-snug text-muted">No layer is switched on. Pick one in the strip above the map.</p>}
              </MapKey>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              {status === "online" ? "Live basemap: OpenStreetMap data via OpenFreeMap, terrain from open elevation tiles." : status === "offline" ? "No connection to the basemap server: model layers shown on a plain background." : "Connecting to the basemap"}
            </span>
            <span>Drag with the right mouse button (or two fingers) to tilt and turn.</span>
          </div>

          {/* What the strip and the key have no room to say: each layer in full, with its badges and its sources. */}
          <Fold summary="About these layers and where they come from" className="mt-3 rounded-xl border border-line bg-surface px-4 py-2">
            <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
              Each switch above the map shows or hides one layer, and the key beside the map names the marks drawn for the {eventWithChance} event. Point at anything on the map to read its figures.
            </p>
            <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),1fr))] gap-x-6 gap-y-3">
              <LayerNote name="The event shown" aside={<Tag kind={isScore ? "assumption" : "real"}>{isScore ? "Return period assumed" : "From the data"}</Tag>}>
                Showing {tierNote}. The slider steps through the return periods in years, from {rpLabel(r.scenarios[0].returnPeriod)} (most frequent) to {rpLabel(r.scenarios[last].returnPeriod)} (rarest).
              </LayerNote>
              {offer && (
                <LayerNote name="Offer building" aside={block && heightIsAssumption(block) ? <Tag kind="assumption">{block.heightFrom === "assumed" ? "Height assumed" : "Height estimated"}</Tag> : undefined}>
                  Always shown, above every layer. {offerKeyText}. The call-out beside it names the building and gives the water at the site; from far out it is a small label with the name.
                </LayerNote>
              )}
              {offer &&
                (bufferM !== null ? (
                  <LayerNote name="Buffer ring" aside={<Tag kind="assumption" />}>
                    {bufferText}. A dashed ring. It stands for the building&rsquo;s footprint and the error in a stated coordinate.
                  </LayerNote>
                ) : (
                  <LayerNote name="No buffer ring">Depth only is selected: the reading at the point is in force, so no buffer is drawn.</LayerNote>
                ))}
              <LayerNote name={`Flood depth, metres${isScore ? " (score converted to metres)" : ""}`} aside={<Tag kind={isScore ? "proxy" : "real"} />}>
                Five bands from shallowest to deepest; the key gives the depth range of each.
                {allDrivers && ` The shading is the map depth${drainage ? " and drainage ponding" : ""}; water from ${DRIVER_LABELS.overload.toLowerCase()} is not shaded, as it is assumed over the whole area.`}
              </LayerNote>
              {drainage && (
                <LayerNote name="Drainage zone">
                  Within {fmtInt(drainage.reachM)} m of a mapped drain or inside an informal settlement; darker means closer. Ponding of up to {fmtNum(pondingM)} m is assumed there at this event.
                </LayerNote>
              )}
              <LayerNote name={`${offer ? "The portfolio's insured buildings" : "Insured buildings"} (synthetic)`}>
                A larger dot is a larger insured value (KES); a faint dot is dry at this event. A dot with a ring takes a loss. In the 3D view a taller column is a larger loss (KES). Water and loss are as {allDrivers ? "all loss drivers give" : "Depth only gives"} them.
                {counts && counts.overload > 0 && ` At this event the drains are taken as overloaded, so every building has some water and no dot is faint.`}
                {offer && ` Drawn small here so the offer stands out: ${plural(offer.site.neighbours.count, "building")} of the portfolio ${offer.site.neighbours.count === 1 ? "lies" : "lie"} within ${fmtDistance(offer.site.neighbours.radiusM)} of it.`}
              </LayerNote>
              <LayerNote name={`Wards shaded by ${shadedBy}`}>
                A deeper shade is a ward with more at this event, measured in {METRIC_UNITS[wardMetric]}.{topWards[0] ? ` The highest is ${topWards[0].name}, ${metricText(topWards[0], wardMetric)}.` : ""}
              </LayerNote>
              <LayerNote name="Rivers, streams and drains">Lines from OpenStreetMap. A river, a stream, and a drain or ditch each have their own colour, named in the key.</LayerNote>
              <LayerNote name="Informal settlements">Outlines from OpenStreetMap, which are incomplete there.</LayerNote>
              <LayerNote name="Schools, health and emergency services">Zoom in to see them. A larger dot with a dark outline stands in water at this event.</LayerNote>
              <LayerNote name="County-named flood areas">A filled dot is an area flagged by the proxy; a ring is one it missed.</LayerNote>
            </dl>
            <SourceLine
              className="mt-4 border-t border-line pt-3"
              sources={[
                { kind: "real", text: `${isScore ? "Hazard maps (the flood score on them is a derived proxy)" : "Flood depth maps"}, ward boundaries, OpenStreetMap rivers, drains, settlements and facilities, county-named flood areas` },
                { kind: "synthetic", text: "Insured buildings" },
                { kind: "assumption", text: `Return periods${isScore ? ", the scale that turns the score into metres" : ""}${drainage ? ", drainage ponding depths" : ""}` },
              ]}
            />
            <div className="mb-2 mt-3">
              <Note>
                <strong className="font-semibold text-ink">What is real here.</strong> Ward boundaries are the 85 Nairobi wards (Omare &amp; Omare 2017, CC BY 4.0). Rivers, drains, informal settlements, schools and health facilities are from OpenStreetMap (data from February and May 2025); informal settlement outlines are incomplete there, Kibera for instance is mapped only as a point. The flood layer is the hazard proxy converted to depth with the assumptions in force{dataset.drainage ? ", plus drainage ponding near OpenStreetMap drains and inside informal settlements, which is our own assumption" : ""}. The buildings are synthetic and placed at random, so ward totals show how accumulation would be read, not a real concentration of risk.
              </Note>
            </div>
          </Fold>
        </div>

        {/* Beside the map this is one column. Under the map, on a screen too narrow for two columns, the cards sit side by side where they fit. */}
        <div className="flex min-w-0 flex-wrap gap-4 @3xl:flex-col @3xl:flex-nowrap">
          {offer ? (
            <OfferSiteCard
              className={SIDE_CARD}
              offer={offer}
              at={atBuilding}
              site={atSite}
              onPick={(id) => {
                const i = r.scenarios.findIndex((x) => x.id === id);
                if (i >= 0) pickEvent(i);
              }}
              footprint={footprint}
              footprintLoading={footprintLoading}
              block={block}
              onOpenStep={onOpenStep}
            />
          ) : (
          <Card className={SIDE_CARD} title={`At the ${event} event`}>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Buildings flooded</dt>
                <dd className="tabular text-lg font-semibold text-ink">
                  {fmtInt(s.affected)} <span className="text-sm font-normal text-muted">of {fmtInt(r.buildingCount)}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Portfolio loss, ground-up</dt>
                <dd className="tabular text-lg font-semibold text-brand">{kes1(s.lossKes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Value in the flood area</dt>
                <dd className="tabular font-semibold text-ink">{kes1(s.tivExposedKes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Loss as share of all value</dt>
                <dd className="tabular font-semibold text-ink">{fmtPct(s.lossKes / r.totalTivKes, 2)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs leading-relaxed text-muted">All four figures are for the {eventWithChance} event picked on the map{r.mode === "all_drivers" ? ", with all loss drivers" : ", with Depth only"}. Ground-up means before deductibles and reinsurance.</p>
            <SourceLine sources={[portfolioSource, hazardSource, assumptionSource]} className="mt-3 border-t border-line pt-3" />
            <PortfolioDrivers result={r} counts={counts} event={event} drainageOn={!!drainage} onOpenStep={onOpenStep} />
            {geo?.facilities && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-semibold text-ink">Public facilities in the flood area</span>
                  <span className="shrink-0 text-muted">deeper than {fmtNum(DEEP_M, 1)} m</span>
                </div>
                <ul className="space-y-1 text-sm">
                  {facilitiesWet.map((g) => (
                    <li key={g.label} className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 text-ink-2">
                        <Swatch color={FACILITY_COLORS[g.kinds[0]]} />
                        {g.label}
                      </span>
                      <span className="tabular shrink-0 whitespace-nowrap text-ink">
                        {fmtInt(g.wet)} <span className="text-muted">of {fmtInt(g.total)}</span>
                        <strong className="ml-3 inline-block w-10 text-right font-semibold">{fmtInt(g.deep)}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs leading-relaxed text-muted">Each row counts facilities: first those the water reaches out of all mapped, then those in water deeper than {fmtNum(DEEP_M, 1)} m. The proxy marks shallow water widely, so the second count is the one to quote.</p>
                <SourceLine sources={[{ kind: "real", text: "Facilities from OpenStreetMap" }]} className="mt-2" />
              </div>
            )}
          </Card>
          )}

          {/* The last card takes up any height the map column leaves over. */}
          <SelectionCard hint={offer ? "Click a portfolio building near the offer to trace its loss." : "Click a building to trace its loss, or a ward to see what it holds."} className="flex-[1_1_18rem] @3xl:flex-auto" session={session} active={active} k={ki} geo={geo} wardOf={wardOf} wardRows={wardRows} selection={selection} onClear={() => setSelection(null)} />
        </div>

        {!offer && (
        <ChartFrame
          className="@3xl:col-span-2"
          title={`Accumulation by ward at the ${eventWithChance} event`}
          subtitle={`Each row is one ward: the insured buildings it holds, their value, and what the ${event} event does to them. The bar ranks the wards by ${metricLabel.toLowerCase()}, with the figure beside it. Losses are ground-up, before deductibles and reinsurance.`}
          sources={[portfolioSource, { kind: "real", text: `Ward boundaries (Omare & Omare 2017); ${isScore ? "hazard maps, whose score is a derived proxy" : "flood depth maps"}` }, assumptionSource]}
          aside={<Segmented label="Rank wards by" value={wardMetric} onChange={setWardMetric} options={WARD_METRICS.map((m) => ({ value: m.value, label: m.label }))} />}
        >
          {!geo?.wards ? (
            <p className="text-sm text-ink-2">Ward boundaries are not available, so losses cannot be grouped by ward.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-180 text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-2 pr-3 font-medium">Ward</th>
                    <th className="py-2 pr-3 font-medium">Sub-county</th>
                    <th className="py-2 pr-3 text-right font-medium">Insured buildings</th>
                    <th className="py-2 pr-3 text-right font-medium">Insured value, KES</th>
                    <th className="py-2 pr-3 text-right font-medium">Buildings flooded</th>
                    <th className="py-2 pr-3 text-right font-medium">Ground-up loss, KES</th>
                    <th className="w-[28%] py-2 font-medium">Ranked by {metricLabel.toLowerCase()} ({METRIC_UNITS[wardMetric]})</th>
                  </tr>
                </thead>
                <tbody>
                  {topWards.map((w) => (
                    <tr
                      key={`${w.index}-${w.name}`}
                      onClick={() => w.index >= 0 && focusWard(w.index)}
                      className={`border-b border-line/60 ${w.index >= 0 ? "cursor-pointer hover:bg-surface-2" : ""} ${selection?.type === "ward" && selection.index === w.index ? "bg-surface-2" : ""}`}
                    >
                      <td className="py-2 pr-3 font-medium text-ink">{w.name}</td>
                      <td className="py-2 pr-3 text-ink-2">{w.subcounty}</td>
                      <td className="tabular py-2 pr-3 text-right">{fmtInt(w.buildings)}</td>
                      <td className="tabular py-2 pr-3 text-right">{fmtKes(w.tivKes)}</td>
                      <td className="tabular py-2 pr-3 text-right">{fmtInt(w.flooded)}</td>
                      <td className="tabular py-2 pr-3 text-right font-semibold text-ink">{fmtKes(w.lossKes)}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="h-1.5 flex-1 rounded-full bg-surface-2">
                            <span className="block h-1.5 rounded-full" style={{ width: `${(metricValue(w, wardMetric) / maxMetric) * 100}%`, background: WARD_COLOR }} />
                          </span>
                          <span className="tabular w-28 shrink-0 text-right text-xs text-ink-2">{metricText(w, wardMetric)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Top {topWards.length} of {ranked.length} wards holding insured buildings. Click a ward to zoom to it. The top three wards carry {fmtPct(ranked.slice(0, 3).reduce((t, w) => t + w.lossKes, 0) / (s.lossKes || 1), 0)} of the loss at this event.
                {outside && ` ${fmtInt(outside.buildings)} buildings (${fmtKes(outside.tivKes)} insured, ${fmtKes(outside.lossKes)} loss at this event) sit inside the hazard maps but outside Nairobi County's wards, so they are left out of this table.`}
              </p>
            </div>
          )}
        </ChartFrame>
        )}
      </div>
    </>
  );
}

/** The side card of the offer view: the flood depth at the building at every return period, and what lies around it. */
function OfferSiteCard({
  className,
  offer,
  at,
  site: picked,
  onPick,
  footprint,
  footprintLoading,
  block,
  onOpenStep,
}: {
  className: string;
  offer: PricedFocus;
  /** The row of the return period picked on the slider. */
  at: FocusReturnPeriod | null;
  /** The same return period in the offer's loss drivers. */
  site: DriverReturnPeriod | null;
  onPick: (scenarioId: string) => void;
  footprint: Footprint | null;
  footprintLoading: boolean;
  /** The block the map draws for the building. null at an approximate location. */
  block: BuildingBlock | null;
  onOpenStep?: (id: StepId) => void;
}) {
  const { building, site, drivers } = offer;
  const isScore = offer.hazardKind === "score";
  const all = drivers.mode === "all_drivers";
  const design = drivers.drainDesign;
  const dryOr = (m: number) => (m > 0 ? fmtNum(m) : "dry");
  const about = site.approximate ? "about " : "";
  const nearest = site.river.nearest;
  const stated = site.river.statedName !== null || site.river.statedDistanceM !== null;
  const facts: [string, string][] = [
    ...(at && at.terrainM <= 0 ? ([[`Nearest mapped flood water, ${rpLabel(at.returnPeriod)} terrain map`, at.nearestWetM !== null ? `${about}${fmtDistance(at.nearestWetM)}` : "none on this map"]] as [string, string][]) : []),
    ["Nearest river or stream", nearest ? `${nearest.name ?? `unnamed ${nearest.kind}`}, ${about}${fmtDistance(nearest.distanceM)}` : site.waterwaysLoaded ? "none mapped" : "waterways layer not loaded"],
    ...(stated
      ? ([
          [
            "River distance, stated and measured",
            `The document says ${site.river.statedDistanceM !== null ? fmtDistance(site.river.statedDistanceM) : "no distance"}${site.river.statedName ? ` to ${site.river.statedName}` : ""}; ${
              site.river.named ? `the map measures ${about}${fmtDistance(site.river.named.distanceM)} to ${site.river.named.matchedName}` : site.river.statedName ? "the map holds no river of that name" : nearest ? `the map measures ${about}${fmtDistance(nearest.distanceM)} to the nearest` : "nothing to measure against"
            }`,
          ],
        ] as [string, string][])
      : []),
    ["Nearest drain, ditch or canal", site.drain ? `${site.drain.name ? `${site.drain.name}, ` : ""}${about}${fmtDistance(site.drain.distanceM)}` : site.waterwaysLoaded ? "none mapped" : "waterways layer not loaded"],
    [
      "Drainage stress, 0 to 1",
      site.drainageStress !== null
        ? `${fmtNum(site.drainageStress)}${site.inInformalSettlement ? ", inside an informal settlement" : ""}${site.drainageReachM !== null ? ` (1 on a drain, 0 beyond ${fmtInt(site.drainageReachM)} m)` : ""}`
        : "not measured: drainage is switched off",
    ],
  ];
  return (
    <Card className={className} title={building.name} aside={<Tag kind="none">This building</Tag>}>
      <div className="-mt-2 mb-3 text-sm text-ink-2">
        {fmtPoint(site.lat, site.lon)}
        {building.ward && ` · ${building.ward.name} ward, ${building.ward.subcounty}`}
      </div>
      {offer.severalLine && <p className="mb-3 text-xs leading-relaxed text-ink-2">{offer.severalLine}</p>}
      <p className="mb-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm leading-relaxed text-ink">{siteVerdict(offer)}</p>

      <h4 className="text-sm font-semibold text-ink">Water at the site, by return period</h4>
      <p className="mb-2 mt-0.5 text-xs leading-relaxed text-muted">
        {all
          ? `One row per event, depths in metres. The water at the site is the deepest of the readings beside it, and the note under it names which one. Pick a row to show that event on the map.`
          : `One row per event, depths in metres. Depth only is selected, so the reading at the point is in force: the water at the site is the map depth at the point${offer.drainageOn ? ", or drainage ponding where that is deeper" : ""}. Pick a row to show that event on the map.`}
      </p>
      <div className="overflow-x-auto">
        <table className={`w-full text-sm ${all ? "min-w-112" : ""}`}>
          <caption className="sr-only">Water at {building.name} at each modelled return period, in metres</caption>
          <thead>
            <tr className="border-b border-line text-left align-bottom text-xs text-muted">
              <th scope="col" className="py-1.5 pr-2 font-medium">Return period</th>
              <th scope="col" className="py-1.5 pr-2 text-right font-medium">At the point, m</th>
              {all && <th scope="col" className="py-1.5 pr-2 text-right font-medium">Within the buffer, m</th>}
              {offer.drainageOn && <th scope="col" className="py-1.5 pr-2 text-right font-medium">Ponding, m</th>}
              {all && <th scope="col" className="py-1.5 pr-2 font-medium">Drains overloaded</th>}
              <th scope="col" className="py-1.5 text-right font-medium">Water at the site, m</th>
            </tr>
          </thead>
          <tbody>
            {drivers.perReturnPeriod.map((p) => {
              const shown = picked?.id === p.id;
              return (
                <tr key={p.id} aria-current={shown ? "true" : undefined} className={`border-b border-line/60 align-top ${shown ? "bg-surface-2 font-semibold text-ink" : "text-ink-2"}`}>
                  <th scope="row" className="py-1.5 pr-2 text-left font-[inherit]">
                    <button onClick={() => onPick(p.id)} title={rpWithChance(p.returnPeriod)} aria-label={`Show the ${rpWithChance(p.returnPeriod)} event`} className="whitespace-nowrap underline-offset-2 hover:underline">
                      {rpLabel(p.returnPeriod)}
                    </button>
                    <span className="block text-xs font-normal text-muted">
                      {annualChance(p.returnPeriod)}{shown ? ", shown" : ""}
                    </span>
                  </th>
                  <td className="tabular py-1.5 pr-2 text-right">{dryOr(p.depths.pointM)}</td>
                  {all && <td className="tabular py-1.5 pr-2 text-right">{dryOr(p.depths.bufferM)}</td>}
                  {offer.drainageOn && <td className="tabular py-1.5 pr-2 text-right">{dryOr(p.depths.pondingM)}</td>}
                  {all && (
                    <td className="py-1.5 pr-2">
                      {p.depths.overloaded ? "Yes" : "No"}
                      {p.depths.overloaded && p.depths.overloadM > 0 && <span className="tabular block text-xs font-normal text-muted">{fmtNum(p.depths.overloadM)} m</span>}
                    </td>
                  )}
                  <td className="tabular py-1.5 text-right">
                    {dryOr(p.depths.surfaceM)}
                    {p.surfaceFrom !== "dry" && <span className="block text-xs font-normal text-muted">{WATER_NOTE[p.surfaceFrom]}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {picked && (
        <p className="mt-2 text-xs leading-relaxed text-ink-2">
          {rpWithChance(picked.returnPeriod)}: {picked.depths.surfaceM > 0 ? `${metres(picked.depths.surfaceM)} of water at the site, from ${WATER_FROM[picked.surfaceFrom]}` : "no water at the site"}.
          {isScore && at && at.terrainM > 0 && ` The depth at the point is the map's score of ${fmtNum(at.hazard, 3)} turned into metres.`}
        </p>
      )}

      {all ? (
        <ul className="mt-3 space-y-2.5 border-t border-line pt-3 text-xs leading-relaxed text-ink-2">
          <li>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <strong className="font-semibold text-ink">Buffer: {fmtInt(drivers.bufferRadiusM)} m</strong> <Tag kind="assumption" />
              {offer.judgement.setBy.bufferRadiusM === "agents" && <Tag kind="ai" />}
            </span>
            <span className="mt-0.5 block">The highest map depth within {fmtInt(drivers.bufferRadiusM)} m of the building is used, drawn as the dashed ring. Set by: {SETTER_LABELS[offer.judgement.setBy.bufferRadiusM]}.</span>
          </li>
          <li>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <strong className="font-semibold text-ink">Drains designed for: {rpWithChance(design.returnPeriod)}</strong>
              {design.source.kind === "offer" ? <Tag kind={offer.document.path === "model" ? "ai" : "real"}>From the offer</Tag> : <Tag kind="assumption" />}
            </span>
            <span className="mt-0.5 block">
              {design.source.what}. A rarer event overloads them, and the site is then taken to have at least {metres(drivers.judgement.drainOverloadDepthM)} of water.
            </span>
            {design.source.kind === "offer" && design.source.quote && <q className="mt-1 block text-muted">{design.source.quote}</q>}
            {design.source.kind === "offer" && onOpenStep && (
              <button onClick={() => onOpenStep("offer")} className="mt-1 font-medium text-ink underline underline-offset-2">
                See it in {STEP_NAMES.offer}
              </button>
            )}
          </li>
          <li>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <strong className="font-semibold text-ink">Water when the drains are overloaded: {metres(drivers.judgement.drainOverloadDepthM)}</strong> <Tag kind="assumption" />
            </span>
            <span className="mt-0.5 block">Set by: {SETTER_LABELS[offer.judgement.setBy.drainOverloadDepthM]}.</span>
          </li>
          {onOpenStep && (
            <li>
              Each assumption, its range and the reasons are in{" "}
              <button onClick={() => onOpenStep("agents")} className="font-medium text-ink underline underline-offset-2">
                {STEP_NAMES.agents}
              </button>
              .
            </li>
          )}
        </ul>
      ) : (
        <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-2">
          <strong className="font-semibold text-ink">{LOSS_MODE_LABELS.depth_only}.</strong> The reading at the point is in force: no buffer is read, no ring is drawn and drain overload is not counted. {selectMode("all_drivers")} to see them.
        </p>
      )}

      <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-muted">{label}</dt>
            <dd className="tabular ml-auto min-w-0 wrap-break-word text-right text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-2">
        {site.approximate ? (
          <p>
            <strong className="font-semibold text-ink">Approximate location.</strong> The document gives no usable coordinates, so {building.standIn ?? "a named place"} stands in for them. The map shows a wide ring and no block, no outline is looked up, and every depth and distance here is approximate.
          </p>
        ) : footprintLoading ? (
          <p className="flex items-center gap-2">
            <span className="spinner inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-line border-t-ink" /> Looking up the building&rsquo;s outline on OpenStreetMap. A square block of approximate shape stands at the stated coordinates meanwhile.
          </p>
        ) : footprint?.found ? (
          <p>
            <strong className="font-semibold text-ink">{FOOTPRINT_LABEL}.</strong> {footprint.distanceM > 0 ? `Its nearest wall is ${fmtDistance(footprint.distanceM)} from them` : "The coordinates fall inside it"}
            {footprint.name ? `; it is mapped as "${footprint.name}"` : ""}. The block on the map stands on this outline.{" "}
            <a href={footprint.osmUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
              View the outline on OpenStreetMap
            </a>
            . {OSM_CREDIT}.
          </p>
        ) : (
          <p>
            <strong className="font-semibold text-ink">Shape approximate.</strong> {footprint?.reason ?? `No building outline within ${fmtInt(FOOTPRINT_RADIUS_M)} m`}. The block on the map is a square{block?.sideM ? ` of ${fmtInt(block.sideM)} m a side` : ""}, centred on the stated coordinates{building.floorAreaM2 !== null ? ", sized from the stated floor area" : ""}.
          </p>
        )}
        {block && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              <strong className="font-semibold text-ink">Block height:</strong> {heightText(block)}.
            </span>
            {heightIsAssumption(block) && <Tag kind="assumption" />}
          </p>
        )}
        {block && <p className="mt-1.5 text-muted">The block shows where the building stands and roughly how large it is. Its shape and height play no part in the flood depth or the loss.</p>}
        {!site.approximate && <p className="mt-1.5 text-muted">The lookup sends the coordinates, and nothing else, to a public OpenStreetMap server.</p>}
      </div>

      {onOpenStep && (
        <p className="mt-3 text-xs leading-relaxed text-ink-2">
          What this water does to the building is in{" "}
          <button onClick={() => onOpenStep("vulnerability")} className="font-medium text-ink underline underline-offset-2">
            {STEP_NAMES.vulnerability}
          </button>
          .
        </p>
      )}
      <SourceLine
        className="mt-3 border-t border-line pt-3"
        sources={[
          { kind: "real", text: `${isScore ? "Hazard maps, whose score is a derived proxy" : "Flood depth maps"}; rivers, drains and the outline from OpenStreetMap` },
          { kind: "assumption", text: `${isScore ? "The scale that turns the score into metres" : "Return periods"}${offer.drainageOn ? ", drainage ponding and its reach" : ""}${all ? `, the buffer radius, ${design.source.kind === "offer" ? "" : "the drain design return period and "}the water depth when the drains are overloaded` : ""}` },
          { kind: offer.document.path === "model" ? "ai" : "real", text: `The building's ${site.approximate ? "place name" : "coordinates"}${stated ? " and the stated river distance" : ""}, read from the offer document${offer.document.path === "model" ? "" : " by fixed rules"} (${STEP_NAMES.offer})` },
        ]}
      />
    </Card>
  );
}

/**
 * The portfolio view's driver counts: how many insured buildings each of drivers 1 to 3 puts water at
 * in the event picked. With Depth only there is no split, and a line says the point reading is in force.
 */
function PortfolioDrivers({ result, counts, event, drainageOn, onOpenStep }: { result: Active["result"]; counts: DriverCounts | null; event: string; drainageOn: boolean; onOpenStep?: (id: StepId) => void }) {
  const j = result.judgement;
  if (!counts || !j) {
    return (
      <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-ink-2">
        <strong className="font-semibold text-ink">{LOSS_MODE_LABELS.depth_only}.</strong> Each building is read at its own point{drainageOn ? ", with drainage ponding where that is deeper" : ""}. {selectMode("all_drivers")} to count water around a building and from overloaded drains.
      </p>
    );
  }
  const total = result.buildingCount;
  const rows: [string, number, string][] = [
    ["Wet at the point", counts.point, "the map shows water at the building's own point"],
    [`Wet within the buffer (${fmtInt(j.bufferRadiusM)} m)`, counts.buffer, "the map shows water at the point or around it"],
    ["Wet by drainage ponding", counts.ponding, drainageOn ? "near a mapped drain or inside an informal settlement" : "drainage is switched off"],
    ["Wet by drain overload", counts.overload, counts.overload > 0 ? `${fmtInt(counts.overloadAlone)} of them have no other water` : `the drains are taken as designed for a ${rpLabel(j.drainDesignRp)} event`],
  ];
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="text-xs font-semibold text-ink">Where the water comes from, {event} event</div>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">Insured buildings out of {fmtInt(total)}. A building can be counted on more than one line.</p>
      <ul className="mt-1.5 space-y-1.5 text-sm">
        {rows.map(([label, n, note]) => (
          <li key={label} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="min-w-0 text-ink-2">
              {label}
              <span className="block text-xs text-muted">{note}</span>
            </span>
            <span className="tabular ml-auto shrink-0 whitespace-nowrap font-semibold text-ink">
              {fmtInt(n)} <span className="font-normal text-muted">of {fmtInt(total)}</span>
            </span>
          </li>
        ))}
      </ul>
      {onOpenStep && (
        <p className="mt-2 text-xs leading-relaxed text-ink-2">
          The loss each driver adds is in{" "}
          <button onClick={() => onOpenStep("loss")} className="font-medium text-ink underline underline-offset-2">
            {STEP_NAMES.loss}
          </button>
          .
        </p>
      )}
      <SourceLine
        className="mt-2"
        sources={[
          { kind: "synthetic", text: "Insured buildings, placed at random" },
          { kind: "assumption", text: `Buffer of ${fmtInt(j.bufferRadiusM)} m, drains designed for a ${rpWithChance(j.drainDesignRp)} event, ${fmtNum(j.drainOverloadDepthM)} m of water when they are overloaded${drainageOn ? ", drainage ponding" : ""}` },
        ]}
      />
    </div>
  );
}

function SelectionCard({
  hint,
  className,
  session,
  active,
  k,
  geo,
  wardOf,
  wardRows,
  selection,
  onClear,
}: {
  /** What to say while nothing is picked. */
  hint: string;
  className: string;
  session: Session;
  active: Active;
  k: number;
  geo: GeoLayers | null;
  wardOf: number[];
  wardRows: AreaRow[];
  selection: Selection | null;
  onClear: () => void;
}) {
  const r = active.result;
  const isScore = session.dataset.hazardKind === "score";
  const event = rpWithChance(r.scenarios[k].returnPeriod);
  if (!selection) {
    return (
      <Card className={`flex flex-col ${className}`} title="Details">
        {/* This card can be much taller than its one line, so the line sits in a marked-out space that shows where the details will go. */}
        <p className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line px-4 py-3 text-center text-sm leading-relaxed text-ink-2">{hint}</p>
      </Card>
    );
  }
  if (selection.type === "building") {
    const b = session.dataset.buildings[selection.index];
    const per = r.buildings[selection.index].perScenario;
    const t = per[k];
    const ward = wardOf[selection.index] >= 0 ? geo?.wards?.features[wardOf[selection.index]]?.properties : null;
    const s = r.scenarios[k];
    const rows: [string, string][] = [
      ["Insured value", fmtKes(b.tivKes, 2)],
      [isScore ? "Hazard score" : "Flood depth", isScore ? fmtNum(t.hazard, 3) : `${fmtNum(t.hazard)} m`],
      ...(isScore ? ([["Terrain depth", `${fmtNum(t.hazard, 3)} × ${fmtNum(s.tierSlope, 3)} × ${fmtNum(r.params.depthScaleM)} m = ${fmtNum(t.hazard > 0 ? t.hazard * s.tierSlope * r.params.depthScaleM : 0)} m`]] as [string, string][]) : []),
      ...(t.drivers ? ([["Depth within the buffer", `${fmtNum(t.drivers.bufferM)} m${t.drivers.bufferM > t.drivers.pointM ? ", deeper than at the point" : ""}`]] as [string, string][]) : []),
      ...(t.drainageM > 0 ? ([["Drainage ponding", `${fmtNum(t.drainageM)} m${t.drainageM >= t.depthM ? ", the deepest water, so used" : ""}`]] as [string, string][]) : []),
      ...(t.drivers ? ([["Drains overloaded", t.drivers.overloaded ? `yes, at least ${fmtNum(t.drivers.overloadM)} m of water` : "no"]] as [string, string][]) : []),
      ...(t.drivers ? ([["Water at the site", `${fmtNum(t.drivers.surfaceM)} m`]] as [string, string][]) : []),
      ["Depth on the curve", `${fmtNum(t.effectiveDepthM)} m (fragility ${fmtNum(r.params.fragility[b.housingClass])})`],
      ["Damage", `${fmtPct(t.damageRatio, 1)}${t.capped ? " (capped)" : ""}`],
      ["Loss", fmtKes(t.lossKes, 2)],
    ];
    return (
      <Card className={className} title={`${b.locId}`} aside={<button onClick={onClear} className="text-xs text-ink-2 underline-offset-2 hover:underline">Clear</button>}>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Swatch color={CLASS_COLORS[b.housingClass]} /> {HOUSING_LABELS[b.housingClass]}
          {ward && <span>· {ward.name}, {ward.subcounty}</span>}
        </div>
        <dl className="space-y-1 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap justify-between gap-x-3">
              <dt className="text-muted">{label}</dt>
              <dd className="tabular ml-auto min-w-0 wrap-break-word text-right text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 border-t border-line pt-2 text-xs text-muted">Ground-up loss at every event, KES. The figures above are for the {event} event.</div>
        {/* As many events to a row as the text size leaves room for, so no figure is squeezed out of its cell. */}
        <div className="mt-1 grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-1 text-center text-xs">
          {per.map((p, i) => (
            <div key={r.scenarios[i].id} className={`rounded-md px-1 py-1 ${i === k ? "bg-surface-2 font-semibold text-ink" : "text-ink-2"}`}>
              <div className="text-muted">{rpLabel(r.scenarios[i].returnPeriod)}</div>
              <div className="tabular">{p.lossKes > 0 ? kes1(p.lossKes).replace("KES ", "") : "0"}</div>
            </div>
          ))}
        </div>
        <SourceLine
          className="mt-3 border-t border-line pt-3"
          sources={[
            { kind: "synthetic", text: "The building and its insured value" },
            { kind: "real", text: isScore ? "Hazard map; the score read from it is a derived proxy" : "Flood depth map" },
            { kind: "assumption", text: `${isScore ? "Depth scale, " : ""}fragility and caps${t.drainageM > 0 ? ", drainage ponding" : ""}${t.drivers ? ", the buffer radius, the drain design return period and the water depth when the drains are overloaded" : ""}` },
          ]}
        />
      </Card>
    );
  }
  const row = wardRows[selection.index];
  if (!row) return null;
  const inWard = session.dataset.buildings.map((b, i) => ({ b, i })).filter(({ i }) => wardOf[i] === selection.index);
  const top = inWard.map(({ b, i }) => ({ b, loss: r.buildings[i].perScenario[k].lossKes })).filter((x) => x.loss > 0).sort((a, b) => b.loss - a.loss).slice(0, 3);
  const portfolioLoss = r.scenarios[k].lossKes || 1;
  return (
    <Card className={className} title={`${row.name} ward`} aside={<button onClick={onClear} className="text-xs text-ink-2 underline-offset-2 hover:underline">Clear</button>}>
      <div className="mb-2 text-sm text-ink-2">{row.subcounty} sub-county · {event} event</div>
      <dl className="space-y-1 text-sm">
        {(
          [
            ["Insured buildings", fmtInt(row.buildings)],
            ["Insured value", fmtKes(row.tivKes)],
            ["Buildings flooded at this event", fmtInt(row.flooded)],
            ["Ground-up loss at this event", fmtKes(row.lossKes)],
            ["Share of portfolio loss", fmtPct(row.lossKes / portfolioLoss, 1)],
          ] as [string, string][]
        ).map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-muted">{label}</dt>
            <dd className="tabular ml-auto min-w-0 wrap-break-word text-right text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {top.length > 0 && (
        <div className="mt-3 border-t border-line pt-2 text-xs text-ink-2">
          Largest losses here: {top.map((x) => `${x.b.locId} (${fmtKes(x.loss)})`).join(", ")}
        </div>
      )}
      <SourceLine
        className="mt-3 border-t border-line pt-3"
        sources={[
          { kind: "synthetic", text: "Insured buildings, placed at random" },
          { kind: "real", text: `Ward boundary; ${isScore ? "hazard map, whose score is a derived proxy" : "flood depth map"}` },
        ]}
      />
    </Card>
  );
}
