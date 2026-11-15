import { DIVERGING, VIRIDIS, toCss } from "../util/colorRamp";
import type { Unit } from "../api/types";
import { useI18n } from "../i18n/I18nContext";
import { formatCount, unitLabel } from "../util/format";
import type { CalendarView } from "./CalendarHeatmap";

function gradient(stops: typeof VIRIDIS): string {
  return `linear-gradient(to right, ${stops.map((stop) => toCss(stop)).join(", ")})`;
}

export function Legend({ view, max, unit }: { view: CalendarView; max: number; unit: Unit }) {
  const { lang, t } = useI18n();
  const anomaly = view === "anomaly";
  return (
    <figure className="legend" aria-label={t.legend.colourScale}>
      <div className="legend__bar" style={{ background: gradient(anomaly ? DIVERGING : VIRIDIS) }} />
      <figcaption className="legend__labels">
        {anomaly ? (
          <>
            <span>{t.legend.quarterUsual}</span>
            <span>{t.legend.usual}</span>
            <span>{t.legend.fourUsual}</span>
          </>
        ) : (
          <>
            <span>0</span>
            <span>{formatCount(max / 4)}</span>
            <span>
              {formatCount(max)} {unitLabel(unit, "many", lang)}
            </span>
          </>
        )}
      </figcaption>
      <ul className="coverage" aria-label={t.legend.colourScale}>
        <li className="coverage__item coverage__item--observed">{t.legend.observedByViirs}</li>
        <li className="coverage__item coverage__item--bridged">{t.legend.bridgedByNoaa20}</li>
        <li className="coverage__item coverage__item--modeled">{t.legend.modeledFromModis}</li>
      </ul>
    </figure>
  );
}
