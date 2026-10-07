"use client";

import { useState } from "react";
import { fmtInt, fmtKes, fmtPct } from "@/lib/format";
import type { Session } from "@/lib/session";
import { HazardMap } from "../charts/HazardMap";
import { Card, CheckList, ChecksSummary, Note, Segmented, StepHeader, Tag } from "../ui";

export function HazardStep({ session }: { session: Session }) {
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

        <div className="space-y-4">
          {isScore && (
            <Note>
              <strong className="font-semibold text-ink">How to read the tiers.</strong> The five maps are cuts through one score: &ldquo;common&rdquo; keeps the top 40% of cells and &ldquo;extreme&rdquo; the top 5%. A rarer flood reaches more places, so the widest map stands for the rarest event. The return period given to each tier is an assumption, set in the next step.
            </Note>
          )}
          {hits.length > 0 && (
            <Card title={`Known flood areas: ${hits.length - missed.length} of ${hits.length} flagged`} aside={<Tag kind="real">Real names, approximate coordinates</Tag>}>
              <p className="text-sm leading-relaxed text-ink-2">
                These are neighbourhoods the county has named as flood-prone. They test the hazard layer; they are not part of the portfolio.
              </p>
              {missed.length > 0 && (
                <p className="mt-2 text-sm leading-relaxed text-ink-2">
                  <strong className="font-semibold text-ink">Missed:</strong> {missed.map((h) => h.name).join(", ")}. {isScore && "These flood when drains overload, which a terrain-and-river proxy cannot see. Losses there are understated."}
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
