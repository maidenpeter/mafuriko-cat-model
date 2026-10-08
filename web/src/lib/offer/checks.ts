import type { Check, CheckGroup, CheckStatus } from "../checks";
import { fmtInt, fmtKes, fmtNum } from "../format";
import { kes1, LOSS_MODE_LABELS, rpLabel } from "../labels";
import { HOUSING_LABELS } from "../model/types";
import { JRC_AFRICA_RESIDENTIAL } from "../model/vulnerability";
import { describeReading } from "./coords";
import { DRIVER_IDS, DRIVER_LABELS, type OfferDrivers } from "./drivers";
import { riverDistanceM } from "./locate";
import { fmtDistance, fmtPoint, plural } from "./shared";
import {
  OUTSIDE_MAPS_MESSAGE,
  type OfferCheckId,
  type OfferChecks,
  type OfferExtraction,
  type OfferChecksInput,
  type OfferLocation,
  type OfferPricing,
  type OfferScenario,
  type PricingRow,
  type RowPricing,
} from "./types";
import { statusCounts, usableValue } from "./verify";

/**
 * The checks shown with an offer. Each one is a plain test in code on what was read and what was
 * priced. Where the model cannot see something (basements, a commercial building on a curve built
 * for homes) the check says so as a limit: a warning, never a failure.
 *
 *   offerChecks(input)        what was read and where the building is: needs no price
 *   offerDriverChecks(input)  the three checks on the loss drivers of a priced offer
 *
 * buildOfferFocus runs both and puts them in one list, focus.checks. Every screen and both exports
 * read that list, so nothing adds the driver checks a second time.
 */

const check = (group: CheckGroup, id: OfferCheckId, title: string, status: CheckStatus, detail: string, locId?: string): Check => ({
  group,
  id: locId ? `${id}:${locId}` : id,
  title,
  status,
  detail,
});

// --- offer-values --------------------------------------------------------------------------------

function valuesCheck({ extraction }: OfferChecksInput): Check {
  const counts = statusCounts(extraction);
  const { unverified } = counts;
  const stated = counts.verified + counts.unverified + counts.confirmed + counts.edited;
  const byModel = extraction.rows.filter((r) => r.path === "model").length;
  const byRules = extraction.rows.length - byModel;
  const paths = [byModel > 0 && `${plural(byModel, "row")} read by the model`, byRules > 0 && `${plural(byRules, "row")} read by the fixed rules`].filter(Boolean).join(", ");

  return check(
    "ai",
    "offer-values",
    "Every value read from the document is found in its words",
    stated === 0 || unverified > 0 ? "warn" : "pass",
    stated === 0
      ? "No value could be read from the document. Enter the building's details by hand."
      : `${plural(stated, "value")} read: ${fmtInt(counts.verified)} verified against the document, ${fmtInt(unverified)} unverified and not used until confirmed or edited, ${fmtInt(counts.confirmed)} confirmed and ${fmtInt(counts.edited)} edited by the underwriter.${paths ? ` ${paths}.` : ""}`,
  );
}

// --- offer-coordinates ---------------------------------------------------------------------------

/** How the location was arrived at, in plain words, and whether the reader should look twice. */
function howLocated(location: OfferLocation): { text: string; flagged: boolean } {
  if (location.kind === "none") return { text: location.reason, flagged: true };
  if (location.kind === "approximate") {
    const from = location.source === "ward" ? `the centre of ${location.matchedName} ward` : `the point of the named flood area "${location.matchedName}"`;
    return { text: `The document gives no usable coordinates. "${location.placeName}" is placed at ${from}, so the location is approximate and so is every figure that depends on it.`, flagged: true };
  }
  const r = location.reading;
  if (!r) return { text: `Coordinates typed by the underwriter: ${fmtPoint(location.lat, location.lon)}.`, flagged: false };
  const read = `Read from "${r.raw}" as ${describeReading(r)}.`;
  if (r.conflict) return { text: `${read} The sign and the letter contradict each other: check the point against the address.`, flagged: true };
  if (r.writtenBothWays) return { text: `${read} The document wrote the direction both ways. Both say the same thing, so the point is used as read.`, flagged: true };
  return { text: read, flagged: false };
}

