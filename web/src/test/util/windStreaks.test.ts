import { describe, expect, it } from "vitest";
import { WebMercatorViewport } from "@deck.gl/core";
import { windStroke, type WindField, type WindGrid } from "../../util/wind";
import {
  DENSITY,
  MAX_AGE,
  MAX_STREAKS,
  MIN_STREAKS,
  TRAIL_POINTS,
  TRAIL_STEP,
  advance,
  degreesPerPixel,
  mark,
  spawn,
  spawnBox,
  stillPicture,
  streakCount,
  toScreen,
  windDrift,
  type GeoBox,
  type Streak,
} from "../../util/windStreaks";

const grid: WindGrid = { west: -62, south: -26, east: -60, north: -24, nx: 2, ny: 2 };

const field = (u: number, v: number): WindField => ({
  generated_at: "2026-11-14T18:00:00Z",
  source: "test",
  grid,
  hours: ["2026-11-14T18:00:00Z"],
  u: [[u, u, u, u]],
  v: [[v, v, v, v]],
});

const streak = (lng = -61, lat = -25): Streak => ({ lng, lat, age: 0, speed: 0, trail: [] });

describe("degreesPerPixel", () => {
  it("is 360/512 at zoom 0 and halves at each deeper zoom", () => {
    expect(degreesPerPixel(0)).toBeCloseTo(360 / 512);
    expect(degreesPerPixel(4)).toBeCloseTo(degreesPerPixel(0) / 16);
  });
});

describe("windDrift", () => {
  it("moves with the wind's own direction and keeps the screen pace", () => {
    const [eastLng, eastLat] = windDrift(5, 0, -25, 4, 1);
    expect(eastLng).toBeGreaterThan(0);
    expect(eastLat).toBeCloseTo(0);
    const [northLng, northLat] = windDrift(0, 5, -25, 4, 1);
    expect(northLng).toBeCloseTo(0);
    expect(northLat).toBeGreaterThan(0);
    expect(windDrift(0, 0, -25, 4, 1)).toEqual([0, 0]);
    const [nearLng] = windDrift(5, 0, -25, 5, 1);
    expect(nearLng).toBeCloseTo(eastLng / 2);
    // The pace on screen is the stroke's pixels per second at any zoom.
    expect(eastLng / degreesPerPixel(4)).toBeCloseTo(windStroke(5).pixels * 60);
  });

  it("needs fewer degrees north the further from the equator", () => {
    const [, atSixty] = windDrift(0, 5, 60, 4, 1);
    const [, atEquator] = windDrift(0, 5, 0, 4, 1);
    expect(atSixty).toBeCloseTo(atEquator / 2);
  });
});

describe("spawnBox", () => {
  it("intersects the field's box with what the camera sees", () => {
    expect(spawnBox(grid, [-61, -25.5, -59, -24])).toEqual([-61, -25.5, -60, -24]);
    expect(spawnBox(grid, [-180, -90, 180, 90])).toEqual([-62, -26, -60, -24]);
    expect(spawnBox(grid, [-50, -20, -40, -10])).toBeNull();
  });
});

describe("streakCount", () => {
  it("grows with the visible area, between the clamps", () => {
    const small = streakCount([-62, -26, -58, -18], 6, 1216, 599);
    const wide = streakCount([-62, -26, -54, -18], 6, 1216, 599);
    expect(wide).toBeGreaterThan(small * 1.5);
    expect(wide).toBeLessThanOrEqual(MAX_STREAKS);
  });
  it("never drops under the minimum while field is in view", () => {
    expect(streakCount([-61, -25.01, -60.99, -25], 4, 1216, 599)).toBe(MIN_STREAKS);
    expect(streakCount([-180, -90, 180, 90], 30, 4000, 3000)).toBe(MAX_STREAKS);
  });
  it("caps the count by the canvas area when the box is far larger", () => {
    const capped = streakCount([-180, -80, 180, 80], 2, 800, 600);
    expect(capped).toBe(Math.round(((800 * 600) / 10000) * DENSITY));
  });
});

