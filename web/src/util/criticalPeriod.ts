import type { CalendarRecord, CriticalPeriod } from "../api/types";
import { median } from "./aggregation";

/** Median over years of each calendar month, January first; months never seen count as zero. */
export function monthlyClimatology(records: Pick<CalendarRecord, "month_of_year" | "harmonized">[]): number[] {
  const byMonth: number[][] = Array.from({ length: 12 }, () => []);
  for (const record of records) byMonth[record.month_of_year - 1]?.push(record.harmonized);
  return byMonth.map((values) => median(values) ?? 0);
}

/**
 * Shortest run of consecutive calendar months holding `share` of the activity,
 * the same rule as the model's `burn_calendar.critical_period`. Runs wrap
 * around the year end, so a season from November to February is one period;
 * among runs of the shortest length the one holding most activity wins.
 * Medians rather than totals keep one extreme season from stretching it.
 */
export function criticalPeriod(
  records: Pick<CalendarRecord, "month_of_year" | "harmonized">[],
  share = 0.8,
): CriticalPeriod {
  const values = monthlyClimatology(records);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { share, months: [], start_month: null, end_month: null };

  let best: { start: number; length: number; held: number } | null = null;
  for (let length = 1; length <= 12 && best === null; length++) {
    for (let start = 0; start < 12; start++) {
      let held = 0;
      for (let i = 0; i < length; i++) held += values[(start + i) % 12]!;
      held /= total;
      if (held >= share && (best === null || held > best.held)) best = { start, length, held };
    }
  }
  // A full year always holds 100 %, so a run is always found.
  const { start, length, held } = best!;
  const months = Array.from({ length }, (_, i) => ((start + i) % 12) + 1);
  const peak = values.indexOf(Math.max(...values)) + 1;
  return {
    share,
    held: Math.round(held * 10000) / 10000,
    months,
    start_month: months[0]!,
    end_month: months[months.length - 1]!,
    peak_month: peak,
    median_by_month: values.map((value) => Math.round(value * 100) / 100),
  };
}
