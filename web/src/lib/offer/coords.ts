import type { CoordinateHow, DescribeReading, InKenya, ParseCoordinates } from "./types";

/**
 * Latitude and longitude as a broker writes them. The direction of each number is read from
 * what is on the page, a hemisphere letter or a minus sign, and the reading records which.
 * Nothing here assumes a hemisphere from where Kenya is.
 */

// A box around Kenya with a margin of about 0.2 degrees. The country runs from about 4.7°S
// (the coast at the Tanzanian border) to 5.5°N (the Ilemi triangle), and from 33.9°E (Lake
// Victoria) to 41.9°E (the Somali border).
const KENYA = { south: -4.9, north: 5.7, west: 33.7, east: 42.1 };

export const inKenya: InKenya = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) && lat >= KENYA.south && lat <= KENYA.north && lon >= KENYA.west && lon <= KENYA.east;

type Letter = "N" | "S" | "E" | "W";
type Axis = "lat" | "lon";

/** One number that could be half of a pair, with the marks written around it. */
interface Token {
  start: number;
  end: number;
  /** Decimal degrees, always positive: the direction is in minus and letter. */
  degrees: number;
  minus: boolean;
  letter: Letter | null;
  /** Set by a letter, or by the word latitude or longitude in front of the number. */
  axis: Axis | null;
  /** Digits after the decimal point, or 9 for degrees and minutes, which only a coordinate uses. */
  decimals: number;
}

// A hyphen, the minus sign proper, and the short dash a word processor swaps a hyphen for.
const MINUS = "-\u2212\u2013";

// An amount with thousands separators is matched whole so its pieces are never taken for coordinates.
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

