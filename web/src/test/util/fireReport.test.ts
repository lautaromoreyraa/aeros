import { describe as group, expect, it } from "vitest";
import { type FireCheck, ago, describe, fireCheckUrl, parsePoint } from "../../util/fireReport";

const NOW = new Date("2026-11-15T18:00:00Z");

const base: FireCheck = {
  verdict: "not_seen",
  point: { lat: -25, lon: -61 },
  radius_km: 15,
  checked_at: "2026-11-15T18:00:00Z",
  emergency: [{ country: "Argentina", number: "100" }],
  goes: { available: true, fresh: true, nearest: null },
  polar: { lookback_hours: 48, detections: 0, nearest: null },
};

group("parsePoint", () => {
  it("reads a typed latitude and longitude", () => {
    expect(parsePoint(" -25.3, -60.9 ")).toEqual({ lat: -25.3, lon: -60.9 });
    expect(parsePoint("-25.3 -60.9")).toEqual({ lat: -25.3, lon: -60.9 });
    expect(parsePoint("-25.3;-60.9")).toEqual({ lat: -25.3, lon: -60.9 });
  });

  it("refuses anything that is not a point", () => {
    for (const bad of ["", "Resistencia", "-25.3", "1, 2, 3", "95, 0", "0, 200", "a, b"])
      expect(parsePoint(bad)).toBeNull();
  });
});

it("builds the check URL without a doubled slash", () => {
  expect(fireCheckUrl("/api/", -25.123456789, -61)).toBe("/api/alerts/fire-check?lat=-25.123&lon=-61.000");
});

it("says how long ago in minutes, then hours", () => {
  expect(ago("2026-11-15T17:48:00Z", NOW)).toBe("12 min ago");
  expect(ago("2026-11-15T05:30:00Z", NOW)).toBe("12 h ago");
  expect(ago(null, NOW)).toBe("");
});

group("describe", () => {
  it("never reads 'not seen' as 'no fire'", () => {
    const { title, lines } = describe(base, NOW);
    expect(title).toBe("No satellite saw fire near you");
    expect(lines[0]).toContain("does not mean there is no fire");
  });

  it("names the satellite and the distance of what was seen", () => {
    const seen = describe(
      {
        ...base,
        verdict: "seen_recently",
        polar: {
          lookback_hours: 48,
          detections: 3,
          nearest: { distance_km: 2.4, when: "2026-11-15T05:30:00Z", satellite: "NOAA-21", confident: true },
        },
      },
      NOW,
    );
    expect(seen.lines[0]).toBe(
      "NOAA-21 saw fire 2.4 km away, 12 h ago (3 detections within 15 km in the last 48 h).",
    );
  });

  it("says GOES sees heat right now", () => {
    const now = describe(
      {
        ...base,
        verdict: "seen_now",
        goes: { available: true, fresh: true, nearest: { distance_km: 4.1, last_seen: "2026-11-15T17:50:00Z", confident: true } },
      },
      NOW,
    );
    expect(now.title).toContain("right now");
    expect(now.lines[0]).toContain("4.1 km away");
  });

  it("does not turn missing data into 'nothing seen'", () => {
    const { title, lines } = describe({ ...base, verdict: "unknown" }, NOW);
    expect(title).toBe("Could not check that point");
    expect(lines.join(" ")).not.toContain("No satellite saw");
  });

  it("tells a point outside the study area apart", () => {
    expect(describe({ ...base, verdict: "outside" }, NOW).title).toBe("Outside the area aeros watches");
  });
});
