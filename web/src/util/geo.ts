import { cellToLatLng } from "h3-js";
import type { LngLat } from "./area";

export interface CellCenter {
  cell: string;
  center: LngLat;
}

/** H3 gives [lat, lng]; everything else in the app speaks [lng, lat]. */
export function cellCenters(cells: string[]): CellCenter[] {
  return cells.map((cell) => {
    const [lat, lng] = cellToLatLng(cell);
    return { cell, center: [lng, lat] };
  });
}

/** Satellite fleet changes that make raw hotspot counts jump. */
export const FLEET_EVENTS = [
  { year: 2000, month: 11, label: "Terra only" },
  { year: 2002, month: 7, label: "Aqua joins" },
  { year: 2012, month: 1, label: "VIIRS era" },
] as const;
