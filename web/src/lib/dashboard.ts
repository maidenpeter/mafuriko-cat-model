/**
 * The calculations behind the dashboard. Pure functions, no React, so each one is tested on its own.
 *
 *   nearestEventIndex(rps)        which modelled event the page opens on (the one nearest 1-in-100)
 *   classLossRows(scenario)       loss by housing class beside each class's share of insured value
 *   topWards(rows)                the wards with the most loss, ranked
 *   shadeLevel(value, max)        which of five shades a ward gets on the small map
 *   layerSteps(row)               one event from ground-up to net, as waterfall steps
 *   aalChange(reference, agents)  what the agents' assumptions did to the average annual loss
 *   paramChanges(ledger)          the parameters the agents moved away from the reference
 *   hotspotCount(hits)            how many named flood areas the hazard layer flags
 *   chainStatus(checks)           the five stages of the model chain with their check counts
 *   dashboardStepId(step)         which walkthrough step a link on the dashboard opens
 *   droppedFileKind(name, exts)   whether a file given to the offer card is an offer, model data, or neither
 *   headlineFlags(flags, max)     the few worst points to weigh on an offer, with how many are left over
 *   portfolioChangeText(kes, share)  what an offer adds to a portfolio figure, in words
 *   rangePlacement(value, values) where one value sits in a list: below, within or above its range
 *   checkGroups(checks, offer)    every check sorted into the six groups of the Audit step
 */

import type { Check, CheckStatus } from "./checks";
import { kes1 } from "./labels";
import type { TermsLossAt, LayerRow } from "./model/terms";
import { HOUSING_CLASSES, HOUSING_LABELS, type HousingClass, type ScenarioResult } from "./model/types";
import type { StepId } from "./steps";

/** A fraction as a signed percentage with one decimal: 0.125 gives "+12.5%", -0.04 gives "-4.0%". */
export function signedPct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "n/a";
  const text = (fraction * 100).toFixed(1);
  if (text === "0.0" || text === "-0.0") return "0.0%";
  return `${fraction > 0 ? "+" : ""}${text}%`;
}

/**
 * Index of the modelled event nearest the target return period, or -1 when there are none.
 * Nearest is measured on the logarithm of the return period, the scale the loss curve is drawn on,
 * so 50 and 200 are equally far from 100. A tie goes to the more frequent event.
 */
export function nearestEventIndex(returnPeriods: number[], target = 100): number {
  let best = -1;
  let bestGap = Infinity;
  returnPeriods.forEach((rp, i) => {
    if (!(rp > 0)) return;
    const gap = Math.abs(Math.log(rp) - Math.log(target));
    if (gap < bestGap - 1e-12) {
      best = i;
      bestGap = gap;
    }
  });
  return best;
}

/** The loss curves read at one standard return period, or null when that return period is not in the list. */
export function standardAt(standard: TermsLossAt[], returnPeriod: number): TermsLossAt | null {
  return standard.find((s) => s.returnPeriod === returnPeriod) ?? null;
}

export interface ClassLossRow {
  housingClass: HousingClass;
  label: string;
  buildings: number;
  affected: number;
  tivKes: number;
  lossKes: number;
  /** The class's share of the portfolio's insured value, 0 to 1. */
  tivShare: number;
  /** The class's share of the event's loss, 0 to 1. */
  lossShare: number;
}

/** One row per housing class for one event, in the model's own class order (weakest construction first). */
export function classLossRows(scenario: Pick<ScenarioResult, "byClass">): ClassLossRow[] {
  const totalTiv = HOUSING_CLASSES.reduce((t, c) => t + scenario.byClass[c].tivKes, 0);
  const totalLoss = HOUSING_CLASSES.reduce((t, c) => t + scenario.byClass[c].lossKes, 0);
  return HOUSING_CLASSES.map((c) => {
    const b = scenario.byClass[c];
    return {
      housingClass: c,
      label: HOUSING_LABELS[c],
      buildings: b.count,
      affected: b.affected,
      tivKes: b.tivKes,
      lossKes: b.lossKes,
      tivShare: totalTiv > 0 ? b.tivKes / totalTiv : 0,
      lossShare: totalLoss > 0 ? b.lossKes / totalLoss : 0,
    };
  });
}

/** What topWards needs from a ward row. AreaRow from lib/geo/spatial fits. */
export interface WardLoss {
  /** Index into the ward collection, or -1 for buildings outside every ward. */
  index: number;
  name: string;
  subcounty: string;
  buildings: number;
  flooded: number;
  lossKes: number;
}

