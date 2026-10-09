"use client";

/**
 * The tornado and the Shapley split as a step uses them: handed what every step already has (the
 * priced offer or none, the data set in view, the parameters in force, the judgement block and the
 * "Losses from" setting), they work out the target and the sets and draw the chart. With a priced
 * offer the answer read is the offer's; without one it is the portfolio's.
 */

import { useMemo } from "react";
import { interpretSets } from "@/lib/dashboard";
import { offerTarget, type Target } from "@/lib/interpret";
import type { LossMode } from "@/lib/model/drivers";
import { REFERENCE_PARAMS } from "@/lib/model/params";
import type { Dataset, ModelParams } from "@/lib/model/types";
import type { FocusJudgement, PricedFocus } from "@/lib/offer/focus";
import type { StepId } from "@/lib/steps";
import type { ChartSource } from "../charts/ChartFrame";
import { Shapley } from "./Shapley";
import { Tornado } from "./Tornado";

interface Common {
  /** The priced offer, or null to read the portfolio. */
  focus: PricedFocus | null;
  /** The data set in view, with drainage when the Flood source switch has it on. */
  dataset: Dataset;
  judgement: FocusJudgement;
  mode: LossMode;
  className?: string;
}

const useTarget = (focus: PricedFocus | null, dataset: Dataset): Target =>
  useMemo(() => (focus ? offerTarget(focus, dataset) : { kind: "portfolio", dataset }), [focus, dataset]);

const sourcesFor = (focus: PricedFocus | null): ChartSource[] => [
  { kind: "real", text: "Hazard maps supplied with the model data; the score on them is a derived proxy for flooding" },
  focus ? { kind: "real", text: "The offer's own figures, as read from the document" } : { kind: "synthetic", text: "Portfolio of insured buildings" },
];

/** Which assumptions move the answer most, for the result in force. */
export function StepTornado({ focus, dataset, params, judgement, mode, className = "" }: Common & { params: ModelParams }) {
  const target = useTarget(focus, dataset);
  const base = useMemo(() => interpretSets(params, null, judgement).base, [params, judgement]);
  return <Tornado target={target} base={base} mode={mode} subject={focus ? "this offer" : "the portfolio"} sources={sourcesFor(focus)} className={className} />;
}

/** How much of the agents' change each group of assumptions accounts for. `agreedParams` is null until the agents have run. */
export function StepShapley({ focus, dataset, agreedParams, judgement, mode, compact = false, onOpenStep, className = "" }: Common & { agreedParams: ModelParams | null; compact?: boolean; onOpenStep?: (id: StepId) => void }) {
  const target = useTarget(focus, dataset);
  const sets = useMemo(() => interpretSets(agreedParams ?? REFERENCE_PARAMS, agreedParams, judgement), [agreedParams, judgement]);
  return <Shapley target={target} reference={sets.reference} agreed={sets.agreed} mode={mode} subject={focus ? "this offer" : "the portfolio"} sources={sourcesFor(focus)} compact={compact} onOpenStep={onOpenStep} className={className} />;
}
