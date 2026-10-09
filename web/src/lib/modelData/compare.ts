/**
 * "Compare versions": how the key figures move between two model data versions, both run on the
 * same parameters and the same basis, so the only thing that moves between the two columns is
 * the data. Pure: no React, no network, no disk. The screen draws it.
 *
 * How to use it:
 *   const comparison = compareVersions(
 *     { version: versionA, dataset: datasetA },           // the version in force and its dataset
 *     { version: versionB, dataset: datasetB },           // the version to compare, loaded through the same path
 *     active.params,                                      // the assumptions in force
 *     { mode, judgement: judgement.assumed },             // the header switch and the figures beyond depth
 *   );
 *   comparison.rows        one row per key figure: total insured value, buildings, 1-in-100, 1-in-250, average annual loss
 *   comparison.byClass     one block per housing class with the same rows (count, insured value, 1-in-100, 1-in-250, average annual loss)
 *   comparison.a.figures   the key figures of the first side (keyFigures), comparison.a.curve its loss curve, most frequent first
 *   comparison.same        true when both sides are the same version with the same file hashes
 *
 * Pass each side's dataset as the view shows it (with dataset.drainage when the Flood source
 * switch has drainage on), so the figures match the ones on screen. Losses are ground-up: before
 * any deductible, limit or reinsurance, like the dashboard's.
 */
import type { LossMode } from "../model/drivers";
import { averageAnnualLoss, lossAtReturnPeriod, type CurvePoint } from "../model/financial";
import { runModel } from "../model/pipeline";
import { HOUSING_CLASSES, HOUSING_LABELS, type Dataset, type HazardKind, type HousingClass, type ModelParams, type ModelResult } from "../model/types";
import type { OfferJudgement } from "../offer/judgement";
import { hashesOf, type ModelDataVersion } from "./version";

/** One side of the comparison: a version and its dataset as loaded. */
export interface VersionSide {
  version: ModelDataVersion;
  dataset: Dataset;
}

/** The basis both sides are run on. Depth only on the reference figures beyond depth when left out. */
export interface CompareOptions {
  mode?: LossMode;
  judgement?: OfferJudgement;
}

/** The key figures of one housing class, ground-up. */
export interface ClassFigures {
  housingClass: HousingClass;
  /** "Concrete / RCC" and so on. */
  label: string;
  /** Buildings of the class. */
  count: number;
  /** Their insured value. */
  tivKes: number;
  /** The class's loss in a 1-in-100 flood, read off its own curve the way the portfolio's is. null when 100 years is more frequent than anything modelled. */
  loss100Kes: number | null;
  /** The same at 1-in-250. */
  loss250Kes: number | null;
  /** The class's average annual loss: the area under its own curve. */
  aalKes: number;
}

/** The key figures of a model run, ground-up: what the dashboard shows first. */
export interface KeyFigures {
  buildings: number;
  totalTivKes: number;
  /** The 1-in-100 loss read off the curve. null when 100 years is more frequent than anything modelled. */
  loss100Kes: number | null;
  /** True when the 1-in-100 loss is held flat beyond the rarest modelled flood. */
  loss100Extrapolated: boolean;
  loss250Kes: number | null;
  loss250Extrapolated: boolean;
  aalKes: number;
  /** One entry per housing class, in the order of HOUSING_CLASSES. */
  byClass: ClassFigures[];
}

/** A figure on both sides and how it moved. */
export interface FigureChange {
  a: number | null;
  b: number | null;
  /** b minus a. null when either side has no figure. */
  change: number | null;
  /** The change as a fraction of a: 0.12 is up 12%. null when either side has no figure or a is zero. */
  share: number | null;
}

/** One row of the comparison table. */
export interface ComparisonRow extends FigureChange {
  id: "buildings" | "tiv" | "loss100" | "loss250" | "aal";
  /** "Total insured value", "Buildings", "1-in-100 loss", "1-in-250 loss", "Average annual loss". */
  label: string;
  /** "kes" for an amount in shillings, "count" for a number of buildings. */
  unit: "kes" | "count";
  /** True on a loss row when either side holds the figure flat beyond its rarest modelled flood. */
  extrapolated: boolean;
}

/** The comparison for one housing class. */
export interface ClassComparison {
  housingClass: HousingClass;
  label: string;
  rows: ComparisonRow[];
}

/** The version of one side, for the column heading. */
export interface VersionSummary {
  id: string;
  label: string;
  date: string;
  status: ModelDataVersion["status"];
  /** The area's name: "Nairobi". */
  area: string;
  /** hashesOf(version): the short key of the version's file hashes, the same the trace block and the cache use. */
  hashes: string;
  /** From the dataset as loaded. */
  datasetName: string;
  hazardKind: HazardKind;
}

export interface ComparisonSide {
  version: VersionSummary;
  figures: KeyFigures;
  /** The loss curve, most frequent first: one point per modelled flood. */
  curve: CurvePoint[];
}