export type RankedWard<W extends WardLoss = WardLoss> = W & {
  /** 1 for the ward with the most loss. */
  rank: number;
  /** The ward's share of the loss across every row given, 0 to 1. */
  lossShare: number;
};

/**
 * The wards with the most loss, largest first. Wards with no loss are left out, so the list can be
 * shorter than `count`. Equal losses keep the order they were given in.
 */
export function topWards<W extends WardLoss>(rows: W[], count = 10): RankedWard<W>[] {
  const total = rows.reduce((t, r) => t + (r.lossKes > 0 ? r.lossKes : 0), 0);
  return rows
    .map((row, order) => ({ row, order }))
    .filter(({ row }) => row.lossKes > 0)
    .sort((a, b) => b.row.lossKes - a.row.lossKes || a.order - b.order)
    .slice(0, Math.max(0, count))
    .map(({ row }, i) => ({ ...row, rank: i + 1, lossShare: total > 0 ? row.lossKes / total : 0 }));
}

/**
 * Which shade a value gets on the small map: 0 for no loss, then 1 to `levels` as the loss rises to `max`.
 * The steps are even on the square root of the loss, because a few wards carry most of it and even steps
 * on the loss itself would leave nearly every ward in the palest shade.
 */
export function shadeLevel(value: number, max: number, levels = 5): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(levels, Math.max(1, Math.ceil(Math.sqrt(Math.min(1, value / max)) * levels)));
}

export interface LayerStep {
  label: string;
  /** A total's level, or the size of what is taken off. */
  value: number;
  kind: "total" | "decrease";
}

/**
 * One event from ground-up loss to net loss: ground-up, minus deductibles, gross, minus quota share,
 * minus excess of loss, net. The part above policy limits gets its own step only when there is any,
 * so the bars always add up to the totals beside them.
 */
export function layerSteps(row: LayerRow): LayerStep[] {
  return [
    { label: "Ground-up", value: row.groundUpKes, kind: "total" },
    { label: "Minus deductibles", value: row.deductiblesKes, kind: "decrease" },
    ...(row.overLimitKes > 0 ? [{ label: "Minus amounts over policy limits", value: row.overLimitKes, kind: "decrease" as const }] : []),
    { label: "Gross", value: row.grossKes, kind: "total" },
    { label: "Minus quota share", value: row.quotaShareKes, kind: "decrease" },
    { label: "Minus excess of loss", value: row.xolKes, kind: "decrease" },
    { label: "Net", value: row.netKes, kind: "total" },
  ];
}

export interface AalChange {
  referenceKes: number;
  agentsKes: number;
  /** (agents - reference) / reference. null when the reference figure is zero, so there is nothing to divide by. */
  fraction: number | null;
}

/**
 * Average annual loss on the agents' assumptions against the reference assumptions.
 * null when the agents have not produced a result yet.
 */
export function aalChange(referenceAalKes: number, agentsAalKes: number | null | undefined): AalChange | null {
  if (agentsAalKes === null || agentsAalKes === undefined || !Number.isFinite(agentsAalKes) || !Number.isFinite(referenceAalKes)) return null;
  return { referenceKes: referenceAalKes, agentsKes: agentsAalKes, fraction: referenceAalKes > 0 ? agentsAalKes / referenceAalKes - 1 : null };
}

export interface ParamChange {
  path: string;
  reference: number;
  agreed: number;
  /** (agreed - reference) / reference. null when the reference value is zero. */
  fraction: number | null;
  /** True when code pulled the agents' value back inside its allowed range. */
  adjusted: boolean;
}

/** The parameters whose agreed value differs from the reference, in the order given. LedgerRow from the agents fits. */
export function paramChanges(ledger: { path: string; reference: number; final: number; adjusted?: boolean }[]): ParamChange[] {
  return ledger
    .filter((row) => Math.abs(row.final - row.reference) > 1e-9)
    .map((row) => ({ path: row.path, reference: row.reference, agreed: row.final, fraction: row.reference !== 0 ? row.final / row.reference - 1 : null, adjusted: row.adjusted ?? false }));
}

/** How many of the named flood areas the hazard layer flags. */
export function hotspotCount(hits: { hit: boolean }[]): { matched: number; total: number } {
  return { matched: hits.filter((h) => h.hit).length, total: hits.length };
}

/** The step a stage of the model chain opens. */
export type ChainStep = "hazard" | "vulnerability" | "exposure" | "financial" | "results";

