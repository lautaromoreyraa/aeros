import { describe, expect, it } from "vitest";
import { burntUpTo, busiestCells, emberColor, shownAt, type PastFireStep } from "../../util/pastFires";

const steps: PastFireStep[] = [
  { time: "2025-01-07T19:46:00Z", label: "NOAA-20 VIIRS", cells: [["a", 3, 10]] },
  { time: "2025-01-07T21:04:00Z", label: "Suomi NPP VIIRS", cells: [["a", 2, 5], ["b", 1, 1]] },
  { time: "2025-01-08T09:26:00Z", label: "Suomi NPP VIIRS", cells: [["c", 4, 8]] },
];

describe("burntUpTo", () => {
  it("adds up each cell over the steps shown and remembers when it was last seen", () => {
    expect(burntUpTo(steps, 2)).toEqual([
      { cell: "a", detections: 5, frp: 15, last: 1 },
      { cell: "b", detections: 1, frp: 1, last: 1 },
    ]);
  });

  it("shows nothing before the first step", () => {
    expect(burntUpTo(steps, 0)).toEqual([]);
  });
});

describe("shownAt", () => {
  it("counts the steps that had happened by a moment", () => {
    expect(shownAt(steps, "2025-01-07T18:30:00Z")).toBe(0);
    expect(shownAt(steps, "2025-01-07T21:04:00Z")).toBe(2);
    expect(shownAt(steps, "2025-01-08T01:00:00-08:00")).toBe(2);
    expect(shownAt(steps, "2025-01-08T03:25:00-08:00")).toBe(3);
    expect(shownAt(steps, "2025-02-01T00:00:00Z")).toBe(3);
  });
});

describe("busiestCells", () => {
  it("returns the cells of the step with the most detections", () => {
    expect(busiestCells(steps)).toEqual(["c"]);
    expect(busiestCells([])).toEqual([]);
  });
});

describe("emberColor", () => {
  it("cools down as the fire gets older", () => {
    const alphas = [0, 1, 4, 20].map((age) => emberColor(age)[3]);
    expect(alphas).toEqual([...alphas].sort((a, b) => b - a));
    expect(emberColor(0)).not.toEqual(emberColor(20));
  });
});
