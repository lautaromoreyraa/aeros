import { clamp01 } from "./colorRamp";

/** Seen from this zoom or farther, a column stands at its full height. */
export const FULL_HEIGHT_ZOOM = 5.5;

/**
 * Share of its height a column keeps at a zoom: all of it from afar, half for
 * every zoom level closer. Close up a full column would bury the towns around
 * its own cell.
 */
export function columnScale(zoom: number): number {
  return Math.min(1, 2 ** (FULL_HEIGHT_ZOOM - zoom));
}

/** Opacity, 0-255, of a cell the ground shows through: the more fire, the more solid. */
export function cellAlpha(t: number): number {
  return Math.round(100 + 130 * clamp01(t));
}
