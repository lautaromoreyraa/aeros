/**
 * Three facts for one place on the terrain.
 *
 * Anyone reads the alert. A desk reads the same three lines as a decision:
 * leave crews, watch the weather, check this place, or send a crew here first.
 * The early-warning test stays in `alertDecision`. This does not repeat its
 * p-value, the satellites, or how many days had data.
 */
import type { EarlyWarning, EarlyWarningScore } from "../api/types";
import { REGION_RATIO_THRESHOLD, formatDay, type AlertDecision } from "./earlyWarning";
import type { FireLevel } from "./fireWeather";

export interface TerrainFact {
  /** Alert, This week, or Decision. */
  label: "Alert" | "This week" | "Decision";
  /** The one thing a person reads. */
  value: string;
  /** One sentence for the person who has to act. */
  detail: string;
}

/** How hard the three facts read, for colour only. */
export type TerrainTone = "unknown" | "quiet" | "watch" | "act";

export interface TerrainBrief {
  tone: TerrainTone;
  facts: [TerrainFact, TerrainFact, TerrainFact];
}

export interface TerrainBriefInput {
  /** The tapped cell, or every cell of the open zone. */
  cellIds: readonly string[];
  report: EarlyWarning | null;
  decision: AlertDecision;
  /**
   * Worst fire-weather level on a day that is still ahead.
   * A stale forecast is `null`: it must not move a crew.
   */
  weather: FireLevel | null;
}

const SEVERE: ReadonlySet<FireLevel> = new Set(["high", "extreme"]);

/** "14× usual" from 10 up, one decimal below that, nothing under 1×. */
export function timesUsual(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio) || ratio < 1) return null;
  if (ratio >= 10) return `${Math.round(ratio)}× usual`;
  const rounded = Math.round(ratio * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}× usual` : `${rounded.toFixed(1)}× usual`;
}

/** The strongest level among forecast days; `null` when none has a level. */
export function worstLevel(levels: readonly (FireLevel | null)[]): FireLevel | null {
  const rank: Record<FireLevel, number> = { normal: 0, elevated: 1, high: 2, extreme: 3 };
  let best: FireLevel | null = null;
  for (const level of levels) {
    if (level && (best === null || rank[level] > rank[best])) best = level;
  }
  return best;
}

/** "Nov 7–Nov 14" for the early-warning window. */
function windowSpan(report: EarlyWarning): string {
  const start = formatDay(report.window[0]);
  const end = formatDay(report.window[1]);
  return start === end ? start : `${start}–${end}`;
}

/** The flagged cell in this place with the largest excess. */
function leadingScore(cellIds: readonly string[], decision: AlertDecision): EarlyWarningScore | null {
  const wanted = new Set(cellIds);
  let best: EarlyWarningScore | null = null;
  for (const score of decision.cells) {
    if (!wanted.has(score.cell)) continue;
    if (!best) {
      best = score;
      continue;
    }
    const next = score.ratio ?? Number.NEGATIVE_INFINITY;
    const current = best.ratio ?? Number.NEGATIVE_INFINITY;
    if (next > current || (next === current && score.observed > best.observed)) best = score;
  }
  return best;
}

const unknown = (): TerrainBrief => ({
  tone: "unknown",
  facts: [
    { label: "Alert", value: "No reading", detail: "No satellite reading for this week yet." },
    { label: "This week", value: "—", detail: "Nothing to compare with earlier years." },
    { label: "Decision", value: "Wait", detail: "Do not move a crew until a reading arrives." },
  ],
});

/**
 * The three facts for the open place.
 * "Act first" uses the same twice-usual bar as a region-wide alert, or high
 * or extreme fire weather on a day still ahead. A flagged place under that
 * bar is "Check here". A quiet place with that weather is "Watch weather".
 */
export function terrainBrief({ cellIds, report, decision, weather }: TerrainBriefInput): TerrainBrief {
  if (!report) return unknown();
  const score = leadingScore(cellIds, decision);
  // No flagged cell and no regional baseline: silence is not an all-clear.
  if (!score && !report.region) return unknown();

  const severe = weather !== null && SEVERE.has(weather);
  const scale = score ? (timesUsual(score.ratio) ?? "Above usual") : "As usual";
  const span = windowSpan(report);
  const scaleDetail = score
    ? `${span}, against the same days in earlier years.`
    : `${span}, in line with the same days of earlier years.`;

  if (!score && severe) {
    return {
      tone: "watch",
      facts: [
        { label: "Alert", value: "No alert", detail: "Nothing unusual here this week." },
        { label: "This week", value: scale, detail: scaleDetail },
        {
          label: "Decision",
          value: "Watch weather",
          detail: "No unusual fire. The next days are very dry and windy, so keep a watch.",
        },
      ],
    };
  }

  if (!score) {
    return {
      tone: "quiet",
      facts: [
        { label: "Alert", value: "No alert", detail: "Nothing unusual here this week." },
        { label: "This week", value: "As usual", detail: scaleDetail },
        { label: "Decision", value: "No action", detail: "Nothing in this reading calls for a crew." },
      ],
    };
  }

  const large = score.ratio !== null && score.ratio >= REGION_RATIO_THRESHOLD;
  if (large || severe) {
    const detail = large
      ? severe
        ? "At least twice the usual, and the next days are very dry and windy. Send a crew here first."
        : "At least twice the usual for these days. Send a crew here first."
      : "Fire is above usual and the next days are very dry and windy. Send a crew here first.";
    return {
      tone: "act",
      facts: [
        { label: "Alert", value: "Alert", detail: "Unusual fire here this week." },
        { label: "This week", value: scale, detail: scaleDetail },
        { label: "Decision", value: "Act first", detail },
      ],
    };
  }

  return {
    tone: "watch",
    facts: [
      { label: "Alert", value: "Alert", detail: "Unusual fire here this week." },
      { label: "This week", value: scale, detail: scaleDetail },
      {
        label: "Decision",
        value: "Check here",
        detail: "Fire is above usual. Look here before you send a crew.",
      },
    ],
  };
}
