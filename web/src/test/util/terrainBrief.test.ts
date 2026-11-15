import { describe, expect, it } from "vitest";
import type { EarlyWarning } from "../../api/types";
import type { AlertDecision } from "../../util/earlyWarning";
import { terrainBrief, timesUsual, worstLevel } from "../../util/terrainBrief";

const REPORT: EarlyWarning = {
  generated_at: "2026-11-14T06:00:00Z",
  window: ["2026-11-07", "2026-11-14"],
  days_with_data: ["2026-11-07"],
  gap_days: [],
  method: { alpha: 0.01 },
  region: { observed: 100, expected: 80, ratio: 1.25, p_value: 0.02 },
  cells: [],
};

const QUIET: AlertDecision = { active: false, region: false, cells: [] };

const cell = (id: string, ratio: number | null, observed = 10): AlertDecision["cells"][number] => ({
  cell: id,
  observed,
  expected: ratio ? observed / ratio : 1,
  ratio,
  p_value: 0.001,
});

describe("timesUsual", () => {
  it("rounds from 10 up and keeps one decimal below", () => {
    expect(timesUsual(14)).toBe("14× usual");
    expect(timesUsual(9.96)).toBe("10× usual");
    expect(timesUsual(2)).toBe("2× usual");
    expect(timesUsual(1.64)).toBe("1.6× usual");
  });

  it("drops a ratio that is missing or under one", () => {
    expect(timesUsual(null)).toBeNull();
    expect(timesUsual(0.4)).toBeNull();
  });
});

describe("worstLevel", () => {
  it("keeps the strongest level", () => {
    expect(worstLevel([null, "elevated", "high", "normal"])).toBe("high");
    expect(worstLevel([null])).toBeNull();
  });
});

describe("terrainBrief", () => {
  it("waits when there is no reading", () => {
    const brief = terrainBrief({ cellIds: ["a"], report: null, decision: QUIET, weather: "extreme" });
    expect(brief.tone).toBe("unknown");
    expect(brief.facts.map((fact) => fact.value)).toEqual(["No reading", "—", "Wait"]);
  });

  it("does not call a missing baseline an all-clear", () => {
    const brief = terrainBrief({
      cellIds: ["a"],
      report: { ...REPORT, region: null },
      decision: QUIET,
      weather: "extreme",
    });
    expect(brief.facts[2].value).toBe("Wait");
  });

  it("stands down when this week is in line with earlier years", () => {
    const brief = terrainBrief({ cellIds: ["a"], report: REPORT, decision: QUIET, weather: "elevated" });
    expect(brief.tone).toBe("quiet");
    expect(brief.facts.map((fact) => fact.value)).toEqual(["No alert", "As usual", "No action"]);
  });

  it("watches the weather when fire is usual and the next days are severe", () => {
    const brief = terrainBrief({ cellIds: ["a"], report: REPORT, decision: QUIET, weather: "extreme" });
    expect(brief.tone).toBe("watch");
    expect(brief.facts[0].value).toBe("No alert");
    expect(brief.facts[2].value).toBe("Watch weather");
  });

  it("asks for a look when fire is up but under twice the usual", () => {
    const decision: AlertDecision = { active: true, region: false, cells: [cell("a", 1.6)] };
    const brief = terrainBrief({ cellIds: ["a"], report: REPORT, decision, weather: "normal" });
    expect(brief.tone).toBe("watch");
    expect(brief.facts.map((fact) => fact.value)).toEqual(["Alert", "1.6× usual", "Check here"]);
  });

  it("sends a crew first at twice the usual", () => {
    const decision: AlertDecision = { active: true, region: false, cells: [cell("a", 14, 42)] };
    const brief = terrainBrief({ cellIds: ["a"], report: REPORT, decision, weather: null });
    expect(brief.tone).toBe("act");
    expect(brief.facts[1].value).toBe("14× usual");
    expect(brief.facts[2].value).toBe("Act first");
    expect(brief.facts[2].detail).toMatch(/twice the usual/);
  });

  it("sends a crew first when a smaller excess meets severe weather", () => {
    const decision: AlertDecision = { active: true, region: false, cells: [cell("a", 1.6)] };
    const brief = terrainBrief({ cellIds: ["a"], report: REPORT, decision, weather: "high" });
    expect(brief.facts[2].value).toBe("Act first");
    expect(brief.facts[2].detail).toMatch(/dry and windy/);
  });

  it("uses the largest excess when the zone holds several flagged cells", () => {
    const decision: AlertDecision = {
      active: true,
      region: false,
      cells: [cell("quiet-neighbour", 1.2), cell("hot", 3), cell("elsewhere", 9)],
    };
    const brief = terrainBrief({
      cellIds: ["quiet-neighbour", "hot"],
      report: REPORT,
      decision,
      weather: null,
    });
    expect(brief.facts[1].value).toBe("3× usual");
    expect(brief.facts[2].value).toBe("Act first");
  });

  it("says above usual when a flagged cell has no ratio", () => {
    const decision: AlertDecision = { active: true, region: false, cells: [cell("a", null)] };
    const brief = terrainBrief({ cellIds: ["a"], report: REPORT, decision, weather: null });
    expect(brief.facts[1].value).toBe("Above usual");
    expect(brief.facts[2].value).toBe("Check here");
  });

  it("never puts the probability machinery in the three facts", () => {
    const decision: AlertDecision = { active: true, region: false, cells: [cell("a", 14, 42)] };
    const text = terrainBrief({ cellIds: ["a"], report: REPORT, decision, weather: "extreme" }).facts
      .flatMap((fact) => [fact.value, fact.detail])
      .join(" ");
    expect(text).not.toMatch(/p-value|p <|satellite|NOAA|by chance|of \d+ days/i);
  });
});
