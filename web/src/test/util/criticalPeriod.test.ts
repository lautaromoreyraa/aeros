import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CalendarRecord, CriticalPeriod } from "../../api/types";
import { criticalPeriod, monthlyClimatology } from "../../util/criticalPeriod";

const year = (values: number[], y = 2001) => values.map((harmonized, i) => ({ month_of_year: i + 1, harmonized, year: y }));

describe("monthlyClimatology", () => {
  it("takes the median of each calendar month and zero for months never seen", () => {
    const records = [
      { month_of_year: 1, harmonized: 10 },
      { month_of_year: 1, harmonized: 30 },
      { month_of_year: 1, harmonized: 1000 },
    ];
    const result = monthlyClimatology(records);
    expect(result[0]).toBe(30);
    expect(result[1]).toBe(0);
  });
});

describe("criticalPeriod", () => {
  it("finds the shortest run holding the share", () => {
    // Any three months hold 75 %, so it takes four.
    const result = criticalPeriod(year([0, 0, 0, 0, 0, 0, 25, 25, 25, 25, 0, 0]));
    expect(result.months).toEqual([7, 8, 9, 10]);
    expect(result).toMatchObject({ start_month: 7, end_month: 10, peak_month: 7, held: 1 });
  });

  it("prefers a shorter run, and the fuller one among runs of that length", () => {
    expect(criticalPeriod(year([0, 0, 0, 0, 0, 0, 5, 45, 45, 5, 0, 0])).months).toEqual([8, 9]);
    expect(criticalPeriod(year([0, 0, 0, 0, 0, 0, 15, 30, 35, 20, 0, 0])).months).toEqual([8, 9, 10]);
  });

  it("wraps around the year end for a southern summer season", () => {
    const result = criticalPeriod(year([25, 25, 0, 0, 0, 0, 0, 0, 0, 0, 25, 25]));
    expect(result.months).toEqual([11, 12, 1, 2]);
    expect(result).toMatchObject({ start_month: 11, end_month: 2 });
  });

  it("is empty when nothing burned", () => {
    expect(criticalPeriod(year(new Array(12).fill(0)))).toEqual({
      share: 0.8,
      months: [],
      start_month: null,
      end_month: null,
    });
  });

  it("reproduces the model's critical period for the demo region", () => {
    const read = (name: string) =>
      JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/data/hotspots/${name}`, import.meta.url)), "utf8"));
    const region = read("calendar_region.json") as CalendarRecord[];
    const model = read("critical_period.json") as CriticalPeriod;
    const result = criticalPeriod(region, model.share);
    expect(result.months).toEqual(model.months);
    expect(result.peak_month).toBe(model.peak_month);
    expect(result.held).toBeCloseTo(model.held!, 3);
    result.median_by_month!.forEach((value, i) => expect(value).toBeCloseTo(model.median_by_month![i]!, 1));
  });
});
