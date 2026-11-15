import type { FireLevel, FireWeatherDay } from "../util/fireWeather";

const LEVEL_LABELS: Record<FireLevel, string> = {
  normal: "Normal",
  elevated: "Elevated",
  high: "High",
  extreme: "Extreme",
};

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" });

const dayLabel = (day: string) => {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(time) ? day : `${WEEKDAY.format(time)} ${DAY.format(time)}`;
};

interface Props {
  days: FireWeatherDay[];
  label: string;
}

/** One chip per forecast day: how dry and windy it gets at its worst point, and how many areas reach extreme. */
export function FireWeatherDays({ days, label }: Props) {
  return (
    <ol className="day-strip day-strip--weather" aria-label={label}>
      {days.map((day) => (
        <li
          key={day.day}
          className={`day day--fire-${day.level ?? "none"}`}
          title={day.top === null ? undefined : `Highest rank ${Math.round(day.top)} of 100`}
        >
          <span className="day__date">{dayLabel(day.day)}</span>
          <span className="day__level">{day.level ? LEVEL_LABELS[day.level] : "No data"}</span>
          {day.extreme > 0 && (
            <span className="day__source">{day.extreme === 1 ? "1 area extreme" : `${day.extreme} areas extreme`}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
