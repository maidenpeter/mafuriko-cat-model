/**
 * The building-level export and the choice of Oasis run, so the independent check covers what the
 * screen shows.
 *
 *   buildingExport(dataset, result)   one row per building and return period for the result in force:
 *                                     the depth of water at the site and the final ground-up damage
 *                                     ratio, with a header (the view) saying which settings gave it
 *   buildingExportCsv(export)         the rows as CSV, with the view on a comment line at the top
 *   buildingExportViewJson(export)    the view alone as JSON
 *
 * oasis/build_and_run.py reads the CSV in one of two ways. With --depths it takes the depths and
 * applies the damage function itself, so Oasis checks the damage function too. With --damage-ratios
 * it takes the damage ratios as they are, so Oasis checks the financial engine and the loss
 * arithmetic for any set of loss drivers. It copies the view into the file it writes.
 *
 *   oasisSettings(dataset, result, source)   the settings in force, as the header bar shows them
 *   oasisRunFor(settings)                    the run made for exactly those settings, or null
 *   oasisChecked(run, file, dataset, result) true only when a file was made for this very result
 *
 * Pure functions, no React and no network.
 */

import { LOSS_MODE_LABELS } from "./labels";
import type { LossMode } from "./model/drivers";
import { flattenParams, REFERENCE_PARAMS } from "./model/params";
import { resultFingerprint } from "./model/pipeline";
import type { Dataset, HazardKind, HousingClass, ModelParams, ModelResult } from "./model/types";
import { PORTFOLIO_KEYS } from "./offer/focus";
import { REFERENCE_JUDGEMENT, type OfferJudgement } from "./offer/judgement";

export type FloodSource = "terrain" | "terrain_drainage";

/** The two settings of the header switch "Flood source", in its own words. */
export const FLOOD_SOURCE_LABELS: Record<FloodSource, string> = { terrain: "Terrain only", terrain_drainage: "Terrain + drainage" };

/** The settings a portfolio result was worked out under, as the header bar shows them. */
export interface OasisSettings {
  floodSource: FloodSource;
  lossesFrom: LossMode;
  /**
   * True when the model's parameters are the reference set and, with all loss drivers, so is every
   * figure beyond flood depth that reaches the portfolio: nothing agreed by the agents, nothing typed.
   */
  referenceAssumptions: boolean;
}

const sameParams = (a: ModelParams, b: ModelParams) => {
  const other = new Map(flattenParams(b).map((p) => [p.path, p.value]));
  return flattenParams(a).every((p) => p.value === other.get(p.path));
};

/** The figures beyond flood depth a portfolio result was run on. null with Depth only, where none is read. */
function portfolioFigures(result: ModelResult): Partial<OfferJudgement> | null {
  if (result.mode !== "all_drivers") return null;
  const ran = result.judgement ?? REFERENCE_JUDGEMENT;
  return Object.fromEntries(PORTFOLIO_KEYS.map((key) => [key, ran[key]]));
}

/**
 * The settings in force for a result. `source` is where the screen says the assumptions came from;
 * left out, the parameters are compared with the reference set.
 */
export function oasisSettings(dataset: Pick<Dataset, "drainage">, result: ModelResult, source?: "ai" | "reference"): OasisSettings {
  const figures = portfolioFigures(result);
  const referenceFigures = !figures || PORTFOLIO_KEYS.every((key) => figures[key] === REFERENCE_JUDGEMENT[key]);
  return {
    floodSource: dataset.drainage ? "terrain_drainage" : "terrain",
    lossesFrom: result.mode ?? "depth_only",
    referenceAssumptions: source !== "ai" && sameParams(result.params, REFERENCE_PARAMS) && referenceFigures,
  };
}

// ---------------------------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------------------------

