import { boundsOf, type LngLat } from "./area";
import type { CellCenter } from "./geo";

/**
 * A sector is a named set of H3 cells, so its calendar is the area calendar of
 * those cells and needs no query of its own. The page never assumes how the
 * set was built: swapping `demoSectors` for sectors that come with the model's
 * output changes where they are made, not how they are drawn.
 */
export interface Sector {
  id: string;
  name: string;
  /** Where it lies, in a few words. */
  place: string;
  cells: string[];
}

/** The pseudo-sector that stands for the whole region. */
export const WHOLE_REGION = "all";

/** Share of the region's width and height at which the demo cuts fall. */
const NORTH_SOUTH_CUT = 0.5;
const WEST_EAST_CUT_NORTH = 0.5;
const WEST_EAST_CUT_SOUTH = 0.6;

const DEMO_SECTORS = [
  { id: "bo", name: "Bolivian Chaco", place: "Bolivia · north-west" },
  { id: "py", name: "Chaco Boreal", place: "Paraguay · north-east" },
  { id: "ar", name: "Dry Chaco", place: "Argentina · south-west" },
  { id: "hu", name: "Humid Chaco", place: "AR · PY · east" },
] as const;

/**
 * Four placeholder sectors for the bundled demo artifacts: the region is cut
 * in a north half and a south half, and each half at a fixed share of its
 * width. They only borrow the names and the layout of the design. The real
 * ones are country-by-ecoregion polygons that the model rasterizes to cells.
 * Every cell lands in exactly one sector; a sector left without cells is dropped.
 */
export function demoSectors(centers: CellCenter[]): Sector[] {
  if (centers.length === 0) return [];
  const { west, south, east, north } = boundsOf(centers.map((cell) => cell.center));
  const midLat = south + (north - south) * NORTH_SOUTH_CUT;
  const cutNorth = west + (east - west) * WEST_EAST_CUT_NORTH;
  const cutSouth = west + (east - west) * WEST_EAST_CUT_SOUTH;

  const bySector = new Map<string, string[]>(DEMO_SECTORS.map((sector) => [sector.id, []]));
  for (const { cell, center } of centers) {
    const [lng, lat] = center as LngLat;
    const northern = lat >= midLat;
    const id = northern ? (lng < cutNorth ? "bo" : "py") : lng < cutSouth ? "ar" : "hu";
    bySector.get(id)!.push(cell);
  }
  return DEMO_SECTORS.map((sector) => ({ ...sector, cells: bySector.get(sector.id)! })).filter(
    (sector) => sector.cells.length > 0,
  );
}

/** The cells to query for a sector id; `null` asks for the whole region, as a calendar query does. */
export function cellsOfSector(sectors: Sector[], id: string): string[] | null {
  if (id === WHOLE_REGION) return null;
  return sectors.find((sector) => sector.id === id)?.cells ?? null;
}
