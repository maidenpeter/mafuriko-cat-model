import { fmtInt, fmtNum } from "../format";
import { HOUSING_CLASSES, HOUSING_LABELS } from "../model/types";
import { fmtDistance } from "./shared";
import type { CoreTermKey, FloodLoss, OfferExtraction, OfferRowValues, Quoted, ValueRef } from "./types";

/**
 * Every value of an offer that is shown on screen: its name, the kind of thing it holds and the
 * order it appears in. One list, so a value is called the same thing in the boxes of the Read the
 * offer step, in the table of fields, in the list of values pricing waits for and in the checks.
 *
 * How to use it:
 *   ROW_FIELDS        the values of one building, in the exposure file's order
 *   TERM_GROUPS       the offer-level values, in the two groups the screen shows
 *   TERM_FIELDS       the same values as one flat list
 *   historyFields(e)  the document's own loss history: the years it covers, then the year and the
 *                     amount of each past flood loss, each ready for a table row and a quote mark
 *   historyFieldDef(r) the box a loss history value is typed into, by its reference
 *   fieldLabel(f)     the name without its unit in brackets, for a table that shows the unit in the value
 *   fieldText(v, f)   the value as text with its unit: "KES 4,250,000,000", "48,500 m²", "5%", "1.8 km"
 */

export type FieldKind = "text" | "degrees" | "kes" | "area" | "percent" | "count" | "metres" | "choice" | "year" | "years";

export interface FieldDef<K extends string> {
  key: K;
  /** The name over the box. Carries the unit in brackets where the box holds a bare number. */
  label: string;
  kind: FieldKind;
  /** The name where the label would not stand on its own in a table. Otherwise the label without its unit is used. */
  plain?: string;
  hint?: string;
  choices?: { value: string; label: string }[];
  /** What the empty choice of a list says. */
  empty?: string;
}

export const ROW_FIELDS: FieldDef<keyof OfferRowValues>[] = [
  { key: "name", label: "Building name", kind: "text" },
  { key: "lat", label: "Latitude", kind: "degrees", hint: "Decimal degrees. South is negative." },
  { key: "lon", label: "Longitude", kind: "degrees", hint: "Decimal degrees. East is positive." },
  { key: "housingClass", label: "Construction class", kind: "choice", choices: HOUSING_CLASSES.map((c) => ({ value: c, label: HOUSING_LABELS[c] })), empty: "Not stated: pick one" },
  { key: "floorAreaM2", label: "Floor area (m²)", kind: "area" },
  { key: "costPerM2Kes", label: "Cost per m² (KES)", kind: "kes" },
  { key: "tivKes", label: "Insured value (KES)", kind: "kes", hint: "Left empty, it is worked out as floor area × cost per m²." },
];

export const TERM_GROUPS: { title: string; fields: FieldDef<CoreTermKey>[] }[] = [
  {
    title: "Flood terms",
    fields: [
      { key: "floodDeductiblePct", label: "Flood deductible (%)", kind: "percent", hint: "With no percentage and no minimum, the example terms are used." },
      { key: "floodDeductibleMinKes", label: "Deductible minimum (KES)", kind: "kes", hint: "With no percentage, this is a flat deductible." },
      {
        key: "floodDeductibleBasis",
        label: "The percentage is taken of",
        plain: "Deductible percentage is taken of",
        kind: "choice",
        choices: [
          { value: "percent_of_loss", label: "Each loss" },
          { value: "percent_of_sum_insured", label: "The insured value" },
        ],
        empty: "Not stated: read as each loss",
      },
      { key: "floodLimitKes", label: "Flood limit (KES)", kind: "kes", hint: "Left empty, the example limit is used." },
      {
        key: "floodCover",
        label: "Flood cover",
        kind: "choice",
        choices: [
          { value: "covered", label: "Covered" },
          { value: "excluded", label: "Excluded" },
        ],
      },
      { key: "policyPeriod", label: "Policy period", kind: "text" },
    ],
  },
  {
    title: "The building and where it is",
    fields: [
      { key: "basements", label: "Basement levels", kind: "count", hint: "0 means the document says there are none." },
      {
        key: "occupancy",
        label: "Occupancy",
        kind: "choice",
        choices: [
          { value: "residential", label: "Residential" },
          { value: "commercial", label: "Commercial" },
          { value: "industrial", label: "Industrial" },
          { value: "mixed", label: "Mixed use" },
          { value: "other", label: "Other" },
        ],
      },
      { key: "placeName", label: "Place name", kind: "text", hint: "Used for a building with no coordinates: a ward or a named flood area." },
      { key: "riverName", label: "Nearest river named", kind: "text" },
      { key: "riverDistanceM", label: "Stated distance to it (m)", plain: "Stated distance to that river", kind: "metres" },
    ],
  },
];

export const TERM_FIELDS = TERM_GROUPS.flatMap((g) => g.fields);

