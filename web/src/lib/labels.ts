/**
 * The wording every chart and headline figure shares, so a return period, an amount in
 * shillings or a source badge reads the same on every screen. Pure functions, no React.
 *
 * How to use it:
 *   rpLabel(100)        "1-in-100"
 *   annualChance(100)   "1% a year"
 *   rpWithChance(100)   "1-in-100 (1% a year)"       axis ticks, tooltips, table headers
 *   kes1(4_200_000_000) "KES 4.2bn"                   every amount on a chart or a figure
 *   pct1(0.125)         "12.5%"                       takes a fraction, like fmtPct
 *   SOURCE_LABELS.real  "Real data"                   the word on a source badge
 *   EP_HELP             the one line of help under the exceedance curve
 *   axisTicks(max)      round tick values from zero   used by BarChart and Waterfall
 *   wrapLabel(text, n)  lines of at most n characters used for labels drawn inside SVG
 */

/** "1-in-100". Whole years are written whole; anything else keeps up to two decimals. */
export function rpLabel(returnPeriod: number): string {
  if (!Number.isFinite(returnPeriod) || returnPeriod <= 0) return "n/a";
  return `1-in-${trimZeros(returnPeriod.toFixed(2))}`;
}

/**
 * The chance of the return period being exceeded in any one year: 100 gives "1% a year".
 * One decimal is kept where it says something (250 gives "0.4% a year", 8 gives "12.5% a year").
 * Very long return periods keep one significant figure, so they never read as "0% a year".
 */
export function annualChance(returnPeriod: number): string {
  if (!Number.isFinite(returnPeriod) || returnPeriod <= 0) return "n/a";
  const pct = 100 / returnPeriod;
  // 0.095 and up rounds to 0.1 or more at one decimal. Below that, one decimal would round to nothing.
  const digits = pct >= 0.095 ? 1 : Math.min(6, Math.ceil(-Math.log10(pct) - 1e-9));
  return `${trimZeros(pct.toFixed(digits))}% a year`;
}

/** "1-in-100 (1% a year)": the return period with its annual chance beside it. */
export function rpWithChance(returnPeriod: number): string {
  if (!Number.isFinite(returnPeriod) || returnPeriod <= 0) return "n/a";
  return `${rpLabel(returnPeriod)} (${annualChance(returnPeriod)})`;
}

const KES_UNITS = [
  { divisor: 1e3, suffix: "k" },
  { divisor: 1e6, suffix: "m" },
  { divisor: 1e9, suffix: "bn" },
];

/**
 * Shillings with exactly one decimal: "KES 4.2bn", "KES 213.9m", "KES 50.0k", and whole
 * shillings below a thousand ("KES 950"). A negative amount carries a minus sign in front
 * ("-KES 4.2bn"), which is how a waterfall labels what is taken off.
 */
export function kes1(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  let text = "0";
  if (Math.round(abs) < 1000) {
    text = String(Math.round(abs));
  } else {
    for (let i = 0; i < KES_UNITS.length; i++) {
      const { divisor, suffix } = KES_UNITS[i];
      const scaled = (abs / divisor).toFixed(1);
      text = `${scaled}${suffix}`;
      // 999,960 would print as "1000.0k"; it moves up to the next unit and reads "1.0m".
      if (Number(scaled) < 1000 || i === KES_UNITS.length - 1) break;
    }
  }
  // An amount that rounds to nothing is shown without a sign, never as "-KES 0".
  const sign = value < 0 && text !== "0" ? "-" : "";
  return `${sign}KES ${text}`;
}

/** A fraction as a percentage with exactly one decimal: 0.125 gives "12.5%", 1 gives "100.0%". */
export function pct1(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "n/a";
  const text = (fraction * 100).toFixed(1);
  return `${text === "-0.0" ? "0.0" : text}%`;
}

/**
 * Where a figure comes from. One of four, the same everywhere:
 * real (rasters, OSM, hotspots), synthetic (the portfolio), assumption (return periods,
 * depth scale, terms), ai (agent or extraction output).
 */
export type SourceKind = "real" | "synthetic" | "assumption" | "ai";

export const SOURCE_KINDS: readonly SourceKind[] = ["real", "synthetic", "assumption", "ai"];

/** The word on the badge. SourceBadge in ChartFrame.tsx draws it. */
export const SOURCE_LABELS: Record<SourceKind, string> = {
  real: "Real data",
  synthetic: "Synthetic",
  assumption: "Assumption",
  ai: "AI",
};

/** The one line of help that sits under the exceedance curve. */
export const EP_HELP = "Read across from a return period to the loss: a 1-in-100 loss has about a 1% chance of being exceeded in any year.";

/** Round tick values from zero up to the first one at or above max. The same steps LineChart uses. */
export function axisTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || !(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * (1 - 1e-9)) ?? raw;
  const ticks: number[] = [];
  // Counting steps, not adding them up, keeps 0.1 + 0.2 style drift out of the tick values.
  for (let i = 0; i * step < max + step * 0.999; i++) ticks.push(Number((i * step).toPrecision(12)));
  return ticks;
}

/**
 * Breaks a label into lines of at most maxChars characters, at spaces where it can, for text
 * drawn inside SVG (which does not wrap by itself). Text that does not fit in maxLines ends
 * in "…"; the caller shows the full label in a title or tooltip.
 */
export function wrapLabel(text: string, maxChars: number, maxLines = 2): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const lines: string[] = [];
  let line = "";
  for (let word of text.trim().split(/\s+/).filter(Boolean)) {
    // A single word longer than a line is cut across lines.
    for (;;) {
      const joined = line ? `${line} ${word}` : word;
      if (joined.length <= limit) {
        line = joined;
        break;
      }
      if (line) {
        lines.push(line);
        line = "";
      } else {
        lines.push(word.slice(0, limit));
        word = word.slice(limit);
        if (!word) break;
      }
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines.length ? lines : [""];
  const kept = lines.slice(0, Math.max(1, maxLines));
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = `${last.length >= limit ? last.slice(0, Math.max(0, limit - 1)) : last}…`;
  return kept;
}

/** "4.00" to "4", "0.40" to "0.4"; a figure with no decimal point is left alone. */
function trimZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
