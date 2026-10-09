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
 *   judgementChanges(ledger)      the beyond-depth assumptions the agents moved away from the reference
 *   driverParts(byDriver, order)  one loss split by driver, as the parts of a stacked bar
 *   hotspotCount(hits)            how many named flood areas the hazard layer flags
 *   chainStatus(checks)           the five stages of the model chain with their check counts
 *   dashboardStepId(step)         which walkthrough step a link on the dashboard opens
 *   OFFER_FILE_TYPES_TEXT         the kinds of file an offer can be given as, in words
 *   headlineFlags(flags, max)     the few worst points to weigh on an offer, with how many are left over
 *   portfolioChangeParts(kes, share) what an offer adds to a portfolio figure: the amount and its share, apart
 *   portfolioChangeText(kes, share)  the same in one phrase
 *   rangePlacement(value, values) where one value sits in a list: below, within or above its range
 *   checkGroups(checks, offer)    every check sorted into the six groups of the Audit step
 *
 * The interpretability screens and records read the library in lib/interpret through this file, which
 * the library does not read back (its tornado takes its labels from lib/export, so lib/export cannot
 * read the library itself):
 *   signedKes(kes), changeWords(kes)   a change in a loss with its sign: "+KES 1.2m"; "adds KES 1.2m", "takes off KES 1.1m"
 *   swingValueText(unit, value)        a value an assumption is swung to, with its unit
 *   signedTicks(lo, hi)                round axis ticks through zero, for a chart of changes
 *   shapleySumLine(result, measure)    the line that prints the shares added up beside the whole change
 *   shapleyTile(result, top, measure)  the largest shares, the rest as one, and the whole change: the Dashboard's tile
 *   tornadoCells(rows), shapleyCells(result)   the tables the written note, the Audit step and the decision note print
 *   interpretation(input)              the tornado and the split for the portfolio and the priced offer, with the method lines
 */

import type { Check, CheckStatus } from "./checks";
import { fmtNum } from "./format";
import {
  offerTarget,
  shapley,
  SHAPLEY_TITLE,
  shapleyMethodLine,
  tornado,
  TORNADO_TITLE,
  tornadoMethodLine,
  tornadoPlan,
  type Assumptions,
  type ShapleyGroup,
  type ShapleyResult,
  type Target,
  type TornadoRow,
} from "./interpret";
import { axisTicks, kes1, rpLabel } from "./labels";
import type { LossMode } from "./model/drivers";
import { REFERENCE_PARAMS } from "./model/params";
import type { TermsLossAt, LayerRow } from "./model/terms";
import { HOUSING_CLASSES, HOUSING_LABELS, type Dataset, type HousingClass, type ModelParams, type ScenarioResult } from "./model/types";
import { portfolioJudgement, type FocusJudgement, type PricedFocus } from "./offer/focus";
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

export interface JudgementChange {
  /** Which beyond-depth assumption. */
  key: string;
  /** Its plain name, with the unit. */
  label: string;
  reference: number;
  agreed: number;
  /** (agreed - reference) / reference. null when the reference value is zero. */
  fraction: number | null;
  /** True when code corrected the agents' figure: back into its range, or up so its ladder does not fall. */
  adjusted: boolean;
}

/**
 * The beyond-depth assumptions the agents agreed away from the reference, in the order given.
 * A figure the Chair did not decide (agreed null) has not moved. JudgementLedgerRow from the agents fits.
 */
export function judgementChanges(ledger: { key: string; label: string; reference: number; agreed: number | null; adjusted?: boolean }[]): { moved: JudgementChange[]; of: number } {
  const moved = ledger.flatMap((row) =>
    row.agreed !== null && Number.isFinite(row.agreed) && Math.abs(row.agreed - row.reference) > 1e-9
      ? [{ key: row.key, label: row.label, reference: row.reference, agreed: row.agreed, fraction: row.reference !== 0 ? row.agreed / row.reference - 1 : null, adjusted: row.adjusted ?? false }]
      : [],
  );
  return { moved, of: ledger.length };
}

