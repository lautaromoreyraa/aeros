import type { CalendarRecord, Unit } from "../api/types";
import { useI18n } from "../i18n/I18nContext";
import { formatCount, formatRatio, formatSigned, sourceLabel, unitLabel } from "../util/format";
import { monthLabel } from "../util/months";

/** The numbers behind one calendar square. */
export function MonthDetail({ record, unit, heading }: { record: CalendarRecord; unit: Unit; heading: string }) {
  const { lang, t } = useI18n();
  const monthName = monthLabel(record.month_of_year - 1, lang);
  const name = `${monthName} ${record.year}`;
  const ratio = record.anomaly_ratio;
  const tone = ratio === null ? "neutral" : ratio >= 1.25 ? "above" : ratio <= 0.8 ? "below" : "neutral";
  return (
    <article className="month-detail" aria-live="polite">
      <p className="month-detail__eyebrow">{heading}</p>
      <h3 className="month-detail__title">{name}</h3>
      <p className="month-detail__value">
        {formatCount(record.harmonized)}
        <span>{t.monthDetail.viirsEquivalent(unitLabel(unit, "many", lang))}</span>
      </p>
      <dl className="month-detail__list">
        <div>
          <dt>{t.monthDetail.interval90}</dt>
          <dd>
            {formatCount(record.low)} – {formatCount(record.high)}
          </dd>
        </div>
        <div>
          <dt>{t.monthDetail.usualMonth(monthName)}</dt>
          <dd>{formatCount(record.median_same_month)}</dd>
        </div>
        <div>
          <dt>{t.monthDetail.versusUsual}</dt>
          {record.in_progress ? (
            <dd>{t.monthDetail.inProgress}</dd>
          ) : (
            <dd className={`tone tone--${tone}`}>
              {formatSigned(record.anomaly)} ({formatRatio(ratio)})
            </dd>
          )}
        </div>
        <div>
          <dt>{t.monthDetail.rawStacked}</dt>
          <dd>{formatCount(record.stacked_raw)}</dd>
        </div>
        <div>
          <dt>{t.monthDetail.source}</dt>
          <dd>{sourceLabel(record.source, lang)}</dd>
        </div>
      </dl>
    </article>
  );
}
