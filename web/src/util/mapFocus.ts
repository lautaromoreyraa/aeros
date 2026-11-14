/** A rectangle in pixels, as `getBoundingClientRect` gives it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Point = [x: number, y: number];

/** Room kept around a focused area, and above it for the map's toolbar. */
const MARGIN = 32;
const TOOLBAR = 72;
/** The focused area never gets less than this, however large the panel. */
const MIN_FREE = 120;

/** A panel is a side panel when it starts in the right half; otherwise it is a bottom sheet. */
export function panelSide(map: Rect, panel: Rect): "right" | "bottom" {
  return panel.left - map.left > map.width / 2 ? "right" : "bottom";
}

/**
 * Padding for fitting the camera to an area so it lands in the part of the map
 * the floating panel leaves free.
 */
export function focusPadding(map: Rect, panel: Rect | null): Padding {
  const padding = { top: TOOLBAR, right: MARGIN, bottom: MARGIN, left: MARGIN };
  if (panel) {
    if (panelSide(map, panel) === "right") padding.right = map.left + map.width - panel.left + MARGIN;
    else padding.bottom = map.top + map.height - panel.top + MARGIN;
  }
  padding.right = Math.min(padding.right, Math.max(MARGIN, map.width - padding.left - MIN_FREE));
  padding.bottom = Math.min(padding.bottom, Math.max(MARGIN, map.height - padding.top - MIN_FREE));
  return padding;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** How far the line's end stays from the panel's corners. */
const INSET = 24;

/**
 * Where the line from a cell meets the panel, in map pixels: on the panel's
 * left edge level with the cell, or on a sheet's top edge right above it.
 */
export function leaderEnd(from: Point, map: Rect, panel: Rect): Point {
  const left = panel.left - map.left;
  const top = panel.top - map.top;
  if (panelSide(map, panel) === "right") return [left, clamp(from[1], top + INSET, top + panel.height - INSET)];
  return [clamp(from[0], left + INSET, left + panel.width - INSET), top];
}
