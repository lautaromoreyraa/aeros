import { useMemo } from "react";
import type { CalendarRecord, Unit } from "../api/types";
import { yearlyTotals } from "../util/aggregation";
import { formatCount, unitLabel } from "../util/format";
import { FLEET_EVENTS } from "../util/geo";

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 28, right: 12, bottom: 28, left: 48 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

/**
 * Yearly totals, raw stacked against harmonized. The raw line steps up when
 * Aqua and then VIIRS start flying, while the fire on the ground did not
 * change; the harmonized line is the series that can be compared across eras.
 */
export function AnnualChart({ records, unit, showRaw }: { records: CalendarRecord[]; unit: Unit; showRaw: boolean }) {
  const years = useMemo(() => yearlyTotals(records), [records]);
  if (years.length < 2) return null;

  const first = years[0]!.year;
  const last = years[years.length - 1]!.year;
  const yMax = niceMax(Math.max(...years.map((year) => Math.max(year.high, year.stacked))));
  const x = (year: number) => PAD.left + ((year - first) / Math.max(1, last - first)) * (WIDTH - PAD.left - PAD.right);
  const y = (value: number) => HEIGHT - PAD.bottom - (value / yMax) * (HEIGHT - PAD.top - PAD.bottom);
  const line = (pick: (year: (typeof years)[number]) => number) =>
    years.map((year, index) => `${index ? "L" : "M"}${x(year.year).toFixed(1)},${y(pick(year)).toFixed(1)}`).join("");
  const band =
    years.map((year, index) => `${index ? "L" : "M"}${x(year.year).toFixed(1)},${y(year.high).toFixed(1)}`).join("") +
    [...years]
      .reverse()
      .map((year) => `L${x(year.year).toFixed(1)},${y(year.low).toFixed(1)}`)
      .join("") +
    "Z";
  const ticks = [0, yMax / 2, yMax];
  const yearTicks = years.filter((year) => year.year % 5 === 0).map((year) => year.year);

  return (
    <figure className="annual">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby="annual-title annual-desc">
        <title id="annual-title">{`${unitLabel(unit, "toggle")} per year in the selected area`}</title>
        <desc id="annual-desc">
          Harmonized VIIRS-equivalent totals with their 90 % interval
          {showRaw ? ", and the raw stacked MODIS plus VIIRS count that jumps when satellites change" : ""}.
        </desc>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="annual__grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="annual__tick" x={PAD.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatCount(tick)}
            </text>
          </g>
        ))}
        {yearTicks.map((year) => (
          <text key={year} className="annual__tick" x={x(year)} y={HEIGHT - 8} textAnchor="middle">
            {year}
          </text>
        ))}
        {FLEET_EVENTS.filter((event) => event.year > first && event.year <= last).map((event) => {
          const position = x(event.year + (event.month - 1) / 12);
          return (
            <g key={event.label} className="annual__event">
              <line x1={position} x2={position} y1={PAD.top - 10} y2={HEIGHT - PAD.bottom} />
              <text x={position + 4} y={PAD.top - 14}>
                {event.label}
              </text>
            </g>
          );
        })}
        <path className="annual__band" d={band} />
        {showRaw && <path className="annual__raw" d={line((year) => year.stacked)} />}
        <path className="annual__harmonized" d={line((year) => year.harmonized)} />
        {years.map((year) => (
          <circle
            key={year.year}
            className={year.months < 12 ? "annual__dot annual__dot--partial" : "annual__dot"}
            cx={x(year.year)}
            cy={y(year.harmonized)}
            r={3}
          >
            <title>
              {year.year}: {formatCount(year.harmonized)} harmonized
              {showRaw ? `, ${formatCount(year.stacked)} raw` : ""}
              {year.months < 12 ? ` (${year.months} months)` : ""}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="annual__key">
        <span className="key key--harmonized">Harmonized (90 % interval)</span>
        {showRaw && <span className="key key--raw">Raw stacked</span>}
        <span className="key key--partial">Partial year</span>
      </figcaption>
    </figure>
  );
}
