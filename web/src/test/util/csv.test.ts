import { describe, expect, it } from "vitest";
import type { CalendarRecord } from "../../api/types";
import { CSV_COLUMNS, calendarToCsv, csvFileName, escapeField } from "../../util/csv";

const record: CalendarRecord = {
  year: 2019,
  month_of_year: 8,
  harmonized: 812.456,
  low: 790.04,
  high: 834.96,
  stacked_raw: 1402,
  unattached: 0,
  median_same_month: 600,
  anomaly: 212.456,
  anomaly_ratio: 1.354093,
  source: "observed",
};

describe("calendarToCsv", () => {
  it("writes a header and one CRLF-terminated row per month", () => {
    const csv = calendarToCsv([record]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[1]).toBe("2019,8,812.5,790.0,835.0,1402,600.0,212.5,1.354,observed");
    expect(lines[2]).toBe("");
  });

  it("leaves missing anomalies empty instead of writing null", () => {
    const csv = calendarToCsv([{ ...record, median_same_month: null, anomaly: null, anomaly_ratio: null }]);
    expect(csv.split("\r\n")[1]).toBe("2019,8,812.5,790.0,835.0,1402,,,,observed");
  });

  it("returns only the header for an empty area", () => {
    expect(calendarToCsv([])).toBe(CSV_COLUMNS.join(",") + "\r\n");
  });
});

describe("escapeField", () => {
  it("quotes only when needed and doubles inner quotes", () => {
    expect(escapeField("plain")).toBe("plain");
    expect(escapeField("a,b")).toBe('"a,b"');
    expect(escapeField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeField("two\nlines")).toBe('"two\nlines"');
  });
});

describe("csvFileName", () => {
  it("slugs the area label", () => {
    expect(csvFileName("Drawn area (12 cells)", "2001-01", "2026-10")).toBe(
      "aeros-calendar-drawn-area-12-cells-2001-01-to-2026-10.csv",
    );
    expect(csvFileName("¡¡", "2001-01", "2001-02")).toBe("aeros-calendar-area-2001-01-to-2001-02.csv");
  });
});
