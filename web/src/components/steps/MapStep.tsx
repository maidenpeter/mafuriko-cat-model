"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { DEPTH_LABELS } from "@/lib/geo/hazardImage";
import { loadGeo, type FacilityKind, type GeoLayers } from "@/lib/geo/layers";
import { assignPoints, facilityDepths, geometryBBox, wardAccumulation, type AreaRow, type BBox } from "@/lib/geo/spatial";
import { HOUSING_CLASSES, HOUSING_LABELS } from "@/lib/model/types";
import type { Active, Session } from "@/lib/session";
import { useTheme } from "@/lib/useDisplay";
import { DRAINAGE_COLOR, FACILITY_COLORS, SETTLEMENT_COLOR, WARD_COLOR, WARD_METRICS, WATER_COLORS, type BasemapStatus, type LayerKey, type LayerState, type MapView, type Selection, type WardMetric } from "../map/mapTheme";
import { Button, Card, Note, Segmented, StepHeader, Tag } from "../ui";
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
const metricText = (row: AreaRow, m: WardMetric) => (m === "loss" ? fmtKes(row.lossKes) : m === "tiv" ? fmtKes(row.tivKes) : m === "flooded" ? fmtInt(row.flooded) : fmtPct(metricValue(row, m), 1));

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

export function MapStep({ session, active }: { session: Session; active: Active }) {
  const { dataset } = session;
  const r = active.result;
  const isScore = dataset.hazardKind === "score";
  const last = r.scenarios.length - 1;
  const initialK = Math.max(0, r.scenarios.findIndex((s) => s.returnPeriod === 100));

  const [geo, setGeo] = useState<GeoLayers | null>(null);
  const [k, setK] = useState(initialK === -1 ? last : initialK);
  const [playing, setPlaying] = useState(false);
  const [layers, setLayers] = useState<LayerState>({ hazard: true, drainage: true, buildings: true, wards: true, waterways: true, settlements: true, facilities: true, hotspots: true });
  const [threeD, setThreeD] = useState(false);
  const [wardMetric, setWardMetric] = useState<WardMetric>("loss");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<{ bbox: BBox; seq: number } | null>(null);
  const [status, setStatus] = useState<BasemapStatus>("loading");
  // The map takes its basemap and colours when it is created, so a theme change builds a new one.
  // Everything above lives here and carries over; the camera carries over through this record.
  const theme = useTheme();
  const mapView = useRef<MapView>({ camera: null, threeD: null, selection: null, focusSeq: 0 });

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
  const tierNote = `${isScore ? `the "${s.id}" map, assumed to be a 1 in ${s.returnPeriod} event` : `the published 1 in ${s.returnPeriod} depth map`}${drainage ? `, plus drainage ponding up to ${fmtNum(drainage.depthM[dataset.scenarios.findIndex((x) => x.id === s.id)] ?? 0)} m near drains and in informal settlements` : ""}`;

  return (
    <div>
      <StepHeader kicker="Step 6" title="Risk map">
        Every layer on one map of Nairobi: where water collects at each event, which insured buildings it reaches, how losses pile up by ward, and what else sits in the water&rsquo;s path. Pick an event or press play to watch the flood spread as events get rarer.
      </StepHeader>

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
              <span className="font-display text-3xl font-semibold tracking-tight text-ink">1 in {s.returnPeriod}</span>
              <span className="text-xs text-muted">{fmtPct(1 / s.returnPeriod, 1)} chance a year</span>
            </div>
            <input
              aria-label="Event return period"
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
                <button key={x.id} onClick={() => setK(i)} className={i === ki ? "font-semibold text-ink" : "hover:text-ink"}>
                  {x.returnPeriod}
                </button>
              ))}
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

          <Card className={SIDE_CARD} title={`At the 1 in ${s.returnPeriod} event`}>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Buildings flooded</dt>
                <dd className="tabular text-lg font-semibold text-ink">
                  {fmtInt(s.affected)} <span className="text-sm font-normal text-muted">of {fmtInt(r.buildingCount)}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Portfolio loss</dt>
                <dd className="tabular text-lg font-semibold text-brand">{fmtKes(s.lossKes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Value in the flood area</dt>
                <dd className="tabular font-semibold text-ink">{fmtKes(s.tivExposedKes)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Loss as share of all value</dt>
                <dd className="tabular font-semibold text-ink">{fmtPct(s.lossKes / r.totalTivKes, 2)}</dd>
              </div>
            </dl>
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
                <p className="mt-2 text-xs leading-relaxed text-muted">The proxy marks shallow water widely, so the second count is the one to quote.</p>
              </div>
            )}
          </Card>

          {/* The last card takes up any height the map and the layers leave over. */}
          <SelectionCard className="flex-[1_1_18rem] @3xl:flex-auto" session={session} active={active} k={ki} geo={geo} wardOf={wardOf} wardRows={wardRows} selection={selection} onClear={() => setSelection(null)} />
        </div>

        {/* The layers double as the map's legend, so they sit right under it, in as many columns as fit. */}
        <Card title="Layers" className="@3xl:col-start-1 @3xl:row-start-2">
          <div className="-mx-2 grid grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))] content-start gap-x-2 gap-y-0.5">
            <Toggle id="lyr-hazard" checked={layers.hazard} onChange={(v) => setLayer("hazard", v)}>
              Flood depth {isScore && <span className="text-xs text-muted">(score converted to metres)</span>}
              <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                {DEPTH_LABELS.map((l, i) => (
                  <span key={l} className="inline-flex items-center gap-1 text-xs text-ink-2">
                    <span className="inline-block h-2.5 w-3.5 shrink-0 rounded-sm" style={{ background: `var(--seq-${i + 1})` }} />
                    {l}
                  </span>
                ))}
              </span>
            </Toggle>
            {drainage && (
              <Toggle id="lyr-drainage" checked={layers.drainage} onChange={(v) => setLayer("drainage", v)}>
                <span className="inline-flex items-center gap-1.5"><Swatch shape="square" color={DRAINAGE_COLOR} /> Drainage zone</span>
                <span className="mt-0.5 block text-xs text-ink-2">Within {fmtInt(drainage.reachM)} m of a mapped drain or inside an informal settlement; darker means closer.</span>
              </Toggle>
            )}
            <Toggle id="lyr-buildings" checked={layers.buildings} onChange={(v) => setLayer("buildings", v)}>
              Insured buildings <span className="text-xs text-muted">(synthetic)</span>
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
            </Toggle>
            <Toggle id="lyr-hotspots" checked={layers.hotspots} onChange={(v) => setLayer("hotspots", v)}>
              County-named flood areas
              <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-ink-2">
                <span className="inline-flex items-center gap-1"><Swatch color="var(--navy-line)" /> flagged by the proxy</span>
                <span className="inline-flex items-center gap-1"><Swatch shape="ring" color={WARD_COLOR} /> missed</span>
              </span>
            </Toggle>
          </div>
        </Card>

        <Card
          className="@3xl:col-span-2 @3xl:row-start-4 @6xl:col-span-3 @6xl:row-start-3"
          title={`Accumulation by ward at the 1 in ${s.returnPeriod} event`}
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
                    <th className="py-2 pr-3 text-right font-medium">Buildings</th>
                    <th className="py-2 pr-3 text-right font-medium">Insured value</th>
                    <th className="py-2 pr-3 text-right font-medium">Flooded</th>
                    <th className="py-2 pr-3 text-right font-medium">Loss</th>
                    <th className="w-[28%] py-2 font-medium">Ranked by {WARD_METRICS.find((m) => m.value === wardMetric)?.label.toLowerCase()}</th>
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
                          <span className="tabular w-20 text-right text-xs text-ink-2">{metricText(w, wardMetric)}</span>
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
        </Card>

        {/* A grid, so the note is as tall as the layers card when the two share a row. */}
        <div className="grid @3xl:col-start-1 @3xl:row-start-3 @6xl:col-start-2 @6xl:row-start-2">
          <Note>
            <strong className="font-semibold text-ink">What is real here.</strong> Ward boundaries are the 85 Nairobi wards (Omare &amp; Omare 2017, CC BY 4.0). Rivers, drains, informal settlements, schools and health facilities are from OpenStreetMap (data from February and May 2025); informal settlement outlines are incomplete there, Kibera for instance is mapped only as a point. The flood layer is the hazard proxy converted to depth with the assumptions in force{dataset.drainage ? ", plus drainage ponding near OpenStreetMap drains and inside informal settlements, which is our own assumption" : ""}. The buildings are synthetic and placed at random, so ward totals show how accumulation would be read, not a real concentration of risk.
          </Note>
        </div>
      </div>
    </div>
  );
}

