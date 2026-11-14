const countFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return countFormat.format(Math.round(value));
}

/** "2.4×" or "0.6×"; a ratio reads better than a signed percentage for skewed counts. */
export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  return `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}×`;
}

export function formatSigned(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  return rounded > 0 ? `+${countFormat.format(rounded)}` : countFormat.format(rounded);
}

export type Coverage = "observed" | "bridged" | "modeled";

/** Collapses the model's source codes into the three coverage levels the calendar shows. */
export function coverageOf(source: string): Coverage {
  if (source === "observed") return "observed";
  if (source === "bridged") return "bridged";
  return "modeled";
}

export const SOURCE_LABELS: Record<string, string> = {
  observed: "Observed by VIIRS",
  bridged: "Bridged: NOAA-20 standing in for Suomi NPP",
  modeled_terra_aqua: "Modeled from MODIS Terra + Aqua",
  modeled_terra: "Modeled from MODIS Terra",
};

export const COVERAGE_LABELS: Record<Coverage, string> = {
  observed: "Observed",
  bridged: "Bridged",
  modeled: "Modeled",
};

const UNIT_LABELS = {
  hotspots: { one: "hotspot", many: "hotspots", toggle: "Hotspots" },
  cell_days: { one: "fire cell-day", many: "fire cell-days", toggle: "Cell-days" },
} as const;

export function unitLabel(unit: keyof typeof UNIT_LABELS, form: "one" | "many" | "toggle" = "many"): string {
  return UNIT_LABELS[unit][form];
}

/** Satellite names as the model writes them, spelled out for people. */
export const SATELLITE_NAMES: Record<string, string> = {
  SNPP: "Suomi NPP",
  NOAA20: "NOAA-20",
  NOAA21: "NOAA-21",
};
