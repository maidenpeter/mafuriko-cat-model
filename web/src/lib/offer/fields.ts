import { fmtInt, fmtNum } from "../format";
import { HOUSING_CLASSES, HOUSING_LABELS } from "../model/types";
import { fmtDistance } from "./shared";
import type { OfferRowValues, OfferTerms } from "./types";

/**
 * Every value of an offer that is shown on screen: its name, the kind of thing it holds and the
 * order it appears in. One list, so a value is called the same thing in the boxes of the Read the
 * offer step, in the table of fields, in the list of values pricing waits for and in the checks.
 *
 * How to use it:
 *   ROW_FIELDS      the values of one building, in the exposure file's order
 *   TERM_GROUPS     the offer-level values, in the two groups the screen shows
 *   TERM_FIELDS     the same values as one flat list
 *   fieldLabel(f)   the name without its unit in brackets, for a table that shows the unit in the value
 *   fieldText(v, f) the value as text with its unit: "KES 4,250,000,000", "48,500 m²", "5%", "1.8 km"
 */

export type FieldKind = "text" | "degrees" | "kes" | "area" | "percent" | "count" | "metres" | "choice";

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

export const TERM_GROUPS: { title: string; fields: FieldDef<keyof OfferTerms>[] }[] = [
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
    default:
      return value.toLocaleString("en-KE", { maximumFractionDigits: 6 });
  }
}
