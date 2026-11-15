import type { CalendarRecord, Unit } from "../api/types";
import { useI18n } from "../i18n/I18nContext";
import { criticalPeriod } from "../util/criticalPeriod";
import { formatCount, formatRatio, sourceLabel, unitLabel } from "../util/format";
import { monthLabel } from "../util/months";
import { recordAt, seasonToDate, verdictOf } from "../util/sectorKpis";
import { verdictLabel } from "./SectorList";

interface Props {
  records: CalendarRecord[];
  unit: Unit;
  year: number;
  month: number;
}

/** The figures of one sector for the month on the timeline. */
export function SectorOverview({ records, unit, year, month }: Props) {
  const { lang } = useI18n();
  const record = recordAt(records, year, month);
  const verdict = verdictOf(record);
  const season = seasonToDate(records, year, month);
  const critical = criticalPeriod(records);
  const mName = monthLabel(month - 1, lang);
  const criticalLabel =
    critical.start_month === null
      ? "—"
      : `${monthLabel(critical.start_month - 1, lang)}–${monthLabel(critical.end_month! - 1, lang)}`;

  if (!record) {
    return (
      <p className="summary__note">
        {lang === "es"
          ? `No hay registros para ${mName} de ${year} en este sector.`
          : `There is no record for ${mName} ${year} in this sector.`}
      </p>
    );
  }
  return (
    <div className="overview">
      <p className="overview__value">
        {formatCount(record.harmonized)}
        <span> {unitLabel(unit, "many", lang)}</span>
      </p>
      <p className="overview__interval">
        {lang === "es"
          ? `Probablemente entre ${formatCount(record.low)} y ${formatCount(record.high)}`
          : `Likely between ${formatCount(record.low)} and ${formatCount(record.high)}`}
      </p>
      <p>
        <span className={`chip chip--${verdict}`}>{verdictLabel(verdict, lang)}</span>
      </p>
      <dl className="overview__facts">
        <div>
          <dt>{lang === "es" ? `Un ${mName} habitual` : `A usual ${mName}`}</dt>
          <dd>
            {formatCount(record.median_same_month)}{" "}
            <small>
              {lang === "es"
                ? `este mes representó ${formatRatio(record.anomaly_ratio)} eso`
                : `this one ${formatRatio(record.anomaly_ratio)} that`}
            </small>
          </dd>
        </div>
        <div>
          <dt>{lang === "es" ? "Temporada de incendios hasta ahora" : "This fire season so far"}</dt>
          <dd>
            {formatCount(season.total)}
            {season.change !== null && (
              <small>
                {" "}
                {season.change >= 0 ? "+" : "−"}
                {Math.abs(Math.round(season.change * 100))} % {lang === "es" ? `vs. habitual a ${mName}` : `vs usual to ${mName}`}
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>{lang === "es" ? "Período crítico local" : "Fire season here"}</dt>
          <dd>
            {criticalLabel}{" "}
            <small>
              {lang === "es"
                ? `cuando ocurre el ${Math.round(critical.share * 100)} % del fuego del año`
                : `when ${Math.round(critical.share * 100)} % of a year's fire happens`}
            </small>
          </dd>
        </div>
        <div>
          <dt>{lang === "es" ? "Método de conteo" : "How it was counted"}</dt>
          <dd>
            <small>{sourceLabel(record.source, lang)}</small>
          </dd>
        </div>
      </dl>
    </div>
  );
}
