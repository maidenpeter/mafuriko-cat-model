"use client";

import { useState } from "react";
import { fmtInt, fmtKes, fmtNum, fmtPct } from "@/lib/format";
import { DRAINAGE_DEFAULTS } from "@/lib/geo/drainage";
import type { DrainageState } from "@/lib/geo/drainageView";
import { SCORE_TIERS } from "@/lib/model/types";
import type { Session } from "@/lib/session";
import { HazardMap } from "../charts/HazardMap";
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

  return (
    <div>
      <StepHeader kicker="Step 2" title="Hazard">
        {isScore
          ? "Each building was looked up on five susceptibility maps. The value is a score from 0 to 1 built from terrain and distance to rivers. It is not a measured flood depth."
          : "Each building was looked up on the flood depth maps. The value is water depth in metres for a flood of the stated rarity."}
      </StepHeader>

      <Card
        title={<span className="inline-flex flex-wrap items-center gap-2">Buildings on the hazard map <Tag kind={isScore ? "proxy" : "real"} /></span>}
        aside={<Segmented label="Scenario" value={scenario.id} onChange={(id) => setIndex(dataset.scenarios.findIndex((s) => s.id === id))} options={dataset.scenarios.map((s) => ({ value: s.id, label: s.label }))} />}
      >
        <HazardMap dataset={dataset} scenarioIndex={index} hits={hits} />
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div><div className="text-muted">Buildings affected</div><div className="tabular text-lg font-semibold text-ink">{fmtInt(affected.length)} of {fmtInt(dataset.buildings.length)}</div></div>
          <div><div className="text-muted">Insured value in affected cells</div><div className="tabular text-lg font-semibold text-ink">{fmtKes(tivExposed)}</div></div>
          <div><div className="text-muted">Share of portfolio value</div><div className="tabular text-lg font-semibold text-ink">{fmtPct(tivExposed / reference.totalTivKes)}</div></div>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Checks on the hazard values" aside={<ChecksSummary checks={session.hazardChecks} />}>
          <CheckList checks={session.hazardChecks} />
        </Card>

        <div className="min-w-0 space-y-4">
          {isScore && (
            <Note>
              <strong className="font-semibold text-ink">How to read the tiers.</strong> The five maps are cuts through one score: &ldquo;common&rdquo; keeps the top 40% of cells and &ldquo;extreme&rdquo; the top 5%. A rarer flood reaches more places, so the widest map stands for the rarest event. The return period given to each tier is an assumption, set in the next step.
            </Note>
          )}
          {isScore && drainage && <DrainageCard control={drainage} total={hits.length} />}
          {hits.length > 0 && (
            <Card title={`Known flood areas: ${hits.length - missed.length} of ${hits.length} flagged`} aside={<Tag kind="real">Real names, approximate coordinates</Tag>}>
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
      </div>
    </div>
  );
}

function DrainageCard({ control, total }: { control: DrainageControl; total: number }) {
  const { state, enabled, onToggle } = control;
  const reach = DRAINAGE_DEFAULTS.reachM;
  const row = state?.sensitivity.rows.find((x) => x.reachM === reach);
  const depths = SCORE_TIERS.map((t) => DRAINAGE_DEFAULTS.depthM[t]);
  return (
    <Card
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
      <p className="text-sm leading-relaxed text-ink-2">
        The proxy sees low ground near rivers, not drains that overflow or crowded settlements that shed water onto paths. We add that from open data: shallow ponding within {fmtInt(reach)} m of mapped drains, ditches and canals, and inside informal settlements, rising from {fmtNum(depths[0])} m in the most frequent event to {fmtNum(depths[depths.length - 1])} m in the rarest. Where ponding is deeper than the terrain depth, the model uses it.
      </p>
      {!state || !row ? (
        <p className="mt-3 text-sm text-muted">Measuring distances to drains and settlements on the hazard grid.</p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div>
              <div className="text-xs text-muted">County flood areas flagged</div>
              <div className="tabular text-lg font-semibold text-ink">
                {state.sensitivity.baseHits} <span className="text-muted">to</span> <span className="text-brand">{row.hits}</span> <span className="text-sm font-normal text-muted">of {total}</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">Extra flooded area, rarest event</div>
              <div className="tabular text-lg font-semibold text-ink">+{fmtNum(row.addedAreaKm2, 0)} km²</div>
            </div>
            <div>
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
          <div className="mt-4 overflow-x-auto">
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
          <p className="mt-3 text-xs leading-relaxed text-muted">
            The reach and the ponding depths are our assumptions, not measurements; the table shows how the hotspot test moves with the reach. Hotspots are tested at their neighbourhood centre, as in the starter kit. Drains and settlements come from OpenStreetMap, which maps some areas far better than others.
          </p>
        </>
      )}
    </Card>
  );
}