function coordinateCheck(row: PricingRow, priced: RowPricing, maps: number): Check {
  const how = howLocated(row.location);
  const title = "Location is inside the hazard maps loaded";
  if (row.location.kind === "none") return check("data", "offer-coordinates", title, "fail", `${row.name}: no location, so the maps cannot be read. ${how.text}`, row.locId);
  if (priced.status === "outside") return check("data", "offer-coordinates", title, "fail", `${row.name}: ${OUTSIDE_MAPS_MESSAGE}. ${how.text}`, row.locId);
  return check("data", "offer-coordinates", title, how.flagged ? "warn" : "pass", `${row.name}: inside the area covered by ${maps === 1 ? "the hazard map" : `all ${fmtInt(maps)} hazard maps`}. ${how.text}`, row.locId);
}

// --- offer-river ---------------------------------------------------------------------------------

/** The stated and the mapped distance agree when they are within a quarter of the stated figure, or 250 m if that is more. */
const riverAgrees = (statedM: number, mappedM: number) => Math.abs(statedM - mappedM) <= Math.max(250, 0.25 * statedM);

function riverCheck(row: PricingRow, { extraction, waterways }: OfferChecksInput): Check | null {
  const name = usableValue(extraction.terms.riverName)?.trim() || null;
  const statedM = usableValue(extraction.terms.riverDistanceM);
  if (row.location.kind === "none" || (name === null && statedM === null)) return null;

  const title = "Stated river distance agrees with the map";
  const out = (status: CheckStatus, detail: string) => check("hazard", "offer-river", title, status, `${row.name}: ${detail}`, row.locId);
  const stated = statedM !== null ? `a stated distance of ${fmtDistance(statedM)}` : "no stated distance";
  if (name === null) return out("warn", `the document gives ${stated} to a river but no river name that could be read, so it cannot be checked against the map.`);
  if (!waterways) return out("warn", `the open waterways layer is not loaded, so ${stated} to the ${name} cannot be checked.`);

  const mapped = riverDistanceM(row.location, name, waterways);
  if (!mapped) return out("warn", `"${name}" is not in the open waterways layer, so ${stated} cannot be checked against the map.`);

  const approximate = row.location.kind === "approximate" ? " The location is approximate, so this distance is too." : "";
  const onMap = `the nearest mapped stretch of ${mapped.matchedName} is ${fmtDistance(mapped.distanceM)} from the point`;
  if (statedM === null) return out("warn", `the document names the ${name} but gives no distance; ${onMap}.${approximate}`);
  if (riverAgrees(statedM, mapped.distanceM)) return out("pass", `the document says ${fmtDistance(statedM)}; ${onMap}.${approximate}`);
  const gap = fmtDistance(Math.abs(statedM - mapped.distanceM));
  return out(
    "warn",
    mapped.distanceM < statedM
      ? `the document says ${fmtDistance(statedM)}; ${onMap}, which is ${gap} closer than stated.${approximate}`
      : `the document says ${fmtDistance(statedM)}; ${onMap}, which is ${gap} farther than stated. The document may mean a nearer stream that the layer does not name.${approximate}`,
  );
}

// --- offer-value-per-m2 --------------------------------------------------------------------------

/** The value per m2 set against the class range, and which figure it was worked out from. */
export interface ValuePerM2 {
  /** KES per m2. null when it cannot be worked out. */
  kes: number | null;
  /**
   * building_value   the building's own value as the offer states it / floor area: the like-for-like
   *                  figure, as the class range is a rebuilding cost per m2
   * insured_value    the whole insured value / floor area, when the offer does not state the split:
   *                  plant, machinery and contents are in it, so it reads high
   * cost_per_m2      the stated cost per m2, when there is no floor area or no insured value
   */
  from: "building_value" | "insured_value" | "cost_per_m2" | null;
  /** How it was worked out, in a few plain words for a sentence. */
  how: string;
}

