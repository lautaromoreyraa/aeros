import { formatMonth } from "../util/months";
import type { CalendarDataSource, CalendarQuery, CalendarRecord, RegionData } from "./types";

/**
 * The AWS backend: the region artifacts still come from static files (they are
 * the same for every visitor), while each area calendar is computed by
 * `POST /calendar` from the full-resolution model output.
 */
export class HttpCalendarSource implements CalendarDataSource {
  constructor(
    private readonly apiUrl: string,
    private readonly regionSource: Pick<CalendarDataSource, "loadRegion">,
  ) {}

  loadRegion(): Promise<RegionData> {
    return this.regionSource.loadRegion();
  }

  async calendar(query: CalendarQuery): Promise<CalendarRecord[]> {
    const response = await fetch(`${this.apiUrl}/calendar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cells: query.cells, start: formatMonth(query.start), end: formatMonth(query.end) }),
    });
    if (!response.ok) throw new Error(`The calendar service answered ${response.status}`);
    return (await response.json()) as CalendarRecord[];
  }
}
