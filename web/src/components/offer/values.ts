import { kes1, rpWithChance } from "@/lib/labels";
import { BELOW_GROUND_TITLE, DRIVER_GROUPS, fieldDefOf, HISTORY_TITLE, TERM_GROUPS, type FieldKind } from "@/lib/offer/fields";
import type { FocusBuilding, FocusField } from "@/lib/offer/focus";
import { fmtDistance } from "@/lib/offer/shared";

/**
 * What the step shows of the values read from an offer, worked out from the focus's flat list of fields.
 *
 * How to use it:
 *   const groups = valueGroups(focus.fields, focus.extraction.rows.length);
 *   const counts = countValues(groups);          // the one count the whole step quotes
 *   groupOpenAtFirst(group)                      // whether a group starts unfolded
 *   rightColumnFrom(groups)                      // where to cut the groups into two columns
 *
 * Nothing here reads a document or works out a figure: the values, their statuses and their
 * sentences all come ready from lib/offer/focus.
 */

// ---------------------------------------------------------------------------------------------
// One value in its box
// ---------------------------------------------------------------------------------------------

/** The value as it sits in its box: digits the underwriter can type over. */
export function boxText(value: string | number | null, kind: FieldKind): string {
  if (value === null) return "";
  if (typeof value !== "number") return value;
  if (kind === "degrees") return String(Number(value.toFixed(6)));
  // A year takes no thousands separator: "2018", never "2,018".
  if (kind === "year") return String(value);
  return value.toLocaleString("en-KE", { maximumFractionDigits: 6 });
}

/** The same value in the short form used across the app, shown under the name of a long figure. */
export function plainer(value: string | number | null, kind: FieldKind): string | null {
  if (typeof value !== "number") return null;
  if (kind === "kes" && Math.abs(value) >= 1e6) return kes1(value);
  if (kind === "metres" && value >= 1000) return fmtDistance(value);
  // A return period is typed as a number of years and read back as every return period in the app is written.
  if (kind === "returnPeriod" && value > 0) return rpWithChance(value);
  return null;
}

/** What a box asks for, in the words shown when a typed value is refused. */
export function wantedFor(kind: FieldKind): string {
  if (kind === "degrees") return "a number of degrees, such as -1.2921";
  if (kind === "text") return "text";
  if (kind === "year") return "a year as four digits, such as 2018";
  if (kind === "returnPeriod") return "a number of years, such as 50";
  if (kind === "depth") return "a number of metres, such as 7.5";
  return "a number of zero or more, such as 8,000,000";
}

/**
 * The few values whose box could be misread without a word on its sign or its unit, by the key of
 * the value. Every other value is said by its name and the unit in it.
 */
const BOX_HINTS: Record<string, string> = {
  lat: "South is negative",
  lon: "East is positive",
  basements: "0 means none",
  basementDepthM: "Metres below ground",
  drainDesignRp: "50 means a 1-in-50 year storm",
};

/** The short clause under a value's name: its hint, and a long figure in the short form. null when there is neither. */
export function helperOf(field: FocusField): string | null {
  const def = fieldDefOf(field.ref);
  if (!def) return null;
  const hint = field.ref.scope === "row" || field.ref.scope === "terms" ? BOX_HINTS[field.ref.key] : undefined;
  return [plainer(field.raw, def.kind), hint].filter(Boolean).join(" · ") || null;
}

/**
 * The name over a value's box, with its unit: "Floor area (m²)", "Past flood loss 1: amount (KES)".
 * A building's value and an offer-level one take the name the field list gives the box; a past
 * loss and an item of equipment carry their number, so they keep the name the focus gives them.
 */
export function boxLabel(field: FocusField): string {
  const def = fieldDefOf(field.ref);
  if (!def) return field.label;
  if (field.ref.scope === "row" || (field.ref.scope === "terms" && field.ref.key !== "floodHistoryYears")) return def.label;
  return def.kind === "kes" ? `${field.label} (KES)` : field.label;
}

/** A value's name inside a sentence: "cost per m²", "insured value". */
export const nameInLine = (field: FocusField): string => (field.label ? field.label[0].toLowerCase() + field.label.slice(1) : field.label);

// ---------------------------------------------------------------------------------------------
// The groups
// ---------------------------------------------------------------------------------------------

/** One group of values, as the field list defines it: a building's row, the flood terms, the value split and so on. */
export interface ValueGroup {
  /** Stable for as long as the offer is on screen: "row:0", "terms:Flood terms", "history", "notes". */
  key: string;
  title: string;
  /** True for a building's own row. It starts unfolded whatever its values say. */
  building: boolean;
  /** Every value of the group, stated or not, in the order of the field list. */
  fields: FocusField[];
  /** The values the document states or the underwriter set: each is drawn as a row. */
  stated: FocusField[];
  /** The values the document does not state: each is offered by name, not drawn as an empty box. */
  missing: FocusField[];
  /** How many stated values code could not check. */
  toCheck: number;
}

/**
 * The offer-level values in the order the screen shows them: the flood terms and the building first,
 * then what the loss drivers read (value split, below ground, drainage and protection, cover and premium).
 */
const TERM_SECTIONS: { title: string; keys: string[] }[] = [
  ...TERM_GROUPS.map((g) => ({ title: g.title, keys: g.fields.map((x) => x.key as string) })),
  ...["Value split", BELOW_GROUND_TITLE, "Drainage and protection", "Cover and premium"].flatMap((title) => {
    const group = DRIVER_GROUPS.find((g) => g.title === title);
    return group ? [{ title, keys: group.fields.map((x) => x.key as string) }] : [];
  }),
];

