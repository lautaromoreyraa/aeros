import type { CalendarRecord } from "../api/types";
import type { YearTotal } from "./aggregation";

/** How a month compares with the same month in the other years. */
export type Verdict = "above" | "normal" | "below" | "no_baseline" | "no_data";

/** A month counts as unusual only when its whole 90 % interval is clear of the usual band. */
const ABOVE_FACTOR = 1.15;
const BELOW_FACTOR = 0.87;

export function recordAt(records: CalendarRecord[], year: number, month: number): CalendarRecord | undefined {
  return records.find((record) => record.year === year && record.month_of_year === month);
}

export function verdictOf(record: CalendarRecord | undefined): Verdict {
  if (!record) return "no_data";
  const usual = record.median_same_month;
  if (usual === null || usual <= 0) return "no_baseline";
  if (record.low > usual * ABOVE_FACTOR) return "above";
  if (record.high < usual * BELOW_FACTOR) return "below";
  return "normal";
}

export interface SeasonToDate {
  total: number;
  usual: number;
  /** Total over the usual total minus one, or `null` without a baseline. */
  change: number | null;
}

/** January through `month` of `year`, against the same months in the other years. */
export function seasonToDate(records: CalendarRecord[], year: number, month: number): SeasonToDate {
  let total = 0;
  let usual = 0;
  for (const record of records) {
    if (record.year !== year || record.month_of_year > month) continue;
    total += record.harmonized;
    usual += record.median_same_month ?? 0;
  }
  return { total, usual, change: usual > 0 ? total / usual - 1 : null };
}

export interface EraComparison {
  early: [number, number];
  late: [number, number];
  /** How much busier the later years look when the files are simply stacked. */
  stackedChange: number | null;
  /** The same comparison once both eras are in VIIRS units. */
  harmonizedChange: number | null;
}

const EARLY: [number, number] = [2002, 2011];
const LATE: [number, number] = [2012, 2021];

function meanOver(totals: YearTotal[], [first, last]: [number, number], pick: (t: YearTotal) => number): number | null {
  // A year with missing months would pull the mean down for no fire-related reason.
  const years = totals.filter((t) => t.year >= first && t.year <= last && t.months === 12);
  if (years.length === 0) return null;
  return years.reduce((sum, t) => sum + pick(t), 0) / years.length;
}

/**
 * The jump the satellite change puts into raw counts: the VIIRS era against the
 * MODIS-only era, stacked and harmonized. The difference between the two is the
 * part of the "increase" that is the instrument, not the fire.
 */
export function eraComparison(totals: YearTotal[], early = EARLY, late = LATE): EraComparison {
  const change = (pick: (t: YearTotal) => number) => {
    const before = meanOver(totals, early, pick);
    const after = meanOver(totals, late, pick);
    return before === null || after === null || before <= 0 ? null : after / before - 1;
  };
  return {
    early,
    late,
    stackedChange: change((t) => t.stacked),
    harmonizedChange: change((t) => t.harmonized),
  };
}
