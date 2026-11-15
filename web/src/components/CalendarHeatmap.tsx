import { useMemo } from "react";
import type { CalendarRecord, Unit } from "../api/types";
import { useI18n } from "../i18n/I18nContext";
import { DIVERGING, VIRIDIS, ratioScale, readableTextOn, sampleRamp, sqrtScale, toCss } from "../util/colorRamp";
import { monthLabel } from "../util/months";
import { coverageLabel, coverageOf, formatCount, formatRatio, unitLabel } from "../util/format";

export type CalendarView = "harmonized" | "raw" | "anomaly";

interface Props {
  records: CalendarRecord[];
  view: CalendarView;
  unit: Unit;
  /** Calendar months of the critical period, highlighted in the header. */
  criticalMonths: number[];
  peakMonth: number | null;
  selected: CalendarRecord | null;
  onSelect: (record: CalendarRecord) => void;
}

export function valueOf(record: CalendarRecord, view: CalendarView): number {
  return view === "raw" ? record.stacked_raw : record.harmonized;
}

/**
 * The shared maximum for the count views. Harmonized and raw use the same
 * scale on purpose: switching between them must show the raw jump in 2012,
 * not two separately normalised pictures that look alike.
 */
export function countScaleMax(records: CalendarRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.harmonized, record.stacked_raw), 0);
}

export function colorFor(record: CalendarRecord, view: CalendarView, max: number) {
  return view === "anomaly"
    ? sampleRamp(DIVERGING, ratioScale(record.anomaly_ratio))
    : sampleRamp(VIRIDIS, sqrtScale(valueOf(record, view), max));
}

function describe(record: CalendarRecord, view: CalendarView, unit: Unit, lang: "en" | "es"): string {
  const mName = monthLabel(record.month_of_year - 1, lang);
  const cov = coverageLabel(coverageOf(record.source), lang).toLowerCase();
  const month = `${mName} ${record.year} (${cov})`;
  if (view === "anomaly") {
    if (record.in_progress) {
      return lang === "es"
        ? `${month}: en curso, aún no comparado con lo habitual`
        : `${month}: in progress, not compared with the usual yet`;
    }
    return record.anomaly_ratio === null
      ? (lang === "es" ? `${month}: sin valor habitual para comparar` : `${month}: no usual value to compare with`)
      : (lang === "es"
          ? `${month}: ${formatRatio(record.anomaly_ratio)} lo habitual para ${mName}`
          : `${month}: ${formatRatio(record.anomaly_ratio)} the usual ${mName}`);
  }
  const modeLabel = view === "raw"
    ? (lang === "es" ? "brutos acumulados" : "raw stacked")
    : (lang === "es" ? "armonizados" : "harmonized");
  return `${month}: ${formatCount(valueOf(record, view))} ${unitLabel(unit, "many", lang)} ${modeLabel}`;
}

export function CalendarHeatmap({ records, view, unit, criticalMonths, peakMonth, selected, onSelect }: Props) {
  const { lang } = useI18n();
  const max = useMemo(() => countScaleMax(records), [records]);
  const months12 = useMemo(() => Array.from({ length: 12 }, (_, i) => monthLabel(i, lang)), [lang]);
  const years = useMemo(() => {
    const byYear = new Map<number, (CalendarRecord | undefined)[]>();
    for (const record of records) {
      const row = byYear.get(record.year) ?? new Array<CalendarRecord | undefined>(12).fill(undefined);
      row[record.month_of_year - 1] = record;
      byYear.set(record.year, row);
    }
    return [...byYear.entries()].sort(([a], [b]) => b - a);
  }, [records]);

  if (records.length === 0) {
    return <p className="calendar__empty">{lang === "es" ? "Sin meses en este rango." : "No months in this range."}</p>;
  }

  return (
    <div
      className="calendar"
      role="region"
      aria-label={lang === "es" ? "Calendario de incendios, mes por año" : "Burning calendar, month by year"}
      tabIndex={0}
    >
      <table className="calendar__table">
        <caption className="visually-hidden">
          {view === "anomaly"
            ? (lang === "es"
                ? "Cada mes comparado con la mediana del mismo mes en todos los demás años"
                : "Each month compared with the median of the same month in every other year")
            : (lang === "es"
                ? `Focos ${view === "raw" ? "brutos acumulados" : "armonizados"} por mes`
                : `${view === "raw" ? "Raw stacked" : "Harmonized"} hotspots per month`)}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="calendar__corner">
              <span className="visually-hidden">{lang === "es" ? "Año" : "Year"}</span>
            </th>
            {months12.map((label, index) => (
              <th
                key={label}
                scope="col"
                className={[
                  "calendar__month",
                  criticalMonths.includes(index + 1) && "calendar__month--critical",
                  peakMonth === index + 1 && "calendar__month--peak",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-description={
                  criticalMonths.includes(index + 1)
                    ? (lang === "es"
                        ? `período crítico${peakMonth === index + 1 ? ", mes pico" : ""}`
                        : `critical period${peakMonth === index + 1 ? ", peak month" : ""}`)
                    : undefined
                }
              >
                <span aria-hidden="true">{label.slice(0, 1)}</span>
                <span className="calendar__month-full">{label.slice(1)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map(([year, months]) => (
            <tr key={year}>
              <th scope="row" className="calendar__year">
                {year}
              </th>
              {months.map((record, index) => {
                if (!record) return <td key={index} className="calendar__cell calendar__cell--none" />;
                const color = colorFor(record, view, max);
                const isSelected =
                  selected?.year === record.year && selected.month_of_year === record.month_of_year;
                return (
                  <td key={index} className="calendar__cell">
                    <button
                      type="button"
                      className="calendar__swatch"
                      style={{ background: toCss(color), color: readableTextOn(color) }}
                      aria-pressed={isSelected}
                      aria-label={describe(record, view, unit, lang)}
                      title={describe(record, view, unit, lang)}
                      data-coverage={coverageOf(record.source)}
                      onClick={() => onSelect(record)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
