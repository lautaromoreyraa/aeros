import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticCalendarSource } from "../../api/staticSource";
import type { CalendarRecord, CellsMonthly } from "../../api/types";
import { monthKey } from "../../util/months";

const cells: CellsMonthly = {
  resolution: 4,
  months: ["2001-01", "2002-01"],
  columns: ["month_index", "harmonized", "variance", "stacked_raw"],
  cells: [
    { cell: "a", values: [[0, 10, 0, 4], [1, 30, 0, 9]] },
    { cell: "b", values: [[0, 5, 0, 2]] },
  ],
};

const record = (year: number, harmonized: number): CalendarRecord => ({
  year,
  month_of_year: 1,
  harmonized,
  low: harmonized,
  high: harmonized,
  stacked_raw: 0,
  unattached: 0,
  median_same_month: null,
  anomaly: null,
  anomaly_ratio: null,
  source: "observed",
});

const files: Record<string, unknown> = {
  "/data/cells_monthly.json": cells,
  "/data/calendar_region.json": [record(2001, 15), record(2002, 30)],
  "/data/validation.json": null,
  "/data/morning.json": [],
};

function stubFetch(fail: Set<string> = new Set()) {
  const fetchMock = vi.fn(async (url: string) =>
    fail.has(url)
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify(files[url]), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("StaticCalendarSource", () => {
  it("loads the artifacts once and reuses them", async () => {
    const fetchMock = stubFetch();
    const source = new StaticCalendarSource("/data");
    await source.loadRegion();
    await source.calendar({ cells: null, start: 0, end: Number.MAX_SAFE_INTEGER });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("aggregates the selected cells and applies the month range after the anomaly", async () => {
    stubFetch();
    const source = new StaticCalendarSource("/data");
    const result = await source.calendar({ cells: ["a"], start: monthKey(2002, 1), end: monthKey(2002, 1) });
    expect(result).toHaveLength(1);
    // The reference still comes from 2001, outside the requested range.
    expect(result[0]).toMatchObject({ year: 2002, harmonized: 30, median_same_month: 10, anomaly: 20 });
  });

  it("survives missing optional artifacts but fails on missing essentials, and can retry", async () => {
    stubFetch(new Set(["/data/validation.json"]));
    expect((await new StaticCalendarSource("/data").loadRegion()).validation).toBeNull();

    stubFetch(new Set(["/data/cells_monthly.json"]));
    const source = new StaticCalendarSource("/data");
    await expect(source.loadRegion()).rejects.toThrow("cells_monthly.json");
    stubFetch();
    await expect(source.loadRegion()).resolves.toMatchObject({ morning: [] });
  });
});
