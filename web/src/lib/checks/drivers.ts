import { fmtInt, fmtKes, fmtNum } from "../format";
import { rpLabel, rpWithChance } from "../labels";
import { runModel } from "../model/pipeline";
import type { Dataset, ModelResult } from "../model/types";
import { REFERENCE_JUDGEMENT } from "../offer/judgement";
import type { Check } from "./index";

/**
 * Checks on loss drivers 1 to 3 (surrounding flooding, drainage ponding, drain overload), read
 * back from the result itself. Nothing to check in depth-only mode, where the drivers are off.
 * financialChecks already includes these, so a list built from it needs no second call.
 */
export function driverChecks(dataset: Dataset, result: ModelResult): Check[] {
  if (result.mode !== "all_drivers") return [];
  const group = "financial" as const;
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const judgement = result.judgement ?? REFERENCE_JUDGEMENT;
  const events = result.scenarios.length;

  // Every building and scenario must carry its split.
  let missing = 0;
  let partsOff = 0;
  let depthsOff = 0;
  const wet = result.scenarios.map(() => ({ point: 0, buffer: 0, ponding: 0, overload: 0, overloadOnly: 0 }));
  for (const b of result.buildings) {
    b.perScenario.forEach((p, k) => {
      const d = p.drivers;
      if (!d) {
        missing += 1;
        return;
      }
      if (!close(d.pointKes + d.surroundingKes + d.pondingKes + d.overloadKes, p.lossKes)) partsOff += 1;
      if (d.bufferM < d.pointM || d.surfaceM < Math.max(d.bufferM, d.pondingM, d.overloadM)) depthsOff += 1;
      if (d.pointM > 0) wet[k].point += 1;
      if (d.bufferM > 0) wet[k].buffer += 1;
      if (d.pondingM > 0) wet[k].ponding += 1;
      if (d.overloadM > 0) wet[k].overload += 1;
      if (d.overloadM > 0 && !(d.bufferM > 0) && !(d.pondingM > 0)) wet[k].overloadOnly += 1;
    });
  }
  const totalsOk = result.scenarios.every((s) => s.byDriver !== undefined && close(s.byDriver.pointKes + s.byDriver.surroundingKes + s.byDriver.pondingKes + s.byDriver.overloadKes, s.lossKes));
  const rarest = result.scenarios[events - 1]?.byDriver;

  const out: Check[] = [];
  out.push({
    group, id: "drivers-add-up", title: "The loss drivers add up to each building's loss", status: missing === 0 && partsOff === 0 && totalsOk ? "pass" : "fail",
    detail: missing > 0
      ? `${fmtInt(missing)} building results carry no split by driver.`
      : partsOff > 0 || !totalsOk
        ? `The parts do not add up to the loss in ${fmtInt(partsOff)} building results.`
        : `In all ${events} events × ${fmtInt(result.buildingCount)} buildings, the loss from the depth at the point, what the surroundings add, drainage ponding and drain overload equals the building's loss.${rarest ? ` Rarest event: Surrounding flooding ${fmtKes(rarest.pointKes + rarest.surroundingKes)} (${fmtKes(rarest.pointKes)} at the point, ${fmtKes(rarest.surroundingKes)} added within the buffer), Drainage ponding ${fmtKes(rarest.pondingKes)}, Drain overload ${fmtKes(rarest.overloadKes)}.` : ""}`,
  });

  out.push({
    group, id: "buffer-ge-point", title: "Depth within the buffer is never below depth at the point", status: missing === 0 && depthsOff === 0 ? "pass" : "fail",
    detail:
      (depthsOff > 0 ? `${fmtInt(depthsOff)} building results have a buffer depth below the point depth, or a depth used below one of its drivers. ` : "") +
      `Assumptions: buffer ${fmtNum(judgement.bufferRadiusM)} m; drains designed for ${rpWithChance(judgement.drainDesignRp)}, with ${fmtNum(judgement.drainOverloadDepthM)} m of surface water beyond that. ` +
      `Buildings with water, of ${fmtInt(result.buildingCount)}: ` +
      result.scenarios.map((s, k) => `${rpLabel(s.returnPeriod)}: ${wet[k].point} at the point, ${wet[k].buffer} within the buffer, ${wet[k].ponding} by drainage ponding, ${wet[k].overload} by drain overload (${wet[k].overloadOnly} by drain overload alone)`).join("; ") +
      ".",
  });

  // Depth only is the same run with the drivers off. It can never give more.
  const depthOnly = runModel(dataset, result.params);
  const never = result.scenarios.every((s, k) => depthOnly.scenarios[k] !== undefined && depthOnly.scenarios[k].lossKes <= s.lossKes + 1e-6 * Math.max(1, s.lossKes));
  out.push({
    group, id: "depth-only-le-all", title: "Depth only never gives a higher loss than All loss drivers", status: never ? "pass" : "fail",
    detail:
      result.scenarios.map((s, k) => `${rpLabel(s.returnPeriod)}: ${fmtKes(depthOnly.scenarios[k]?.lossKes)} to ${fmtKes(s.lossKes)}`).join("; ") +
      `. Average annual loss: ${fmtKes(depthOnly.aalKes)} to ${fmtKes(result.aalKes)}.`,
  });
  return out;
}
