import { describe, expect, it } from "vitest";
import type { CellCenter } from "../../util/geo";
import { WHOLE_REGION, cellsOfSector, demoSectors } from "../../util/sectors";

/** A regular grid of cells, one per degree, named after their position. */
function grid(west: number, south: number, east: number, north: number): CellCenter[] {
  const cells: CellCenter[] = [];
  for (let lng = west; lng <= east; lng++) {
    for (let lat = south; lat <= north; lat++) cells.push({ cell: `c${lng}:${lat}`, center: [lng, lat] });
  }
  return cells;
}

describe("demoSectors", () => {
  const centers = grid(-66, -34, -56, -17);
  const sectors = demoSectors(centers);

  it("gives every cell to exactly one sector", () => {
    const assigned = sectors.flatMap((sector) => sector.cells);
    expect(assigned).toHaveLength(centers.length);
    expect(new Set(assigned)).toEqual(new Set(centers.map((c) => c.cell)));
  });

  it("lays the four sectors out as the design does", () => {
    expect(sectors.map((sector) => sector.id)).toEqual(["bo", "py", "ar", "hu"]);
    const latOf = (cell: string) => Number(cell.split(":")[1]);
    const lngOf = (cell: string) => Number(cell.slice(1).split(":")[0]);
    const cells = Object.fromEntries(sectors.map((sector) => [sector.id, sector.cells]));
    // North sectors lie above the south ones, and bo is west of py.
    expect(Math.min(...cells.bo!.map(latOf))).toBeGreaterThan(Math.max(...cells.ar!.map(latOf)));
    expect(Math.max(...cells.bo!.map(lngOf))).toBeLessThan(Math.min(...cells.py!.map(lngOf)));
    expect(Math.max(...cells.ar!.map(lngOf))).toBeLessThan(Math.min(...cells.hu!.map(lngOf)));
  });

  it("is deterministic", () => {
    expect(demoSectors(centers)).toEqual(sectors);
  });

  it("returns nothing for an empty region and drops sectors left without cells", () => {
    expect(demoSectors([])).toEqual([]);
    // One row of cells has no south half, so only the two northern sectors remain.
    expect(demoSectors(grid(-66, -25, -56, -25)).map((sector) => sector.id)).toEqual(["bo", "py"]);
  });
});

describe("cellsOfSector", () => {
  const sectors = demoSectors(grid(-66, -34, -56, -17));

  it("asks for the whole region with null, as a calendar query does", () => {
    expect(cellsOfSector(sectors, WHOLE_REGION)).toBeNull();
  });

  it("returns the cells of a sector, and null for an id that does not exist", () => {
    expect(cellsOfSector(sectors, "ar")).toEqual(sectors.find((s) => s.id === "ar")!.cells);
    expect(cellsOfSector(sectors, "nope")).toBeNull();
  });
});