export interface ChainStage {
  step: ChainStep;
  label: string;
  /** The worst result among the stage's checks, or "none" when it has no checks yet. */
  status: CheckStatus | "none";
  pass: number;
  warn: number;
  fail: number;
  total: number;
}

/** Financial checks that are about the shape of the loss curve, not the arithmetic of one event. */
export const LOSS_CURVE_CHECK_IDS: readonly string[] = ["loss-rises", "aal", "aal-order"];

const CHAIN: { step: ChainStep; label: string; owns: (c: Check) => boolean }[] = [
  { step: "hazard", label: "Hazard", owns: (c) => c.group === "hazard" },
  { step: "vulnerability", label: "Vulnerability", owns: (c) => c.group === "vulnerability" },
  { step: "exposure", label: "Exposure", owns: (c) => c.group === "data" },
  { step: "financial", label: "Financial engine", owns: (c) => c.group === "financial" && !LOSS_CURVE_CHECK_IDS.includes(c.id) },
  { step: "results", label: "Loss curve", owns: (c) => c.group === "financial" && LOSS_CURVE_CHECK_IDS.includes(c.id) },
];

/**
 * The five stages of the model chain, in order, each with the checks that belong to it. The checks on the
 * agents are not part of the chain. A stage is as good as its worst check: one failure makes it "fail",
 * otherwise one warning makes it "warn".
 */
export function chainStatus(checks: Check[]): ChainStage[] {
  return CHAIN.map(({ step, label, owns }) => {
    const mine = checks.filter(owns);
    const count = (s: CheckStatus) => mine.filter((c) => c.status === s).length;
    const pass = count("pass");
    const warn = count("warn");
    const fail = count("fail");
    return { step, label, status: mine.length === 0 ? "none" : fail > 0 ? "fail" : warn > 0 ? "warn" : "pass", pass, warn, fail, total: mine.length };
  });
}

/** "6 of 6 checks passed", "5 of 6 passed, 1 warning", "No checks yet". */
export function chainSummary(stage: Pick<ChainStage, "pass" | "warn" | "fail" | "total">): string {
  if (stage.total === 0) return "No checks yet";
  if (stage.warn === 0 && stage.fail === 0) return `${stage.pass} of ${stage.total} checks passed`;
  const parts = [`${stage.pass} of ${stage.total} passed`];
  if (stage.fail > 0) parts.push(`${stage.fail} failed`);
  if (stage.warn > 0) parts.push(`${stage.warn} warning${stage.warn > 1 ? "s" : ""}`);
  return parts.join(", ");
}

/** Every place the dashboard can send the reader: a stage of the model chain, the agents, or the offer. */
export type DashboardStep = ChainStep | "agents" | "offer";

const DASHBOARD_STEP_IDS: Record<DashboardStep, StepId> = {
  hazard: "hazard",
  vulnerability: "vulnerability",
  // The exposure checks are shown where the files are read.
  exposure: "data",
  financial: "loss",
  results: "results",
  agents: "agents",
  offer: "offer",
};

/**
 * The walkthrough step a link on the dashboard opens, as an id from lib/steps.ts. The step's number and
 * name come from there (stepIndex, STEP_NAMES), so a link never carries a number of its own.
 */
export function dashboardStepId(step: DashboardStep): StepId {
  return DASHBOARD_STEP_IDS[step];
}

/** What a file given to the offer card is: an offer to read, a zip of model data, an old Word file, or none of these. */
export type DroppedFileKind = "offer" | "model-data" | "old-word" | "unsupported";

/**
 * Sorts a file by the end of its name, whatever its case. A .zip is model data and a .doc is the old Word
 * format, whatever the list of offer types says. `offerExtensions` are written with their dot: [".docx", ".txt"].
 */
export function droppedFileKind(fileName: string, offerExtensions: readonly string[]): DroppedFileKind {
  const name = fileName.trim().toLowerCase();
  if (name.endsWith(".zip")) return "model-data";
  if (name.endsWith(".doc")) return "old-word";
  return offerExtensions.some((ext) => name.endsWith(ext.toLowerCase())) ? "offer" : "unsupported";
}

/** How serious a point to weigh is. The same three words as Severity in lib/decision. */
type FlagSeverity = "high" | "medium" | "low";
const FLAG_ORDER: readonly FlagSeverity[] = ["high", "medium", "low"];

export interface HeadlineFlags<F> {
  /** The worst flags, high before medium before low, in the order given within a severity. */
  shown: F[];
  /** How many flags are not shown. */
  more: number;
  /** How many flags there are at each severity, shown or not. */
  counts: Record<FlagSeverity, number>;
}

