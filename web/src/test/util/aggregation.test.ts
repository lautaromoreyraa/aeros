import { describe, expect, it } from "vitest";
import type { CalendarRecord, CellsMonthly } from "../../api/types";
import {
  Z90,
  aggregateCalendar,
  areaVariance,
  cellTotals,
  inRange,
  leaveOneOutAnomalies,
  median,
  sharedErrorCoefficients,
  sumCells,
  yearlyTotals,
} from "../../util/aggregation";

/** Two cells, two months; shared sd is 10 % of each cell's count (k = 0.1). */
const k = 0.1;
const cellA = { h: [10, 20], v: [4, 9] };
const cellB = { h: [30, 0], v: [16, 0] };
const data: CellsMonthly = {
  resolution: 4,
  months: ["2001-01", "2001-02"],
  columns: ["month_index", "harmonized", "variance", "stacked_raw"],
  cells: [
    {
      cell: "a",
      values: [
        [0, cellA.h[0]!, cellA.v[0]! + (k * cellA.h[0]!) ** 2, 5],
        [1, cellA.h[1]!, cellA.v[1]! + (k * cellA.h[1]!) ** 2, 7],
      ],
    },
    { cell: "b", values: [[0, cellB.h[0]!, cellB.v[0]! + (k * cellB.h[0]!) ** 2, 12]] },
  ],
};

function regionRecord(month: number, harmonized: number, variance: number): CalendarRecord {
  const half = Z90 * Math.sqrt(variance);
  return {
    year: 2001,
    month_of_year: month,
    harmonized,
    low: harmonized - half,
    high: harmonized + half,
    stacked_raw: 0,
    unattached: 0,
    median_same_month: null,
    anomaly: null,
    anomaly_ratio: null,
    source: "modeled_terra",
  };
}

// The model's region variance: Σv + (Σs)².
const region = [
  regionRecord(1, 40, 4 + 16 + (k * 40) ** 2),
  regionRecord(2, 20, 9 + (k * 20) ** 2),
];

describe("sumCells", () => {
  it("adds every cell when no area is given and leaves silent months at zero", () => {
    const totals = sumCells(data, null);
    expect(totals[0]).toMatchObject({ harmonized: 40, stacked: 17 });
    expect(totals[1]).toMatchObject({ harmonized: 20, stacked: 7 });
  });

  it("keeps only the cells of the area", () => {
    expect(sumCells(data, new Set(["b"]))[1]).toMatchObject({ harmonized: 0, stacked: 0 });
  });
});

describe("shared error", () => {
  it("recovers k² from the region interval", () => {
    const k2 = sharedErrorCoefficients(region, sumCells(data, null));
    expect(k2[0]).toBeCloseTo(k * k, 10);
    // A month with a single non-zero cell has no cross term to learn from.
    expect(k2[1]).toBe(0);
  });

  it("reproduces the model variance for the full region", () => {
    const all = sumCells(data, null);
    const k2 = sharedErrorCoefficients(region, all);
    expect(areaVariance(all[0]!, k2[0]!)).toBeCloseTo(4 + 16 + (k * 40) ** 2, 8);
  });
});

describe("median", () => {
  it("handles odd, even and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("leaveOneOutAnomalies", () => {
  const rows = [
    { year: 2001, month_of_year: 9, harmonized: 100 },
    { year: 2002, month_of_year: 9, harmonized: 200 },
    { year: 2003, month_of_year: 9, harmonized: 900 },
    { year: 2001, month_of_year: 10, harmonized: 0 },
    { year: 2002, month_of_year: 10, harmonized: 5 },
  ];
  const result = leaveOneOutAnomalies(rows);

  it("compares each month with the median of the same month in the other years", () => {
    expect(result[2]).toEqual({ median_same_month: 150, anomaly: 750, anomaly_ratio: 6 });
    expect(result[0]).toEqual({ median_same_month: 550, anomaly: -450, anomaly_ratio: 100 / 550 });
  });

  it("leaves the ratio empty when the usual value is zero", () => {
    expect(result[4]).toEqual({ median_same_month: 0, anomaly: 5, anomaly_ratio: null });
  });

  it("has no reference for a month seen in a single year", () => {
    expect(leaveOneOutAnomalies([{ year: 2001, month_of_year: 1, harmonized: 3 }])[0]).toEqual({
      median_same_month: null,
      anomaly: null,
      anomaly_ratio: null,
    });
  });
});

describe("aggregateCalendar", () => {
  it("returns the model's region calendar untouched for the whole region", () => {
    expect(aggregateCalendar(data, region, null)).toBe(region);
  });

  it("builds a sub-area calendar with the shared term in its interval", () => {
    const [january] = aggregateCalendar(data, region, new Set(["a"]));
    const variance = cellA.v[0]! + (k * cellA.h[0]!) ** 2;
    expect(january).toMatchObject({ year: 2001, month_of_year: 1, harmonized: 10, stacked_raw: 5 });
    expect(january!.high - january!.harmonized).toBeCloseTo(Z90 * Math.sqrt(variance), 8);
    expect(january!.source).toBe("modeled_terra");
  });

  it("never lets the lower bound go below zero", () => {
    for (const record of aggregateCalendar(data, region, new Set(["b"]))) {
      expect(record.low).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("range helpers", () => {
  it("totals each cell over a month range", () => {
    expect(cellTotals(data, 1, 1)).toEqual([
      { cell: "a", harmonized: 20, stacked: 7 },
      { cell: "b", harmonized: 0, stacked: 0 },
    ]);
  });

  it("filters records by an inclusive month range and totals years", () => {
    const records = aggregateCalendar(data, region, new Set(["a", "b"]));
    const january = 2001 * 12;
    expect(inRange(records, january, january)).toHaveLength(1);
    expect(yearlyTotals(records)[0]).toMatchObject({ year: 2001, harmonized: 60, stacked: 24, months: 2 });
  });
});