/**
 * A building's value per m2 for the under-insurance test. The class range in the portfolio is a
 * rebuilding cost per m2, so the building's own value is used where the offer states it: with
 * plant, machinery and contents in the figure an under-insured building could sit inside the range.
 * The stated building value is for the whole offer, so several buildings share it by insured value.
 */
export function valuePerM2Of(row: PricingRow, rows: PricingRow[], extraction: OfferExtraction): ValuePerM2 {
  const stated = extraction.terms.valueBuildingKes ? usableValue(extraction.terms.valueBuildingKes) : null;
  const offerTiv = rows.every((r) => r.tivKes !== null && r.tivKes > 0) ? rows.reduce((t, r) => t + (r.tivKes ?? 0), 0) : null;
  if (typeof stated === "number" && stated > 0 && row.floorAreaM2 !== null && row.tivKes !== null && offerTiv !== null) {
    const shared = rows.length > 1;
    return { kes: (stated * (row.tivKes / offerTiv)) / row.floorAreaM2, from: "building_value", how: shared ? "the stated building value, shared between the buildings by insured value, ÷ floor area" : "the stated building value ÷ floor area" };
  }
  if (row.tivKes !== null && row.floorAreaM2 !== null) {
    return row.tivFrom === "area_times_cost"
      ? { kes: row.tivKes / row.floorAreaM2, from: "cost_per_m2", how: "the stated cost per m², as no insured value is stated" }
      : { kes: row.tivKes / row.floorAreaM2, from: "insured_value", how: "insured value ÷ floor area; the offer does not state the building's own value, so plant, machinery and contents are in the figure" };
  }
  return row.costPerM2Kes !== null ? { kes: row.costPerM2Kes, from: "cost_per_m2", how: "the stated cost per m²" } : { kes: null, from: null, how: "" };
}

function valuePerM2Check(row: PricingRow, { dataset, rows, extraction }: OfferChecksInput): Check | null {
  if (row.housingClass === null) return null;
  const value = valuePerM2Of(row, rows, extraction);
  const perM2 = value.kes;
  if (row.tivKes === null && perM2 === null) return null;

  const label = HOUSING_LABELS[row.housingClass];
  const title = "Value per m² is within the loaded portfolio's range for the class";
  const out = (status: CheckStatus, detail: string) => check("data", "offer-value-per-m2", title, status, `${row.name}: ${detail}`, row.locId);
  if (perM2 === null) return out("warn", "no floor area could be read, so the value per m² cannot be worked out.");

  const costs = dataset.buildings.filter((b) => b.housingClass === row.housingClass && b.costPerM2Kes !== null && b.costPerM2Kes > 0).map((b) => b.costPerM2Kes as number);
  const offer = `${fmtKes(perM2)} per m² (${value.how})`;
  if (costs.length === 0) return out("warn", `${offer}. The loaded portfolio has no cost per m² for ${label} buildings to compare it with.`);

  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const range = `The cost per m² of the ${plural(costs.length, `${label} building`)} in the loaded portfolio runs from ${fmtKes(min)} to ${fmtKes(max)}`;
  if (perM2 < min) return out("warn", `${offer}. ${range}. The offer is below the lowest: possible under-insurance.`);
  if (perM2 > max) return out("warn", `${offer}. ${range}. The offer is above the highest: check that the floor area and the insured value were read correctly.`);
  return out("pass", `${offer}. ${range}.`);
}

// --- offer-basements -----------------------------------------------------------------------------

