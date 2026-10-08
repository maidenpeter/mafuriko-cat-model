import { fmtInt, fmtNum } from "../format";

/**
 * Small pieces every file in lib/offer and the offer screen share, kept in one place so a
 * distance, a point or a scale word reads the same wherever it appears.
 */

/** "1 value", "3 values". */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** "850 m", "1.8 km". */
export const fmtDistance = (m: number) => (m < 1000 ? `${fmtInt(m)} m` : `${fmtNum(m / 1000, 1)} km`);

/** "1.2921° S, 36.8219° E". */
export const fmtPoint = (lat: number, lon: number) => `${fmtNum(Math.abs(lat), 5)}° ${lat < 0 ? "S" : "N"}, ${fmtNum(Math.abs(lon), 5)}° ${lon < 0 ? "W" : "E"}`;

/** Scale words and letters after an amount of money. */
export const MONEY_SCALES: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, mio: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9 };

/** A distance is held in metres, so "1.8 km" is 1800. */
export const DISTANCE_SCALES: Record<string, number> = { km: 1e3, kilometre: 1e3, kilometres: 1e3, kilometer: 1e3, kilometers: 1e3 };
