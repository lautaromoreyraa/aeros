import type { CalendarRecord, CellsMonthly, HarmonizedSource } from "../api/types";
import { parseMonth, yearOf, monthOfYear } from "./months";

/** z-score of a two-sided 90 % interval, the same constant the model uses. */
export const Z90 = 1.6448536269514722;

export interface MonthTotals {
  harmonized: number;
  /** Sum over cells of each cell's own variance (noise + its shared term squared). */
  cellVariance: number;
  /** Sum over cells of harmonized squared, used to rebuild the shared term. */
  harmonizedSquares: number;
  stacked: number;
}

/** Adds up the cells of an area, month by month. Months without hotspots stay at zero. */
export function sumCells(data: CellsMonthly, cells: ReadonlySet<string> | null): MonthTotals[] {
  const totals: MonthTotals[] = data.months.map(() => ({
    harmonized: 0,
    cellVariance: 0,
    harmonizedSquares: 0,
    stacked: 0,
  }));
  for (const { cell, values } of data.cells) {
    if (cells && !cells.has(cell)) continue;
    for (const [index, harmonized, variance, stacked] of values) {
      const total = totals[index];
      if (!total) continue;
      total.harmonized += harmonized;
      total.cellVariance += variance;
      total.harmonizedSquares += harmonized * harmonized;
      total.stacked += stacked;
    }
  }
  return totals;
}

/**
 * Per month, the squared coefficient k² of the systematic error shared by all
 * cells, recovered from the region calendar.
 *
 * The model's area variance is Σvᵢ + (Σsᵢ)², but each cell only ships
 * vᵢ + sᵢ². Assuming the shared sd is proportional to the harmonized count
 * (sᵢ = k·hᵢ, a common relative error for the month), the region interval gives
 * region_var − Σ(vᵢ + sᵢ²) = k²·(H² − Σhᵢ²), which is solved for k². With it, a
 * sub-area gets the shared term back instead of an interval that would be far
 * too narrow, and the whole region reproduces the model's interval exactly.
 */
export function sharedErrorCoefficients(region: CalendarRecord[], all: MonthTotals[]): number[] {
  return all.map((total, index) => {
    const record = region[index];
    if (!record) return 0;
    const half = record.high - record.harmonized;
    const regionVariance = (half / Z90) ** 2;
    const cross = total.harmonized ** 2 - total.harmonizedSquares;
    if (cross <= 0) return 0;
    return Math.max(0, (regionVariance - total.cellVariance) / cross);
  });
}

