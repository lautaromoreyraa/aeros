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
  "/data/hotspots/cells_monthly.json": cells,
  "/data/hotspots/calendar_region.json": [record(2001, 15), record(2002, 30)],
  "/data/hotspots/validation.json": null,
  "/data/hotspots/morning.json": [],
  "/data/hotspots/meta.json": { unit: "hotspots", reference_chain: ["SNPP", "NOAA20"] },
  "/data/hotspots/critical_period.json": { share: 0.8, months: [1], start_month: 1, end_month: 1 },
};

function stubFetch(fail: Set<string> = new Set()) {
  const fetchMock = vi.fn(async (url: string) =>
    fail.has(url) || !(url in files)
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
    const region = await source.loadRegion("hotspots");
    await source.calendar({ unit: "hotspots", cells: null, start: 0, end: Number.MAX_SAFE_INTEGER });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(region).toMatchObject({ unit: "hotspots", meta: { reference_chain: ["SNPP", "NOAA20"] } });
    expect(region.criticalPeriod?.months).toEqual([1]);
  });

  it("aggregates the selected cells and applies the month range after the anomaly", async () => {
    stubFetch();
    const source = new StaticCalendarSource("/data");
    const result = await source.calendar({ unit: "hotspots", cells: ["a"], start: monthKey(2002, 1), end: monthKey(2002, 1) });
    expect(result).toHaveLength(1);
    // The reference still comes from 2001, outside the requested range.
    expect(result[0]).toMatchObject({ year: 2002, harmonized: 30, median_same_month: 10, anomaly: 20 });
  });

  it("survives missing optional artifacts but fails on missing essentials, and can retry", async () => {
    stubFetch(new Set(["/data/hotspots/validation.json", "/data/hotspots/critical_period.json"]));
    const partial = await new StaticCalendarSource("/data").loadRegion("hotspots");
    expect(partial.validation).toBeNull();
    expect(partial.criticalPeriod).toBeNull();

    stubFetch(new Set(["/data/hotspots/cells_monthly.json"]));
    const source = new StaticCalendarSource("/data");
    await expect(source.loadRegion("hotspots")).rejects.toThrow("cells_monthly.json");
    stubFetch();
    await expect(source.loadRegion("hotspots")).resolves.toMatchObject({ morning: [] });
  });

  it("keeps each unit as its own dataset", async () => {
    stubFetch();
    await expect(new StaticCalendarSource("/data").loadRegion("cell_days")).rejects.toThrow("/data/cell_days/");
  });
});
