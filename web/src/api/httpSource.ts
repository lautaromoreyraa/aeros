import { formatMonth } from "../util/months";
import { getOptionalJson } from "./staticSource";
import type { CalendarDataSource, CalendarQuery, CalendarRecord, EarlyWarning, Forecast, RegionData, Unit } from "./types";

/**
 * The AWS backend: the region artifacts still come from static files (they are
 * the same for every visitor), while each area calendar is computed by
 * `POST /calendar` from the full-resolution model output. The early warning
 * changes daily, so it comes from `GET /early-warning`; the forecast is a
 * static artifact like the region files.
 */
export class HttpCalendarSource implements CalendarDataSource {
  constructor(
    private readonly apiUrl: string,
    private readonly regionSource: Pick<CalendarDataSource, "loadRegion" | "forecast">,
  ) {}

  loadRegion(unit: Unit): Promise<RegionData> {
    return this.regionSource.loadRegion(unit);
  }

  async calendar(query: CalendarQuery): Promise<CalendarRecord[]> {
    const body = JSON.stringify({
      unit: query.unit,
      cells: query.cells,
      start: formatMonth(query.start),
      end: formatMonth(query.end),
    });
    const response = await fetch(`${this.apiUrl}/calendar`, {
      method: "POST",
      // CloudFront signs the request for the Lambda function URL (OAC) with
      // this hash and cannot compute it itself; without it the URL answers 403.
      headers: { "Content-Type": "application/json", "x-amz-content-sha256": await sha256Hex(body) },
      body,
    });
    if (!response.ok) throw new Error(`The calendar service answered ${response.status}`);
    return (await response.json()) as CalendarRecord[];
  }

  earlyWarning(): Promise<EarlyWarning | null> {
    return getOptionalJson<EarlyWarning>(`${this.apiUrl}/early-warning`);
  }

  forecast(): Promise<Forecast | null> {
    return this.regionSource.forecast();
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
