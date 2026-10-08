import { fmtInt, fmtKes, fmtNum } from "../format";
import type { IngestReport } from "../ingest";
import { buildingDepths } from "../model/drivers";
import { hotspotHits } from "../model/hotspots";
import { tierSlopes } from "../model/hazard";
import { depthAt, scenarioReturnPeriods } from "../model/pipeline";
import { HOUSING_CLASSES, HOUSING_LABELS, type Dataset, type ModelParams, type ModelResult } from "../model/types";
import { baseCurve, damageRatio } from "../model/vulnerability";
import { REFERENCE_JUDGEMENT } from "../offer/judgement";
import { driverChecks } from "./drivers";

export { driverChecks };

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckGroup = "data" | "hazard" | "vulnerability" | "financial" | "ai";

export interface Check {
  id: string;
  group: CheckGroup;
  title: string;
  status: CheckStatus;
  detail: string;
}

const check = (group: CheckGroup, id: string, title: string, status: CheckStatus, detail: string): Check => ({ group, id, title, status, detail });
const passIf = (ok: boolean, otherwise: CheckStatus = "fail"): CheckStatus => (ok ? "pass" : otherwise);

export function dataChecks(dataset: Dataset, report: IngestReport): Check[] {
  const g = "data" as const;
  const out: Check[] = [];
  const used = report.files.filter((f) => f.used);
  const rasterCount = used.filter((f) => f.kind === "hazard-raster").length;

  out.push(
    check(g, "files-found", "Expected files found and recognised", passIf(used.length > 0 && (rasterCount > 0 || report.hazardSource === "columns")),
      `${used.length} of ${report.files.length} files used: 1 exposure file, ${rasterCount} hazard maps, ${report.hotspotRows > 0 ? "1 hotspot file" : "no hotspot file"}.`),
  );

  out.push(
    check(g, "rows-read", "Rows read equals rows in the file", passIf(report.rowsParsed === report.rowsInFile, report.rowsDropped.length > 0 ? "warn" : "fail"),
      report.rowsParsed === report.rowsInFile
        ? `${fmtInt(report.rowsParsed)} of ${fmtInt(report.rowsInFile)} rows read.`
        : `${fmtInt(report.rowsParsed)} of ${fmtInt(report.rowsInFile)} rows read. Dropped: ${report.rowsDropped.slice(0, 3).map((d) => `row ${d.row} (${d.reason})`).join("; ")}${report.rowsDropped.length > 3 ? "…" : ""}`),
  );

  out.push(
    check(g, "columns", "Required columns present", passIf(report.missingColumns.length === 0),
      report.missingColumns.length === 0 ? "loc_id, lat, lon, housing_class and tiv_kes are all present." : `Missing: ${report.missingColumns.join(", ")}.`),
  );

  out.push(
    check(g, "no-missing", "No missing coordinates or values", passIf(report.rowsDropped.length === 0, "warn"),
      report.rowsDropped.length === 0 ? "Every row has a latitude, a longitude and an insured value." : `${report.rowsDropped.length} rows left out of the model.`),
  );

  if (dataset.rasters.length > 0) {
    out.push(
      check(g, "in-extent", "Coordinates fall inside the hazard maps", passIf(report.outsideRaster === 0, "warn"),
        report.outsideRaster === 0 ? `All ${fmtInt(dataset.buildings.length)} buildings sit inside the mapped area.` : `${report.outsideRaster} buildings are outside the mapped area and are treated as dry.`),
    );
  }

  if (report.tivRatio) {
    const r = report.tivRatio;
    const consistent = Math.abs(r.median - 1) < 0.05;
    const total = dataset.buildings.reduce((s, b) => s + b.tivKes, 0);
    out.push(
      check(g, "tiv-consistent", "Insured value equals floor area × cost per m²", passIf(consistent, "warn"),
        consistent
          ? `Ratio across ${fmtInt(r.n)} rows: ${fmtNum(r.min)} to ${fmtNum(r.max)}.`
          : `Insured values are ${fmtNum(r.median, 1)}× floor area × cost per m² (range ${fmtNum(r.min)} to ${fmtNum(r.max)}). The portfolio totals ${fmtKes(total)}; the documented formula would give ${fmtKes(total / r.median)}. Values are used as they are in the file.`),
    );
  }

  out.push(
    check(g, "synthetic-flag", "Every row carries the synthetic flag", passIf(report.syntheticColumnPresent && report.syntheticFlagged === report.rowsParsed, "warn"),
      !report.syntheticColumnPresent
        ? "The file has no 'synthetic' column. Treat the portfolio as unverified."
        : `${fmtInt(report.syntheticFlagged)} of ${fmtInt(report.rowsParsed)} rows are flagged synthetic.`),
  );

  out.push(
    check(g, "classes-known", "Every housing class is one the model knows", passIf(report.unknownClasses.length === 0, "warn"),
      report.unknownClasses.length === 0
        ? `${HOUSING_CLASSES.length} classes: ${HOUSING_CLASSES.map((c) => `${HOUSING_LABELS[c]} (${dataset.buildings.filter((b) => b.housingClass === c).length})`).join(", ")}.`
        : `Unrecognised: ${report.unknownClasses.map((u) => `"${u.value}" ×${u.count}`).join(", ")}. These use the permanent masonry curve.`),
  );

  return out;
}

