import { describe, expect, it } from "vitest";
import { cellWeekSummary, firmsUrl, formatRatio } from "../../util/cellWeekSummary";
import type { AlertDecision } from "../../util/earlyWarning";
import type { EarlyWarning } from "../../api/types";

const BASE_REPORT: EarlyWarning = {
  generated_at: "2026-11-14T06:00:00Z",
  window: ["2026-11-07", "2026-11-14"],
  days_with_data: ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-14"],
  gap_days: ["2026-11-13"],
  days: [
    { date: "2026-11-07", status: "ok", satellite: "NOAA-20", detections: 5 },
    { date: "2026-11-08", status: "ok", satellite: "NOAA-21", detections: 10 },
  ],
  method: { alpha: 0.01 },
  region: null,
  cells: [
    { cell: "flagged-cell-1", observed: 42, expected: 3, ratio: 14, p_value: 0.00001 },
    { cell: "flagged-cell-2", observed: 8, expected: 5, ratio: 1.6, p_value: 0.005 },
    { cell: "flagged-cell-low-expected", observed: 3, expected: 0.4, ratio: 7.5, p_value: 0.001 },
  ],
};

const BASE_DECISION: AlertDecision = {
  active: true,
  region: false,
  cells: [
    { cell: "flagged-cell-1", observed: 42, expected: 3, ratio: 14, p_value: 0.00001 },
    { cell: "flagged-cell-2", observed: 8, expected: 5, ratio: 1.6, p_value: 0.005 },
    { cell: "flagged-cell-low-expected", observed: 3, expected: 0.4, ratio: 7.5, p_value: 0.001 },
  ],
};

describe("formatRatio", () => {
  it("rounds ratios >= 10 to nearest integer", () => {
    expect(formatRatio(14)).toBe("14 times");
    expect(formatRatio(10)).toBe("10 times");
    expect(formatRatio(100)).toBe("100 times");
  });

  it("gives one decimal for ratios under 10", () => {
    expect(formatRatio(1.6)).toBe("1.6 times");
    expect(formatRatio(3.14)).toBe("3.1 times");
    expect(formatRatio(9.9)).toBe("9.9 times");
  });

  it("says 'less than 1 times' when expected exceeds observed", () => {
    expect(formatRatio(0.5)).toBe("less than 1 times");
    expect(formatRatio(0)).toBe("less than 1 times");
  });

  it("handles null ratio", () => {
    expect(formatRatio(null)).toBe("an unusual amount");
  });
});

describe("firmsUrl", () => {
  it("builds a FIRMS URL from lng/lat", () => {
    const url = firmsUrl(-60.3, -25.5);
    expect(url).toContain("firms.modaps.eosdis.nasa.gov");
    expect(url).toContain("@-60.3,-25.5,9.00z");
  });
});

describe("cellWeekSummary", () => {
  it("returns flagged summary when the cell is in the decision", () => {
    const result = cellWeekSummary("flagged-cell-1", BASE_REPORT, BASE_DECISION, [-60.3, -25.5]);
    expect(result.flagged).toBe(true);
    expect(result.observedLabel).toMatch(/42/);
    expect(result.expectedLabel).toMatch(/3/);
    expect(result.ratioLabel).toBe("14 times");
    expect(result.oddsLabel).toBe("less than 1 in 1,000 by chance");
    expect(result.satellitesLabel).toBe("NOAA-20, NOAA-21");
    expect(result.firmsUrl).toContain("@-60.3,-25.5,9.00z");
  });

  it("handles expected < 1 as 'less than 1'", () => {
    const result = cellWeekSummary("flagged-cell-low-expected", BASE_REPORT, BASE_DECISION, [-60.3, -25.5]);
    expect(result.expectedLabel).toBe("less than 1");
  });

  it("returns unflagged summary when the cell is not in the decision", () => {
    const result = cellWeekSummary("unknown-cell", BASE_REPORT, BASE_DECISION, [0, 0]);
    expect(result.flagged).toBe(false);
  });

  it("formats window as human readable date range", () => {
    const result = cellWeekSummary("unknown-cell", BASE_REPORT, BASE_DECISION, [0, 0]);
    expect(result.windowLabel).toMatch(/Nov/);
  });

  it("reports data days count", () => {
    const result = cellWeekSummary("flagged-cell-1", BASE_REPORT, BASE_DECISION, [0, 0]);
    expect(result.dataDaysLabel).toMatch(/7 of 8 days/);
  });

  it("renders odds as 'less than 1 in 1,000' when p < 0.001", () => {
    const result = cellWeekSummary("flagged-cell-1", BASE_REPORT, BASE_DECISION, [0, 0]);
    expect(result.oddsLabel).toBe("less than 1 in 1,000 by chance");
  });

  it("renders odds as a fraction when p >= 0.001", () => {
    const decision: AlertDecision = {
      ...BASE_DECISION,
      cells: [{ cell: "flagged-cell-2", observed: 8, expected: 5, ratio: 1.6, p_value: 0.005 }],
    };
    const result = cellWeekSummary("flagged-cell-2", BASE_REPORT, decision, [0, 0]);
    expect(result.oddsLabel).toMatch(/1 in \d+/);
  });
});
