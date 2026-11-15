import type { ForecastWeek, Unit } from "../api/types";
import { formatCount, unitLabel } from "../util/format";
import { weekLabel } from "../util/forecast";

const WIDTH = 640;
const HEIGHT = 240;
const PAD = { top: 20, right: 24, bottom: 36, left: 48 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

interface Props {
  weeks: ForecastWeek[];
  unit: Unit;
  horizon: number;
}

/**
 * Expected hotspots per week with the 90 % band, against what the same weeks
 * usually bring. The band, not the line, is the forecast.
 */
export function ForecastChart({ weeks, unit, horizon }: Props) {
  if (weeks.length === 0) return null;
  const yMax = niceMax(Math.max(...weeks.map((week) => Math.max(week.high, week.climatology))));
  const step = (WIDTH - PAD.left - PAD.right) / Math.max(1, weeks.length - 1);
  const x = (index: number) => PAD.left + index * step;
  const y = (value: number) => HEIGHT - PAD.bottom - (value / yMax) * (HEIGHT - PAD.top - PAD.bottom);
  const path = (pick: (week: ForecastWeek) => number) =>
    weeks.map((week, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(pick(week)).toFixed(1)}`).join("");
  const band =
    path((week) => week.high) +
    [...weeks]
      .map((week, index) => ({ week, index }))
      .reverse()
      .map(({ week, index }) => `L${x(index).toFixed(1)},${y(week.low).toFixed(1)}`)
      .join("") +
    "Z";
  const ticks = [0, yMax / 2, yMax];

  return (
    <figure className="annual forecast-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby="forecast-chart-title forecast-chart-desc">
        <title id="forecast-chart-title">{`Expected ${unitLabel(unit)} for the next ${weeks.length} weeks`}</title>
        <desc id="forecast-chart-desc">
          {weeks
            .map(
              (week) =>
                `${weekLabel(week.week_start)}: ${formatCount(week.expected)} expected, 90 % range ${formatCount(week.low)} to ${formatCount(week.high)}, usually ${formatCount(week.climatology)}`,
            )
            .join(". ")}
        </desc>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="annual__grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="annual__tick" x={PAD.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatCount(tick)}
            </text>
          </g>
        ))}
        {weeks.map((week, index) => (
          <text
            key={week.week_start}
            className={week.horizon === horizon ? "annual__tick forecast-chart__tick--current" : "annual__tick"}
            x={x(index)}
            y={HEIGHT - 12}
            textAnchor={index === 0 ? "start" : index === weeks.length - 1 ? "end" : "middle"}
          >
            {weekLabel(week.week_start)}
          </text>
        ))}
        <path className="annual__band" d={band} />
        <path className="forecast-chart__climatology" d={path((week) => week.climatology)} />
        <path className="annual__harmonized" d={path((week) => week.expected)} />
        {weeks.map((week, index) => (
          <circle
            key={week.week_start}
            className={week.horizon === horizon ? "annual__dot forecast-chart__dot--current" : "annual__dot"}
            cx={x(index)}
            cy={y(week.expected)}
            r={week.horizon === horizon ? 5 : 3}
          />
        ))}
      </svg>
      <figcaption className="annual__key">
        <span className="key key--harmonized">Expected (90 % band)</span>
        <span className="key key--climatology">Usual for these weeks</span>
      </figcaption>
    </figure>
  );
}
