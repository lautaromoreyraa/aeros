/**
 * Plain-language summary of the early-warning week for one H3 cell.
 * All logic is pure so it can be tested without rendering.
 */
import type { EarlyWarning } from "../api/types";
import type { AlertDecision } from "./earlyWarning";
import { formatDay, windowCoverage } from "./earlyWarning";

export interface CellWeekSummary {
  flagged: boolean;
  windowLabel: string;
  /** e.g. "42 fire detections" */
  observedLabel: string;
  /** e.g. "about 3" or "less than 1" */
  expectedLabel: string;
  /** e.g. "14 times" or "less than 1 times" */
  ratioLabel: string;
  /** e.g. "7 of 8 days" */
  dataDaysLabel: string;
  /** e.g. "NOAA-20, NOAA-21" or null */
  satellitesLabel: string | null;
  /** e.g. "less than 1 in 1,000 by chance" or "about 1 in 200 by chance" */
  oddsLabel: string;
  /** NASA FIRMS map link centred on the cell. */
  firmsUrl: string;
}

/**
 * Formats a ratio as a human-readable multiplier.
 * Values >= 10 are rounded to the nearest integer; smaller ones show one decimal.
 * Values < 1 (or null) return a fixed phrase.
 */
export function formatRatio(ratio: number | null): string {
  if (ratio === null) return "an unusual amount";
  if (ratio < 1) return "less than 1 times";
  if (ratio >= 10) return `${Math.round(ratio)} times`;
  return `${ratio.toFixed(1)} times`;
}

/** NASA FIRMS map link centred on a [lng, lat] point at zoom 9. */
export function firmsUrl(lng: number, lat: number): string {
  const lngStr = lng.toFixed(1);
  const latStr = lat.toFixed(1);
  return `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${lngStr},${latStr},9.00z`;
}

/**
 * Converts a Poisson p-value to a plain-language odds phrase.
 * Below 0.001: "less than 1 in 1,000 by chance".
 * Otherwise: "about 1 in N by chance" (N rounded to a friendly number).
 */
function oddsLabel(p: number): string {
  if (p < 0.001) return "less than 1 in 1,000 by chance";
  const n = Math.round(1 / p);
  return `about 1 in ${n.toLocaleString("en-US")} by chance`;
}

function windowLabel(window: [string, string]): string {
  const start = formatDay(window[0]);
  const end = formatDay(window[1]);
  return start === end ? start : `${start}–${end}`;
}

/**
 * Builds a plain-language week summary for a single cell.
 * @param cell  H3 cell id of the tapped cell.
 * @param report  The raw early-warning report.
 * @param decision  The resolved alert decision (which cells passed the test).
 * @param center  [lng, lat] of the cell centre for the FIRMS link.
 */
export function cellWeekSummary(
  cell: string,
  report: EarlyWarning,
  decision: AlertDecision,
  center: [number, number],
): CellWeekSummary {
  const score = decision.cells.find((c) => c.cell === cell) ?? null;
  const coverage = windowCoverage(report);
  const dataDaysLabel = `${coverage.dataDays} of ${coverage.windowDays} days`;
  const satellites = report.days
    ? Array.from(new Set(report.days.map((d) => d.satellite).filter((s): s is string => Boolean(s))))
    : [];
  const satellitesLabel = satellites.length > 0 ? satellites.join(", ") : null;

  const base: Omit<CellWeekSummary, "observedLabel" | "expectedLabel" | "ratioLabel" | "oddsLabel"> = {
    flagged: score !== null,
    windowLabel: windowLabel(report.window),
    dataDaysLabel,
    satellitesLabel,
    firmsUrl: firmsUrl(center[0], center[1]),
  };

  if (!score) {
    return {
      ...base,
      observedLabel: "",
      expectedLabel: "",
      ratioLabel: "",
      oddsLabel: "",
    };
  }

  return {
    ...base,
    observedLabel: `${score.observed} fire detection${score.observed !== 1 ? "s" : ""}`,
    expectedLabel: score.expected < 1 ? "less than 1" : `about ${Math.round(score.expected)}`,
    ratioLabel: formatRatio(score.ratio),
    oddsLabel: oddsLabel(score.p_value),
  };
}
