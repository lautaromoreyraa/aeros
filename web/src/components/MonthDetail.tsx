import type { CalendarRecord, Unit } from "../api/types";
import { SOURCE_LABELS, formatCount, formatRatio, formatSigned, unitLabel } from "../util/format";
import { MONTH_LABELS } from "../util/months";

/** The numbers behind one calendar square. */
export function MonthDetail({ record, unit, heading }: { record: CalendarRecord; unit: Unit; heading: string }) {
  const name = `${MONTH_LABELS[record.month_of_year - 1]} ${record.year}`;
  const ratio = record.anomaly_ratio;
  const tone = ratio === null ? "neutral" : ratio >= 1.25 ? "above" : ratio <= 0.8 ? "below" : "neutral";
  return (
    <article className="month-detail" aria-live="polite">
      <p className="month-detail__eyebrow">{heading}</p>
      <h3 className="month-detail__title">{name}</h3>
      <p className="month-detail__value">
        {formatCount(record.harmonized)}
        <span> VIIRS-equivalent {unitLabel(unit)}</span>
      </p>
      <dl className="month-detail__list">
        <div>
          <dt>90 % interval</dt>
          <dd>
            {formatCount(record.low)} – {formatCount(record.high)}
          </dd>
        </div>
        <div>
          <dt>Usual {MONTH_LABELS[record.month_of_year - 1]}</dt>
          <dd>{formatCount(record.median_same_month)}</dd>
        </div>
        <div>
          <dt>Versus usual</dt>
          {record.in_progress ? (
            <dd>Month in progress, not compared yet</dd>
          ) : (
            <dd className={`tone tone--${tone}`}>
              {formatSigned(record.anomaly)} ({formatRatio(ratio)})
            </dd>
          )}
        </div>
        <div>
          <dt>Raw stacked count</dt>
          <dd>{formatCount(record.stacked_raw)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{SOURCE_LABELS[record.source] ?? record.source}</dd>
        </div>
      </dl>
    </article>
  );
}
