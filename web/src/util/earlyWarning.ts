import type { EarlyWarning, EarlyWarningScore } from "../api/types";

/** A region-wide alert needs both a large excess and strong evidence for it. */
export const REGION_RATIO_THRESHOLD = 2;
export const ALPHA = 0.01;

export interface AlertDecision {
  active: boolean;
  /** The whole region is burning at least twice the usual, significantly. */
  region: boolean;
  /** Cells that passed the per-cell test, most significant first. */
  cells: EarlyWarning["cells"];
}

export function regionIsAlerting(region: EarlyWarningScore | null, alpha = ALPHA): boolean {
  return region !== null && region.ratio !== null && region.ratio >= REGION_RATIO_THRESHOLD && region.p_value < alpha;
}

/**
 * Whether the early warning should raise a banner. The refresh only lists
 * flagged cells, but the filter is repeated here so a report written with a
 * looser threshold cannot raise an alert the UI would not stand behind.
 */
export function alertDecision(report: EarlyWarning | null): AlertDecision {
  if (!report) return { active: false, region: false, cells: [] };
  const alpha = typeof report.method?.alpha === "number" ? report.method.alpha : ALPHA;
  const region = regionIsAlerting(report.region, alpha);
  const cells = report.cells
    .filter((cell) => cell.p_value < alpha && cell.observed > cell.expected)
    .sort((a, b) => a.p_value - b.p_value || b.observed - a.observed);
  return { active: region || cells.length > 0, region, cells };
}

/** Every day from `start` to `end`, inclusive, as "YYYY-MM-DD" (UTC). */
export function daysBetween(start: string, end: string): string[] {
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return [];
  const days: string[] = [];
  for (let time = first; time <= last; time += 86_400_000) days.push(new Date(time).toISOString().slice(0, 10));
  return days;
}

export interface WindowCoverage {
  windowDays: number;
  dataDays: number;
  /** Dates of the gap days; empty when the report only gives a count. */
  gapDates: string[];
  gapCount: number;
}

/**
 * How much of the window actually had data. Gaps are outages or late
 * processing, so they must be shown as missing, never as quiet days.
 */
export function windowCoverage(report: EarlyWarning): WindowCoverage {
  const all = daysBetween(report.window[0], report.window[1]);
  if (typeof report.days_with_data === "number") {
    const dataDays = Math.min(report.days_with_data, all.length);
    return { windowDays: all.length, dataDays, gapDates: report.gap_days ?? [], gapCount: all.length - dataDays };
  }
  const withData = new Set(report.days_with_data);
  const gapDates = all.filter((day) => !withData.has(day));
  return { windowDays: all.length, dataDays: all.length - gapDates.length, gapDates, gapCount: gapDates.length };
}

/**
 * What the page says when nothing is flagged, claiming no more than the data
 * allows: a quiet result only covers the days that had satellite data, and a
 * missing regional result is told apart by its cause.
 */
export function calmMessage(report: EarlyWarning, coverage: WindowCoverage): { title: string; text: string } {
  const from = formatDay(report.window[0]);
  const to = formatDay(report.window[1]);
  if (report.region) {
    const days =
      coverage.gapCount === 0
        ? `Hotspots from ${from} to ${to}`
        : `Hotspots on the ${coverage.dataDays} of ${coverage.windowDays} days from ${from} to ${to} with satellite data`;
    return {
      title: "No unusual fire activity.",
      text: `${days} are within the range of earlier years, region-wide and in every cell.`,
    };
  }
  if (coverage.dataDays === 0)
    return {
      title: "Not enough data to judge.",
      text: "No satellite day in this window returned detections, so nothing can be said about fire activity yet.",
    };
  return {
    title: "Not enough data to judge.",
    text: "Detections came in, but there are no earlier years to compare them with yet, so nothing can be said about them.",
  };
}

/** "Nov 6" style label for a "YYYY-MM-DD" date, in UTC so the day never shifts. */
export function formatDay(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(time)) return day;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(time);
}

/** p-values span many orders of magnitude; below 0.001 the exact value says nothing more. */
export function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p < 0.001) return "p < 0.001";
  return `p = ${p.toFixed(3)}`;
}