export function hazardChecks(dataset: Dataset, report: IngestReport): Check[] {
  const g = "hazard" as const;
  const out: Check[] = [];
  const isScore = dataset.hazardKind === "score";
  const all = dataset.buildings.flatMap((b) => b.hazard);
  const max = all.reduce((m, v) => Math.max(m, v), 0);

  if (isScore) {
    const bad = all.filter((v) => v < 0 || v > 1).length;
    out.push(check(g, "range", "Scores lie between 0 and 1", passIf(bad === 0), bad === 0 ? `Highest score on any building is ${fmtNum(max, 3)}.` : `${bad} values are outside 0 to 1.`));
  } else {
    const bad = all.filter((v) => v < 0 || v > 50).length;
    out.push(check(g, "range", "Depths are plausible", passIf(bad === 0, "warn"), bad === 0 ? `Deepest water at any building is ${fmtNum(max)} m.` : `${bad} values are negative or above 50 m.`));
  }

  // Scenarios are stored from most frequent to rarest, so the hazard at a building should never fall along that order.
  let violations = 0;
  for (const b of dataset.buildings) {
    for (let k = 1; k < b.hazard.length; k++) if (b.hazard[k] < b.hazard[k - 1] - 1e-6) { violations += 1; break; }
  }
  const wet = dataset.scenarios.map((s, k) => `${s.id} ${dataset.buildings.filter((b) => b.hazard[k] > 0).length}`);
  out.push(
    check(g, "nested", "Scenarios are nested: rarer never means less hazard", passIf(violations === 0, "warn"),
      violations === 0 ? `Buildings affected per scenario: ${wet.join(", ")}.` : `${violations} buildings have a lower value in a rarer scenario.`),
  );

  if (report.attached) {
    const a = report.attached;
    out.push(
      check(g, "attached-match", "Raster lookup matches the hazard columns in the file", passIf(a.matched === a.compared, "warn"),
        `${fmtInt(a.matched)} of ${fmtInt(a.compared)} values agree (largest difference ${a.maxAbsDiff.toExponential(1)}).`),
    );
  } else if (report.hazardSource === "columns") {
    out.push(check(g, "attached-match", "Hazard values taken from the file", "warn", "No hazard maps were in the upload, so the pre-attached columns are used without a cross-check."));
  }

  const hits = hotspotHits(dataset);
  if (hits.length > 0) {
    const hit = hits.filter((h) => h.hit);
    const missed = hits.filter((h) => !h.hit).map((h) => h.name);
    out.push(
      check(g, "hotspots", "Known flood areas flagged by the hazard layer", passIf(hit.length === hits.length, "warn"),
        `${hit.length} of ${hits.length} named flood areas are flagged. ${missed.length ? `Missed: ${missed.join(", ")}.` : ""}`.trim()),
    );
  }
  return out;
}

export function vulnerabilityChecks(params: ModelParams): Check[] {
  const g = "vulnerability" as const;
  const depths = Array.from({ length: 161 }, (_, i) => i * 0.05);
  const out: Check[] = [];

  const zeroOk = HOUSING_CLASSES.every((c) => damageRatio(0, c, params) === 0) && baseCurve(0) === 0;
  out.push(check(g, "zero", "Zero depth gives zero damage", passIf(zeroOk), zeroOk ? "All four classes return 0 at 0 m." : "A class returns damage at 0 m."));

  let falls = 0;
  let overCap = 0;
  for (const c of HOUSING_CLASSES) {
    let prev = 0;
    for (const d of depths) {
      const dr = damageRatio(d, c, params);
      if (dr < prev - 1e-12) falls += 1;
      if (dr > params.cap[c] + 1e-12) overCap += 1;
      prev = dr;
    }
  }
  out.push(check(g, "monotonic", "Damage never falls as depth rises", passIf(falls === 0), `Checked ${depths.length} depths from 0 to 8 m for each class.`));
  out.push(
    check(g, "cap", "Damage never exceeds the class cap", passIf(overCap === 0),
      `Caps: ${HOUSING_CLASSES.map((c) => `${HOUSING_LABELS[c]} ${fmtNum(params.cap[c])}`).join(", ")}.`),
  );

  // Classes are listed weakest first.
  let firstBreak: string | null = null;
  for (const d of depths) {
    for (let i = 1; i < HOUSING_CLASSES.length && !firstBreak; i++) {
      const weaker = damageRatio(d, HOUSING_CLASSES[i - 1], params);
      const stronger = damageRatio(d, HOUSING_CLASSES[i], params);
      if (stronger > weaker + 1e-9) firstBreak = `${HOUSING_LABELS[HOUSING_CLASSES[i]]} is damaged more than ${HOUSING_LABELS[HOUSING_CLASSES[i - 1]]} at ${fmtNum(d)} m`;
    }
  }
  out.push(
    check(g, "ordering", "Weaker construction is damaged at least as much as stronger", passIf(!firstBreak, "warn"),
      firstBreak ? `${firstBreak}.` : `At 1 m: ${HOUSING_CLASSES.map((c) => `${HOUSING_LABELS[c]} ${fmtNum(damageRatio(1, c, params))}`).join(", ")}.`),
  );
  return out;
}

