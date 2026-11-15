import { describe, expect, it } from "vitest";
import { daysAhead, levelOf, nearestNode, nodesNear, summarizeDays, type FireWeatherField } from "../../util/fireWeather";
import type { WindGrid } from "../../util/wind";

const LEVELS = { extreme: 95, high: 90, elevated: 75 };
// Three columns, two rows: nodes 0 1 2 on the north row, 3 4 5 on the south one.
const grid: WindGrid = { west: -64, south: -26, east: -60, north: -24, nx: 3, ny: 2 };

const field = (percentile: (number | null)[][]): FireWeatherField => ({
  generated_at: "2026-11-15T00:10:00+00:00",
  source: "test",
  index: "test",
  grid,
  days: percentile.map((_, i) => `2026-11-${15 + i}`),
  hdw: percentile.map((row) => row.map(() => 1)),
  percentile,
  levels: LEVELS,
  climatology: { years: [2016, 2025], half_window_days: 15, samples_per_node: 340 },
});

describe("levelOf", () => {
  it("takes the highest floor the rank reaches", () => {
    expect(levelOf(95, LEVELS)).toBe("extreme");
    expect(levelOf(94.9, LEVELS)).toBe("high");
    expect(levelOf(90, LEVELS)).toBe("high");
    expect(levelOf(75, LEVELS)).toBe("elevated");
    expect(levelOf(74.9, LEVELS)).toBe("normal");
    expect(levelOf(null, LEVELS)).toBeNull();
  });
});

describe("nearestNode", () => {
  it("rounds to the closest node, north row first", () => {
    expect(nearestNode(grid, -64, -24)).toBe(0);
    expect(nearestNode(grid, -60, -26)).toBe(5);
    expect(nearestNode(grid, -62.2, -25.4)).toBe(4);
  });

  it("is null outside the grid", () => {
    expect(nearestNode(grid, -65, -25)).toBeNull();
    expect(nearestNode(grid, -62, -27)).toBeNull();
  });
});

describe("nodesNear", () => {
  it("counts each node once and drops places outside the grid", () => {
    expect(
      nodesNear(grid, [
        [-60.1, -25.9],
        [-63.9, -24.1],
        [-60.2, -25.8],
        [-70, -25],
      ]),
    ).toEqual([0, 5]);
  });
});

describe("summarizeDays", () => {
  const forecast = field([
    [20, 96, 97.5, null, 50, 91],
    [null, null, null, null, null, null],
  ]);

  it("gives each day its highest rank, its level and the extreme nodes", () => {
    expect(summarizeDays(forecast)[0]).toEqual({ day: "2026-11-15", top: 97.5, level: "extreme", extreme: 2, nodes: 6 });
  });

  it("looks only at the nodes it is given", () => {
    expect(summarizeDays(forecast, [3, 4, 5])[0]).toEqual({ day: "2026-11-15", top: 91, level: "high", extreme: 0, nodes: 3 });
  });

  it("has no level for a day without any value", () => {
    expect(summarizeDays(forecast)[1]).toMatchObject({ top: null, level: null, extreme: 0 });
  });
});

describe("daysAhead", () => {
  const days = summarizeDays(field([[10], [80], [92]]));

  it("drops the days already past", () => {
    const ahead = daysAhead(days, "2026-11-16");
    expect(ahead.stale).toBe(false);
    expect(ahead.days.map((day) => day.day)).toEqual(["2026-11-16", "2026-11-17"]);
  });

  it("keeps the whole forecast, flagged stale, once every day is past", () => {
    const ahead = daysAhead(days, "2026-11-20");
    expect(ahead.stale).toBe(true);
    expect(ahead.days).toHaveLength(3);
  });
});