export interface DriverPart<Id extends string = string> {
  id: Id;
  label: string;
  kes: number;
  /** The part's share of the parts added up, 0 to 1. 0 when they add up to nothing. */
  share: number;
}

/**
 * One loss split by driver, as the parts of a stacked bar: each driver in the order asked for, with
 * its share of the whole. A part that is missing, negative or not a number counts as nothing, so the
 * shares always add up to 1 (or to 0 when there is no loss).
 */
export function driverParts<Id extends string>(byDriverKes: Partial<Record<Id, number>>, order: readonly Id[], labels: Record<Id, string>): { parts: DriverPart<Id>[]; totalKes: number } {
  const amount = (id: Id) => {
    const v = byDriverKes[id];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const totalKes = order.reduce((t, id) => t + amount(id), 0);
  return { parts: order.map((id) => ({ id, label: labels[id], kes: amount(id), share: totalKes > 0 ? amount(id) / totalKes : 0 })), totalKes };
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

/**
 * The kinds of file an offer can be given as, as the reader is told them: on the Dashboard's call-out
 * and on the upload card of the "Price an offer" step. Which files are opened is decided in
 * lib/offerFiles/kind.ts; this only names them.
 */
export const OFFER_FILE_TYPES_TEXT = "Word (.docx), PDF (.pdf) or text (.txt)";

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
 * What an offer adds to a portfolio loss, as two parts for a figure and the line under it:
 * the amount ("+KES 1.2m", "no change" when it is under half a shilling, "not modelled" when there
 * is no figure) and its share ("+0.4%", with three decimals when it is under a tenth of a percent).
 * The share is null when it is not known or there is no amount to take a share of.
 */
export function portfolioChangeParts(changeKes: number | null | undefined, share?: number | null): { amount: string; share: string | null } {
  if (changeKes === null || changeKes === undefined || !Number.isFinite(changeKes)) return { amount: "not modelled", share: null };
  if (Math.abs(changeKes) < 0.5) return { amount: "no change", share: null };
  const sign = changeKes < 0 ? "-" : "+";
  const known = share !== null && share !== undefined && Number.isFinite(share);
  return { amount: `${sign}${kes1(Math.abs(changeKes))}`, share: known ? `${sign}${(Math.abs(share) * 100).toFixed(Math.abs(share) < 0.001 ? 3 : 1)}%` : null };
}

/** The same in one phrase: "+KES 1.2m (+0.4%)", "+KES 1.2m" when the share is not known, "no change", "not modelled". */
export function portfolioChangeText(changeKes: number | null | undefined, share?: number | null): string {
  const parts = portfolioChangeParts(changeKes, share);
  return parts.share ? `${parts.amount} (${parts.share})` : parts.amount;
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

// ---------------------------------------------------------------------------------------------
// Interpretability: the tornado and the exact Shapley split, as the screens and the records read them
// ---------------------------------------------------------------------------------------------

/** A change in a loss with its sign: "+KES 1.2m", "-KES 85.0k", "KES 0". "not modelled" with no figure. */
export function signedKes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "not modelled";
  const text = kes1(value);
  return value > 0 && text !== "KES 0" ? `+${text}` : text;
}

/** The same in words: "adds KES 3.2m", "takes off KES 1.1m", "no change" under half a shilling, "not modelled" with no figure. */
export function changeWords(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "not modelled";
  if (Math.abs(value) < 0.5) return "no change";
  return value > 0 ? `adds ${kes1(value)}` : `takes off ${kes1(-value)}`;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** A count up to eight in words, for a sentence ("eight shares"); the figure past that. */
export const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);

/** The two figures the split and the tornado are read on. */
export type Measure = "aal" | "loss100";

export const MEASURE_LABELS: Record<Measure, string> = { aal: "average annual loss", loss100: "1-in-100 loss" };

/** A group's share, or a total, on one measure. null where a 1-in-100 flood is not modelled. */
export const shapleyValue = (g: Pick<ShapleyGroup, "aalKes" | "loss100Kes">, measure: Measure): number | null => (measure === "aal" ? g.aalKes : g.loss100Kes);

/**
 * A value an assumption is swung to, with its unit: "1-in-2" for a return period, "0.4 m", "40%" for a
 * share, "0.4 times depth" for a fragility, and a ladder's rungs "0% / 0% / 0% / 0% / 0%". `short` is
 * the form that fits the end of a bar: "0.4×", and "0% on every rung" for a ladder.
 */
export function swingValueText(unit: string, value: number | number[], short = false): string {
  if (Array.isArray(value)) {
    const rungs = value.map((v) => `${fmtNum(v * 100, 1)}%`);
    if (!short) return rungs.join(" / ");
    return new Set(rungs).size === 1 ? `${rungs[0]} on every rung` : `${rungs[0]} to ${rungs[rungs.length - 1]}`;
  }
  if (unit === "years") return rpLabel(value);
  if (unit === "m") return `${fmtNum(value, 3)} m`;
  if (unit === "times depth") return short ? `${fmtNum(value, 3)}×` : `${fmtNum(value, 3)} times depth`;
  if (unit.startsWith("share")) return `${fmtNum(value * 100, 1)}%`;
  return `${fmtNum(value, 3)} ${unit}`;
}

/** Round ticks from the lowest change to the highest, through zero, on the steps axisTicks uses. */
export function signedTicks(lo: number, hi: number, count = 3): number[] {
  const span = Math.max(1e-9, Math.abs(lo), Math.abs(hi));
  const positive = axisTicks(span, count);
  const step = positive[1] ?? span;
  const ticks: number[] = [];
  for (let i = Math.floor(Math.min(0, lo) / step); i <= Math.ceil(Math.max(0, hi) / step); i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

/**
 * The line that shows the shares add up, with both figures printed so the reader sees they match:
 * "The six shares add up to +KES 438.9m, the whole change the agents made to the average annual loss: +KES 438.9m."
 */
export function shapleySumLine(result: ShapleyResult, measure: Measure = "aal"): string {
  const n = result.groups.length;
  const sum = measure === "aal" ? result.sumAalKes : result.sumLoss100Kes;
  const total = measure === "aal" ? result.totalAalKes : result.totalLoss100Kes;
  const what = MEASURE_LABELS[measure];
  if (sum === null || total === null) return `The change in the ${what} cannot be split: a 1-in-100 flood is not modelled under every combination of the two sets.`;
  if (n === 0) return `The agents changed nothing that reaches the ${what}, so there is no share to add up: the whole change is ${signedKes(total)}.`;
  return `The ${n === 1 ? "one share is" : `${countWord(n)} shares add up to`} ${signedKes(sum)}, the whole change the agents made to the ${what}: ${signedKes(total)}.`;
}

/** One bar of the Dashboard's tile: a group, the rest folded into one, or the whole change. */
export interface ShapleyTileRow {
  id: string;
  label: string;
  aalKes: number;
  loss100Kes: number | null;
}

export interface ShapleyTile {
  /** The groups with the largest shares on the measure, largest first. */
  shown: ShapleyTileRow[];
  /** The other groups added into one row, or null when every group is shown. */
  others: (ShapleyTileRow & { count: number }) | null;
  /** The whole change, agreed less reference. */
  total: ShapleyTileRow;
  sumAalKes: number;
  sumLoss100Kes: number | null;
  /** The sum line on the measure. */
  line: string;
}

/** The Dashboard's tile: the `top` largest shares, the rest as one row, and the whole change, every figure the library's. */
export function shapleyTile(result: ShapleyResult, top = 3, measure: Measure = "aal"): ShapleyTile {
  const size = (g: ShapleyGroup) => Math.abs(shapleyValue(g, measure) ?? 0);
  const ordered = [...result.groups].sort((a, b) => size(b) - size(a));
  const row = ({ id, label, aalKes, loss100Kes }: ShapleyGroup): ShapleyTileRow => ({ id, label, aalKes, loss100Kes });
  // One group left over is shown as itself: a row saying "1 other group" would hide its name for nothing.
  const kept = ordered.length <= Math.max(0, top) + 1 ? ordered : ordered.slice(0, Math.max(0, top));
  const rest = ordered.slice(kept.length);
  const others: ShapleyTile["others"] =
    rest.length > 0
      ? {
          id: "others",
          label: `${rest.length} other groups`,
          count: rest.length,
          aalKes: rest.reduce((t, g) => t + g.aalKes, 0),
          loss100Kes: rest.some((g) => g.loss100Kes === null) ? null : rest.reduce((t, g) => t + (g.loss100Kes as number), 0),
        }
      : null;
  return {
    shown: kept.map(row),
    others,
    total: { id: "total", label: "Whole change", aalKes: result.totalAalKes, loss100Kes: result.totalLoss100Kes },
    sumAalKes: result.sumAalKes,
    sumLoss100Kes: result.sumLoss100Kes,
    line: shapleySumLine(result, measure),
  };
}

/** One row of the tornado as a table prints it. */
export interface TornadoCells {
  id: string;
  assumption: string;
  inForce: string;
  low: string;
  high: string;
  /** The change in the 1-in-100 loss at the low value, then at the high value: "-KES 3.0m to +KES 12.0m". "not modelled" where a 1-in-100 flood is not. */
  change100: string;
  changeAal: string;
  note: string | null;
}

export const TORNADO_HEAD = ["Assumption", "In force", "Low value used", "High value used", "Change in the 1-in-100 loss, low to high", "Change in the average annual loss, low to high"];

const changeSpan = (low: number | null, high: number | null): string => (low === null || high === null ? "not modelled" : `${signedKes(low)} to ${signedKes(high)}`);

/** The tornado's rows as the cells of a table, in the rows' order. */
export function tornadoCells(rows: readonly TornadoRow[]): TornadoCells[] {
  return rows.map((r) => ({
    id: r.id,
    assumption: r.label,
    inForce: swingValueText(r.unit, r.baseValue),
    low: swingValueText(r.unit, r.lowValue),
    high: swingValueText(r.unit, r.highValue),
    change100: changeSpan(r.low.loss100ChangeKes, r.high.loss100ChangeKes),
    changeAal: changeSpan(r.low.aalChangeKes, r.high.aalChangeKes),
    note: r.note,
  }));
}

export const SHAPLEY_HEAD = ["Group", "Share of the change in the average annual loss", "Share of the change in the 1-in-100 loss"];

/** The split as the cells of a table: each group's share, then the shares added up beside the whole change. */
export interface ShapleyCells {
  head: string[];
  rows: string[][];
  sum: string[];
  total: string[];
  /** True when the shares add up to the whole change to floating point; null for the 1-in-100 loss where it is not modelled. */
  matches: { aal: boolean; loss100: boolean | null };
  /** The groups left out before any run, each with why, in one line. "" when none. */
  dropped: string;
}

const addsUp = (sum: number | null, total: number | null): boolean | null => (sum === null || total === null ? null : Math.abs(sum - total) <= 1e-6 * Math.max(1, Math.abs(total)));

export function shapleyCells(result: ShapleyResult): ShapleyCells {
  const n = result.groups.length;
  return {
    head: SHAPLEY_HEAD,
    rows: result.groups.map((g) => [g.label, signedKes(g.aalKes), signedKes(g.loss100Kes)]),
    sum: [n === 1 ? "The one share" : `The ${countWord(n)} shares added up`, signedKes(result.sumAalKes), signedKes(result.sumLoss100Kes)],
    total: ["The whole change, agreed less reference", signedKes(result.totalAalKes), signedKes(result.totalLoss100Kes)],
    matches: { aal: addsUp(result.sumAalKes, result.totalAalKes) as boolean, loss100: addsUp(result.sumLoss100Kes, result.totalLoss100Kes) },
    dropped: result.dropped.length > 0 ? `Not in the split: ${result.dropped.map((d) => `${d.label} (${d.why.replace(/\.$/, "")})`).join("; ")}.` : "",
  };
}

/** Said wherever a split is asked for before the agents have run. */
export const AGENTS_NOT_RUN = "The agents have not run, so there is no change of theirs to attribute.";

/** The sets a target is read with: the base in force, and the reference and agreed sets the split runs between. */
export interface InterpretSets {
  base: Assumptions;
  reference: Assumptions;
  /** null until the agents have agreed a set. */
  agreed: Assumptions | null;
}

/** The sets from the parameters in force, the agents' final parameters (null before they run) and the judgement block every step receives. */
export function interpretSets(params: ModelParams, agreedParams: ModelParams | null, judgement: FocusJudgement): InterpretSets {
  return {
    base: { params, judgement: judgement.assumed },
    reference: { params: REFERENCE_PARAMS, judgement: judgement.reference },
    agreed: agreedParams ? { params: agreedParams, judgement: judgement.assumed } : null,
  };
}

/** The tornado and the split for one target, with everything a record prints: the rows, the cells, the method lines. */
export interface InterpretedTarget {
  kind: Target["kind"];
  tornado: { head: string[]; rows: TornadoRow[]; leftOut: { id: string; label: string; why: string }[]; methodLine: string; cells: TornadoCells[] };
  shapley: { result: ShapleyResult; methodLine: string; sumLine: string; cells: ShapleyCells } | null;
  /** Why there is no split: the agents have not run. null when there is one. */
  shapleyWhy: string | null;
}

export interface Interpretation {
  mode: LossMode;
  titles: { tornado: string; shapley: string };
  portfolio: InterpretedTarget;
  /** The priced offer's, when one was given. */
  offer: InterpretedTarget | null;
}

/** Both for one target, synchronously: for the records and for tests. Screens run the split through shapleyAsync. */
export function interpretTarget(target: Target, sets: InterpretSets, mode: LossMode): InterpretedTarget {
  const rows = tornado(target, sets.base, { mode });
  const result = sets.agreed ? shapley(target, sets.reference, sets.agreed, { mode }) : null;
  return {
    kind: target.kind,
    tornado: { head: TORNADO_HEAD, rows, leftOut: tornadoPlan(target, sets.base, { mode }).leftOut, methodLine: tornadoMethodLine(rows), cells: tornadoCells(rows) },
    shapley: result ? { result, methodLine: shapleyMethodLine(result), sumLine: shapleySumLine(result, "aal"), cells: shapleyCells(result) } : null,
    shapleyWhy: result ? null : AGENTS_NOT_RUN,
  };
}

/**
 * The tornado and the split for the portfolio and, when one is given, the priced offer: what the written
 * note and the audit file carry. `params` are the parameters in force, `agreedParams` the agents' final
 * ones (null before they run), `judgement` the block every step receives (the portfolio's own when left out).
 */
export function interpretation(input: { dataset: Dataset; params: ModelParams; agreedParams: ModelParams | null; judgement?: FocusJudgement | null; mode: LossMode; focus?: PricedFocus | null }): Interpretation {
  const judgement = input.judgement ?? input.focus?.judgement ?? portfolioJudgement();
  const portfolio = interpretTarget({ kind: "portfolio", dataset: input.dataset }, interpretSets(input.params, input.agreedParams, judgement), input.mode);
  const offer = input.focus ? interpretTarget(offerTarget(input.focus, input.dataset), interpretSets(input.params, input.agreedParams, input.focus.judgement), input.mode) : null;
  return { mode: input.mode, titles: { tornado: TORNADO_TITLE, shapley: SHAPLEY_TITLE }, portfolio, offer };
}
