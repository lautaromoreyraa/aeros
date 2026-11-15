import type { CriticalPeriod } from "../api/types";
import { MONTH_LABELS } from "../util/months";

/** One line naming the fire season the calendar highlights. */
export function CriticalPeriodNote({ period }: { period: CriticalPeriod }) {
  if (period.months.length === 0 || period.start_month === null || period.end_month === null) {
    return <p className="critical-note">No fire season: this area had no activity.</p>;
  }
  const name = (month: number) => MONTH_LABELS[month - 1];
  const held = Math.round((period.held ?? period.share) * 100);
  return (
    <p className="critical-note">
      <span className="critical-note__swatch" aria-hidden="true" />
      <span>
        <strong>
          Critical period: {name(period.start_month)}
          {period.months.length > 1 ? `–${name(period.end_month)}` : ""}
        </strong>
        , the shortest run of months holding {held} % of a typical year
        {period.peak_month ? `; peak in ${name(period.peak_month)}` : ""}.
      </span>
    </p>
  );
}
