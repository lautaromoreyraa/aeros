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

/** "23.4° S, 61.2° W" for a [lng, lat] point. */
export function formatPlace([lng, lat]: [number, number]): string {
  return `${Math.abs(lat).toFixed(1)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lng).toFixed(1)}° ${lng < 0 ? "W" : "E"}`;
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

export const SOURCE_LABELS_ES: Record<string, string> = {
  observed: "Observado por VIIRS",
  bridged: "Puenteado: NOAA-20 en reemplazo de Suomi NPP",
  modeled_terra_aqua: "Modelado a partir de MODIS Terra + Aqua",
  modeled_terra: "Modelado a partir de MODIS Terra",
};

export function sourceLabel(source: string, locale: "en" | "es" = "en"): string {
  return (locale === "es" ? SOURCE_LABELS_ES : SOURCE_LABELS)[source] ?? source;
}

export const COVERAGE_LABELS: Record<Coverage, string> = {
  observed: "Observed",
  bridged: "Bridged",
  modeled: "Modeled",
};

export const COVERAGE_LABELS_ES: Record<Coverage, string> = {
  observed: "Observado",
  bridged: "Puenteado",
  modeled: "Modelado",
};

export function coverageLabel(coverage: Coverage, locale: "en" | "es" = "en"): string {
  return (locale === "es" ? COVERAGE_LABELS_ES : COVERAGE_LABELS)[coverage];
}

const UNIT_LABELS = {
  hotspots: { one: "hotspot", many: "hotspots", toggle: "Hotspots" },
  cell_days: { one: "fire cell-day", many: "fire cell-days", toggle: "Cell-days" },
} as const;

const UNIT_LABELS_ES = {
  hotspots: { one: "foco de calor", many: "focos de calor", toggle: "Focos" },
  cell_days: { one: "día-celda de fuego", many: "días-celda de fuego", toggle: "Días-celda" },
} as const;

export function unitLabel(
  unit: keyof typeof UNIT_LABELS,
  form: "one" | "many" | "toggle" = "many",
  locale: "en" | "es" = "en",
): string {
  return (locale === "es" ? UNIT_LABELS_ES : UNIT_LABELS)[unit][form];
}

/** Satellite names as the model writes them, spelled out for people. */
export const SATELLITE_NAMES: Record<string, string> = {
  SNPP: "Suomi NPP",
  NOAA20: "NOAA-20",
  NOAA21: "NOAA-21",
};