/** Variance of an area's monthly total, including the shared systematic term. */
export function areaVariance(total: MonthTotals, sharedK2: number): number {
  const cross = total.harmonized ** 2 - total.harmonizedSquares;
  return total.cellVariance + sharedK2 * Math.max(0, cross);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface AnomalyInput {
  year: number;
  month_of_year: number;
  harmonized: number;
}

export interface Anomaly {
  median_same_month: number | null;
  anomaly: number | null;
  anomaly_ratio: number | null;
}

/**
 * Anomaly of each month against the median of the same calendar month in every
 * *other* year. Leaving the month out keeps an extreme season from defining its
 * own "normal"; the median rather than the mean keeps one extreme year from
 * dragging everyone else's reference.
 */
export function leaveOneOutAnomalies(rows: AnomalyInput[], openIndex: number | null = null): Anomaly[] {
  const byMonth = new Map<number, number[]>();
  rows.forEach((row, index) => {
    const list = byMonth.get(row.month_of_year) ?? [];
    list.push(index);
    byMonth.set(row.month_of_year, list);
  });
  const result: Anomaly[] = rows.map(() => ({ median_same_month: null, anomaly: null, anomaly_ratio: null }));
  for (const indices of byMonth.values()) {
    for (const index of indices) {
      // The month in progress is no one's reference, and is shown its usual but not compared.
      const others = indices.filter((other) => other !== index && other !== openIndex).map((other) => rows[other]!.harmonized);
      const reference = median(others);
      const value = rows[index]!.harmonized;
      if (index === openIndex) {
        result[index] = { median_same_month: reference, anomaly: null, anomaly_ratio: null };
        continue;
      }
      result[index] = {
        median_same_month: reference,
        anomaly: reference === null ? null : value - reference,
        anomaly_ratio: reference === null || reference <= 0 ? null : value / reference,
      };
    }
  }
  return result;
}

/** Index of the newest month of a chronological series, or null when empty. */
function lastIndex(rows: { year: number; month_of_year: number }[]): number | null {
  let best: number | null = null;
  rows.forEach((row, index) => {
    const previous = best === null ? null : rows[best]!;
    if (!previous || row.year * 12 + row.month_of_year > previous.year * 12 + previous.month_of_year) best = index;
  });
  return best;
}

/**
 * The newest month of the record is the one the data is still arriving for:
 * the pipeline runs during it, so it holds a part of its days. Compared with
 * whole months it would always look "below the usual", and it would pull the
 * usual of that month down for every other year. It keeps its count, loses
 * its comparison, and is flagged so the page can say so.
 */
export function closeOpenMonth(records: CalendarRecord[]): CalendarRecord[] {
  const open = lastIndex(records);
  if (open === null) return records;
  const anomalies = leaveOneOutAnomalies(records, open);
  return records.map((record, index) => ({ ...record, ...anomalies[index]!, in_progress: index === open }));
}

/**
 * Burning calendar of an area, computed the same way the model computes the
 * region one. `cells = null` is the whole region and returns the model's own
 * records untouched.
 */
export function aggregateCalendar(
  data: CellsMonthly,
  region: CalendarRecord[],
  cells: ReadonlySet<string> | null,
): CalendarRecord[] {
  if (cells === null) return region;
  const all = sumCells(data, null);
  const k2 = sharedErrorCoefficients(region, all);
  const area = sumCells(data, cells);
  const base = area.map((total, index) => {
    const key = parseMonth(data.months[index] ?? "") ?? 0;
    const variance = areaVariance(total, k2[index] ?? 0);
    const half = Z90 * Math.sqrt(Math.max(0, variance));
    const source: HarmonizedSource | string = region[index]?.source ?? "observed";
    return {
      year: yearOf(key),
      month_of_year: monthOfYear(key),
      harmonized: total.harmonized,
      low: Math.max(0, total.harmonized - half),
      high: total.harmonized + half,
      stacked_raw: total.stacked,
      unattached: 0,
      source,
    };
  });
  const open = lastIndex(base);
  const anomalies = leaveOneOutAnomalies(base, open);
  return base.map((record, index) => ({ ...record, ...anomalies[index]!, in_progress: index === open }));
}

/** Per-cell total over a month range, for the extruded map layer. */
export interface CellTotal {
  cell: string;
  harmonized: number;
  stacked: number;
}

export function cellTotals(data: CellsMonthly, startIndex: number, endIndex: number): CellTotal[] {
  return data.cells.map(({ cell, values }) => {
    let harmonized = 0;
    let stacked = 0;
    for (const [index, value, , raw] of values) {
      if (index < startIndex || index > endIndex) continue;
      harmonized += value;
      stacked += raw;
    }
    return { cell, harmonized, stacked };
  });
}

/** Calendar records limited to an inclusive month range. */
export function inRange(records: CalendarRecord[], start: number, end: number): CalendarRecord[] {
  return records.filter((record) => {
    const key = record.year * 12 + record.month_of_year - 1;
    return key >= start && key <= end;
  });
}

export interface YearTotal {
  year: number;
  harmonized: number;
  low: number;
  high: number;
  stacked: number;
  months: number;
}

/** Yearly totals; interval bounds are added month by month, a conservative envelope. */
export function yearlyTotals(records: CalendarRecord[]): YearTotal[] {
  const byYear = new Map<number, YearTotal>();
  for (const record of records) {
    const total = byYear.get(record.year) ?? {
      year: record.year,
      harmonized: 0,
      low: 0,
      high: 0,
      stacked: 0,
      months: 0,
    };
    total.harmonized += record.harmonized;
    total.low += record.low;
    total.high += record.high;
    total.stacked += record.stacked_raw;
    total.months += 1;
    byYear.set(record.year, total);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}