/** The header of the export: which settings gave these rows. The Oasis script copies it into its output. */
export interface ExportView {
  dataset: string;
  hazardKind: HazardKind;
  floodSource: FloodSource;
  floodSourceLabel: string;
  /** The drainage layer in force: its reach and the ponding depth at full stress per scenario. null on Terrain only. */
  drainage: { reachM: number; pondingDepthM: Record<string, number> } | null;
  lossesFrom: LossMode;
  lossesFromLabel: string;
  assumptions: {
    /** "reference" when every figure below is the reference value, otherwise "agreed": set by the agents or typed over. */
    set: "reference" | "agreed";
    params: ModelParams;
    /** The figures beyond flood depth that reach the portfolio's buildings. null with Depth only, where none is read. */
    beyondDepth: Partial<OfferJudgement> | null;
  };
  buildings: number;
  totalInsuredValueKes: number;
  /** One per return period, most frequent first, as in the rows. */
  scenarios: { id: string; returnPeriod: number; tierSlope: number; lossKes: number; affected: number }[];
  averageAnnualLossKes: number;
  /** resultFingerprint of the result the rows were taken from. */
  fingerprint: string;
}

export interface BuildingExportRow {
  /** Place of the building in the portfolio file, from 1. */
  building: number;
  locId: string;
  housingClass: HousingClass;
  tivKes: number;
  /** Scenario name: the tier ("common") or the return period tag ("rp100y"). */
  scenario: string;
  returnPeriod: number;
  /** Depth of water at the site in metres, as the result's mode reads it. */
  depthM: number;
  /** Final ground-up damage ratio, after every loss driver in force: loss divided by insured value. Never above 1. */
  damageRatio: number;
}

export interface BuildingExport {
  view: ExportView;
  rows: BuildingExportRow[];
}

/**
 * One row per building and return period for the result in force. `dataset` is the one the result
 * was run on, with its drainage layer when the flood source is terrain plus drainage.
 */
export function buildingExport(dataset: Dataset, result: ModelResult, source?: "ai" | "reference"): BuildingExport {
  if (result.buildings.length !== dataset.buildings.length) throw new Error("The result was not run on this data set: the building counts differ.");
  const settings = oasisSettings(dataset, result, source);
  const d = dataset.drainage;
  // The drainage depths are held in the data set's scenario order; the result's order is most frequent first.
  const place = new Map(dataset.scenarios.map((s, i) => [s.id, i]));
  const view: ExportView = {
    dataset: dataset.name,
    hazardKind: dataset.hazardKind,
    floodSource: settings.floodSource,
    floodSourceLabel: FLOOD_SOURCE_LABELS[settings.floodSource],
    drainage: d ? { reachM: d.reachM, pondingDepthM: Object.fromEntries(result.scenarios.map((s) => [s.id, d.depthM[place.get(s.id) ?? -1] ?? 0])) } : null,
    lossesFrom: settings.lossesFrom,
    lossesFromLabel: LOSS_MODE_LABELS[settings.lossesFrom],
    assumptions: { set: settings.referenceAssumptions ? "reference" : "agreed", params: result.params, beyondDepth: portfolioFigures(result) },
    buildings: result.buildingCount,
    totalInsuredValueKes: result.totalTivKes,
    scenarios: result.scenarios.map((s) => ({ id: s.id, returnPeriod: s.returnPeriod, tierSlope: s.tierSlope, lossKes: s.lossKes, affected: s.affected })),
    averageAnnualLossKes: result.aalKes,
    fingerprint: resultFingerprint(result),
  };
  const rows = result.buildings.flatMap((b, i) => {
    const { housingClass, tivKes } = dataset.buildings[i];
    return b.perScenario.map((p, k): BuildingExportRow => ({
      building: i + 1,
      locId: b.locId,
      housingClass,
      tivKes,
      scenario: result.scenarios[k].id,
      returnPeriod: result.scenarios[k].returnPeriod,
      depthM: p.depthM,
      // A building with no insured value has no loss to divide: it keeps the ratio the damage curve gave it.
      damageRatio: Math.min(1, tivKes > 0 ? p.lossKes / tivKes : p.damageRatio),
    }));
  });
  return { view, rows };
}

export const EXPORT_COLUMNS = ["building", "loc_id", "housing_class", "insured_value_kes", "scenario", "return_period", "depth_m", "damage_ratio"] as const;
/** The comment line that carries the view inside the CSV. */
export const EXPORT_VIEW_PREFIX = "# view: ";

const csvCell = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

/**
 * The rows as CSV. Two comment lines come first: what the file is, and the view as one line of
 * JSON, so the file says by itself which settings it was made for. Numbers are written in full,
 * so a reader gets back exactly the figures the app used.
 */
