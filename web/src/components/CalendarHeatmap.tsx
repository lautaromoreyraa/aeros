import { useMemo } from "react";
import type { CalendarRecord } from "../api/types";
import { DIVERGING, VIRIDIS, ratioScale, readableTextOn, sampleRamp, sqrtScale, toCss } from "../util/colorRamp";
import { MONTH_LABELS } from "../util/months";
import { formatCount, formatRatio } from "../util/format";

export type CalendarView = "harmonized" | "raw" | "anomaly";

interface Props {
  records: CalendarRecord[];
  view: CalendarView;
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

function describe(record: CalendarRecord, view: CalendarView): string {
  const month = `${MONTH_LABELS[record.month_of_year - 1]} ${record.year}`;
  if (view === "anomaly") {
    return record.anomaly_ratio === null
      ? `${month}: no usual value to compare with`
      : `${month}: ${formatRatio(record.anomaly_ratio)} the usual ${MONTH_LABELS[record.month_of_year - 1]}`;
  }
  return `${month}: ${formatCount(valueOf(record, view))} ${view === "raw" ? "raw stacked" : "harmonized"} hotspots`;
}

export function CalendarHeatmap({ records, view, selected, onSelect }: Props) {
  const max = useMemo(() => countScaleMax(records), [records]);
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
    return <p className="calendar__empty">No months in this range.</p>;
  }

  return (
    <div className="calendar" role="region" aria-label="Burning calendar, month by year" tabIndex={0}>
      <table className="calendar__table">
        <caption className="visually-hidden">
          {view === "anomaly"
            ? "Each month compared with the median of the same month in every other year"
            : `${view === "raw" ? "Raw stacked" : "Harmonized"} hotspots per month`}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="calendar__corner">
              <span className="visually-hidden">Year</span>
            </th>
            {MONTH_LABELS.map((label) => (
              <th key={label} scope="col" className="calendar__month">
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
                      aria-label={describe(record, view)}
                      title={describe(record, view)}
                      data-modeled={record.source !== "observed" || undefined}
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
