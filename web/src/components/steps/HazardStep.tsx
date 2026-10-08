"use client";

import { useState, type CSSProperties } from "react";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { DRAINAGE_DEFAULTS } from "@/lib/geo/drainage";
import type { DrainageState } from "@/lib/geo/drainageView";
import { SCORE_TIERS } from "@/lib/model/types";
import type { Session } from "@/lib/session";
import { HazardMap, hazardMapRatio } from "../charts/HazardMap";
import { Card, CheckList, ChecksSummary, Note, Segmented, StepHeader, Tag } from "../ui";

/** What the Hazard step needs to show and switch drainage-driven flooding. */
export interface DrainageControl {
  state: DrainageState | null;
  enabled: boolean;
  onToggle: (on: boolean) => void;
}

export function HazardStep({ session, drainage }: { session: Session; drainage?: DrainageControl }) {
  const { dataset, reference, hits } = session;
  const isScore = dataset.hazardKind === "score";
  const [index, setIndex] = useState(dataset.scenarios.length - 1);
  const scenario = dataset.scenarios[index];
  const affected = dataset.buildings.filter((b) => b.hazard[index] > 0);
  const tivExposed = affected.reduce((t, b) => t + b.tivKes, 0);
  const missed = hits.filter((h) => !h.hit);

  const hasSide = isScore || hits.length > 0;
  // On a wide screen the map takes the column that makes its card about as tall as the room between the header
  // and the Back / Next bar: 20rem is the card's own header, legend and figures plus that bar, 2.5rem its padding.
  const mapColumn = `clamp(42%, calc((100dvh - var(--header-height, 9rem) - 20rem) * ${hazardMapRatio(dataset, index).toFixed(3)} + 2.5rem), 50%)`;

  return (
    <div>
      <StepHeader kicker="Step 2" title="Hazard">
        {isScore
          ? "Each building was looked up on five susceptibility maps. The value is a score from 0 to 1 built from terrain and distance to rivers. It is not a measured flood depth."
          : "Each building was looked up on the flood depth maps. The value is water depth in metres for a flood of the stated rarity."}
      </StepHeader>

      {/* Three layouts from one set of cards. Narrow: one column. From 48rem of room: the map across the top and
          two columns under it. From 72rem: the map on the left with its checks and notes beside it, so the picture
          and what it means are read together. The widths are the step's own, in rem, so they follow the text size. */}
      <div className="grid gap-4 @3xl:grid-cols-2 @6xl:grid-cols-[var(--map-column)_minmax(0,1fr)]" style={{ "--map-column": mapColumn } as CSSProperties}>
        <Card
          className="@3xl:col-span-2 @6xl:col-span-1"
          title={<span className="inline-flex flex-wrap items-center gap-2">Buildings on the hazard map <Tag kind={isScore ? "proxy" : "real"} /></span>}
          aside={<Segmented label="Scenario" value={scenario.id} onChange={(id) => setIndex(dataset.scenarios.findIndex((s) => s.id === id))} options={dataset.scenarios.map((s) => ({ value: s.id, label: s.label }))} />}
        >
          <HazardMap dataset={dataset} scenarioIndex={index} hits={hits} />
          {/* A label that wraps would push its figure down, so the figures sit on the bottom edge and stay in line. */}
          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div className="flex flex-col justify-between"><div className="text-muted">Buildings affected</div><div className="tabular text-lg font-semibold text-ink">{fmtInt(affected.length)} of {fmtInt(dataset.buildings.length)}</div></div>
            <div className="flex flex-col justify-between"><div className="text-muted">Insured value in affected cells</div><div className="tabular text-lg font-semibold text-ink">{fmtKes(tivExposed)}</div></div>
            <div className="flex flex-col justify-between"><div className="text-muted">Share of portfolio value</div><div className="tabular text-lg font-semibold text-ink">{fmtPct(tivExposed / reference.totalTivKes)}</div></div>
          </div>
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
                  <strong className="font-semibold text-ink">How to read the tiers.</strong> The five maps are cuts through one score: &ldquo;common&rdquo; keeps the top 40% of cells and &ldquo;extreme&rdquo; the top 5%. A rarer flood reaches more places, so the widest map stands for the rarest event. The return period given to each tier is an assumption, set in the next step.
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
  const { state, enabled, onToggle } = control;
  const reach = DRAINAGE_DEFAULTS.reachM;
  const row = state?.sensitivity.rows.find((x) => x.reachM === reach);
  const depths = SCORE_TIERS.map((t) => DRAINAGE_DEFAULTS.depthM[t]);
  return (
    <Card
      className={className}
      title="Drainage-driven flooding"
      aside={
        <Segmented
          label="Hazard"
          value={enabled ? "on" : "off"}
          onChange={(v) => onToggle(v === "on")}
          options={[
            { value: "off", label: "Terrain only" },
            { value: "on", label: "Terrain + drainage" },
          ]}
        />
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
                  <div className="text-xs text-muted">County flood areas flagged</div>
                  <div className="tabular text-lg font-semibold text-ink">
                    {state.sensitivity.baseHits} <span className="text-muted">to</span> <span className="text-brand">{row.hits}</span> <span className="text-sm font-normal text-muted">of {total}</span>
                  </div>
                </div>
                <div className="flex flex-col justify-between">
                  <div className="text-xs text-muted">Extra flooded area, rarest event</div>
                  <div className="tabular text-lg font-semibold text-ink">+{fmtNum(row.addedAreaKm2, 0)} km²</div>
                </div>
                <div className="flex flex-col justify-between">
                  <div className="text-xs text-muted">Share of the map flooded</div>
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
                    <th className="py-1.5 pr-3 font-medium">Reach from drains</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Flagged</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Extra area</th>
                    <th className="py-1.5 font-medium">Newly flagged</th>
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
    </Card>
  );
}