// ---------------------------------------------------------------------------------------------
// The document's own loss history
// ---------------------------------------------------------------------------------------------

/** The heading the loss history values stand under. */
export const HISTORY_TITLE = "Loss history in the document";

/** How many years the document's loss history covers. Held on the offer's terms, shown with the losses. */
export const HISTORY_YEARS_FIELD: FieldDef<"floodHistoryYears"> = {
  key: "floodHistoryYears",
  label: "Years of loss history",
  kind: "years",
  hint: "The number of years the document's loss history covers. Past flood losses are spread over it.",
};

/** The two values of one past flood loss. The name on screen carries the loss's number: see lossFieldLabel. */
export const LOSS_FIELDS: FieldDef<keyof FloodLoss>[] = [
  { key: "year", label: "Year", kind: "year", hint: "The year the loss happened, as four digits." },
  { key: "amountKes", label: "Amount (KES)", kind: "kes", hint: "The document's own figure for the whole loss. Left empty, the loss counts as an event with no amount." },
];

/** "Past flood loss 1: year", "Past flood loss 1: amount". index is the loss's place in the list, from 0. */
export const lossFieldLabel = (index: number, key: keyof FloodLoss): string => `Past flood loss ${index + 1}: ${key === "year" ? "year" : "amount"}`;

/** One loss history value, flat, ready for a table row and for a mark in the document. */
export interface HistoryField {
  /** Stable id: "terms:floodHistoryYears", "loss:0:year", "loss:0:amountKes". */
  id: string;
  /** Points at the value in the extraction, for editValue and confirmValue. */
  ref: ValueRef;
  /** "Years of loss history", "Past flood loss 1: year", "Past flood loss 1: amount". */
  label: string;
  /** The value as text with its unit: "11 years", "2018", "KES 4,200,000". "" when there is none. */
  value: string;
  /** The value with its quote, status and reason, as held in the extraction. */
  quoted: Quoted<number>;
  /** The kind of box the value is typed into. */
  field: FieldDef<string>;
}

const NOT_STATED: Quoted<number> = { value: null, quote: "", status: "missing", reason: null };

/**
 * The loss history as a list: the years it covers first, whether stated or not, then two
 * entries for each past flood loss in the document's order. An offer with no loss history
 * gives the one "Years of loss history" entry, not stated.
 */
export function historyFields(extraction: OfferExtraction): HistoryField[] {
  const years = extraction.terms.floodHistoryYears ?? NOT_STATED;
  const out: HistoryField[] = [
    { id: "terms:floodHistoryYears", ref: { scope: "terms", key: "floodHistoryYears" }, label: HISTORY_YEARS_FIELD.label, value: fieldText(years.value, HISTORY_YEARS_FIELD), quoted: years, field: HISTORY_YEARS_FIELD },
  ];
  (extraction.floodLosses ?? []).forEach((loss, index) => {
    for (const field of LOSS_FIELDS) {
      out.push({ id: `loss:${index}:${field.key}`, ref: { scope: "loss", index, key: field.key }, label: lossFieldLabel(index, field.key), value: fieldText(loss[field.key].value, field), quoted: loss[field.key], field });
    }
  });
  return out;
}

/** The box for a loss history value, by its reference. null for any other value: ROW_FIELDS and TERM_FIELDS hold those. */
export function historyFieldDef(ref: ValueRef): FieldDef<string> | null {
  if (ref.scope === "terms" && ref.key === "floodHistoryYears") return HISTORY_YEARS_FIELD;
  if (ref.scope === "loss") return LOSS_FIELDS.find((f) => f.key === ref.key) ?? null;
  return null;
}

/** The field's name for a table: the label with any unit in brackets left off. */
export const fieldLabel = (field: FieldDef<string>): string => field.plain ?? field.label.replace(/\s*\([^)]*\)$/, "");

/** A value as text with its unit, for a table or a sentence. "" when there is no value. */
export function fieldText(value: string | number | null, field: FieldDef<string>): string {
  if (value === null) return "";
  if (typeof value !== "number") return field.choices?.find((c) => c.value === value)?.label ?? value;
  if (!Number.isFinite(value)) return "";
  switch (field.kind) {
    case "degrees":
      return String(Number(value.toFixed(6)));
    case "kes":
      return `KES ${fmtInt(value)}`;
    case "area":
      return `${value.toLocaleString("en-KE", { maximumFractionDigits: 1 })} m²`;
    case "percent":
      return `${fmtNum(value, 2)}%`;
    case "metres":
      return fmtDistance(value);
    case "year":
      // A year takes no thousands separator: "2018", never "2,018".
      return String(value);
    case "years":
      return `${fmtNum(value, 1)} ${value === 1 ? "year" : "years"}`;
    default:
      return value.toLocaleString("en-KE", { maximumFractionDigits: 6 });
  }
}