export interface VersionComparison {
  a: ComparisonSide;
  b: ComparisonSide;
  /** What both sides were run on. */
  settings: { params: ModelParams; mode: LossMode; judgement: OfferJudgement | null };
  rows: ComparisonRow[];
  byClass: ClassComparison[];
  /** True when both sides are the same version with the same file hashes: every change is then zero. */
  same: boolean;
}

/** The key figures of a result, ground-up, with the same figures per housing class. */
export function keyFigures(result: ModelResult): KeyFigures {
  const at = (rp: number) => result.standardLosses.find((s) => s.returnPeriod === rp) ?? lossAtReturnPeriod(result.scenarios.map((s) => ({ returnPeriod: s.returnPeriod, lossKes: s.lossKes })), rp);
  const at100 = at(100);
  const at250 = at(250);
  // Every scenario counts every building of a class, so the counts are read off the rarest one.
  const last = result.scenarios[result.scenarios.length - 1];
  const byClass: ClassFigures[] = HOUSING_CLASSES.map((c) => {
    const points: CurvePoint[] = result.scenarios.map((s) => ({ returnPeriod: s.returnPeriod, lossKes: s.byClass[c].lossKes }));
    return {
      housingClass: c,
      label: HOUSING_LABELS[c],
      count: last?.byClass[c].count ?? 0,
      tivKes: last?.byClass[c].tivKes ?? 0,
      loss100Kes: lossAtReturnPeriod(points, 100).lossKes,
      loss250Kes: lossAtReturnPeriod(points, 250).lossKes,
      aalKes: averageAnnualLoss(points),
    };
  });
  return {
    buildings: result.buildingCount,
    totalTivKes: result.totalTivKes,
    loss100Kes: at100.lossKes,
    loss100Extrapolated: at100.extrapolated,
    loss250Kes: at250.lossKes,
    loss250Extrapolated: at250.extrapolated,
    aalKes: result.aalKes,
    byClass,
  };
}

/** b against a: the difference and its share of a. */
export function figureChange(a: number | null, b: number | null): FigureChange {
  const change = a !== null && b !== null ? b - a : null;
  const share = change !== null && a !== null && a !== 0 ? change / a : null;
  return { a, b, change, share };
}

const row = (id: ComparisonRow["id"], label: string, unit: ComparisonRow["unit"], a: number | null, b: number | null, extrapolated = false): ComparisonRow => ({ id, label, unit, ...figureChange(a, b), extrapolated });

function summaryOf(side: VersionSide): VersionSummary {
  const { version, dataset } = side;
  return { id: version.id, label: version.label, date: version.date, status: version.status, area: version.area.name, hashes: hashesOf(version), datasetName: dataset.name, hazardKind: dataset.hazardKind };
}

/**
 * The key figures of both versions on the same parameters and basis, and how each moved from a
 * to b. runModel is run once per side; nothing else is read.
 */
export function compareVersions(a: VersionSide, b: VersionSide, params: ModelParams, options: CompareOptions = {}): VersionComparison {
  const mode: LossMode = options.mode ?? "depth_only";
  const judgement = options.judgement ?? null;
  const run = (side: VersionSide): ComparisonSide => {
    const result = runModel(side.dataset, params, judgement ? { mode, judgement } : { mode });
    return { version: summaryOf(side), figures: keyFigures(result), curve: result.scenarios.map((s) => ({ returnPeriod: s.returnPeriod, lossKes: s.lossKes })) };
  };
  const sideA = run(a);
  const sideB = run(b);
  const fa = sideA.figures;
  const fb = sideB.figures;
  const rows: ComparisonRow[] = [
    row("tiv", "Total insured value", "kes", fa.totalTivKes, fb.totalTivKes),
    row("buildings", "Buildings", "count", fa.buildings, fb.buildings),
    row("loss100", "1-in-100 loss", "kes", fa.loss100Kes, fb.loss100Kes, fa.loss100Extrapolated || fb.loss100Extrapolated),
    row("loss250", "1-in-250 loss", "kes", fa.loss250Kes, fb.loss250Kes, fa.loss250Extrapolated || fb.loss250Extrapolated),
    row("aal", "Average annual loss", "kes", fa.aalKes, fb.aalKes),
  ];
  const byClass: ClassComparison[] = HOUSING_CLASSES.map((c, i) => {
    const ca = fa.byClass[i];
    const cb = fb.byClass[i];
    return {
      housingClass: c,
      label: HOUSING_LABELS[c],
      rows: [
        row("tiv", "Insured value", "kes", ca.tivKes, cb.tivKes),
        row("buildings", "Buildings", "count", ca.count, cb.count),
        row("loss100", "1-in-100 loss", "kes", ca.loss100Kes, cb.loss100Kes),
        row("loss250", "1-in-250 loss", "kes", ca.loss250Kes, cb.loss250Kes),
        row("aal", "Average annual loss", "kes", ca.aalKes, cb.aalKes),
      ],
    };
  });
  return {
    a: sideA,
    b: sideB,
    settings: { params, mode, judgement },
    rows,
    byClass,
    same: sideA.version.id === sideB.version.id && sideA.version.hashes === sideB.version.hashes,
  };
}
