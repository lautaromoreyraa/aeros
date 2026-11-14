import type { Forecast, ForecastWeek } from "../api/types";
import { DIVERGING, ratioScale, sampleRamp, type Rgb } from "./colorRamp";

/** z for a two-sided 90 % interval, the one the model writes. */
export const Z90 = 1.6448536269514722;
/** The model never lets a cell's Poisson variance fall below this rate. */
export const RATE_FLOOR = 0.05;

/**
 * The model's interval for any set of cells: quasi-Poisson noise that adds up
 * cell by cell, plus a systematic error shared by the whole week that grows
 * with the total, so `half = z·√(d·Σ max(eᵢ, floor) + s·(Σeᵢ)²)`.
 */
export interface IntervalModel {
  dispersion: number;
  systematic: number;
}

/**
 * Recovers `d` and `s` from the per-cell intervals by least squares on
 * `(half/z)² = d·max(e, floor) + s·e²`. Only the upper half is used, since
 * the lower one is clipped at zero. Both terms must be non-negative; when the
 * unconstrained fit makes one negative, it is dropped and the other refitted.
 */
export function fitIntervalModel(forecast: Forecast): IntervalModel {
  let aa = 0;
  let ab = 0;
  let bb = 0;
  let ay = 0;
  let by = 0;
  for (const cell of forecast.cells) {
    for (const [, expected, , high] of cell.values) {
      const half = high - expected;
      if (!(half >= 0)) continue;
      const a = Math.max(expected, RATE_FLOOR);
      const b = expected * expected;
      const y = (half / Z90) ** 2;
      aa += a * a;
      ab += a * b;
      bb += b * b;
      ay += a * y;
      by += b * y;
    }
  }
  const det = aa * bb - ab * ab;
  if (det > 1e-12) {
    const dispersion = (ay * bb - by * ab) / det;
    const systematic = (aa * by - ab * ay) / det;
    if (dispersion >= 0 && systematic >= 0) return { dispersion, systematic };
  }
  const onlyDispersion = aa > 0 ? Math.max(0, ay / aa) : 0;
  const onlySystematic = bb > 0 ? Math.max(0, by / bb) : 0;
  // Pick whichever single term explains more of the squared half-widths.
  const residual = (d: number, s: number) =>
    forecast.cells.reduce(
      (sum, cell) =>
        sum +
        cell.values.reduce((inner, [, e, , high]) => {
          const predicted = d * Math.max(e, RATE_FLOOR) + s * e * e;
          return inner + (((high - e) / Z90) ** 2 - predicted) ** 2;
        }, 0),
      0,
    );
  return residual(onlyDispersion, 0) <= residual(0, onlySystematic)
    ? { dispersion: onlyDispersion, systematic: 0 }
    : { dispersion: 0, systematic: onlySystematic };
}

/** Interval for a total of `expected` built from cells whose floored rates add up to `rateSum`. */
export function bandFor(expected: number, rateSum: number, model: IntervalModel): { low: number; high: number } {
  const half = Z90 * Math.sqrt(Math.max(0, model.dispersion * rateSum + model.systematic * expected * expected));
  return { low: Math.max(0, expected - half), high: expected + half };
}

/**
 * Weekly forecast for an area. The whole region uses the model's own rows;
 * a sub-area adds its cells up and rebuilds the interval with the recovered
 * interval model (adding the cells' bounds would ignore that most noise
 * cancels out, and adding variances would ignore the shared error).
 *
 * A cell's climatology is `expected / ratio`; cells without a ratio had no
 * fire in that week in earlier years, so their climatology is zero.
 */
export function areaForecast(
  forecast: Forecast,
  selection: ReadonlySet<string> | null,
  model: IntervalModel = fitIntervalModel(forecast),
): ForecastWeek[] {
  const region = [...forecast.region].sort((a, b) => a.horizon - b.horizon);
  if (selection === null) return region;
  return region.map((week) => {
    let expected = 0;
    let rateSum = 0;
    let climatology = 0;
    for (const cell of forecast.cells) {
      if (!selection.has(cell.cell)) continue;
      const row = cell.values.find((value) => value[0] === week.horizon);
      if (!row) continue;
      const [, e, , , ratio] = row;
      expected += e;
      rateSum += Math.max(e, RATE_FLOOR);
      if (ratio !== null && ratio > 0) climatology += e / ratio;
    }
    return { ...week, expected, climatology, ...bandFor(expected, rateSum, model) };
  });
}

/** Colour for the map: blue below the usual, grey near it, orange above. */
export function ratioColor(ratio: number | null, expected: number): Rgb {
  if (ratio === null) {
    // No fire in that week in earlier years: any expected activity is unusual.
    return expected > RATE_FLOOR ? DIVERGING[DIVERGING.length - 1]! : DIVERGING[Math.floor(DIVERGING.length / 2)]!;
  }
  return sampleRamp(DIVERGING, ratioScale(ratio));
}

export type Outlook = "above" | "near" | "below";

/**
 * Where the forecast sits against climatology, judged by its interval, not
 * its point value: "above" only if even the low end exceeds the usual.
 */
export function outlookOf(week: Pick<ForecastWeek, "low" | "high" | "climatology">): Outlook {
  if (week.low > week.climatology) return "above";
  if (week.high < week.climatology) return "below";
  return "near";
}

/** "Nov 16 – 22" for the week starting on a Monday given as "YYYY-MM-DD". */
export function weekLabel(weekStart: string): string {
  const start = Date.parse(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(start)) return weekStart;
  const end = start + 6 * 86_400_000;
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
  const day = (time: number) => new Date(time).getUTCDate();
  return month.format(start) === month.format(end)
    ? `${month.format(start)} ${day(start)} – ${day(end)}`
    : `${month.format(start)} ${day(start)} – ${month.format(end)} ${day(end)}`;
}
