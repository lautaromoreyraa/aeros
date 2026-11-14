import { aggregateCalendar, inRange } from "../util/aggregation";
import type {
  CalendarDataSource,
  CalendarQuery,
  CalendarRecord,
  CellsMonthly,
  CriticalPeriod,
  DatasetMeta,
  EarlyWarning,
  Forecast,
  MorningRecord,
  RegionData,
  Unit,
  Validation,
} from "./types";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return (await response.json()) as T;
}

/** A product that is not published yet is a normal state, not an error. */
export async function getOptionalJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return (await response.json()) as T;
}

/**
 * Serves the demo artifacts copied to `public/data/<unit>/` and aggregates the
 * selected cells in the browser, with the same rules the model uses for the
 * region calendar.
 */
export class StaticCalendarSource implements CalendarDataSource {
  private readonly regions = new Map<Unit, Promise<RegionData>>();

  constructor(private readonly baseUrl: string) {}

  loadRegion(unit: Unit): Promise<RegionData> {
    const cached = this.regions.get(unit);
    if (cached) return cached;
    const base = `${this.baseUrl}/${unit}`;
    // Validation, drift, metadata and the critical period are context: the
    // calendar works without them.
    const optional = <T>(name: string, fallback: T) => getJson<T>(`${base}/${name}`).catch(() => fallback);
    const region = Promise.all([
      getJson<CellsMonthly>(`${base}/cells_monthly.json`),
      getJson<CalendarRecord[]>(`${base}/calendar_region.json`),
      optional<Validation | null>("validation.json", null),
      optional<MorningRecord[]>("morning.json", []),
      optional<DatasetMeta | null>("meta.json", null),
      optional<CriticalPeriod | null>("critical_period.json", null),
    ]).then(([cells, regionRecords, validation, morning, meta, criticalPeriod]) => ({
      unit,
      meta,
      criticalPeriod,
      cells,
      region: regionRecords,
      validation,
      morning,
    }));
    this.regions.set(unit, region);
    // A failed load must not be cached forever, so a retry can succeed.
    region.catch(() => this.regions.delete(unit));
    return region;
  }

  async calendar(query: CalendarQuery): Promise<CalendarRecord[]> {
    const { cells, region } = await this.loadRegion(query.unit);
    const selected = query.cells === null ? null : new Set(query.cells);
    // Anomalies use every year as reference, so the range is applied last.
    return inRange(aggregateCalendar(cells, region, selected), query.start, query.end);
  }

  earlyWarning(): Promise<EarlyWarning | null> {
    return getOptionalJson<EarlyWarning>(`${this.baseUrl}/early_warning.json`);
  }

  forecast(): Promise<Forecast | null> {
    return getOptionalJson<Forecast>(`${this.baseUrl}/forecast.json`);
  }
}
