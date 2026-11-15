import { describe, expect, it } from "vitest";
import {
  BLAZE,
  DIVERGING,
  VIRIDIS,
  luminance,
  ratioScale,
  readableTextOn,
  sampleRamp,
  sqrtScale,
  toCss,
} from "../../util/colorRamp";

describe("sampleRamp", () => {
  it("returns the end stops at 0 and 1 and clamps outside", () => {
    expect(sampleRamp(VIRIDIS, 0)).toEqual(VIRIDIS[0]);
    expect(sampleRamp(VIRIDIS, 1)).toEqual(VIRIDIS[8]);
    expect(sampleRamp(VIRIDIS, -3)).toEqual(VIRIDIS[0]);
    expect(sampleRamp(VIRIDIS, 7)).toEqual(VIRIDIS[8]);
    expect(sampleRamp(VIRIDIS, Number.NaN)).toEqual(VIRIDIS[0]);
  });

  it("interpolates between neighbouring stops", () => {
    expect(sampleRamp([[0, 0, 0], [100, 200, 50]], 0.5)).toEqual([50, 100, 25]);
  });

  it("gets brighter monotonically along viridis, so it reads in greyscale", () => {
    const steps = Array.from({ length: 21 }, (_, i) => luminance(sampleRamp(VIRIDIS, i / 20)));
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThan(steps[i - 1]!);
  });
});

describe("scales", () => {
  it("compresses skewed counts with a square root", () => {
    expect(sqrtScale(25, 100)).toBe(0.5);
    expect(sqrtScale(0, 100)).toBe(0);
    expect(sqrtScale(10, 0)).toBe(0);
    expect(sqrtScale(500, 100)).toBe(1);
  });

  it("puts half and double the usual at the same distance from neutral", () => {
    expect(ratioScale(1)).toBe(0.5);
    expect(0.5 - ratioScale(0.5)).toBeCloseTo(ratioScale(2) - 0.5, 12);
    expect(ratioScale(16)).toBe(1);
    expect(ratioScale(0)).toBe(0);
    expect(ratioScale(null)).toBe(0.5);
  });

  it("has a neutral grey in the middle of the diverging ramp", () => {
    const [r, g, b] = sampleRamp(DIVERGING, 0.5);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("runs from bluish-white (null) through yellow (low) to red (high fire)", () => {
    // t=0: bluish-white — blue channel dominates, high lightness
    const [r0, g0, b0] = BLAZE[0]!;
    expect(b0).toBeGreaterThan(200);
    expect(r0).toBeGreaterThan(200);
    expect(g0).toBeGreaterThan(200);
    // t=1: red — red channel dominates
    const [rn, gn, bn] = BLAZE[BLAZE.length - 1]!;
    expect(rn).toBeGreaterThan(180);
    expect(gn).toBeLessThan(80);
    expect(bn).toBeLessThan(80);
    // mid-point (yellow): green and red both high, blue low
    const [rm, gm, bm] = sampleRamp(BLAZE, 0.33);
    expect(rm).toBeGreaterThan(220);
    expect(gm).toBeGreaterThan(170);
    expect(bm).toBeLessThan(80);
  });
});

describe("labels on swatches", () => {
  it("uses white on dark purple and black on yellow", () => {
    expect(readableTextOn(VIRIDIS[0]!)).toBe("#fff");
    expect(readableTextOn(VIRIDIS[8]!)).toBe("#000");
  });

  it("formats CSS colours", () => {
    expect(toCss([1, 2, 3])).toBe("rgb(1 2 3)");
    expect(toCss([1, 2, 3], 0.5)).toBe("rgb(1 2 3 / 0.5)");
  });
});
