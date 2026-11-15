import { HttpCalendarSource } from "./httpSource";
import { StaticCalendarSource } from "./staticSource";
import type { CalendarDataSource } from "./types";

/**
 * The single data source the app uses. Setting `VITE_CALENDAR_API_URL` at build
 * time switches area calendars to the AWS endpoint; without it everything is
 * served from the bundled demo artifacts.
 */
function createSource(): CalendarDataSource {
  const staticSource = new StaticCalendarSource(`${import.meta.env.BASE_URL}data`);
  const apiUrl = import.meta.env.VITE_CALENDAR_API_URL as string | undefined;
  return apiUrl ? new HttpCalendarSource(apiUrl.replace(/\/+$/, ""), staticSource) : staticSource;
}

export const calendarSource: CalendarDataSource = createSource();
