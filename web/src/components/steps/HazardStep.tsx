"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { DRAINAGE_DEFAULTS } from "@/lib/geo/drainage";
import type { DrainageState } from "@/lib/geo/drainageView";
import { rpLabel, rpWithChance } from "@/lib/labels";
import { SCORE_TIERS } from "@/lib/model/types";
import { isPriced, type OfferFocus, type PricedFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { Active, Session } from "@/lib/session";
import { STEP_NAMES, type StepId } from "@/lib/steps";
import { SourceBadge, SourceLine } from "../charts/ChartFrame";
import { HazardMap, hazardMapRatio } from "../charts/HazardMap";
import { Button, Card, CheckList, ChecksSummary, Note, Segmented, selectView, StepHeader, Tag } from "../ui";
import { MapStep } from "./MapStep";

/**
 * The source line under the hazard map. It is SourceLine's layout written out, because the hazard score needs
 * the "Derived proxy" marking beside the four shared badges: the maps are real data, the score in them is a proxy.
 */
function Sources({ items, className = "" }: { items: { badge: ReactNode; text: ReactNode }[]; className?: string }) {
  return (
    <ul aria-label="Sources" className={`flex flex-wrap gap-x-5 gap-y-2 text-xs leading-relaxed text-muted ${className}`}>
      {items.map((item, i) => (
        <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {item.badge}
          <span className="min-w-0 wrap-anywhere">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the Hazard step needs to show drainage-driven flooding and say whether it is in force.
 * The setting is switched under "Flood source" in the bar above every page, and nowhere else.
 */
export interface DrainageControl {
  state: DrainageState | null;
  enabled: boolean;
}

interface Props {
  session: Session;
  /** The assumptions and the result in force: what the map draws. */
  active: Active;
  drainage?: DrainageControl;
  /** The priced offer while the header switch is on Offer. The step is then about that building. */
  focus?: PricedFocus | null;
  /** The offer whatever the switch says, priced or not. */
  offerFocus?: OfferFocus | null;
  onOpenStep?: (id: StepId) => void;
}

/**
 * The one hazard step: the interactive map first, then the tests of how far the hazard layer can be trusted.
 * With a priced offer in Offer view it is about that building; otherwise the map is the portfolio's.
 */
export function HazardStep({ session, active, drainage, focus = null, offerFocus = null, onOpenStep }: Props) {
  const { dataset, reference, hits } = session;
  const isScore = dataset.hazardKind === "score";
  const [index, setIndex] = useState(dataset.scenarios.length - 1);
  const scenario = dataset.scenarios[index];
  const missed = hits.filter((h) => !h.hit);

  // The building the step follows: the priced offer while "View" in the bar is on Offer.
  const shown = focus;
  // An offer that is loaded but not followed here: outside the maps, waiting for a value, or "View" is on Portfolio.
  const aside = focus ? null : offerFocus;
  // The basis the map is drawn on: the offer's while it is followed, otherwise the portfolio run's.
  const allDrivers = (shown ? shown.drivers.mode : active.result.mode) === "all_drivers";

  // A depth map carries its own return period. A score tier has none of its own: the one shown is the reference assumption.
  const returnPeriod = scenario.fixedReturnPeriod ?? reference.scenarios.find((s) => s.id === scenario.id)?.returnPeriod;
  const scenarioLabel = (s: (typeof dataset.scenarios)[number]) => (s.fixedReturnPeriod ? rpLabel(s.fixedReturnPeriod) : s.label);
  const mapSources: { badge: ReactNode; text: ReactNode }[] = [
    { badge: <SourceBadge kind="real" />, text: isScore ? "Hazard maps supplied with the model data" : "Flood depth maps supplied with the data" },
    ...(isScore ? [{ badge: <Tag kind="proxy" />, text: "The 0 to 1 score in those maps, built from terrain and distance to rivers. It is not a measured flood depth" }] : []),
    { badge: <SourceBadge kind="synthetic" />, text: "Buildings and their insured values" },
    ...(hits.length > 0 ? [{ badge: <SourceBadge kind="real" />, text: "Known flood areas: real names, approximate coordinates" }] : []),
    ...(dataset.drainage
      ? [
          { badge: <SourceBadge kind="real" />, text: "Drains and informal settlements from OpenStreetMap" },
          { badge: <SourceBadge kind="assumption" />, text: "Reach of the drains and depth of the ponding" },
        ]
      : []),
    ...(returnPeriod !== undefined
      ? [
          isScore
            ? { badge: <SourceBadge kind="assumption" />, text: `Return period of this tier: ${rpWithChance(returnPeriod)} under the reference assumptions` }
            : { badge: <SourceBadge kind="real" />, text: `Return period carried by this map: ${rpWithChance(returnPeriod)}` },
        ]
      : []),
  ];

  const hasSide = isScore || hits.length > 0;
  // On a wide screen the map takes the column that makes its card about as tall as the room between the header
  // and the Back / Next bar: 20rem is the card's own header, legend and figures plus that bar, 2.5rem its padding.
  const mapColumn = `clamp(42%, calc((100dvh - var(--header-height, 9rem) - 20rem) * ${hazardMapRatio(dataset, index).toFixed(3)} + 2.5rem), 50%)`;

  return (
    <div>
      <StepHeader title={STEP_NAMES.hazard}>
        {shown
          ? allDrivers
            ? `Where ${shown.building.name} stands on the flood maps. Move the slider to see the water that reaches it in each flood.`
            : `Where ${shown.building.name} stands on the flood maps. Depth only is selected, so only the water at the building's own point counts.`
          : allDrivers
            ? "Where water collects at each event, which insured buildings it reaches at their point, within the buffer, by drainage ponding and by drain overload, and how losses pile up by ward. Pick an event or press play to watch the flood spread as events get rarer."
            : "Where water collects at each event, which insured buildings it reaches and how losses pile up by ward. Pick an event or press play to watch the flood spread as events get rarer."}
      </StepHeader>

      {aside && (
        <div className="mb-4">
          {aside.outside ? (
            <Note tone="warn">
              <strong className="font-semibold text-ink">{aside.outsideMessage}.</strong> {aside.building ? `${aside.building.name} is not on these maps` : "The offer is not on these maps"}, so the map below is the portfolio&rsquo;s.{aside.coverage ? ` ${aside.coverage}` : ""}
            </Note>
          ) : aside.waiting.length > 0 ? (
            <Note tone="warn">
              <strong className="font-semibold text-ink">The offer is not on the map yet.</strong> {plural(aside.waiting.length, "value")} read from the document {aside.waiting.length === 1 ? "waits" : "wait"} to be confirmed, so the map below is the portfolio&rsquo;s.
              {onOpenStep && (
                <Button variant="secondary" className="ml-2 mt-1" onClick={() => onOpenStep("offer")}>
                  Open {STEP_NAMES.offer}
                </Button>
              )}
            </Note>
          ) : isPriced(aside) ? (
            <p className="text-sm text-ink-2">An offer is loaded: {aside.building.name}. {selectView("Offer")} to see it on this map.</p>
          ) : (
            <Note>{aside.statusLine}</Note>
          )}
        </div>
      )}

      <MapStep session={session} active={active} offer={shown} onOpenStep={onOpenStep} />

      <div className="mb-4 mt-10 border-t border-line pt-6">
        <h3 className="text-2xl font-semibold tracking-tight text-ink">Model validation</h3>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-2">
          {shown
            ? `How far the hazard layer can be trusted at this site: whether it finds the places the county knows to flood, how much the answer moves with the drainage assumption, and the raw map the depths at ${shown.building.name} were read from.`
            : "How far the hazard layer can be trusted: whether it finds the places the county knows to flood, how much the answer moves with the drainage assumption, and the raw maps every depth was read from."}
        </p>
      </div>

      {/* Three layouts from one set of cards. Narrow: one column. From 48rem of room: the map across the top and
          two columns under it. From 72rem: the map on the left with its checks and notes beside it, so the picture
          and what it means are read together. The widths are the step's own, in rem, so they follow the text size. */}
      <div className="grid gap-4 @3xl:grid-cols-2 @6xl:grid-cols-[var(--map-column)_minmax(0,1fr)]" style={{ "--map-column": mapColumn } as CSSProperties}>
        <Card
          className="@3xl:col-span-2 @6xl:col-span-1"
          title={<span className="inline-flex flex-wrap items-center gap-2">The hazard map as supplied <Tag kind={isScore ? "proxy" : "real"} /></span>}
          aside={<Segmented label="Scenario" value={scenario.id} onChange={(id) => setIndex(dataset.scenarios.findIndex((s) => s.id === id))} options={dataset.scenarios.map((s) => ({ value: s.id, label: scenarioLabel(s) }))} />}
        >
          <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-ink-2">
            {isScore
              ? `The shading is the susceptibility score in the "${scenario.label}" tier: the darker the cell, the higher the score, and ground with no shading scores 0. `
              : `The shading is the flood depth in metres in a ${returnPeriod !== undefined ? rpWithChance(returnPeriod) : scenario.label} flood: the darker the cell, the deeper the water, and ground with no shading stays dry. `}
            Each dot is an insured building of the portfolio; the large dots sit on a shaded cell. Point at a large dot{hits.length > 0 ? " or a known flood area" : ""} to see its values. Pick another scenario above the map to see the footprint change.
            {allDrivers && " This picture is the map read at each building's own point. Water within the buffer and from overloaded drains is counted on the map at the top of this step."}
          </p>
          <HazardMap dataset={dataset} scenarioIndex={index} hits={hits} offer={shown ? { lat: shown.site.lat, lon: shown.site.lon, name: shown.building.name, approximate: shown.site.approximate } : null} />
          <Sources items={mapSources} className="mt-4 border-t border-line pt-3" />
        </Card>

        {/* Beside the map this is one column as tall as the map card, and its cards share any height left over.
            In the two-column layout the wrapper steps aside, so the checks and the notes are the two columns. */}
        <div className="flex min-w-0 flex-col gap-4 @3xl:contents @6xl:flex">
          <Card className={hasSide ? "@6xl:grow" : "@3xl:col-span-2"} title="Checks on the hazard values" aside={<ChecksSummary checks={session.hazardChecks} />}>
            <CheckList checks={session.hazardChecks} />
          </Card>

          {hasSide && (
            <div className={`flex min-w-0 flex-col gap-4 ${hits.length > 0 ? "@6xl:grow" : ""}`}>
              {isScore && (
                <Note>
                  <strong className="font-semibold text-ink">How to read the tiers.</strong> The five maps are cuts through one score: &ldquo;common&rdquo; keeps the top 40% of cells and &ldquo;extreme&rdquo; the top 5%. A rarer flood reaches more places, so the widest map stands for the rarest event. The return period given to each tier is an assumption, set in the {STEP_NAMES.agents} step.
                </Note>
              )}
              {hits.length > 0 && (
                <Card className="grow" title={`Known flood areas: ${hits.length - missed.length} of ${hits.length} flagged`} aside={<Tag kind="real">Real names, approximate coordinates</Tag>}>
                  <p className="text-sm leading-relaxed text-ink-2">
                    These are neighbourhoods the county has named as flood-prone. They test the hazard layer; they are not part of the portfolio.
                  </p>
                  {missed.length > 0 && (
                    <p className="mt-2 text-sm leading-relaxed text-ink-2">
                      <strong className="font-semibold text-ink">{dataset.drainage ? "Still missed" : "Missed"}:</strong> {missed.map((h) => h.name).join(", ")}. {isScore && (dataset.drainage ? "These need data the open maps do not hold, such as the stormwater network and road culverts." : "These flood when drains overload, which a terrain-and-river proxy cannot see. Losses there are understated.")}
                    </p>
                  )}
                </Card>
              )}
            </div>
          )}
        </div>

        {isScore && drainage && <DrainageCard control={drainage} total={hits.length} className="@3xl:col-span-2" />}
      </div>
    </div>
  );
}

function DrainageCard({ control, total, className }: { control: DrainageControl; total: number; className?: string }) {
  const { state, enabled } = control;
  const reach = DRAINAGE_DEFAULTS.reachM;
  const row = state?.sensitivity.rows.find((x) => x.reachM === reach);
  const depths = SCORE_TIERS.map((t) => DRAINAGE_DEFAULTS.depthM[t]);
  // The setting in force, in the words of the "Flood source" switch. Until the drainage zone has been worked out,
  // terrain flooding alone is in force and the bar has no switch to point at.
  const inForce = state && enabled ? "Terrain + drainage" : "Terrain only";
  return (
    <Card
      className={className}
      title="Drainage-driven flooding"
      aside={
        <p className="min-w-0 text-sm leading-relaxed text-ink-2">
          <strong className="font-semibold text-ink">In force: {inForce}.</strong>
          {state && <> Select the other under &quot;Flood source&quot; in the bar above.</>}
        </p>
      }
    >
      {/* The card runs the full width under the map, so its parts sit side by side: the text and figures beside the
          table, and on a wide screen three columns with the closing note under the figures. Each pair's wrapper
          steps aside there so the four parts can be placed one by one. */}
      <div className="grid gap-x-8 gap-y-4 @3xl:grid-cols-2 @6xl:grid-cols-3 @6xl:grid-rows-[auto_1fr]">
        <div className="min-w-0 @6xl:contents">
          <p className="text-sm leading-relaxed text-ink-2 @6xl:col-start-1 @6xl:row-span-2 @6xl:row-start-1">
            The proxy sees low ground near rivers, not drains that overflow or crowded settlements that shed water onto paths. We add that from open data: shallow ponding within {fmtInt(reach)} m of mapped drains, ditches and canals, and inside informal settlements, rising from {fmtNum(depths[0])} m in the most frequent event to {fmtNum(depths[depths.length - 1])} m in the rarest. Where ponding is deeper than the terrain depth, the model uses it.
          </p>
          {state && row && (
            <div className="mt-4 min-w-0 @6xl:col-start-2 @6xl:row-start-1 @6xl:mt-0">
              {/* As many figures across as fit without breaking one in two: 8.25rem holds the widest of them. */}
              <div className="grid grid-cols-[repeat(auto-fit,minmax(8.25rem,1fr))] gap-3">
                <div className="flex flex-col justify-between">
                  <div className="text-xs text-muted">County flood areas flagged, terrain only to terrain + drainage</div>
                  <div className="tabular text-lg font-semibold text-ink">
                    {state.sensitivity.baseHits} <span className="text-muted">to</span> <span className="text-brand">{row.hits}</span> <span className="text-sm font-normal text-muted">of {total}</span>
                  </div>
                </div>
                <div className="flex flex-col justify-between">
                  <div className="text-xs text-muted">Extra flooded area, rarest event</div>
                  <div className="tabular text-lg font-semibold text-ink">+{fmtNum(row.addedAreaKm2, 0)} km²</div>
                </div>
                <div className="flex flex-col justify-between">
                  <div className="text-xs text-muted">Share of the map flooded, terrain only to terrain + drainage</div>
                  <div className="tabular text-lg font-semibold text-ink">
                    {fmtPct(state.sensitivity.baseWetShare, 1)} <span className="text-muted">to</span> {fmtPct(row.wetShare, 1)}
                  </div>
                </div>
              </div>
              {row.newlyFlagged.length > 0 && (
                <p className="mt-3 text-sm text-ink-2">
                  <strong className="font-semibold text-ink">Newly flagged:</strong> {row.newlyFlagged.join(", ")}.
                </p>
              )}
            </div>
          )}
        </div>
        {!state || !row ? (
          <p className="text-sm text-muted">Measuring distances to drains and settlements on the hazard grid.</p>
        ) : (
          <div className="min-w-0 @6xl:contents">
            <div className="overflow-x-auto @6xl:col-start-3 @6xl:row-span-2 @6xl:row-start-1">
              <table className="w-full min-w-80 text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="py-1.5 pr-3 font-medium">Reach from drains, metres</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Flood areas flagged, of {total}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Extra flooded area, km²</th>
                    <th className="py-1.5 font-medium">Newly flagged areas</th>
                  </tr>
                </thead>
                <tbody>
                  {state.sensitivity.rows.map((x) => (
                    <tr key={x.reachM} className={`border-b border-line/60 ${x.reachM === reach ? "bg-surface-2 font-medium text-ink" : "text-ink-2"}`}>
                      <td className="tabular whitespace-nowrap py-1.5 pr-3">
                        {fmtInt(x.reachM)} m{x.reachM === reach ? " (used)" : ""}
                      </td>
                      <td className="tabular py-1.5 pr-3 text-right">{x.hits}</td>
                      <td className="tabular whitespace-nowrap py-1.5 pr-3 text-right">+{fmtNum(x.addedAreaKm2, 0)} km²</td>
                      <td className="py-1.5 text-xs">{x.newlyFlagged.join(", ") || "none"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted @6xl:col-start-2 @6xl:row-start-2 @6xl:mt-0">
              The reach and the ponding depths are our assumptions, not measurements; the table shows how the hotspot test moves with the reach. Hotspots are tested at their neighbourhood centre, as in the starter kit. Drains and settlements come from OpenStreetMap, which maps some areas far better than others.
            </p>
          </div>
        )}
      </div>
      <SourceLine
        className="mt-4 border-t border-line pt-3"
        sources={[
          { kind: "real", text: "Drains, ditches, canals and informal settlements from OpenStreetMap" },
          { kind: "real", text: "Known flood areas named by the county: real names, approximate coordinates" },
          { kind: "assumption", text: `Reach of ${fmtInt(reach)} m and ponding depths of ${fmtNum(depths[0])} m to ${fmtNum(depths[depths.length - 1])} m` },
        ]}
      />
    </Card>
  );
}
