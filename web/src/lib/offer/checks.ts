import type { Check, CheckGroup, CheckStatus } from "../checks";
import { fmtInt, fmtKes } from "../format";
import { HOUSING_LABELS } from "../model/types";
import { JRC_AFRICA_RESIDENTIAL } from "../model/vulnerability";
import { describeReading } from "./coords";
import { riverDistanceM } from "./locate";
import { fmtDistance, fmtPoint, plural } from "./shared";
import {
  OUTSIDE_MAPS_MESSAGE,
  type OfferCheckId,
  type OfferChecks,
  type OfferChecksInput,
  type OfferLocation,
  type PricingRow,
  type RowPricing,
} from "./types";
import { statusCounts, usableValue } from "./verify";

/**
 * The checks shown with an offer. Each one is a plain test in code on what was read and what was
 * priced. Where the model cannot see something (basements, a commercial building on a curve built
 * for homes) the check says so as a limit: a warning, never a failure.
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

function valuePerM2Check(row: PricingRow, { dataset }: OfferChecksInput): Check | null {
  if (row.housingClass === null) return null;
  const perM2 = row.tivKes !== null && row.floorAreaM2 !== null ? row.tivKes / row.floorAreaM2 : row.costPerM2Kes;
  if (row.tivKes === null && perM2 === null) return null;

  const label = HOUSING_LABELS[row.housingClass];
  const title = "Value per m² is within the loaded portfolio's range for the class";
  const out = (status: CheckStatus, detail: string) => check("data", "offer-value-per-m2", title, status, `${row.name}: ${detail}`, row.locId);
  if (perM2 === null) return out("warn", "no floor area could be read, so the value per m² cannot be worked out.");

  const costs = dataset.buildings.filter((b) => b.housingClass === row.housingClass && b.costPerM2Kes !== null && b.costPerM2Kes > 0).map((b) => b.costPerM2Kes as number);
  const how = row.tivKes !== null && row.floorAreaM2 !== null ? (row.tivFrom === "area_times_cost" ? "the stated cost per m², as no insured value is stated" : "insured value ÷ floor area") : "the stated cost per m²";
  const offer = `${fmtKes(perM2)} per m² (${how})`;
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
    `${stated}${withPlant}. The hazard maps give flooding at ground level. Water entering basements is not modelled, so loss below ground is not in these figures.`,
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
