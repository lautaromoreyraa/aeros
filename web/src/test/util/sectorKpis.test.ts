import { describe, expect, it } from "vitest";
import type { CalendarRecord } from "../../api/types";
import type { YearTotal } from "../../util/aggregation";
import { eraComparison, recordAt, seasonToDate, verdictOf } from "../../util/sectorKpis";

function record(overrides: Partial<CalendarRecord> = {}): CalendarRecord {
  return {
    year: 2024,
    month_of_year: 9,
    harmonized: 100,
    low: 90,
    high: 110,
    stacked_raw: 100,
    unattached: 0,
    median_same_month: 100,
    anomaly: 0,
    anomaly_ratio: 1,
    source: "observed",
    ...overrides,
  };
}

describe("verdictOf", () => {
  it("calls a month normal while its interval overlaps the usual band", () => {
    expect(verdictOf(record())).toBe("normal");
    // Value above the median, but the interval still reaches into the usual band.
    expect(verdictOf(record({ low: 105, high: 160, harmonized: 130 }))).toBe("normal");
  });

  it("calls a month above or below only when the whole interval is clear of the band", () => {
    expect(verdictOf(record({ low: 120, high: 160, harmonized: 140 }))).toBe("above");
    expect(verdictOf(record({ low: 40, high: 80, harmonized: 60 }))).toBe("below");
  });

  it("separates a missing month from one without a baseline", () => {
    expect(verdictOf(undefined)).toBe("no_data");
    expect(verdictOf(record({ median_same_month: null }))).toBe("no_baseline");
    expect(verdictOf(record({ median_same_month: 0 }))).toBe("no_baseline");
  });
});

describe("recordAt", () => {
  it("finds a month by year and month of year", () => {
    const records = [record({ month_of_year: 8 }), record({ month_of_year: 9, harmonized: 7 })];
    expect(recordAt(records, 2024, 9)?.harmonized).toBe(7);
    expect(recordAt(records, 2023, 9)).toBeUndefined();
  });
});

describe("seasonToDate", () => {
  const records = [
    record({ month_of_year: 1, harmonized: 10, median_same_month: 8 }),
    record({ month_of_year: 2, harmonized: 20, median_same_month: 12 }),
    record({ month_of_year: 3, harmonized: 99, median_same_month: 50 }),
    record({ year: 2023, month_of_year: 1, harmonized: 500, median_same_month: 500 }),
  ];

  it("adds January to the chosen month of that year only", () => {
    const { total, usual, change } = seasonToDate(records, 2024, 2);
    expect(total).toBe(30);
    expect(usual).toBe(20);
    expect(change).toBeCloseTo(0.5);
  });

  it("has no change to report without a baseline", () => {
    expect(seasonToDate(records, 2022, 6)).toEqual({ total: 0, usual: 0, change: null });
  });
});

describe("eraComparison", () => {
  function totals(year: number, harmonized: number, stacked: number, months = 12): YearTotal {
    return { year, harmonized, low: harmonized, high: harmonized, stacked, months };
  }
  const years = [
    ...[2002, 2003, 2004].map((y) => totals(y, 100, 60)),
    ...[2012, 2013, 2014].map((y) => totals(y, 110, 150)),
  ];

  it("shows the jump in stacked counts that harmonizing removes", () => {
    const { stackedChange, harmonizedChange } = eraComparison(years);
    expect(stackedChange).toBeCloseTo(1.5);
    expect(harmonizedChange).toBeCloseTo(0.1);
  });

  it("ignores years with missing months", () => {
    const withGap = [...years, totals(2005, 1, 1, 7), totals(2015, 9999, 9999, 3)];
    expect(eraComparison(withGap)).toEqual(eraComparison(years));
  });

  it("reports nothing when an era has no complete year", () => {
    expect(eraComparison(years.filter((y) => y.year > 2010))).toMatchObject({
      stackedChange: null,
      harmonizedChange: null,
    });
  });
});
