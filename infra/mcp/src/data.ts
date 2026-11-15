// Read-only views over the artifacts the model pipeline publishes
// (validation.json, calendar_region.json, morning.json, critical_period.json,
// meta.json).

export interface CalendarRow {
  year: number;
  month_of_year: number;
  harmonized: number | null;
  low: number | null;
  high: number | null;
  stacked_raw: number;
  median_same_month: number | null;
  anomaly: number | null;
  anomaly_ratio: number | null;
  source: string;
}

export interface CalendarQuery {
  fromYear?: number;
  toYear?: number;
  month?: number;
}

export type Fetcher = (url: string) => Promise<Response>;

export class PipelineData {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = (url) =>
      fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit),
  ) {}

  private async json<T>(name: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  validation(): Promise<unknown> {
    return this.json("validation.json");
  }

  morning(): Promise<unknown> {
    return this.json("morning.json");
  }

  criticalPeriod(): Promise<unknown> {
    return this.json("critical_period.json");
  }

  meta(): Promise<unknown> {
    return this.json("meta.json");
  }

  async calendar(query: CalendarQuery = {}): Promise<CalendarRow[]> {
    const rows = await this.json<CalendarRow[]>("calendar_region.json");
    return filterCalendar(rows, query);
  }
}

export function filterCalendar(rows: CalendarRow[], query: CalendarQuery): CalendarRow[] {
  return rows.filter(
    (row) =>
      (query.fromYear === undefined || row.year >= query.fromYear) &&
      (query.toYear === undefined || row.year <= query.toYear) &&
      (query.month === undefined || row.month_of_year === query.month),
  );
}

/** Months whose harmonized count exceeds the same-month median by `factor` or more. */
export function unusualMonths(rows: CalendarRow[], factor = 2): CalendarRow[] {
  return rows
    .filter((row) => row.anomaly_ratio !== null && row.anomaly_ratio >= factor)
    .sort((a, b) => (b.anomaly_ratio ?? 0) - (a.anomaly_ratio ?? 0));
}
