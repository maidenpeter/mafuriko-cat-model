/** Shared between the map and its legend. Kept apart from RiskMap so the legend can render without loading the map library. */

export type LayerKey = "hazard" | "buildings" | "wards" | "waterways" | "settlements" | "facilities" | "hotspots";
export type LayerState = Record<LayerKey, boolean>;
export type WardMetric = "loss" | "tiv" | "flooded" | "lossRatio";
export type Selection = { type: "building"; index: number } | { type: "ward"; index: number };
export type BasemapStatus = "loading" | "online" | "offline";

export const WATER_COLORS = { river: "#2f7ed8", stream: "#5fa2e6", canal: "#2ba0a8", drain: "#14a38b", ditch: "#14a38b" } as const;
export const FACILITY_COLORS = { hospital: "#d11242", clinic: "#e8577a", school: "#d9921a", police: "#3b5ba9", fire_station: "#f26b1d" } as const;
export const SETTLEMENT_COLOR = "#7b4fb8";
export const WARD_COLOR = "#d11242";

export const WARD_METRICS: { value: WardMetric; label: string }[] = [
  { value: "loss", label: "Loss" },
  { value: "tiv", label: "Insured value" },
  { value: "flooded", label: "Buildings flooded" },
  { value: "lossRatio", label: "Loss as % of value" },
];
