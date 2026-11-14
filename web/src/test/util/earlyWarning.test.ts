import { describe, expect, it } from "vitest";
import type { EarlyWarning } from "../../api/types";
import { alertDecision, daysBetween, formatDay, formatPValue, regionIsAlerting, windowCoverage } from "../../util/earlyWarning";

const report = (overrides: Partial<EarlyWarning> = {}): EarlyWarning => ({
  generated_at: "2026-11-13T06:00:00Z",
  window: ["2026-11-06", "2026-11-12"],
  days_with_data: ["2026-11-06", "2026-11-07", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"],
  region: { observed: 100, expected: 80, ratio: 1.25, p_value: 0.02 },
  cells: [],
  ...overrides,
});

describe("regionIsAlerting", () => {
  it("needs a ratio of at least 2 and p below 0.01", () => {
    expect(regionIsAlerting({ observed: 200, expected: 100, ratio: 2, p_value: 0.001 })).toBe(true);
    expect(regionIsAlerting({ observed: 199, expected: 100, ratio: 1.99, p_value: 0.0001 })).toBe(false);
    expect(regionIsAlerting({ observed: 4, expected: 1, ratio: 4, p_value: 0.019 })).toBe(false);
    expect(regionIsAlerting({ observed: 200, expected: 100, ratio: 2, p_value: 0.01 })).toBe(false);
  });

  it("never alerts without a region score or a ratio", () => {
    expect(regionIsAlerting(null)).toBe(false);
    expect(regionIsAlerting({ observed: 5, expected: 0, ratio: null, p_value: 0.0001 })).toBe(false);
  });
});

describe("alertDecision", () => {
  it("is calm without a report or with nothing flagged", () => {
    expect(alertDecision(null).active).toBe(false);
    expect(alertDecision(report()).active).toBe(false);
  });

  it("alerts on the region alone", () => {
    const decision = alertDecision(report({ region: { observed: 300, expected: 100, ratio: 3, p_value: 1e-9 } }));
    expect(decision).toMatchObject({ active: true, region: true, cells: [] });
  });

  it("alerts on flagged cells alone, most significant first", () => {
    const decision = alertDecision(
      report({
        cells: [
          { cell: "b", observed: 9, expected: 2, ratio: 4.5, p_value: 0.004 },
          { cell: "a", observed: 12, expected: 2, ratio: 6, p_value: 0.0001 },
        ],
      }),
    );
    expect(decision.active).toBe(true);
    expect(decision.region).toBe(false);
    expect(decision.cells.map((cell) => cell.cell)).toEqual(["a", "b"]);
  });

  it("ignores cells that do not pass the test or burn less than expected", () => {
    const decision = alertDecision(
      report({
        cells: [
          { cell: "weak", observed: 5, expected: 2, ratio: 2.5, p_value: 0.05 },
          { cell: "low", observed: 1, expected: 9, ratio: 0.1, p_value: 0.001 },
        ],
      }),
    );
    expect(decision.active).toBe(false);
  });

  it("uses the report's own alpha when it states one", () => {
    const cells = [{ cell: "a", observed: 9, expected: 2, ratio: 4.5, p_value: 0.004 }];
    expect(alertDecision(report({ cells, method: { alpha: 0.001 } })).active).toBe(false);
  });
});

describe("windowCoverage", () => {
  it("names the gap days from the list of data days", () => {
    expect(windowCoverage(report())).toEqual({ windowDays: 7, dataDays: 6, gapDates: ["2026-11-08"], gapCount: 1 });
  });

  it("works with only a count of data days", () => {
    expect(windowCoverage(report({ days_with_data: 5 }))).toEqual({
      windowDays: 7,
      dataDays: 5,
      gapDates: [],
      gapCount: 2,
    });
  });
});

describe("dates and p-values", () => {
  it("lists every day of an inclusive window", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(daysBetween("2026-11-02", "2026-11-01")).toEqual([]);
  });

  it("formats days in UTC and p-values with a floor", () => {
    expect(formatDay("2026-11-08")).toBe("Nov 8");
    expect(formatPValue(1e-7)).toBe("p < 0.001");
    expect(formatPValue(0.0042)).toBe("p = 0.004");
  });
});