export function buildingExportCsv(exported: BuildingExport): string {
  const lines = [
    "# Building-level export: one row per building and return period. depth_m is the water at the site, damage_ratio the final ground-up loss over insured value.",
    `${EXPORT_VIEW_PREFIX}${JSON.stringify(exported.view)}`,
    EXPORT_COLUMNS.join(","),
    ...exported.rows.map((r) => [r.building, csvCell(r.locId), r.housingClass, r.tivKes, csvCell(r.scenario), r.returnPeriod, r.depthM, r.damageRatio].join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

/** The view alone, as a JSON file to keep beside the CSV. */
export function buildingExportViewJson(exported: BuildingExport): string {
  return `${JSON.stringify(exported.view, null, 1)}\n`;
}

// ---------------------------------------------------------------------------------------------
// Which Oasis run covers which settings
// ---------------------------------------------------------------------------------------------

/** What the Oasis run was fed: depths (it applied the damage function itself) or finished damage ratios. */
export type OasisRunMode = "depths" | "damage_ratios";

export interface OasisRunSpec {
  /** File name under /oasis/ in the app. */
  file: string;
  floodSource: FloodSource;
  lossesFrom: LossMode;
  mode: OasisRunMode;
}

/** The three runs shipped with the app. Each is for the reference assumptions with nothing typed over. */
export const OASIS_RUNS: OasisRunSpec[] = [
  { file: "reference.json", floodSource: "terrain", lossesFrom: "depth_only", mode: "depths" },
  { file: "reference-drainage.json", floodSource: "terrain_drainage", lossesFrom: "depth_only", mode: "depths" },
  { file: "reference-drivers.json", floodSource: "terrain_drainage", lossesFrom: "all_drivers", mode: "damage_ratios" },
];

/** A view in the header's own words: "Terrain + drainage, All loss drivers". */
export const viewName = (v: { floodSource: FloodSource; lossesFrom: LossMode }) => `${FLOOD_SOURCE_LABELS[v.floodSource]}, ${LOSS_MODE_LABELS[v.lossesFrom]}`;

export const OASIS_NOT_CHECKED = "Not checked by Oasis for these settings";
/** The one line under it: which settings an Oasis run exists for. */
export const OASIS_COVERED_LINE = `Saved Oasis runs exist for the reference assumptions with nothing typed over, on the starter kit data set, under three settings: ${OASIS_RUNS.map(viewName).join("; ")}.`;

/** The run made for exactly these settings. null for any other combination: agreed or typed assumptions, or a pairing no run was made for. */
export function oasisRunFor(settings: OasisSettings): OasisRunSpec | null {
  if (!settings.referenceAssumptions) return null;
  return OASIS_RUNS.find((run) => run.floodSource === settings.floodSource && run.lossesFrom === settings.lossesFrom) ?? null;
}

/** What oasis/build_and_run.py writes to public/oasis/<file>. */
export interface OasisRunFile {
  engine: string;
  oasislmfVersion: string;
  generatedAt: string;
  dataset: string;
  tivBasis: "file" | "documented";
  params: ModelParams;
  samples: number;
  periods: number;
  events: { tier: string; returnPeriod: number; oasisLossKes: number; ourLossKes: number }[];
  aal: { oasisKes: number; ourTrapezoidKes: number; ourDiscreteKes: number };
  maxEventDiffPct: number;
  notes: string[];
  /** Missing in a file written before the export existed: such a file names no view and is never shown. */
  mode?: OasisRunMode;
  view?: ExportView | null;
}

/**
 * True only when the file was made for this very result: the run chosen for the settings, the same
 * data set, the same view and the same result fingerprint. Anything else is not a check of what
 * the screen shows.
 */
export function oasisChecked(run: OasisRunSpec, file: OasisRunFile | null | undefined, dataset: Pick<Dataset, "name">, result: ModelResult): file is OasisRunFile & { view: ExportView } {
  const view = file?.view;
  if (!file || !view) return false;
  return file.mode === run.mode && file.dataset === dataset.name && view.floodSource === run.floodSource && view.lossesFrom === run.lossesFrom && view.assumptions.set === "reference" && view.fingerprint === resultFingerprint(result);
}