/** The few worst flags for a first screen. The full list, with its evidence, belongs to the Results step. */
export function headlineFlags<F extends { severity: FlagSeverity }>(flags: readonly F[], max = 3): HeadlineFlags<F> {
  const counts: Record<FlagSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const flag of flags) counts[flag.severity] += 1;
  const sorted = flags.map((flag, order) => ({ flag, order })).sort((a, b) => FLAG_ORDER.indexOf(a.flag.severity) - FLAG_ORDER.indexOf(b.flag.severity) || a.order - b.order);
  const shown = sorted.slice(0, Math.max(0, max)).map((x) => x.flag);
  return { shown, more: flags.length - shown.length, counts };
}

/** "3 high, 2 medium, 4 low"; severities with none are left out. "none" when there are no flags. */
export function flagCountText(counts: Record<FlagSeverity, number>): string {
  const parts = FLAG_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * What an offer adds to a portfolio loss, in words: "+KES 1.2m (+0.4%)", "no change" when the
 * amount is under half a shilling, "not modelled" when there is no figure. The share is left out
 * when it is not known, and written with three decimals when it is under a tenth of a percent.
 */
export function portfolioChangeText(changeKes: number | null | undefined, share?: number | null): string {
  if (changeKes === null || changeKes === undefined || !Number.isFinite(changeKes)) return "not modelled";
  if (Math.abs(changeKes) < 0.5) return "no change";
  const sign = changeKes < 0 ? "-" : "+";
  const part = share !== null && share !== undefined && Number.isFinite(share) ? ` (${sign}${(Math.abs(share) * 100).toFixed(Math.abs(share) < 0.001 ? 3 : 1)}%)` : "";
  return `${sign}${kes1(Math.abs(changeKes))}${part}`;
}

export interface RangePlacement {
  /** How many usable values the range was read from. */
  count: number;
  min: number | null;
  median: number | null;
  max: number | null;
  /** Where the value sits. "unknown" when there is no value or no range to compare it with. */
  position: "below" | "within" | "above" | "unknown";
  /** The share of the values at or below this one, 0 to 1. null when it cannot be compared. */
  shareAtOrBelow: number | null;
  /** The value's place between the lowest (0) and the highest (1), held at the ends when it lies outside. null when it cannot be compared. */
  at: number | null;
}

/** Where one value sits among others. Values that are not finite numbers above zero are left out of the range. */
export function rangePlacement(value: number | null | undefined, values: readonly (number | null | undefined)[]): RangePlacement {
  const sorted = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return { count, min: null, median: null, max: null, position: "unknown", shareAtOrBelow: null, at: null };
  const min = sorted[0];
  const max = sorted[count - 1];
  const mid = count >> 1;
  const median = count % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (value === null || value === undefined || !Number.isFinite(value)) return { count, min, median, max, position: "unknown", shareAtOrBelow: null, at: null };
  const at = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : value < min ? 0 : value > max ? 1 : 0.5;
  return { count, min, median, max, position: value < min ? "below" : value > max ? "above" : "within", shareAtOrBelow: sorted.filter((v) => v <= value).length / count, at };
}

/** The six groups the Audit step lists its checks under. */
export type AuditGroupId = "data" | "hazard" | "vulnerability" | "financial" | "agents" | "offer";

export interface AuditGroup {
  id: AuditGroupId;
  title: string;
  checks: Check[];
}

const AUDIT_GROUPS: { id: AuditGroupId; title: string; owns: (c: Check) => boolean }[] = [
  { id: "data", title: "Reading the data", owns: (c) => c.group === "data" },
  { id: "hazard", title: "Hazard", owns: (c) => c.group === "hazard" },
  { id: "vulnerability", title: "Vulnerability", owns: (c) => c.group === "vulnerability" },
  { id: "financial", title: "Financial and insurance terms", owns: (c) => c.group === "financial" },
  { id: "agents", title: "Agents", owns: (c) => c.group === "ai" },
];

/**
 * Every check under its group, in the order the model runs: data, hazard, vulnerability, financial
 * and terms, agents, then the offer. The offer's checks stay together whatever group each one
 * names, because they are all about one document. A group with no checks is left out.
 */
export function checkGroups(checks: readonly Check[], offerChecks: readonly Check[] = []): AuditGroup[] {
  const groups: AuditGroup[] = AUDIT_GROUPS.map(({ id, title, owns }) => ({ id, title, checks: checks.filter(owns) }));
  groups.push({ id: "offer", title: "The offer", checks: [...offerChecks] });
  return groups.filter((g) => g.checks.length > 0);
}