function SelectionCard({
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
  if (!selection) {
    return (
      <Card className={`flex flex-col ${className}`} title="Details">
        {/* This card can be much taller than its one line, so the line sits in a marked-out space that shows where the details will go. */}
        <p className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line px-4 py-3 text-center text-sm leading-relaxed text-ink-2">Click a building to trace its loss, or a ward to see what it holds.</p>
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
        <div className="mt-3 border-t border-line pt-2 text-xs text-muted">Loss at every event</div>
        {/* As many events to a row as the text size leaves room for, so no figure is squeezed out of its cell. */}
        <div className="mt-1 grid grid-cols-[repeat(auto-fit,minmax(3.5rem,1fr))] gap-1 text-center text-xs">
          {per.map((p, i) => (
            <div key={r.scenarios[i].id} className={`rounded-md px-1 py-1 ${i === k ? "bg-surface-2 font-semibold text-ink" : "text-ink-2"}`}>
              <div className="text-muted">1:{r.scenarios[i].returnPeriod}</div>
              <div className="tabular">{p.lossKes > 0 ? fmtKes(p.lossKes, 0).replace("KES ", "") : "0"}</div>
            </div>
          ))}
        </div>
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
      <div className="mb-2 text-sm text-ink-2">{row.subcounty} sub-county</div>
      <dl className="space-y-1 text-sm">
        {(
          [
            ["Insured buildings", fmtInt(row.buildings)],
            ["Insured value", fmtKes(row.tivKes)],
            ["Flooded at this event", fmtInt(row.flooded)],
            ["Loss at this event", fmtKes(row.lossKes)],
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
    </Card>
  );
}
