import type { CalendarRecord } from "../api/types";

export const CSV_COLUMNS = [
  "year",
  "month",
  "harmonized_viirs_equivalent",
  "low_90",
  "high_90",
  "stacked_raw",
  "median_same_month",
  "anomaly",
  "anomaly_ratio",
  "source",
] as const;

function number(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return "";
  return value.toFixed(digits);
}

/** RFC 4180 quoting: only fields with a comma, quote or line break get quotes. */
export function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The calendar of the selected area as CSV, one row per month, CRLF line ends. */
export function calendarToCsv(records: CalendarRecord[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    lines.push(
      [
        String(record.year),
        String(record.month_of_year),
        number(record.harmonized, 1),
        number(record.low, 1),
        number(record.high, 1),
        number(record.stacked_raw, 0),
        number(record.median_same_month, 1),
        number(record.anomaly, 1),
        number(record.anomaly_ratio, 3),
        record.source,
      ]
        .map(escapeField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export function csvFileName(label: string, start: string, end: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `aeros-calendar-${slug || "area"}-${start}-to-${end}.csv`;
}
