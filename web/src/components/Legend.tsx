import { DIVERGING, VIRIDIS, toCss } from "../util/colorRamp";
import { formatCount } from "../util/format";
import type { CalendarView } from "./CalendarHeatmap";

function gradient(stops: typeof VIRIDIS): string {
  return `linear-gradient(to right, ${stops.map((stop) => toCss(stop)).join(", ")})`;
}

export function Legend({ view, max }: { view: CalendarView; max: number }) {
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
            <span>{formatCount(max)} hotspots</span>
          </>
        )}
      </figcaption>
      <span className="legend__modeled">Dotted months are modeled from MODIS, before VIIRS (2012)</span>
    </figure>
  );
}