/** The heading the flood notes stand under. */
const NOTES_TITLE = "Flood notes from the document";

/**
 * Every value of the offer, group by group. `buildings` is how many insured buildings were read.
 * The notes have a group only when the document holds one: a note is a remark, not a value to ask for.
 */
export function valueGroups(fields: FocusField[], buildings: number): ValueGroup[] {
  const byId = new Map(fields.map((x) => [x.id, x]));
  const group = (key: string, title: string, own: FocusField[], building = false): ValueGroup => {
    // A note or an item of equipment that was cleared has no name to ask for: it is simply gone.
    const kept = own.filter((x) => x.status !== "missing" || (x.group !== "note" && x.ref.scope !== "equipment"));
    const stated = kept.filter((x) => x.status !== "missing");
    return { key, title, building, fields: kept, stated, missing: kept.filter((x) => x.status === "missing"), toCheck: stated.filter((x) => x.status === "unverified").length };
  };
  const out: ValueGroup[] = [];
  for (let i = 0; i < buildings; i++) {
    out.push(group(`row:${i}`, buildings > 1 ? `Building ${i + 1}` : "The insured building", fields.filter((x) => x.row === i), true));
  }
  for (const { title, keys } of TERM_SECTIONS) {
    const own = keys.flatMap((key) => byId.get(`terms:${key}`) ?? []);
    // The equipment below ground follows the two values of its group, item by item.
    if (title === BELOW_GROUND_TITLE) own.push(...fields.filter((x) => x.ref.scope === "equipment"));
    out.push(group(`terms:${title}`, title, own));
  }
  out.push(group("history", HISTORY_TITLE, fields.filter((x) => x.ref.scope === "loss" || x.id === "terms:floodHistoryYears")));
  const notes = group("notes", NOTES_TITLE, fields.filter((x) => x.group === "note"));
  if (notes.stated.length > 0) out.push(notes);
  return out;
}

/** How the values of an offer stand, counted over the groups on screen. */
export interface ValueCounts {
  /** Values the document states or the underwriter set. */
  read: number;
  verified: number;
  /** Values code could not check: each waits for the underwriter. */
  toCheck: number;
  /** Values the underwriter confirmed or typed. */
  byYou: number;
  /** Values the document does not state. */
  notStated: number;
}

export function countValues(groups: ValueGroup[]): ValueCounts {
  const stated = groups.flatMap((g) => g.stated);
  const verified = stated.filter((x) => x.status === "verified").length;
  const toCheck = stated.filter((x) => x.status === "unverified").length;
  return { read: stated.length, verified, toCheck, byYou: stated.length - verified - toCheck, notStated: groups.reduce((n, g) => n + g.missing.length, 0) };
}

/** A group starts unfolded when it is a building's row, or when any of its values is not simply verified. */
export const groupOpenAtFirst = (group: ValueGroup): boolean => group.building || group.stated.some((x) => x.status !== "verified");

/** The group's state in a few words, for its heading: "7 values, 1 to check". */
export function groupSummary(group: ValueGroup, folded: boolean): string {
  const n = group.stated.length;
  // A group the document says nothing of: its count of values not stated says so by itself.
  if (n === 0) return folded && group.missing.length > 0 ? `${group.missing.length} not stated` : "nothing stated";
  const parts = [`${n} ${n === 1 ? "value" : "values"}`];
  if (group.toCheck > 0) parts.push(`${group.toCheck} to check`);
  else if (n > 0 && group.stated.every((x) => x.status === "verified")) parts.push("all verified");
  // Unfolded, the group names what is not stated itself.
  if (folded && group.missing.length > 0) parts.push(`${group.missing.length} not stated`);
  return parts.join(", ");
}

/**
 * The key of the first group of the right-hand column when the groups stand in two columns, so the
 * two are about the same length as they first appear. null when everything belongs in one column.
 */
export function rightColumnFrom(groups: ValueGroup[]): string | null {
  const lines = groups.map((g) => 2 + (groupOpenAtFirst(g) ? g.stated.length + (g.missing.length > 0 ? 1 : 0) : 0));
  const total = lines.reduce((a, b) => a + b, 0);
  let run = 0;
  let cut = groups.length;
  let gap = Infinity;
  lines.forEach((n, i) => {
    run += n;
    const now = Math.abs(total - 2 * run);
    if (now < gap) {
      gap = now;
      cut = i + 1;
    }
  });
  return groups[cut]?.key ?? null;
}

// ---------------------------------------------------------------------------------------------
// Where the building is, in a clause
// ---------------------------------------------------------------------------------------------

/** How the building's position was read, in a short clause. The full sentence is FocusBuilding.locationHow. */
export function positionClause(building: FocusBuilding): string {
  const { location } = building;
  if (location.kind === "none") return "not located";
  if (location.kind === "approximate") return `placed at ${building.standIn ?? "a named place"}, with no usable coordinates`;
  return location.reading ? "position read from the coordinates in the document" : "position typed by you";
}

/** The building's class and where it is, in one line: "Concrete / RCC · Kilimani ward, Dagoretti North · position read from ...". */
export function buildingFacts(building: FocusBuilding): string {
  const ward = building.ward ? `${building.ward.name} ward${building.ward.subcounty ? `, ${building.ward.subcounty}` : ""}` : null;
  return [building.housingLabel, ward, positionClause(building)].filter(Boolean).join(" · ");
}
