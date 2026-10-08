"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { DEPTH_LABELS } from "@/lib/geo/hazardImage";
import { loadGeo, type FacilityKind, type GeoLayers } from "@/lib/geo/layers";
import { annualChance, kes1, rpLabel, rpWithChance } from "@/lib/labels";
import { assignPoints, facilityDepths, geometryBBox, wardAccumulation, type AreaRow, type BBox } from "@/lib/geo/spatial";
import { HOUSING_CLASSES, HOUSING_LABELS } from "@/lib/model/types";
import { FREQUENT_FLOOD_RP, type FocusReturnPeriod, type PricedFocus } from "@/lib/offer/focus";
import { findFootprint, FOOTPRINT_LABEL, FOOTPRINT_RADIUS_M, OSM_CREDIT, type Footprint } from "@/lib/offer/footprint";
import { fmtDistance, fmtPoint, plural } from "@/lib/offer/shared";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, type StepId } from "@/lib/steps";
import { useTheme } from "@/lib/useDisplay";
import { DRAINAGE_COLOR, FACILITY_COLORS, OFFER_COLOR, SETTLEMENT_COLOR, WARD_COLOR, WARD_METRICS, WATER_COLORS, type BasemapStatus, type LayerKey, type LayerState, type MapView, type OfferMark, type Selection, type WardMetric } from "../map/mapTheme";
import { ChartFrame, SourceLine, type ChartSource } from "../charts/ChartFrame";
import { Button, Card, Note, Segmented, Tag } from "../ui";
import { CLASS_COLORS } from "./DataStep";

const RiskMap = dynamic(() => import("../map/RiskMap").then((m) => m.RiskMap), {
  ssr: false,
  loading: () => <div className="h-full w-full rounded-xl border border-line bg-surface-2" />,
});

/**
 * The map's height follows the window. On a wide screen it takes what is left under the page
 * header once the step heading, the line under the map and the Back / Next bar have their room,
 * so the whole map is on the first screen. On a short screen it is never taller than what can be
 * seen at once between the header and that bar. The last term keeps a very tall window from
 * making the map much taller than it is wide (21rem is the side panel and its gap).
 * The placeholders fill the same box, so the page does not jump when the map arrives.
 */
const MAP_HEIGHT =
  "h-[clamp(22rem,60dvh,min(36rem,150cqw))] lg:h-[clamp(20rem,max(100dvh_-_var(--header-height,9rem)_-_14rem,min(30rem,100dvh_-_var(--header-height,9rem)_-_7.25rem)),min(56rem,max(24rem,100cqw_-_21rem)))]";

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
const metricText = (row: AreaRow, m: WardMetric) => (m === "loss" ? kes1(row.lossKes) : m === "tiv" ? kes1(row.tivKes) : m === "flooded" ? `${fmtInt(row.flooded)} buildings` : fmtPct(metricValue(row, m), 1));

/** What each ward measure is counted in, for column heads and the map key. */
const METRIC_UNITS: Record<WardMetric, string> = { loss: "KES", tiv: "KES", flooded: "buildings", lossRatio: "% of insured value" };

/** The facility dots on the map, named one by one so the key does not lean on colour alone. */
const FACILITY_KEY: { label: string; kind: FacilityKind }[] = [
  { label: "hospital", kind: "hospital" },
  { label: "clinic", kind: "clinic" },
  { label: "school", kind: "school" },
  { label: "police", kind: "police" },
  { label: "fire station", kind: "fire_station" },
];