export function financialChecks(dataset: Dataset, result: ModelResult): Check[] {
  const g = "financial" as const;
  const out: Check[] = [];
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

  // Recompute every scenario loss from the inputs, independently of the engine's own bookkeeping,
  // at the depth the result's mode uses: the point and the ponding, or the deepest of all loss drivers.
  const rps = scenarioReturnPeriods(dataset, result.params);
  const slopes = tierSlopes(dataset);
  const allDrivers = result.mode === "all_drivers";
  const judgement = result.judgement ?? REFERENCE_JUDGEMENT;
  const depthUsed = (i: number, k: number) =>
    allDrivers ? buildingDepths(dataset, i, k, result.params, judgement, slopes[k], rps[k]).surfaceM : depthAt(dataset, i, k, result.params, slopes[k]).depthM;
  const recomputed = new Map<string, number>();
  dataset.scenarios.forEach((s, k) => {
    let total = 0;
    dataset.buildings.forEach((b, i) => {
      total += damageRatio(depthUsed(i, k), b.housingClass, result.params) * b.tivKes;
    });
    recomputed.set(`${s.id}@${rps[k]}`, total);
  });
  const sumOk = result.scenarios.every((s) => close(recomputed.get(`${s.id}@${s.returnPeriod}`) ?? NaN, s.lossKes));
  out.push(
    check(g, "sum-buildings", "Building losses add up to the portfolio loss", passIf(sumOk),
      `Recomputed from the inputs for ${result.scenarios.length} scenarios × ${fmtInt(result.buildingCount)} buildings; ${sumOk ? "all totals agree" : "totals differ"}.`),
  );

  const classOk = result.scenarios.every((s) => close(HOUSING_CLASSES.reduce((t, c) => t + s.byClass[c].lossKes, 0), s.lossKes));
  out.push(check(g, "sum-classes", "Class losses add up to the portfolio loss", passIf(classOk), classOk ? "The four class totals equal the portfolio total in every scenario." : "Class totals do not reconcile."));

  let over = 0;
  result.buildings.forEach((b, i) => {
    if (b.perScenario.some((p) => p.lossKes > dataset.buildings[i].tivKes + 1e-6)) over += 1;
  });
  out.push(check(g, "loss-le-tiv", "No building loses more than its insured value", passIf(over === 0), over === 0 ? "Highest damage ratio applied is " + fmtNum(Math.max(0, ...result.buildings.flatMap((b) => b.perScenario.map((p) => p.damageRatio)))) + "." : `${over} buildings exceed their insured value.`));

  let rising = true;
  for (let i = 1; i < result.scenarios.length; i++) if (result.scenarios[i].lossKes < result.scenarios[i - 1].lossKes - 1e-6) rising = false;
  out.push(
    check(g, "loss-rises", "Loss rises as the event gets rarer", passIf(rising),
      result.scenarios.map((s) => `${s.returnPeriod}y ${fmtKes(s.lossKes)}`).join(" → "),
    ),
  );

  const maxLoss = Math.max(0, ...result.scenarios.map((s) => s.lossKes));
  out.push(
    check(g, "aal", "Average annual loss is below the largest scenario loss", passIf(result.aalKes <= maxLoss + 1e-6),
      `Average annual loss ${fmtKes(result.aalKes)}; largest scenario ${fmtKes(maxLoss)}.`),
  );
  // With all loss drivers, the checks on the drivers themselves follow. None in depth-only mode.
  return [...out, ...driverChecks(dataset, result)];
}

export function summarise(checks: Check[]): Record<CheckStatus, number> {
  return { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length };
}
