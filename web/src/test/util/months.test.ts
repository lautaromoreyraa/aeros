import { describe, expect, it } from "vitest";
import { clampMonth, formatMonth, monthKey, monthOfYear, parseMonth, yearOf } from "../../util/months";

describe("month keys", () => {
  it("round-trips through the YYYY-MM text form", () => {
    const key = parseMonth("2012-01")!;
    expect(key).toBe(monthKey(2012, 1));
    expect(formatMonth(key)).toBe("2012-01");
    expect(yearOf(key)).toBe(2012);
    expect(monthOfYear(key)).toBe(1);
  });

  it("orders December before the next January", () => {
    expect(parseMonth("2012-01")! - parseMonth("2011-12")!).toBe(1);
  });

  it("rejects malformed months", () => {
    expect(parseMonth("2012-13")).toBeNull();
    expect(parseMonth("2012-1")).toBeNull();
    expect(parseMonth("")).toBeNull();
  });

  it("clamps to the available range", () => {
    expect(clampMonth(5, 10, 20)).toBe(10);
    expect(clampMonth(25, 10, 20)).toBe(20);
  });
});