const DIRECTION = "N|S|E|W|[Nn]orth|[Ss]outh|[Ee]ast|[Ww]est";
// In front of the number: "S 1.2921" or "South 1.2921". The letter must stand alone.
const LETTER_BEFORE = new RegExp(`(?:^|[^A-Za-z])(${DIRECTION})\\.?[ \\t]{0,2}$`);
// The same letter written against the number: "S1.2921".
const LETTER_TOUCHING = new RegExp(`(?:^|[^A-Za-z])(?:${DIRECTION})$`);
// The word in front of the number: "Latitude: 1.2921", "Lon = 36.82".
const AXIS_BEFORE = /(?:^|[^A-Za-z])(lat(?:itude)?|lon(?:g(?:itude)?)?)\.?\s{0,2}[:=]?\s{0,2}$/i;
// After the number: a degree sign, then perhaps minutes and seconds.
const DEGREE_MARK = /^\s{0,2}(?:[°\u00ba\u02da]|deg(?:rees)?\b\.?)/;
const MINUTES = /^\s{0,2}(\d{1,2}(?:\.\d+)?)\s{0,2}['\u2032\u2019]/;
const SECONDS = /^\s{0,2}(\d{1,2}(?:\.\d+)?)\s{0,2}(?:"|\u2033|\u201d|'')/;
const LETTER_AFTER = new RegExp(`^\\s{0,2}(${DIRECTION})(?![A-Za-z])`);
// What may stand between the two numbers of a pair.
const BETWEEN = /^[\s,;/|]{0,6}(?:and\s{1,2})?$/;

const letterOf = (word: string) => word[0].toUpperCase() as Letter;
const axisOfLetter = (letter: Letter): Axis => (letter === "N" || letter === "S" ? "lat" : "lon");

/** Every number in the text that could be a coordinate, with its sign, letter and label. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  let resumeAt = 0;
  for (const match of text.matchAll(NUMBER)) {
    const at = match.index ?? 0;
    // Minutes and seconds already taken by the number before.
    if (at < resumeAt) continue;
    const written = match[0];
    const dot = written.indexOf(".");
    // More than three whole digits, or a thousands separator, is an amount.
    if (written.includes(",") || (dot === -1 ? written.length : dot) > 3) continue;
    // "A12.5" and "v1.2921" are codes, not numbers standing on their own.
    if (at > 0 && /[A-Za-z0-9.]/.test(text[at - 1]) && !LETTER_TOUCHING.test(text.slice(Math.max(resumeAt, at - 6), at))) continue;

    let start = at;
    // A minus counts only when it touches the number and nothing is joined to it on the left,
    // so the hyphen in "2019-2023" or "Plot 12-3" is not read as a sign.
    const minus = at > 0 && MINUS.includes(text[at - 1]) && (at === 1 || !/[A-Za-z0-9]/.test(text[at - 2]));
    if (minus) start = at - 1;
    else if (at > 0 && text[at - 1] === "+") start = at - 1;

    // Only the text since the number before is looked at, so a letter that closed one
    // number is not read again as the opening of the next.
    const before = (from: number) => text.slice(Math.max(resumeAt, from - 16), from);
    let letter: Letter | null = null;
    let axis: Axis | null = null;
    const lead = LETTER_BEFORE.exec(before(start));
    if (lead) {
      letter = letterOf(lead[1]);
      start -= before(start).length - before(start).lastIndexOf(lead[1]);
    }
    const label = AXIS_BEFORE.exec(before(start));
    if (label) {
      axis = label[1].toLowerCase().startsWith("lat") ? "lat" : "lon";
      start -= before(start).length - before(start).lastIndexOf(label[1]);
    }

    let end = at + written.length;
    let degrees = Number(written);
    let decimals = dot === -1 ? 0 : written.length - dot - 1;
    const mark = DEGREE_MARK.exec(text.slice(end));
    if (mark) {
      end += mark[0].length;
      const minutes = MINUTES.exec(text.slice(end));
      if (minutes && Number(minutes[1]) < 60) {
        end += minutes[0].length;
        degrees += Number(minutes[1]) / 60;
        decimals = 9;
        const seconds = SECONDS.exec(text.slice(end));
        if (seconds && Number(seconds[1]) < 60) {
          end += seconds[0].length;
          degrees += Number(seconds[1]) / 3600;
        }
      }
    }
    // A letter in front wins: in "S 1.2921 E 36.8219" the E belongs to the second number.
    if (!letter) {
      const trail = LETTER_AFTER.exec(text.slice(end));
      if (trail) {
        letter = letterOf(trail[1]);
        end += trail[0].length;
      }
    }
    if (letter) axis = axisOfLetter(letter);
    resumeAt = end;
    out.push({ start, end, degrees, minus, letter, axis, decimals });
  }
  return out;
}

function howOf(token: Token): CoordinateHow {
  if (!token.letter) return "sign";
  if (!token.minus) return "hemisphere";
  return token.letter === "S" || token.letter === "W" ? "both_agree" : "both_conflict";
}

// The letter decides whenever one is written. Without a letter the sign does.
const signed = (token: Token) => (token.letter ? (token.letter === "S" || token.letter === "W" ? -token.degrees : token.degrees) : token.minus ? -token.degrees : token.degrees);

/**
 * Whether two neighbouring numbers are a latitude and a longitude, and which is which.
 * The fewer marks a pair carries, the more its numbers must look like coordinates, so that
 * "3 floors, 2 basements" or "KES 4.5, 3.25" is not read as a place.
 */
function asPair(a: Token, b: Token): { lat: Token; lon: Token } | null {
  if (a.axis && b.axis && a.axis === b.axis) return null;
  const marked = (a.axis ? 1 : 0) + (b.axis ? 1 : 0);
  const fewest = Math.min(a.axis ? 9 : a.decimals, b.axis ? 9 : b.decimals);
  if (marked === 0 && fewest < 3) return null;
  if (marked === 1 && fewest < 2) return null;
  // Latitude first when nothing says otherwise: the order every memo and map service uses.
  const aIsLat = a.axis ? a.axis === "lat" : b.axis ? b.axis === "lon" : true;
  const lat = aIsLat ? a : b;
  const lon = aIsLat ? b : a;
  if (lat.degrees > 90 || lon.degrees > 180) return null;
  return { lat, lon };
}

export const parseCoordinates: ParseCoordinates = (text) => {
  const found = tokens(text);
  for (let i = 0; i + 1 < found.length; i++) {
    const a = found[i];
    const b = found[i + 1];
    if (!BETWEEN.test(text.slice(a.end, b.start))) continue;
    const pair = asPair(a, b);
    if (!pair) continue;
    const latHow = howOf(pair.lat);
    const lonHow = howOf(pair.lon);
    return {
      lat: signed(pair.lat),
      lon: signed(pair.lon),
      latHow,
      lonHow,
      raw: text.slice(a.start, b.end),
      writtenBothWays: [latHow, lonHow].some((how) => how === "both_agree" || how === "both_conflict"),
      conflict: latHow === "both_conflict" || lonHow === "both_conflict",
    };
  }
  return null;
};

const HOW_WORDS: Record<CoordinateHow, string> = {
  hemisphere: "by its letter",
  sign: "by its sign",
  both_agree: "by its letter, with a minus sign that says the same",
  both_conflict: "by its letter, although a minus sign says the opposite",
};

/** "1.2921° S (by its letter, with a minus sign that says the same), 36.8219° E (by its letter)". For the screen and for reasons. */
export const describeReading: DescribeReading = (reading) => {
  const part = (value: number, how: CoordinateHow, positive: string, negative: string) => `${Number(Math.abs(value).toFixed(5))}° ${value < 0 ? negative : positive} (${HOW_WORDS[how]})`;
  return `${part(reading.lat, reading.latHow, "N", "S")}, ${part(reading.lon, reading.lonHow, "E", "W")}`;
};
