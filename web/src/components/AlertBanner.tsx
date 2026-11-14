import type { EarlyWarning } from "../api/types";
import { type AlertDecision, formatDay, windowCoverage } from "../util/earlyWarning";
import { formatRatio } from "../util/format";

interface Props {
  report: EarlyWarning;
  decision: AlertDecision;
  /** Absent on the early-warning view itself, where the banner is the heading. */
  onOpen?: () => void;
}

/** One line that says what is unusual, over which days, and how complete those days were. */
export function AlertBanner({ report, decision, onOpen }: Props) {
  const coverage = windowCoverage(report);
  const parts: string[] = [];
  if (decision.region && report.region) parts.push(`region-wide activity at ${formatRatio(report.region.ratio)} the usual`);
  if (decision.cells.length > 0)
    parts.push(`${decision.cells.length} ${decision.cells.length === 1 ? "cell" : "cells"} burning well above normal`);
  const summary = parts.join(" and ");

  return (
    <div className="alert-banner" role="status">
      <svg className="alert-banner__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path d="M12 3 2 21h20L12 3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M12 10v5M12 17.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p className="alert-banner__text">
        <strong>Early warning:</strong> {summary.charAt(0).toUpperCase() + summary.slice(1)},{" "}
        {formatDay(report.window[0])} – {formatDay(report.window[1])}.{" "}
        <span className="alert-banner__coverage">
          Based on {coverage.dataDays} of {coverage.windowDays} days with satellite data
          {coverage.gapCount > 0 ? `; ${coverage.gapCount} ${coverage.gapCount === 1 ? "day is" : "days are"} missing, not quiet` : ""}.
        </span>
      </p>
      {onOpen && (
        <button type="button" className="button alert-banner__action" onClick={onOpen}>
          See where
        </button>
      )}
    </div>
  );
}
