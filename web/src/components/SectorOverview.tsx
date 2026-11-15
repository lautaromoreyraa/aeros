import type { CalendarRecord, Unit } from "../api/types";
import { criticalPeriod } from "../util/criticalPeriod";
import { SOURCE_LABELS, formatCount, formatRatio } from "../util/format";
import { MONTH_LABELS } from "../util/months";
import { recordAt, seasonToDate, verdictOf } from "../util/sectorKpis";
import { VERDICT_LABELS } from "./SectorList";

interface Props {
  records: CalendarRecord[];
  unit: Unit;
  year: number;
  month: number;
}

/** The figures of one sector for the month on the timeline. */
export function SectorOverview({ records, unit, year, month }: Props) {
  const record = recordAt(records, year, month);
  const verdict = verdictOf(record);
  const season = seasonToDate(records, year, month);
  const critical = criticalPeriod(records);
  const criticalLabel =
    critical.start_month === null
      ? "—"
      : `${MONTH_LABELS[critical.start_month - 1]}–${MONTH_LABELS[critical.end_month! - 1]}`;

  if (!record) {
    return <p className="summary__note">There is no record for {MONTH_LABELS[month - 1]} {year} in this sector.</p>;
  }
  return (
    <div className="overview">
      <p className="overview__value">
        {formatCount(record.harmonized)}
        <span> {unit === "cell_days" ? "cell-days with fire" : "fire detections"}</span>
      </p>
      <p className="overview__interval">
        Likely between {formatCount(record.low)} and {formatCount(record.high)}
      </p>
      <p>
        <span className={`chip chip--${verdict}`}>{VERDICT_LABELS[verdict]}</span>
      </p>
      <dl className="overview__facts">
        <div>
          <dt>A usual {MONTH_LABELS[month - 1]}</dt>
          <dd>
            {formatCount(record.median_same_month)} <small>this one {formatRatio(record.anomaly_ratio)} that</small>
          </dd>
        </div>
        <div>
          <dt>This fire season so far</dt>
          <dd>
            {formatCount(season.total)}
            {season.change !== null && (
              <small>
                {" "}
                {season.change >= 0 ? "+" : "−"}
                {Math.abs(Math.round(season.change * 100))} % vs usual to {MONTH_LABELS[month - 1]}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>Fire season here</dt>
          <dd>
            {criticalLabel} <small>when {Math.round(critical.share * 100)} % of a year's fire happens</small>
          </dd>
        </div>
        <div>
          <dt>How it was counted</dt>
          <dd>
            <small>{SOURCE_LABELS[record.source] ?? record.source}</small>
          </dd>
        </div>
      </dl>
    </div>
  );
}
