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
 *   LOSS_MODE_LABELS    "Depth only", "All loss drivers"  the two settings of the header switch "Losses from"
 *   selectMode(mode)    'Select All loss drivers under "Losses from" in the bar above'  the one way to point at that switch
 *   shareText(0.125)    "12.5%", shareText(0.08) "8%"  a share inside a sentence that shows its arithmetic
 *   perMille(8.02)      "8.02 per mille"              every rate per mille of the insured value
 *   PORTFOLIO_DRIVERS_LINE  the one sentence on which loss drivers the portfolio carries
 *   SETTER_WORDS        who set a figure, in a short form, a sentence form and a counted form
 *   EP_HELP             the one line of help under the exceedance curve
 *   axisTicks(max)      round tick values from zero   used by BarChart and Waterfall
 *   wrapLabel(text, n)  lines of at most n characters used for labels drawn inside SVG
 */

import { fmtNum } from "./format";
import type { LossMode } from "./model/drivers";

/** The two settings of the header switch "Losses from", in its own words. The one place they are written. */
export const LOSS_MODE_LABELS: Record<LossMode, string> = { depth_only: "Depth only", all_drivers: "All loss drivers" };

/** How every screen points at the header switch: the mode by its own name, never in quotes, and the switch by its tag. */
export const selectMode = (mode: LossMode): string => `Select ${LOSS_MODE_LABELS[mode]} under "Losses from" in the bar above`;

/**
 * Which loss drivers the portfolio carries, and why not the other two. The one sentence for it:
 * shown once on screen, on the Loss engine's portfolio view, and once in each record, and nowhere else.
 */
export const PORTFOLIO_DRIVERS_LINE =
  "The portfolio carries Surrounding flooding, Drainage ponding and Drain overload. Basement ingress and Business interruption are not modelled for it, because the synthetic portfolio has no basement or rent data.";

/**
 * A share as it is quoted in a sentence that shows its arithmetic: one decimal, trailing zeros
 * dropped, so 0.125 reads "12.5%" and 0.08 reads "8%" and the sentence reproduces the figure beside it.
 */
export const shareText = (fraction: number): string => `${fmtNum(fraction * 100, 1)}%`;

/** A rate per mille of the insured value: two decimals, four when it is under 0.1 so a small rate never reads as nothing. */
export function perMille(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${fmtNum(value, value !== 0 && Math.abs(value) < 0.1 ? 4 : 2)} per mille`;
}

/** Who set a figure: the offer document, the agents, the underwriter on screen, or the reference set. "not recorded" only in a record made without the screen's own note of it. */
export type SetterKind = "offer" | "agents" | "typed" | "reference" | "not recorded";

/**
 * The words for who set a figure, the one table every screen and record reads:
 *   short     a table cell or a tag            "Agents"
 *   sentence  after "set by" or "Set by:"      "agreed by the agents"
 *   counted   after a count, or as a heading   "agreed by the agents" (3 agreed by the agents)
 */
export const SETTER_WORDS: Record<SetterKind, { short: string; sentence: string; counted: string }> = {
  offer: { short: "Offer", sentence: "read from the offer", counted: "from the offer" },
  agents: { short: "Agents", sentence: "agreed by the agents", counted: "agreed by the agents" },
  typed: { short: "Typed", sentence: "typed by the underwriter", counted: "typed by the underwriter" },
  reference: { short: "Reference", sentence: "the reference value", counted: "reference values" },
  "not recorded": { short: "Not recorded", sentence: "not recorded", counted: "not recorded" },
};

/** The order setters are listed in, wherever more than one is named. */
export const SETTER_ORDER: readonly SetterKind[] = ["offer", "agents", "typed", "reference", "not recorded"];

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