function basementCheck({ extraction }: OfferChecksInput): Check | null {
  const levels = usableValue(extraction.terms.basements);
  const plant = extraction.notes.filter((n) => n.kind === "basement_plant" && usableValue(n) !== null).length;
  if (levels === null && plant === 0) return null;

  const title = "No part of the offer is below ground level";
  if (levels === 0 && plant === 0) return check("hazard", "offer-basements", title, "pass", "The document says there are no basements.");
  const stated = levels === null ? "The document describes plant kept in a basement" : levels === 0 ? "The document says there are no basements, yet describes plant kept in one" : `The document states ${plural(levels, "basement level")}`;
  const withPlant = plant > 0 && levels !== null && levels > 0 ? `, with ${plural(plant, "note")} of critical plant kept there` : "";
  return check(
    "hazard",
    "offer-basements",
    title,
    "warn",
    `${stated}${withPlant}. The hazard maps give flooding at ground level, so water entering a basement is not read from them. With Depth only the loss below ground is left out; with All loss drivers the Basement ingress driver prices it on assumptions.`,
  );
}

// --- offer-flood-history -------------------------------------------------------------------------

function floodHistoryCheck(row: PricingRow, priced: RowPricing, { extraction, pricing }: OfferChecksInput): Check | null {
  if (priced.status !== "priced") return null;
  const reported = extraction.notes.filter((n) => n.kind === "past_flood" && usableValue(n) !== null).length;
  const firstWet = priced.scenarios.find((s) => s.hazard > 0);
  const ponding = priced.scenarios.find((s) => s.drainageM > 0);

  const title = "Reported flood history agrees with the hazard maps";
  const out = (status: CheckStatus, detail: string) => check("hazard", "offer-flood-history", title, status, `${row.name}: ${detail}`, row.locId);
  const notes = `the document reports past flood or water damage (${plural(reported, "note")})`;
  // Said of what was read, not of the document: a report the reading missed is still possible.
  const nothingRead = "no report of past flood or water damage was read from the document";
  const tiers = plural(priced.scenarios.length, "tier");
  const dry = `the terrain maps are dry at this point in all ${tiers}`;
  const drainage = ponding ? ` Drainage ponding does reach it, from the 1-in-${fmtInt(ponding.returnPeriod)} event.` : pricing.drainageOn ? " Drainage ponding does not reach it either." : "";
  const caution = "The maps may be missing a source of flooding here, so do not read a small loss as no risk.";

  if (reported > 0 && priced.dryInEveryTier) return out("warn", `${notes}, but ${dry}.${drainage} ${caution}`);
  // A place name that resolved to one of the named flood areas is itself a report of flooding there.
  const { location } = priced;
  if (location.kind === "approximate" && location.source === "hotspot" && priced.dryInEveryTier) {
    return out("warn", `the location stands in for "${location.matchedName}", one of the named flood areas in the loaded data, but ${dry}.${drainage} ${caution}`);
  }
  if (reported === 0 && firstWet) {
    return out("warn", `the maps show water at this point from the 1-in-${fmtInt(firstWet.returnPeriod)} event, but ${nothingRead}. Ask the broker for the loss history.`);
  }
  if (reported > 0 && firstWet) return out("pass", `${notes}, and the maps show water at this point from the 1-in-${fmtInt(firstWet.returnPeriod)} event.`);
  return out("pass", `${nothingRead}, and ${dry}.`);
}

// --- offer-curve ---------------------------------------------------------------------------------

function curveCheck({ extraction }: OfferChecksInput): Check | null {
  const occupancy = usableValue(extraction.terms.occupancy);
  if (occupancy === null) return null;
  const title = "The damage curve was built for this kind of building";
  const source = `The damage curve comes from ${JRC_AFRICA_RESIDENTIAL.source}`;
  if (occupancy === "residential") return check("vulnerability", "offer-curve", title, "pass", `${source}, and the document describes a residential building.`);
  const kind = occupancy === "other" ? "a building that is not residential" : occupancy === "mixed" ? "a mixed-use building" : occupancy === "industrial" ? "an industrial building" : "a commercial building";
  return check(
    "vulnerability",
    "offer-curve",
    title,
    "warn",
    `${source}. The document describes ${kind}, which is priced on that residential curve: stock, machinery, fit-out and loss of income are not reflected. This is a limit of the model, not a fault in the offer.`,
  );
}

