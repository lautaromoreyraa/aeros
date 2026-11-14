import { describe, expect, it } from "vitest";
import { coverageOf, formatCount, formatRatio, formatSigned, unitLabel } from "../../util/format";

describe("coverageOf", () => {
  it("maps every source code to a coverage level", () => {
    expect(coverageOf("observed")).toBe("observed");
    expect(coverageOf("bridged")).toBe("bridged");
    expect(coverageOf("modeled_terra_aqua")).toBe("modeled");
    expect(coverageOf("modeled_terra")).toBe("modeled");
  });
});

describe("number formats", () => {
  it("rounds counts and signs differences", () => {
    expect(formatCount(1234.6)).toBe("1,235");
    expect(formatCount(null)).toBe("—");
    expect(formatSigned(12.4)).toBe("+12");
    expect(formatSigned(-3)).toBe("-3");
    expect(formatRatio(1.43)).toBe("1.4×");
    expect(formatRatio(12.2)).toBe("12×");
  });

  it("names both units", () => {
    expect(unitLabel("hotspots")).toBe("hotspots");
    expect(unitLabel("cell_days", "one")).toBe("fire cell-day");
  });
});
