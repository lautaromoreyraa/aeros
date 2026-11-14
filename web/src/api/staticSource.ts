import { aggregateCalendar, inRange } from "../util/aggregation";
import type {
  CalendarDataSource,
  CalendarQuery,
  CalendarRecord,
  CellsMonthly,
  MorningRecord,
  RegionData,
  Validation,
} from "./types";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return (await response.json()) as T;
}

/**
 * Serves the demo artifacts copied to `public/data/` and aggregates the
 * selected cells in the browser, with the same rules the model uses for the
 * region calendar.
 */
export class StaticCalendarSource implements CalendarDataSource {
  private region: Promise<RegionData> | null = null;

  constructor(private readonly baseUrl: string) {}

  loadRegion(): Promise<RegionData> {
    this.region ??= Promise.all([
      getJson<CellsMonthly>(`${this.baseUrl}/cells_monthly.json`),
      getJson<CalendarRecord[]>(`${this.baseUrl}/calendar_region.json`),
      // Validation and Terra drift are context, not essential; the app works without them.
      getJson<Validation>(`${this.baseUrl}/validation.json`).catch(() => null),
      getJson<MorningRecord[]>(`${this.baseUrl}/morning.json`).catch(() => []),
    ]).then(([cells, region, validation, morning]) => ({ cells, region, validation, morning }));
    // A failed load must not be cached forever, so a retry can succeed.
    this.region.catch(() => {
      this.region = null;
    });
    return this.region;
  }

  async calendar(query: CalendarQuery): Promise<CalendarRecord[]> {
    const { cells, region } = await this.loadRegion();
    const selected = query.cells === null ? null : new Set(query.cells);
    // Anomalies use every year as reference, so the range is applied last.
    return inRange(aggregateCalendar(cells, region, selected), query.start, query.end);
  }
}
