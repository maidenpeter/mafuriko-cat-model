/**
 * Agent text as this app shows it. A model writes en and em dashes, in ranges of numbers and between words;
 * this app does not show them. A dash between two numbers is a range and reads "to"; a dash set
 * between words with spaces is a pause and becomes a comma; any other becomes a hyphen. Applied
 * where a reply enters the app (a live reply, a replayed run) and when a run is packed to ship.
 * The same three rules are written again in scripts/pack-run.mjs, which is plain Node.
 */

// The two code points, U+2013 and U+2014, built by number so that this file holds neither.
const DASH = `[${String.fromCharCode(0x2013, 0x2014)}]`;
const RANGE = new RegExp(`(\\d)\\s*${DASH}\\s*(?=\\d)`, "g");
const PAUSE = new RegExp(`\\s+${DASH}\\s+`, "g");
const ANY = new RegExp(DASH, "g");

/** One text with no en or em dash: "0 to 1", "9.97 to 10.05". */
export function plainDashes(text: string): string {
  return text.replace(RANGE, "$1 to ").replace(PAUSE, ", ").replace(ANY, "-");
}

/** The same for every text inside a value: a reply as an object, or its raw text. Numbers and the rest are left as they are. */
export function plainDashesDeep<T>(value: T): T {
  if (typeof value === "string") return plainDashes(value) as T;
  if (Array.isArray(value)) return value.map((v) => plainDashesDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plainDashesDeep(v)])) as T;
  }
  return value;
}
