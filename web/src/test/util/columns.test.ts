import { describe, expect, it } from "vitest";
import { cellAlpha, columnScale } from "../../util/columns";

describe("columnScale", () => {
  it("stands at full height from afar and halves per zoom level close up", () => {
    expect(columnScale(4)).toBe(1);
    expect(columnScale(5.5)).toBe(1);
    expect(columnScale(6.5)).toBe(0.5);
    expect(columnScale(9.5)).toBeCloseTo(1 / 16);
  });
});

describe("cellAlpha", () => {
  it("lets the ground show through, more solid the more fire", () => {
    expect(cellAlpha(0)).toBe(100);
    expect(cellAlpha(1)).toBe(230);
    expect(cellAlpha(2)).toBe(230);
    expect(cellAlpha(Number.NaN)).toBe(100);
  });
});
