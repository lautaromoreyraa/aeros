import { describe, expect, it } from "vitest";
import { focusPadding, leaderEnd, panelSide } from "../../util/mapFocus";

const map = { left: 0, top: 56, width: 1200, height: 700 };
const side = { left: 808, top: 112, width: 380, height: 632 };
const sheet = { left: 8, top: 400, width: 344, height: 300 };
const phone = { left: 0, top: 56, width: 360, height: 700 };

describe("panelSide", () => {
  it("tells a side panel from a bottom sheet", () => {
    expect(panelSide(map, side)).toBe("right");
    expect(panelSide(phone, sheet)).toBe("bottom");
  });
});

describe("focusPadding", () => {
  it("keeps the toolbar and the margins free without a panel", () => {
    expect(focusPadding(map, null)).toEqual({ top: 72, right: 32, bottom: 32, left: 32 });
  });

  it("leaves the width of a side panel free on the right", () => {
    expect(focusPadding(map, side).right).toBe(1200 - 808 + 32);
  });

  it("leaves the height of a bottom sheet free", () => {
    expect(focusPadding(phone, sheet).bottom).toBe(56 + 700 - 400 + 32);
  });

  it("never squeezes the focused area below a minimum", () => {
    const wide = { left: 100, top: 56, width: 1100, height: 700 };
    const padding = focusPadding({ left: 0, top: 56, width: 400, height: 700 }, wide);
    expect(400 - padding.left - padding.right).toBeGreaterThanOrEqual(120);
  });
});

describe("leaderEnd", () => {
  it("meets a side panel on its left edge, level with the cell", () => {
    expect(leaderEnd([300, 400], map, side)).toEqual([808, 400]);
  });

  it("stays inside the panel's edge when the cell is above or below it", () => {
    expect(leaderEnd([300, 0], map, side)).toEqual([808, 112 - 56 + 24]);
    expect(leaderEnd([300, 2000], map, side)).toEqual([808, 112 - 56 + 632 - 24]);
  });

  it("meets a bottom sheet on its top edge, right above the cell", () => {
    expect(leaderEnd([120, 100], phone, sheet)).toEqual([120, 400 - 56]);
    expect(leaderEnd([-50, 100], phone, sheet)).toEqual([8 + 24, 400 - 56]);
  });
});
