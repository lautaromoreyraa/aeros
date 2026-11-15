import type { EarlyWarning } from "../api/types";
import { type AlertDecision, formatDay, windowCoverage } from "./earlyWarning";
import { formatCount, formatPlace, formatRatio } from "./format";
import { cellCenters } from "./geo";
import type { Sector } from "./sectors";

/** The places named in one message; the rest are counted, not listed. */
export const MAX_PLACES = 3;

export interface AlertMessage {
  active: boolean;
  /** Email subject, and the first line of the chat message. */
  subject: string;
  /** "Nov 6 – Nov 12". */
  window: string;
  /** One line per place burning above its normal, most significant first. */
  places: string[];
  /** How many flagged places did not fit in {@link places}. */
  more: number;
  /** How complete the window was; missing days are never quiet days. */
  coverage: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The text an early-warning notification carries, built from the same report
 * and decision as the banner, so a message never says more than the UI does.
 */
export function alertMessage(report: EarlyWarning, decision: AlertDecision, sectors: Sector[]): AlertMessage {
  const window = `${formatDay(report.window[0])} – ${formatDay(report.window[1])}`;
  const { dataDays, windowDays, gapCount } = windowCoverage(report);
  const coverage =
    `Based on ${dataDays} of ${windowDays} days with satellite data` +
    (gapCount > 0 ? `; ${plural(gapCount, "day is", "days are")} missing, not quiet.` : ".");

  if (!decision.active)
    return { active: false, subject: "No early warning this week", window, places: [], more: 0, coverage };

  const sectorOf = new Map(sectors.flatMap((sector) => sector.cells.map((cell) => [cell, sector.name] as const)));
  const shown = decision.cells.slice(0, MAX_PLACES);
  const centers = new Map(cellCenters(shown.map((cell) => cell.cell)).map((cell) => [cell.cell, cell.center]));
  const places = shown.map((cell) => {
    const name = sectorOf.get(cell.cell) ?? "Study region";
    const expected = cell.expected < 10 ? cell.expected.toFixed(1) : formatCount(cell.expected);
    return `${name}, ${formatPlace(centers.get(cell.cell)!)}: ${formatRatio(cell.ratio)} the usual (${formatCount(cell.observed)} hotspots, ${expected} expected)`;
  });

  const parts: string[] = [];
  if (decision.region && report.region) parts.push(`the region is burning at ${formatRatio(report.region.ratio)} the usual`);
  if (decision.cells.length > 0) parts.push(`${plural(decision.cells.length, "area", "areas")} well above normal`);
  const summary = parts.join(" and ");

  return {
    active: true,
    subject: `Early warning: ${summary}`,
    window,
    places,
    more: decision.cells.length - shown.length,
    coverage,
  };
}
