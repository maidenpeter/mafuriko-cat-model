import { OFFER_CSV_COLUMNS, type OfferCsv, type PricingRow } from "./types";

/**
 * The offer's rows as an exposure file: the starter kit's columns in the starter kit's order, so
 * the download can be added to a portfolio and uploaded again. Every row is written. A value that
 * is not known is left blank, never written as zero.
 */

/** Quoted when the value holds a comma, a quote, a line break or outer spaces; quotes inside are doubled. */
function cell(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;
}

const num = (v: number | null): string => (v !== null && Number.isFinite(v) ? String(v) : "");

export const offerCsv: OfferCsv = (rows, fileName) => {
  // A file name is free text: a line break in it would split the row.
  const name = fileName.replace(/\s+/g, " ").trim() || "typed text";
  const line = (row: PricingRow): Record<(typeof OFFER_CSV_COLUMNS)[number], string> => ({
    loc_id: row.locId,
    lat: row.location.kind === "none" ? "" : num(row.location.lat),
    lon: row.location.kind === "none" ? "" : num(row.location.lon),
    housing_class: row.housingClass ?? "",
    floor_area_m2: num(row.floorAreaM2),
    cost_per_m2_kes: num(row.costPerM2Kes),
    tiv_kes: num(row.tivKes),
    synthetic: "false",
    source: `offer:${name}`,
  });
  const lines = rows.map((row) => {
    const values = line(row);
    return OFFER_CSV_COLUMNS.map((c) => cell(values[c])).join(",");
  });
  return [OFFER_CSV_COLUMNS.join(","), ...lines].join("\n") + "\n";
};
