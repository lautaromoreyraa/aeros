import { describe, expect, it } from "vitest";
import { type CalendarRow, filterCalendar, PipelineData, unusualMonths } from "../src/data";

function row(year: number, month: number, ratio: number | null): CalendarRow {
  return {
    year,
    month_of_year: month,
    harmonized: 10,
    low: 8,
    high: 12,
    stacked_raw: 7,
    median_same_month: 5,
    anomaly: 5,
    anomaly_ratio: ratio,
    source: "observed",
  };
}

const rows = [row(2004, 8, 1.1), row(2010, 9, 3.5), row(2020, 9, 2.0), row(2021, 1, null)];

describe("calendar views", () => {
  it("filters by year range and month", () => {
    expect(filterCalendar(rows, { fromYear: 2010, month: 9 }).map((r) => r.year)).toEqual([2010, 2020]);
  });

  it("ranks unusual months by how far above the median they are", () => {
    expect(unusualMonths(rows).map((r) => r.year)).toEqual([2010, 2020]);
  });

  it("reads artifacts relative to the base URL", async () => {
    const seen: string[] = [];
    const data = new PipelineData("https://data.example/", async (url) => {
      seen.push(url);
      return Response.json(rows);
    });
    expect(await data.calendar({ toYear: 2005 })).toHaveLength(1);
    expect(seen).toEqual(["https://data.example/calendar_region.json"]);
  });
});
