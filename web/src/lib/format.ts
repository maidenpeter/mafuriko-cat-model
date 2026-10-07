/** KES 63.6bn, KES 4.2m, KES 85,000 */
export function fmtKes(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `KES ${(value / 1e9).toFixed(digits)}bn`;
  if (abs >= 1e6) return `KES ${(value / 1e6).toFixed(digits)}m`;
  return `KES ${Math.round(value).toLocaleString("en-KE")}`;
}

export const fmtInt = (value: number) => Math.round(value).toLocaleString("en-KE");

export const fmtPct = (fraction: number, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;

/** Fixed decimals with trailing zeros after the decimal point removed: 4.00 → "4", 0.70 → "0.7", 100 → "100". */
export function fmtNum(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "n/a";
  const fixed = value.toFixed(digits);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}
