import { describe, expect, it } from "vitest";
import { STRONG_WIND, fromOpenMeteo, gridNodes, hourIndexAt, sampleWind, toComponents, windStroke, type WindField, type WindGrid } from "../../util/wind";

const grid: WindGrid = { west: -62, south: -26, east: -60, north: -24, nx: 2, ny: 2 };

const field = (u: number[], v: number[]): WindField => ({
  generated_at: "2026-11-14T18:00:00Z",
  source: "test",
  grid,
  hours: ["2026-11-14T18:00:00Z", "2026-11-14T19:00:00Z"],
  u: [u, u],
  v: [v, v],
});

describe("toComponents", () => {
  it("turns the direction the wind blows from into where it blows to", () => {
    const [u, v] = toComponents(10, 0);
    expect(u).toBeCloseTo(0);
    expect(v).toBeCloseTo(-10);
    const [east] = toComponents(10, 270);
    expect(east).toBeCloseTo(10);
  });
});

describe("gridNodes", () => {
  it("lists the nodes north row first, west to east", () => {
    expect(gridNodes(grid)).toEqual([
      [-62, -24],
      [-60, -24],
      [-62, -26],
      [-60, -26],
    ]);
  });
});

describe("fromOpenMeteo", () => {
  it("keeps the node order and converts each hour", () => {
    const point = (speed: number, direction: number) => ({
      hourly: { time: ["2026-11-14T18:00"], wind_speed_10m: [speed], wind_direction_10m: [direction] },
    });
    const result = fromOpenMeteo([point(5, 270), point(0, 0), point(0, 0), point(5, 0)], grid, "now");
    expect(result.hours).toEqual(["2026-11-14T18:00:00Z"]);
    expect(result.u[0]![0]).toBeCloseTo(5);
    expect(result.v[0]![3]).toBeCloseTo(-5);
  });
});

describe("sampleWind", () => {
  it("interpolates between nodes and is null outside the grid", () => {
    const wind = field([0, 4, 0, 4], [2, 2, 2, 2]);
    expect(sampleWind(wind, 0, -61, -25)).toEqual([2, 2]);
    expect(sampleWind(wind, 0, -60, -24)).toEqual([4, 2]);
    expect(sampleWind(wind, 0, -70, -25)).toBeNull();
  });
});

describe("hourIndexAt", () => {
  it("picks the closest hour", () => {
    expect(hourIndexAt(field([0, 0, 0, 0], [0, 0, 0, 0]), Date.parse("2026-11-14T18:50:00Z"))).toBe(1);
  });
});

describe("windStroke", () => {
  it("draws light wind faint and slow, strong wind bright and fast", () => {
    const breeze = windStroke(2);
    const gale = windStroke(STRONG_WIND);
    expect(breeze.alpha).toBeLessThan(0.4);
    expect(gale.alpha).toBeCloseTo(0.9);
    expect(gale.pixels / breeze.pixels).toBeGreaterThan(STRONG_WIND / 2);
  });

  it("stops at calm and caps the brightness above a strong wind", () => {
    expect(windStroke(0)).toMatchObject({ pixels: 0, alpha: 0.15 });
    expect(windStroke(40).alpha).toBeCloseTo(0.9);
  });
});
