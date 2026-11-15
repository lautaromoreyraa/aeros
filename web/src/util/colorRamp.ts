/**
 * Colour ramps for the calendar and the map. Viridis is perceptually uniform,
 * readable in greyscale and safe for the common colour-vision deficiencies;
 * the diverging ramp for anomalies runs blue → light grey → orange, which stays
 * distinguishable for deuteranopia and protanopia (unlike red/green).
 */

export type Rgb = [number, number, number];

/** Viridis sampled at nine evenly spaced stops (matplotlib values). */
export const VIRIDIS: Rgb[] = [
  [68, 1, 84],
  [71, 44, 122],
  [59, 81, 139],
  [44, 113, 142],
  [33, 144, 141],
  [39, 173, 129],
  [92, 200, 99],
  [170, 220, 50],
  [253, 231, 37],
];

/**
 * Near-black to violet, red, orange and pale yellow: the ramp of the terrain
 * design. It reads as heat on a dark map; on a light background viridis is
 * the safer choice, so it is opt-in per map.
 */
export const FIRE: Rgb[] = [
  [26, 16, 48],
  [50, 10, 94],
  [120, 28, 109],
  [188, 55, 84],
  [237, 105, 37],
  [251, 182, 26],
  [252, 255, 164],
];

/**
 * Bluish-white to yellow to red: no fire reads as near-white (neutral, calm),
 * low probability reads as yellow (attention without alarm), and confirmed or
 * high-probability fire reads as red (the universal danger signal). Intermediate
 * stops in orange bridge the two warm ends.
 */
export const BLAZE: Rgb[] = [
  [220, 230, 245],
  [253, 220, 40],
  [248, 160, 20],
  [238, 90, 20],
  [220, 30, 30],
];

/** Blue to orange through a neutral grey (PuOr-like, colour-blind safe). */
export const DIVERGING: Rgb[] = [
  [33, 102, 172],
  [103, 169, 207],
  [209, 229, 240],
  [232, 232, 232],
  [253, 219, 199],
  [244, 165, 130],
  [214, 96, 77],
];

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Linear interpolation along evenly spaced stops; `t` is clamped to [0, 1]. */
export function sampleRamp(stops: Rgb[], t: number): Rgb {
  const position = clamp01(t) * (stops.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(stops.length - 1, lower + 1);
  const fraction = position - lower;
  const a = stops[lower]!;
  const b = stops[upper]!;
  return [0, 1, 2].map((channel) => Math.round(a[channel]! + (b[channel]! - a[channel]!) * fraction)) as Rgb;
}

/**
 * Square-root scaling: hotspot counts are heavily skewed (a few months carry
 * most of the fire), and a linear ramp would paint almost every cell the same
 * dark purple.
 */
export function sqrtScale(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return clamp01(Math.sqrt(value / max));
}

/**
 * Anomaly ratio to [0, 1] on a log2 scale, so "half the usual" and "twice the
 * usual" sit at the same distance from the neutral middle. ±`span` doublings
 * saturate the ramp.
 */
export function ratioScale(ratio: number | null, span = 2): number {
  if (ratio === null || !Number.isFinite(ratio)) return 0.5;
  if (ratio <= 0) return 0;
  return clamp01(0.5 + Math.log2(ratio) / (2 * span));
}

export function toCss([r, g, b]: Rgb, alpha = 1): string {
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

/** Relative luminance (WCAG), to pick a readable label colour on top of a swatch. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function readableTextOn(color: Rgb): "#000" | "#fff" {
  // Contrast against black vs. white; whichever is larger wins.
  const l = luminance(color);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000" : "#fff";
}