export const offerChecks: OfferChecks = (input) => {
  const { rows, pricing, dataset } = input;
  // Rows and their results are in the same order; a row with no result yet is skipped.
  const pairs = rows.flatMap((row, i) => (pricing.rows[i] ? [{ row, priced: pricing.rows[i] }] : []));
  const present = (c: Check | null): c is Check => c !== null;

  return [
    valuesCheck(input),
    ...pairs.map(({ row, priced }) => coordinateCheck(row, priced, dataset.rasters.length)),
    ...pairs.map(({ row }) => riverCheck(row, input)).filter(present),
    ...pairs.map(({ row }) => valuePerM2Check(row, input)).filter(present),
    basementCheck(input),
    ...pairs.map(({ row, priced }) => floodHistoryCheck(row, priced, input)).filter(present),
    curveCheck(input),
  ].filter(present);
};

// --- the loss drivers of a priced offer ----------------------------------------------------------

/** The three checks on the offer's loss drivers, in the order they are listed. */
export const OFFER_DRIVER_CHECK_IDS = ["offer-drivers-add-up", "offer-buffer-ge-point", "offer-depth-only-point"] as const;
export type OfferDriverCheckId = (typeof OFFER_DRIVER_CHECK_IDS)[number];

/** A loss curve as the driver checks read it: one point per modelled return period and the two averages. */
interface CheckedCurve {
  curve: (OfferScenario & { groundUpKes: number; grossKes: number })[];
  aalGroundUpKes: number;
  aalGrossKes: number;
}

export interface OfferDriverChecksInput {
  /** The loss drivers under the mode in force: focus.drivers. */
  drivers: OfferDrivers;
  /** The offer's curve under the mode in force: focus.price.total. */
  total: CheckedCurve;
  /** The same offer with Depth only: focus.price.depthOnly. */
  depthOnly: CheckedCurve;
  /** The engine's point pricing, as it stood before the drivers existed: focus.pricing.totals. null when there is none. */
  point: OfferPricing["totals"];
}

const closeTo = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * The checks on the offer's loss drivers, read back from its own figures: the parts add up, the
 * depth within the buffer is never below the depth at the point, and Depth only gives what the
 * point pricing gives. Only a priced offer has drivers, so an offer outside the maps has none.
 * The portfolio's own three are in the model's checks (checks/drivers.ts).
 */
