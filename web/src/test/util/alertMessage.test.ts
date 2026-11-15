import { describe, expect, it } from "vitest";
import type { EarlyWarning } from "../../api/types";
import { MAX_PLACES, alertMessage } from "../../util/alertMessage";
import { alertDecision } from "../../util/earlyWarning";

const CELL = "84b34c7ffffffff";

const report = (overrides: Partial<EarlyWarning> = {}): EarlyWarning => ({
  generated_at: "2026-11-13T06:00:00Z",
  window: ["2026-11-06", "2026-11-12"],
  days_with_data: ["2026-11-06", "2026-11-07", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"],
  region: { observed: 100, expected: 80, ratio: 1.25, p_value: 0.02 },
  cells: [],
  ...overrides,
});

const message = (data: EarlyWarning, sectors = [{ id: "py", name: "Chaco Boreal", place: "", cells: [CELL] }]) =>
  alertMessage(data, alertDecision(data), sectors);

describe("alertMessage", () => {
  it("says the week is calm and still reports the missing days", () => {
    expect(message(report())).toEqual({
      active: false,
      subject: "No early warning this week",
      window: "Nov 6 – Nov 12",
      places: [],
      more: 0,
      coverage: "Based on 6 of 7 days with satellite data; 1 day is missing, not quiet.",
    });
  });

  it("names the sector, the place and the excess of each flagged cell", () => {
    const result = message(report({ cells: [{ cell: CELL, observed: 10, expected: 1.04, ratio: 9.6, p_value: 1e-6 }] }));
    expect(result.active).toBe(true);
    expect(result.subject).toBe("Early warning: 1 area well above normal");
    expect(result.places).toHaveLength(1);
    expect(result.places[0]).toMatch(/^Chaco Boreal, \d+\.\d° S, \d+\.\d° W: 9\.6× the usual \(10 hotspots, 1\.0 expected\)$/);
  });

  it("falls back to the region name for a cell outside every sector", () => {
    const result = message(report({ cells: [{ cell: CELL, observed: 10, expected: 2, ratio: 5, p_value: 1e-6 }] }), []);
    expect(result.places[0]).toMatch(/^Study region, /);
  });

  it("puts the region first when it alerts too, and counts the places left out", () => {
    const cells = Array.from({ length: MAX_PLACES + 2 }, (_, index) => ({
      cell: CELL,
      observed: 20 - index,
      expected: 2,
      ratio: (20 - index) / 2,
      p_value: 1e-6,
    }));
    const result = message(report({ region: { observed: 300, expected: 100, ratio: 3, p_value: 1e-9 }, cells }));
    expect(result.subject).toBe("Early warning: the region is burning at 3.0× the usual and 5 areas well above normal");
    expect(result.places).toHaveLength(MAX_PLACES);
    expect(result.more).toBe(2);
  });
});
