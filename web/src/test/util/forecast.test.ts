import { describe, expect, it } from "vitest";
import type { Forecast, ForecastCellRow } from "../../api/types";
import { DIVERGING } from "../../util/colorRamp";
import {
  RATE_FLOOR,
  Z90,
  areaForecast,
  bandFor,
  fitIntervalModel,
  outlookOf,
  ratioColor,
  weekLabel,
} from "../../util/forecast";

const D = 1.8;
const S = 0.04;
const half = (e: number) => Z90 * Math.sqrt(D * Math.max(e, RATE_FLOOR) + S * e * e);

/** Built exactly as the model writes it, so the recovered band can be checked against the region rows. */
function synthetic(): Forecast {
  const expectedByCell: Record<string, [number, number][]> = {
    a: [[1, 10], [2, 8]],
    b: [[1, 2], [2, 3]],
    c: [[1, 0.5], [2, 0]],
  };
  const climatology: Record<string, number> = { a: 5, b: 4, c: 0 };
  const cells = Object.entries(expectedByCell).map(([cell, rows]) => ({
    cell,
    values: rows.map(([h, e]): ForecastCellRow => [
      h,
      e,
      Math.max(0, e - half(e)),
      e + half(e),
      climatology[cell]! > 0 ? e / climatology[cell]! : null,
    ]),
  }));
  const region = [1, 2].map((h) => {
    const es = Object.values(expectedByCell).map((rows) => rows.find(([horizon]) => horizon === h)![1]);
    const expected = es.reduce((a, b) => a + b, 0);
    const rate = es.reduce((a, e) => a + Math.max(e, RATE_FLOOR), 0);
    const w = Z90 * Math.sqrt(D * rate + S * expected * expected);
    return {
      week_start: h === 1 ? "2026-11-16" : "2026-11-23",
      horizon: h,
      expected,
      low: Math.max(0, expected - w),
      high: expected + w,
      climatology: 9,
    };
  });
  return { issued_week: "2026-11-09", unit: "hotspots", horizons: [1, 2], region, cells };
}

describe("fitIntervalModel", () => {
  it("recovers the dispersion and the shared systematic term", () => {
    const model = fitIntervalModel(synthetic());
    expect(model.dispersion).toBeCloseTo(D, 6);
    expect(model.systematic).toBeCloseTo(S, 6);
  });

  it("never returns a negative term", () => {
    const forecast = synthetic();
    // Pure Poisson-like widths: no shared error at all.
    forecast.cells = [{ cell: "x", values: [[1, 4, 0, 4 + Z90 * 2, null], [2, 9, 0, 9 + Z90 * 3, null]] }];
    const model = fitIntervalModel(forecast);
    expect(model.systematic).toBeGreaterThanOrEqual(0);
    expect(model.dispersion).toBeCloseTo(1, 6);
  });
});

describe("bandFor", () => {
  it("clips the lower bound at zero", () => {
    expect(bandFor(0.2, 0.2, { dispersion: 2, systematic: 0 }).low).toBe(0);
  });

  it("is narrower than adding the cells' bounds", () => {
    const model = { dispersion: D, systematic: S };
    const combined = bandFor(20, 20, model);
    expect(combined.high - 20).toBeLessThan(2 * half(10));
  });
});

describe("areaForecast", () => {
  it("returns the model's region rows for the whole region", () => {
    const forecast = synthetic();
    expect(areaForecast(forecast, null)).toEqual(forecast.region);
  });

  it("rebuilds the region band exactly from all of its cells", () => {
    const forecast = synthetic();
    const all = areaForecast(forecast, new Set(["a", "b", "c"]));
    all.forEach((week, index) => {
      expect(week.expected).toBeCloseTo(forecast.region[index]!.expected, 9);
      expect(week.low).toBeCloseTo(forecast.region[index]!.low, 6);
      expect(week.high).toBeCloseTo(forecast.region[index]!.high, 6);
    });
  });

  it("adds a sub-area's expected values and climatology", () => {
    const [week1, week2] = areaForecast(synthetic(), new Set(["a", "c"]));
    expect(week1!.expected).toBeCloseTo(10.5);
    // Cell c never burned in that week before: it adds nothing to climatology.
    expect(week1!.climatology).toBeCloseTo(5);
    expect(week2!.expected).toBeCloseTo(8);
    expect(week1!.low).toBeLessThan(week1!.expected);
    expect(week1!.high).toBeGreaterThan(week1!.expected);
  });

  it("is zero for an area without forecast cells", () => {
    const [week] = areaForecast(synthetic(), new Set(["nowhere"]));
    expect(week).toMatchObject({ expected: 0, climatology: 0, low: 0 });
  });
});

describe("ratioColor", () => {
  it("is neutral at the usual value and diverges symmetrically", () => {
    expect(ratioColor(1, 3)).toEqual(DIVERGING[3]);
    expect(ratioColor(4, 3)).toEqual(DIVERGING[6]);
    expect(ratioColor(0.25, 3)).toEqual(DIVERGING[0]);
  });

  it("treats activity where none was usual as above normal", () => {
    expect(ratioColor(null, 2)).toEqual(DIVERGING[6]);
    expect(ratioColor(null, 0)).toEqual(DIVERGING[3]);
  });
});

describe("outlookOf and weekLabel", () => {
  it("judges by the interval, not the point value", () => {
    expect(outlookOf({ low: 12, high: 30, climatology: 10 })).toBe("above");
    expect(outlookOf({ low: 8, high: 30, climatology: 10 })).toBe("near");
    expect(outlookOf({ low: 1, high: 9, climatology: 10 })).toBe("below");
  });

  it("labels a Monday-to-Sunday week, across a month end too", () => {
    expect(weekLabel("2026-11-16")).toBe("Nov 16 – 22");
    expect(weekLabel("2026-11-30")).toBe("Nov 30 – Dec 6");
  });
});