describe("spawn", () => {
  it("lands uniform in the box with a fresh tail and a random age", () => {
    const s = streak(0, 0);
    s.trail = [1, 2];
    spawn(s, [-62, -26, -60, -24], () => 0.5);
    expect(s.lng).toBeCloseTo(-61);
    expect(s.lat).toBeCloseTo(-25);
    expect(s.trail).toEqual([]);
    expect(s.speed).toBe(0);
    expect(s.age).toBeGreaterThanOrEqual(0);
    expect(s.age).toBeLessThan(MAX_AGE);
  });
});

describe("advance and mark", () => {
  it("moves the streak with the wind and remembers its tail", () => {
    const wind = field(5, 0);
    const s = streak();
    expect(advance(s, wind, 0, 4, TRAIL_STEP)).toBe(true);
    expect(s.lng).toBeGreaterThan(-61);
    expect(s.lat).toBeCloseTo(-25);
    expect(s.speed).toBeCloseTo(5);
    for (let i = 0; i < TRAIL_POINTS + 5; i++) {
      mark(s);
      advance(s, wind, 0, 4, TRAIL_STEP);
    }
    expect(s.trail.length).toBe(TRAIL_POINTS * 2);
    const lngs = s.trail.filter((_, i) => i % 2 === 0);
    expect([...lngs].sort((a, b) => a - b)).toEqual(lngs);
  });

  it("returns false outside the grid and once the age passes", () => {
    const wind = field(5, 0);
    const outside = streak(-70, -25);
    expect(advance(outside, wind, 0, 4, TRAIL_STEP)).toBe(false);
    const old = streak();
    old.age = MAX_AGE;
    expect(advance(old, wind, 0, 4, TRAIL_STEP)).toBe(false);
  });
});

describe("stillPicture", () => {
  it("builds count streaks whose tails run with the wind, all inside the box", () => {
    const lcg = () => {
      let seed = 42;
      return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    };
    const wind = field(5, 0);
    const box: GeoBox = [-62, -26, -60, -24];
    const streaks = stillPicture(10, box, wind, 0, 4, lcg());
    expect(streaks.length).toBe(10);
    for (const s of streaks) {
      expect(s.lng).toBeGreaterThanOrEqual(box[0]);
      expect(s.lng).toBeLessThanOrEqual(box[2]);
      expect(s.lat).toBeGreaterThanOrEqual(box[1]);
      expect(s.lat).toBeLessThanOrEqual(box[3]);
      if (s.trail.length >= 4) {
        const lngs = s.trail.filter((_, i) => i % 2 === 0);
        expect(s.lng).toBeGreaterThan(lngs[lngs.length - 1]!);
        expect([...lngs].sort((a, b) => a - b)).toEqual(lngs);
      }
    }
    expect(stillPicture(10, box, wind, 0, 4, lcg()).map((s) => s.lng)).toEqual(streaks.map((s) => s.lng));
  });
});

describe("toScreen", () => {
  const viewport = new WebMercatorViewport({ width: 1216, height: 599, longitude: -61, latitude: -24, zoom: 5.3, pitch: 45, bearing: -12 });
  it("matches the viewport's own projection within a micro", () => {
    const matrix = viewport.pixelProjectionMatrix;
    for (const [lng, lat] of [[-61, -24], [-60.5, -23.8], [-61.7, -24.6]] as const) {
      const [x, y] = toScreen(matrix, lng, lat);
      const [px, py] = viewport.project([lng, lat]) as [number, number];
      expect(x).toBeCloseTo(px, 6);
      expect(y).toBeCloseTo(py, 6);
    }
  });
  it("doubles a point's distance from the centre one zoom deeper, flat", () => {
    const flat = new WebMercatorViewport({ width: 800, height: 600, longitude: -61, latitude: -24, zoom: 4 });
    const deep = new WebMercatorViewport({ width: 800, height: 600, longitude: -61, latitude: -24, zoom: 5 });
    const centre: [number, number] = [400, 300];
    const [x1, y1] = toScreen(flat.pixelProjectionMatrix, -60, -24);
    const [x2, y2] = toScreen(deep.pixelProjectionMatrix, -60, -24);
    expect(x2 - centre[0]).toBeCloseTo((x1 - centre[0]) * 2, 3);
    expect(y2 - centre[1]).toBeCloseTo((y1 - centre[1]) * 2, 3);
  });
});
