import { describe, expect, it } from "vitest";
import { boundsOf, boxToRing, cellsInArea, parseBox, pointInBox, pointInRing, type LngLat } from "../../util/area";

const square: LngLat[] = [
  [-62, -25],
  [-60, -25],
  [-60, -23],
  [-62, -23],
];

const cells = [
  { cell: "inside", center: [-61, -24] as LngLat },
  { cell: "outside", center: [-59, -24] as LngLat },
  { cell: "far", center: [-70, -40] as LngLat },
];

describe("pointInRing", () => {
  it("separates points inside and outside a square", () => {
    expect(pointInRing([-61, -24], square)).toBe(true);
    expect(pointInRing([-59, -24], square)).toBe(false);
  });

  it("handles a concave ring", () => {
    // An L shape: the notch at the top right is outside.
    const l: LngLat[] = [
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 4],
      [0, 4],
    ];
    expect(pointInRing([1, 3], l)).toBe(true);
    expect(pointInRing([3, 3], l)).toBe(false);
  });

  it("accepts closed rings", () => {
    expect(pointInRing([-61, -24], [...square, square[0]!])).toBe(true);
  });
});

describe("cellsInArea", () => {
  it("returns null for the whole region, meaning no filter", () => {
    expect(cellsInArea(cells, { kind: "region" })).toBeNull();
  });

  it("keeps cells whose centre is inside a drawn polygon", () => {
    expect([...cellsInArea(cells, { kind: "polygon", ring: square })!]).toEqual(["inside"]);
  });

  it("keeps cells inside a lat/lon box", () => {
    const box = { west: -62, south: -25, east: -58, north: -23 };
    expect([...cellsInArea(cells, { kind: "box", box })!].sort()).toEqual(["inside", "outside"]);
    expect(pointInBox([-58, -23], box)).toBe(true);
  });

  it("assigns every cell to exactly one of two halves", () => {
    const west = cellsInArea(cells, { kind: "box", box: { west: -80, south: -50, east: -60.5, north: 0 } })!;
    const east = cellsInArea(cells, { kind: "box", box: { west: -60.5, south: -50, east: -40, north: 0 } })!;
    expect(west.size + east.size).toBe(cells.length);
  });
});

describe("parseBox", () => {
  it("parses numbers, including a decimal comma", () => {
    expect(parseBox({ west: "-62,5", south: "-25", east: "-60", north: "-23" })).toEqual({
      box: { west: -62.5, south: -25, east: -60, north: -23 },
    });
  });

  it("reports empty, non-numeric and out-of-range fields", () => {
    const result = parseBox({ west: "", south: "abc", east: "200", north: "-23" });
    expect("errors" in result && result.errors).toMatchObject({
      west: "Enter a number",
      south: "Enter a number",
      east: expect.stringContaining("180"),
    });
  });

  it("rejects inverted boxes", () => {
    const result = parseBox({ west: "-60", south: "-23", east: "-62", north: "-25" });
    expect("errors" in result && result.errors.form).toBe("South must be below north");
  });
});

describe("shapes", () => {
  it("converts a box to a ring and back to its bounds", () => {
    const box = { west: -62, south: -25, east: -60, north: -23 };
    expect(boundsOf(boxToRing(box))).toEqual(box);
  });
});
