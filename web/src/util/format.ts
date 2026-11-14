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

export const SOURCE_LABELS: Record<string, string> = {
  observed: "Observed by VIIRS",
  modeled_terra_aqua: "Modeled from MODIS Terra + Aqua",
  modeled_terra: "Modeled from MODIS Terra",
};