export function offerDriverChecks({ drivers, total, depthOnly, point }: OfferDriverChecksInput): Check[] {
  const rows = drivers.perReturnPeriod;
  const all = drivers.mode === "all_drivers";
  const group = "financial" as const;
  const out: Check[] = [];

  const partsOff = rows.filter((r) => {
    const six = DRIVER_IDS.reduce((t, id) => t + r.groundUpKes[id], 0);
    const gross = DRIVER_IDS.reduce((t, id) => t + r.grossByDriverKes[id], 0);
    return !(
      closeTo(six, r.groundUpTotalKes) &&
      closeTo(r.pointKes + r.bufferAddedKes, r.groundUpKes.surrounding) &&
      closeTo(r.groundUpKes.surrounding + r.groundUpKes.ponding + r.groundUpKes.overload, r.structureKes) &&
      closeTo(r.groundUpKes.uncertainty, (all ? drivers.judgement.uncertaintyLoading : 0) * r.modelledKes) &&
      closeTo(gross, r.grossKes) &&
      closeTo(r.groundUpTotalKes - r.deductibleKes - r.overLimitKes, r.grossKes)
    );
  });
  const rarest = rows[rows.length - 1];
  out.push({
    group,
    id: "offer-drivers-add-up",
    title: "The offer's loss drivers add up to its loss",
    status: rows.length > 0 && partsOff.length === 0 ? "pass" : "fail",
    detail:
      partsOff.length > 0
        ? `The parts do not add up at ${partsOff.map((r) => rpLabel(r.returnPeriod)).join(", ")}.`
        : `At all ${rows.length} return periods the six drivers add up to the ground-up loss, the depth at the point and what the buffer adds make up ${DRIVER_LABELS.surrounding}, ${DRIVER_LABELS.uncertainty} is its stated share of the other five, and ground-up less the deductible and the part over the limit is the gross loss.${
            rarest ? ` Rarest flood modelled (${rpLabel(rarest.returnPeriod)}): ${DRIVER_IDS.map((id) => `${DRIVER_LABELS[id]} ${kes1(rarest.groundUpKes[id])}`).join(", ")}; ground-up ${kes1(rarest.groundUpTotalKes)}, gross ${kes1(rarest.grossKes)}.` : ""
          }`,
  });

  const depthsOff = rows.filter((r) => {
    const d = r.depths;
    const least = all ? Math.max(d.bufferM, d.pondingM, d.overloadM) : Math.max(d.pointM, d.pondingM);
    return d.bufferM < d.pointM || d.surfaceM < least;
  });
  out.push({
    group,
    id: "offer-buffer-ge-point",
    title: "The offer's depth within the buffer is never below its depth at the point",
    status: rows.length > 0 && depthsOff.length === 0 ? "pass" : "fail",
    detail:
      (depthsOff.length > 0 ? `The depths are out of order at ${depthsOff.map((r) => rpLabel(r.returnPeriod)).join(", ")}. ` : "") +
      rows.map((r) => `${rpLabel(r.returnPeriod)}: ${fmtNum(r.depths.pointM)} m at the point, ${fmtNum(r.depths.bufferM)} m within the buffer`).join("; ") +
      `.${all ? "" : " The buffer is not counted while Depth only is selected."}`,
  });

  // The point pricing is the engine as it stood before the drivers existed (priceOffer). Depth only must give the same.
  const sameCurve = point !== null && point.scenarios.length === depthOnly.curve.length && depthOnly.curve.every((c, k) => closeTo(c.groundUpKes, point.scenarios[k].groundUpKes) && closeTo(c.grossKes, point.scenarios[k].grossKes));
  const sameAal = point !== null && closeTo(depthOnly.aalGroundUpKes, point.aalGroundUpKes) && closeTo(depthOnly.aalGrossKes, point.aalGrossKes);
  const neverAbove = depthOnly.curve.every((c, k) => total.curve[k] !== undefined && c.groundUpKes <= total.curve[k].groundUpKes + 1e-6 * Math.max(1, c.groundUpKes));
  out.push({
    group,
    id: "offer-depth-only-point",
    title: "Depth only reproduces the point reading for the offer",
    status: point === null ? "warn" : sameCurve && sameAal && neverAbove ? "pass" : "fail",
    detail:
      point === null
        ? "The point pricing is not available to compare with."
        : !(sameCurve && sameAal)
          ? `Depth only gives an average annual loss of ${kes1(depthOnly.aalGrossKes)} gross, and the point pricing gives ${kes1(point.aalGrossKes)}. They should be the same.`
          : !neverAbove
            ? "Depth only gives a higher ground-up loss than All loss drivers at one return period or more."
            : `Depth only gives the same ground-up and gross loss as the point pricing at all ${depthOnly.curve.length} return periods (average annual loss ${kes1(depthOnly.aalGrossKes)} gross both ways)${all ? `, and never more than ${LOSS_MODE_LABELS.all_drivers} (${kes1(total.aalGrossKes)} gross)` : ""}.`,
  });
  return out;
}
