/** Area-of-interest geometry. Coordinates are [longitude, latitude], as deck.gl uses. */

export type LngLat = [number, number];

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type Area =
  | { kind: "region" }
  | { kind: "polygon"; ring: LngLat[] }
  | { kind: "box"; box: BoundingBox };

/** Ray casting; the ring may be open or closed. Points on an edge count as inside or not arbitrarily. */
export function pointInRing([x, y]: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInBox([lng, lat]: LngLat, box: BoundingBox): boolean {
  return lng >= box.west && lng <= box.east && lat >= box.south && lat <= box.north;
}

export function boxToRing(box: BoundingBox): LngLat[] {
  return [
    [box.west, box.south],
    [box.east, box.south],
    [box.east, box.north],
    [box.west, box.north],
  ];
}

export type BoxErrors = Partial<Record<keyof BoundingBox | "form", string>>;

/** Parses the lat/lon form; returns either a box or per-field messages. */
export function parseBox(fields: Record<keyof BoundingBox, string>): { box: BoundingBox } | { errors: BoxErrors } {
  const errors: BoxErrors = {};
  const read = (key: keyof BoundingBox, limit: number) => {
    const text = fields[key].trim().replace(",", ".");
    const value = Number(text);
    if (text === "" || !Number.isFinite(value)) errors[key] = "Enter a number";
    else if (Math.abs(value) > limit) errors[key] = `Must be between −${limit} and ${limit}`;
    return value;
  };
  const box = { west: read("west", 180), south: read("south", 90), east: read("east", 180), north: read("north", 90) };
  if (Object.keys(errors).length === 0) {
    if (box.south >= box.north) errors.form = "South must be below north";
    else if (box.west >= box.east) errors.form = "West must be left of east";
  }
  return Object.keys(errors).length ? { errors } : { box };
}

/**
 * Cells whose centre falls inside the area. Centre-in-polygon is the usual H3
 * "polyfill" rule: each cell lands in exactly one of two adjacent areas, so
 * splitting a region never double counts its hotspots.
 */
export function cellsInArea<T extends { cell: string; center: LngLat }>(cells: T[], area: Area): Set<string> | null {
  if (area.kind === "region") return null;
  const test =
    area.kind === "box"
      ? (point: LngLat) => pointInBox(point, area.box)
      : (point: LngLat) => pointInRing(point, area.ring);
  return new Set(cells.filter((cell) => test(cell.center)).map((cell) => cell.cell));
}

export function boundsOf(points: LngLat[]): BoundingBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of points) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, south, east, north };
}
