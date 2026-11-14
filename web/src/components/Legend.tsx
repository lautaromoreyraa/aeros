import { DIVERGING, VIRIDIS, toCss } from "../util/colorRamp";
import type { Unit } from "../api/types";
import { formatCount, unitLabel } from "../util/format";
import type { CalendarView } from "./CalendarHeatmap";

function gradient(stops: typeof VIRIDIS): string {
  return `linear-gradient(to right, ${stops.map((stop) => toCss(stop)).join(", ")})`;
}

export function Legend({ view, max, unit }: { view: CalendarView; max: number; unit: Unit }) {
  const anomaly = view === "anomaly";
  return (
    <figure className="legend" aria-label="Colour scale">
      <div className="legend__bar" style={{ background: gradient(anomaly ? DIVERGING : VIRIDIS) }} />
      <figcaption className="legend__labels">
        {anomaly ? (
          <>
            <span>¼× usual</span>
            <span>usual</span>
            <span>4× usual</span>
          </>
        ) : (
          <>
            <span>0</span>
            <span>{formatCount(max / 4)}</span>
            <span>
              {formatCount(max)} {unitLabel(unit)}
            </span>
          </>
        )}
      </figcaption>
      <ul className="coverage" aria-label="Coverage">
        <li className="coverage__item coverage__item--observed">Observed by VIIRS</li>
        <li className="coverage__item coverage__item--bridged">Bridged by NOAA-20</li>
        <li className="coverage__item coverage__item--modeled">Modeled from MODIS</li>
      </ul>
    </figure>
  );
}