function Swatch({ color, shape = "dot" }: { color: string; shape?: "dot" | "line" | "square" | "ring" }) {
  if (shape === "line") return <span aria-hidden className="inline-block h-[3px] w-4 shrink-0 rounded-full" style={{ background: color }} />;
  if (shape === "square") return <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-[3px]" style={{ background: color }} />;
  if (shape === "ring") return <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-full border-2 bg-surface" style={{ borderColor: color }} />;
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

function Toggle({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-surface-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]" />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/**
 * The layers shown when the map opens. Around an offer building the map starts quiet: the flood depth,
 * the portfolio's buildings drawn faint, and the rivers and drains. The portfolio view starts with everything on.
 */
const defaultLayers = (forOffer: boolean): LayerState => ({ hazard: true, drainage: !forOffer, buildings: true, wards: !forOffer, waterways: true, settlements: !forOffer, facilities: !forOffer, hotspots: !forOffer });

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

/** What the hazard at the site means for the decision, in one or two plain sentences. */
function siteVerdict(offer: PricedFocus): string {
  const b = offer.price.building;
  const rarest = b.perReturnPeriod[b.perReturnPeriod.length - 1];
  const first = b.perReturnPeriod.find((p) => p.depthM > 0);
  if (b.dryAtEveryReturnPeriod || !first || !rarest) {
    const near = b.nearestWetM !== null && b.nearestWetM > 0 ? ` The nearest mapped flood water is ${fmtDistance(b.nearestWetM)} away.` : "";
    return `Dry at every modelled return period${offer.drainageOn ? ", on the terrain maps and from drainage ponding" : " on the terrain maps"}.${near} The model puts no flood loss on this building, so the decision rests on how far the hazard layer can be trusted at this site.`;
  }
  const frequent = first.returnPeriod <= FREQUENT_FLOOD_RP ? ` Water this often is raised as a flag in ${STEP_NAMES.results}.` : "";
  const deepest = rarest === first ? "" : ` and stands at ${metres(rarest.depthM)} in the ${rpLabel(rarest.returnPeriod)} event`;
  if (b.dryOnEveryTerrainMap) {
    return `Dry on every terrain map, but drainage ponding reaches the building from the ${rpWithChance(first.returnPeriod)} event (${metres(first.depthM)})${deepest}. That water is an assumption about overloaded drains, not a mapped flood.${frequent}`;
  }
  return `Water reaches the building from the ${rpWithChance(first.returnPeriod)} event (${metres(first.depthM)}, from ${first.depthFrom === "drainage" ? "drainage ponding" : "the terrain map"})${deepest}.${frequent}`;
}

/**
 * The interactive risk map with its side panel and layer key. The Hazard map step renders it.
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
  const offerMark = useMemo<OfferMark | null>(() => {
    if (!offer || pointKey === null || siteLat === null || siteLon === null) return null;
    const water = !atBuilding ? null : atBuilding.depthM > 0 ? `${metres(atBuilding.depthM)} of water${atBuilding.depthFrom === "drainage" ? " (drainage ponding)" : ""}` : "dry";
    return {
      key: pointKey,
      lat: siteLat,
      lon: siteLon,
      name: offer.building.name,
      approximate: offer.site.approximate,
      outline: footprint?.found ? footprint.polygon.coordinates : null,
      lines: [
        offer.site.approximate ? "The offer building, approximate location" : "The offer building",
        ...(offer.building.housingLabel ? [offer.building.housingLabel] : []),
        ...(water ? [`${event} event: ${water}`] : []),
      ],
    };
  }, [offer, pointKey, siteLat, siteLon, atBuilding, footprint, event]);
  const offerKeyText = !offer
    ? ""
    : offer.site.approximate
      ? "A marker inside a ring: the location is approximate"
      : footprint?.found
        ? FOOTPRINT_LABEL
        : footprintLoading
          ? "A marker while its outline is looked up"
          : "A marker at the stated coordinates";
  const tierNote = `${isScore ? `the "${s.id}" map, assumed to be a ${event} event` : `the published ${event} depth map`}${drainage ? `, plus drainage ponding up to ${fmtNum(drainage.depthM[dataset.scenarios.findIndex((x) => x.id === s.id)] ?? 0)} m near drains and in informal settlements` : ""}`;

  return (
    <>
      {/* Columns follow the room the step has at the chosen text size, not the screen width alone.
          With room for two columns the panel sits beside the map, the layers and the note on sources.
          With room for three, that note moves up beside the layers it describes.
          The layers row is the one that gives, so the map row is never stretched and nothing is left blank under either column. */}
      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:grid-rows-[auto_1fr] @6xl:grid-cols-[minmax(0,1fr)_22rem_22rem]">
        <div className="min-w-0 @6xl:col-span-2">
          <div className={MAP_HEIGHT}>
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
                offer={offerMark}
                muted={forOffer}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-line bg-surface-2 text-sm text-ink-2">Loading map layers</div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              {status === "online" ? "Live basemap: OpenStreetMap data via OpenFreeMap, terrain from open elevation tiles." : status === "offline" ? "No connection to the basemap server: model layers shown on a plain background." : "Connecting to the basemap"}
            </span>
            <span>Drag with the right mouse button (or two fingers) to tilt and turn.</span>
          </div>
        </div>

        {/* Beside the map this is one column. Under the map, on a screen too narrow for two columns, the cards sit side by side where they fit. */}
        <div className="flex min-w-0 flex-wrap gap-4 @3xl:col-start-2 @3xl:row-span-3 @3xl:row-start-1 @3xl:flex-col @3xl:flex-nowrap @6xl:col-start-3 @6xl:row-span-2">
          <Card className={SIDE_CARD} title="Event" aside={<Tag kind={isScore ? "assumption" : "real"}>{isScore ? "Return period assumed" : "From the data"}</Tag>}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-display text-3xl font-semibold tracking-tight text-ink">{event}</span>
              <span className="text-xs text-muted">{annualChance(s.returnPeriod)} chance</span>
            </div>
            <input
              aria-label="Event return period, in years"
              aria-valuetext={eventWithChance}
              type="range"
              min={0}
              max={last}
              step={1}
              value={ki}
              onChange={(e) => {
                setPlaying(false);
                setK(Number(e.target.value));
              }}
              className="mt-3 w-full accent-[var(--brand)]"
            />
            <div className="mt-1 flex justify-between text-xs text-muted tabular">
              {r.scenarios.map((x, i) => (
                <button key={x.id} onClick={() => setK(i)} aria-label={rpWithChance(x.returnPeriod)} title={rpWithChance(x.returnPeriod)} className={i === ki ? "font-semibold text-ink" : "hover:text-ink"}>
                  {x.returnPeriod}
                </button>
              ))}
            </div>
            <div className="mt-0.5 text-center text-xs text-muted">
              Return period in years, from {rpLabel(r.scenarios[0].returnPeriod)} (most frequent) to {rpLabel(r.scenarios[last].returnPeriod)} (rarest)
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-2">Showing {tierNote}.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  if (!playing && ki >= last) setK(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? "Pause" : "Play the flood"}
              </Button>
              <Button variant={threeD ? "primary" : "secondary"} onClick={() => setThreeD((v) => !v)} aria-pressed={threeD}>
                {threeD ? "Back to 2D" : "3D view"}
              </Button>
            </div>
          </Card>

          {offer ? (
            <OfferSiteCard
              className={SIDE_CARD}
              offer={offer}
              at={atBuilding}
              onPick={(id) => {
                const i = r.scenarios.findIndex((x) => x.id === id);
                if (i < 0) return;
                setPlaying(false);
                setK(i);
              }}
              footprint={footprint}
              footprintLoading={footprintLoading}
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
            <p className="mt-2 text-xs leading-relaxed text-muted">All four figures are for the {eventWithChance} event picked above. Ground-up means before deductibles and reinsurance.</p>
            <SourceLine sources={[portfolioSource, hazardSource, assumptionSource]} className="mt-3 border-t border-line pt-3" />
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

          {/* The last card takes up any height the map and the layers leave over. */}
          <SelectionCard hint={offer ? "Click a portfolio building near the offer to trace its loss." : "Click a building to trace its loss, or a ward to see what it holds."} className="flex-[1_1_18rem] @3xl:flex-auto" session={session} active={active} k={ki} geo={geo} wardOf={wardOf} wardRows={wardRows} selection={selection} onClear={() => setSelection(null)} />
        </div>

        {/* The layers double as the map's legend, so they sit right under it, in as many columns as fit. */}
        <Card title="Layers and map key" className="@3xl:col-start-1 @3xl:row-start-2">
          <p className="mb-3 max-w-3xl text-sm leading-relaxed text-ink-2">Tick a layer to show it. The marks beside each name are the ones drawn on the map, for the {eventWithChance} event. Point at anything on the map to read its figures.</p>
          <div className="-mx-2 grid grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))] content-start gap-x-2 gap-y-0.5">
            {offer && (
              <div className="flex items-start gap-2.5 px-2 py-1.5 text-sm text-ink">
                {offer.site.approximate ? (
                  <span aria-hidden className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2" style={{ borderColor: OFFER_COLOR }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: OFFER_COLOR }} />
                  </span>
                ) : footprint?.found ? (
                  <span aria-hidden className="mt-0.5 h-4 w-4 shrink-0 rounded-[3px] border-2 bg-(--brand-wash)" style={{ borderColor: OFFER_COLOR }} />
                ) : (
                  <span aria-hidden className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-surface ring-1 ring-line" style={{ background: OFFER_COLOR }} />
                )}
                <span className="min-w-0 flex-1">
                  <strong className="font-semibold">Offer building</strong> <span className="text-xs text-muted">(always shown, above every layer)</span>
                  <span className="mt-0.5 block text-xs text-ink-2">{offerKeyText}. From far out it is a marker inside a ring.</span>
                </span>
              </div>
            )}
            <Toggle id="lyr-hazard" checked={layers.hazard} onChange={(v) => setLayer("hazard", v)}>
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  Flood depth, metres {isScore && <span className="text-xs text-muted">(score converted to metres)</span>}
                </span>
                <Tag kind={isScore ? "proxy" : "real"} />
              </span>
              <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                {DEPTH_LABELS.map((l, i) => (
                  <span key={l} className="inline-flex items-center gap-1 text-xs text-ink-2">
                    <span aria-hidden className="inline-block h-2.5 w-3.5 shrink-0 rounded-sm" style={{ background: `var(--seq-${i + 1})` }} />
                    {l}
                  </span>
                ))}
              </span>
              <span className="mt-0.5 block text-xs text-ink-2">Five bands from shallowest to deepest, each with its depth range written beside it.</span>
            </Toggle>
            {drainage && (
              <Toggle id="lyr-drainage" checked={layers.drainage} onChange={(v) => setLayer("drainage", v)}>
                <span className="inline-flex items-center gap-1.5"><Swatch shape="square" color={DRAINAGE_COLOR} /> Drainage zone</span>
                <span className="mt-0.5 block text-xs text-ink-2">Within {fmtInt(drainage.reachM)} m of a mapped drain or inside an informal settlement; darker means closer. Ponding of up to {fmtNum(pondingM)} m is assumed there at this event.</span>
              </Toggle>
            )}
            <Toggle id="lyr-buildings" checked={layers.buildings} onChange={(v) => setLayer("buildings", v)}>
              {offer ? "The portfolio's insured buildings" : "Insured buildings"} <span className="text-xs text-muted">(synthetic)</span>
              <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-2">
                {HOUSING_CLASSES.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1">
                    <Swatch color={CLASS_COLORS[c]} />
                    {HOUSING_LABELS[c]}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1">
                  <Swatch color={WARD_COLOR} shape="ring" /> takes a loss
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-ink-2">
                A larger dot is a larger insured value (KES); a faint dot is dry at this event. In the 3D view a taller column is a larger loss (KES).
                {offer && ` Drawn small here so the offer stands out: ${plural(offer.site.neighbours.count, "building")} of the portfolio ${offer.site.neighbours.count === 1 ? "lies" : "lie"} within ${fmtDistance(offer.site.neighbours.radiusM)} of it.`}
              </span>
            </Toggle>
            <Toggle id="lyr-wards" checked={layers.wards} onChange={(v) => setLayer("wards", v)}>
              Wards shaded by
              <select aria-label="Ward shading" value={wardMetric} onChange={(e) => setWardMetric(e.target.value as WardMetric)} className="ml-1.5 rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs text-ink">
                {WARD_METRICS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-[3px] border" style={{ borderColor: WARD_COLOR }} /> lowest
                </span>
                <span className="inline-flex items-center gap-1">
                  <Swatch shape="square" color={WARD_COLOR} /> highest{topWards[0] ? `: ${topWards[0].name}, ${metricText(topWards[0], wardMetric)}` : ""}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-ink-2">A deeper shade is a ward with more at this event, measured in {METRIC_UNITS[wardMetric]}.</span>
            </Toggle>
            <Toggle id="lyr-water" checked={layers.waterways} onChange={(v) => setLayer("waterways", v)}>
              Rivers, streams and drains
              <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-ink-2">
                <span className="inline-flex items-center gap-1"><Swatch shape="line" color={WATER_COLORS.river} /> river</span>
                <span className="inline-flex items-center gap-1"><Swatch shape="line" color={WATER_COLORS.stream} /> stream</span>
                <span className="inline-flex items-center gap-1"><Swatch shape="line" color={WATER_COLORS.drain} /> drain or ditch</span>
              </span>
            </Toggle>
            <Toggle id="lyr-settlements" checked={layers.settlements} onChange={(v) => setLayer("settlements", v)}>
              <span className="inline-flex items-center gap-1.5"><Swatch shape="square" color={SETTLEMENT_COLOR} /> Informal settlements</span>
            </Toggle>
            <Toggle id="lyr-facilities" checked={layers.facilities} onChange={(v) => setLayer("facilities", v)}>
              Schools, health and emergency services <span className="text-xs text-muted">(zoom in to see)</span>
              <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-2">
                {FACILITY_KEY.map((f) => (
                  <span key={f.kind} className="inline-flex items-center gap-1">
                    <Swatch color={FACILITY_COLORS[f.kind]} />
                    {f.label}
                  </span>
                ))}
              </span>
              <span className="mt-0.5 block text-xs text-ink-2">A larger dot with a dark outline stands in water at this event.</span>
            </Toggle>
            <Toggle id="lyr-hotspots" checked={layers.hotspots} onChange={(v) => setLayer("hotspots", v)}>
              County-named flood areas
              <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-ink-2">
                <span className="inline-flex items-center gap-1"><Swatch color="var(--navy-line)" /> flagged by the proxy</span>
                <span className="inline-flex items-center gap-1"><Swatch shape="ring" color={WARD_COLOR} /> missed</span>
              </span>
            </Toggle>
          </div>
          <SourceLine
            className="mt-4 border-t border-line pt-3"
            sources={[
              { kind: "real", text: `${isScore ? "Hazard maps (the flood score on them is a derived proxy)" : "Flood depth maps"}, ward boundaries, OpenStreetMap rivers, drains, settlements and facilities, county-named flood areas` },
              { kind: "synthetic", text: "Insured buildings" },
              { kind: "assumption", text: `Return periods${isScore ? ", the scale that turns the score into metres" : ""}${drainage ? ", drainage ponding depths" : ""}` },
            ]}
          />
        </Card>

        {!offer && (
        <ChartFrame
          className="@3xl:col-span-2 @3xl:row-start-4 @6xl:col-span-3 @6xl:row-start-3"
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

        {/* A grid, so the note is as tall as the layers card when the two share a row. */}
        <div className="grid @3xl:col-start-1 @3xl:row-start-3 @6xl:col-start-2 @6xl:row-start-2">
          <Note>
            <strong className="font-semibold text-ink">What is real here.</strong> Ward boundaries are the 85 Nairobi wards (Omare &amp; Omare 2017, CC BY 4.0). Rivers, drains, informal settlements, schools and health facilities are from OpenStreetMap (data from February and May 2025); informal settlement outlines are incomplete there, Kibera for instance is mapped only as a point. The flood layer is the hazard proxy converted to depth with the assumptions in force{dataset.drainage ? ", plus drainage ponding near OpenStreetMap drains and inside informal settlements, which is our own assumption" : ""}. The buildings are synthetic and placed at random, so ward totals show how accumulation would be read, not a real concentration of risk.
          </Note>
        </div>
      </div>
    </>
  );
}

/** The side card of the offer view: the flood depth at the building at every return period, and what lies around it. */
function OfferSiteCard({
  className,
  offer,
  at,
  onPick,
  footprint,
  footprintLoading,
  onOpenStep,
}: {
  className: string;
  offer: PricedFocus;
  /** The row of the return period picked on the slider. */
  at: FocusReturnPeriod | null;
  onPick: (scenarioId: string) => void;
  footprint: Footprint | null;
  footprintLoading: boolean;
  onOpenStep?: (id: StepId) => void;
}) {
  const { building, site } = offer;
  const price = offer.price.building;
  const isScore = offer.hazardKind === "score";
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

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="mb-1.5 text-left text-xs leading-relaxed text-muted">
            Flood depth at the building, in metres.{offer.drainageOn ? " The deeper of terrain and ponding is the depth used." : ""} Pick a row to show that event on the map.
          </caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th scope="col" className="py-1.5 pr-2 font-medium">Return period</th>
              <th scope="col" className="py-1.5 pr-2 text-right font-medium">Terrain, m</th>
              {offer.drainageOn && <th scope="col" className="py-1.5 pr-2 text-right font-medium">Ponding, m</th>}
              <th scope="col" className="py-1.5 text-right font-medium">Depth used, m</th>
            </tr>
          </thead>
          <tbody>
            {price.perReturnPeriod.map((p) => {
              const picked = at?.id === p.id;
              return (
                <tr key={p.id} aria-current={picked ? "true" : undefined} className={`border-b border-line/60 ${picked ? "bg-surface-2 font-semibold text-ink" : "text-ink-2"}`}>
                  <th scope="row" className="py-1.5 pr-2 text-left font-[inherit]">
                    <button onClick={() => onPick(p.id)} title={rpWithChance(p.returnPeriod)} aria-label={`Show the ${rpWithChance(p.returnPeriod)} event`} className="whitespace-nowrap underline-offset-2 hover:underline">
                      {rpLabel(p.returnPeriod)}
                    </button>
                    {picked && <span className="ml-1.5 text-xs font-normal text-muted">shown</span>}
                  </th>
                  <td className="tabular py-1.5 pr-2 text-right">{fmtNum(p.terrainM)}</td>
                  {offer.drainageOn && <td className="tabular py-1.5 pr-2 text-right">{fmtNum(p.drainageM)}</td>}
                  <td className="tabular py-1.5 text-right">{p.depthM > 0 ? fmtNum(p.depthM) : "dry"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {at && (
        <p className="mt-2 text-xs leading-relaxed text-ink-2">
          {rpWithChance(at.returnPeriod)}: {at.depthM > 0 ? `${metres(at.depthM)} at the building, from ${at.depthFrom === "drainage" ? "drainage ponding" : "the terrain map"}` : "dry at the building"}.
          {isScore && at.terrainM > 0 && ` The terrain depth is the map's score of ${fmtNum(at.hazard, 3)} turned into metres.`}
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
            <strong className="font-semibold text-ink">Approximate location.</strong> The document gives no usable coordinates, so {building.standIn ?? "a named place"} stands in for them. The building is drawn as a marker inside a ring, no outline is looked up, and every depth and distance here is approximate.
          </p>
        ) : footprintLoading ? (
          <p className="flex items-center gap-2">
            <span className="spinner inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-line border-t-ink" /> Looking up the building&rsquo;s outline on OpenStreetMap. A marker shows the stated coordinates meanwhile.
          </p>
        ) : footprint?.found ? (
          <p>
            <strong className="font-semibold text-ink">{FOOTPRINT_LABEL}.</strong> {footprint.distanceM > 0 ? `Its nearest wall is ${fmtDistance(footprint.distanceM)} from them` : "The coordinates fall inside it"}
            {footprint.name ? `; it is mapped as "${footprint.name}"` : ""}.{" "}
            <a href={footprint.osmUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
              View the outline on OpenStreetMap
            </a>
            . {OSM_CREDIT}.
          </p>
        ) : (
          <p>
            <strong className="font-semibold text-ink">No outline drawn.</strong> {footprint?.reason ?? `No building outline within ${fmtInt(FOOTPRINT_RADIUS_M)} m`}. The building is shown as a marker at the stated coordinates.
          </p>
        )}
        {!site.approximate && <p className="mt-1.5 text-muted">The lookup sends the coordinates, and nothing else, to a public OpenStreetMap server.</p>}
      </div>

      {onOpenStep && (
        <p className="mt-3 text-xs leading-relaxed text-ink-2">
          What this depth does to the building is in{" "}
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
          { kind: "assumption", text: `${isScore ? "The scale that turns the score into metres" : "Return periods"}${offer.drainageOn ? ", drainage ponding and its reach" : ""}` },
          { kind: offer.document.path === "model" ? "ai" : "real", text: `The building's ${site.approximate ? "place name" : "coordinates"}${stated ? " and the stated river distance" : ""}, read from the offer document${offer.document.path === "model" ? "" : " by fixed rules"} (${STEP_NAMES.offer})` },
        ]}
      />
    </Card>
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
      ...(t.drainageM > 0 ? ([["Drainage ponding", `${fmtNum(t.drainageM)} m${t.drainageM >= t.depthM ? ", deeper than the terrain depth, so used" : ""}`]] as [string, string][]) : []),
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
            { kind: "assumption", text: `${isScore ? "Depth scale, " : ""}fragility and caps${t.drainageM > 0 ? ", drainage ponding" : ""}` },
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
