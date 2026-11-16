import { Suspense, lazy, useMemo, useState } from "react";
import type { Forecast } from "../api/types";
import { AreaControls } from "../components/AreaControls";
import { ForecastChart } from "../components/ForecastChart";
import { SiMark } from "../components/SiMark";
import type { RiskCell } from "../components/RiskMap";
import type { AreaSelection } from "../hooks/useAreaSelection";
import type { Loadable } from "../hooks/useOutlook";
import type { LoadedRegion } from "../hooks/useRegion";
import { useI18n } from "../i18n/I18nContext";
import { areaLabel, boundsOf, cellsInArea } from "../util/area";
import { DIVERGING, toCss } from "../util/colorRamp";
import { formatCount, formatRatio, unitLabel } from "../util/format";
import { areaForecast, fitIntervalModel, outlookOf, ratioColor, weekLabel, type Outlook } from "../util/forecast";

const RiskMap = lazy(() => import("../components/RiskMap"));

const RAMP = `linear-gradient(to right, ${DIVERGING.map((stop) => toCss(stop)).join(", ")})`;

const value = (number: number) => (number < 10 ? number.toFixed(1) : formatCount(number));

interface Props {
  state: Loadable<Forecast | null>;
  onRetry: () => void;
  region: LoadedRegion;
  theme: "light" | "dark";
  selection: AreaSelection;
}

export function ForecastPage({ state, onRetry, region, theme, selection: chosen }: Props) {
  const { lang, t } = useI18n();
  const forecast = state.status === "ready" ? state.data : null;
  const [horizon, setHorizon] = useState(1);
  const { mode, area, draft } = chosen;
  const selection = useMemo(() => cellsInArea(region.centers, area), [region.centers, area]);
  const model = useMemo(() => (forecast ? fitIntervalModel(forecast) : null), [forecast]);
  const weeks = useMemo(
    () => (forecast && model ? areaForecast(forecast, selection, model) : []),
    [forecast, model, selection],
  );
  const context = useMemo(() => region.centers.map((cell) => cell.cell), [region.centers]);
  const centers = useMemo(() => region.centers.map((cell) => cell.center), [region.centers]);
  const regionBounds = useMemo(() => boundsOf(centers), [centers]);
  const units = forecast ? unitLabel(forecast.unit, "many", lang) : (lang === "es" ? "focos" : "hotspots");

  const outlookText: Record<Outlook, string> = {
    above: t.forecast.outlookAbove,
    near: t.forecast.outlookNear,
    below: t.forecast.outlookBelow,
  };

  const mapCells = useMemo<RiskCell[]>(() => {
    if (!forecast) return [];
    return forecast.cells.flatMap((cell) => {
      const row = cell.values.find((entry) => entry[0] === horizon);
      if (!row) return [];
      const [, expected, low, high, ratio] = row;
      return [
        {
          cell: cell.cell,
          color: ratioColor(ratio, expected),
          tooltip: [
            ratio === null
              ? (lang === "es" ? "Sin fuego habitual en esta semana" : "No fire usual in this week")
              : (lang === "es" ? `${formatRatio(ratio)} lo habitual` : `${formatRatio(ratio)} the usual`),
            lang === "es" ? `${value(expected)} ${units} esperados` : `${value(expected)} ${units} expected`,
            lang === "es" ? `Rango 90 % ${value(low)} – ${value(high)}` : `90 % range ${value(low)} – ${value(high)}`,
          ],
        },
      ];
    });
  }, [forecast, horizon, units, lang]);

  if (state.status === "loading") return <p className="status">{t.forecast.loading}</p>;
  if (state.status === "error")
    return (
      <div className="status" role="alert">
        <p>{t.forecast.error(state.message)}</p>
        <button type="button" className="button" onClick={onRetry}>
          {t.forecast.tryAgain}
        </button>
      </div>
    );
  if (!forecast || weeks.length === 0)
    return (
      <section className="panel outlook-empty">
        <SiMark place="section" />
        <h2 className="panel__title">{t.forecast.emptyTitle}</h2>
        <p className="summary__note">{t.forecast.emptyNote}</p>
      </section>
    );

  const current = weeks.find((week) => week.horizon === horizon) ?? weeks[0]!;
  const selectedCount = selection ? selection.size : region.centers.length;

  return (
    <div className="outlook">
      <div className="outlook__lead">
        <div className="notice" role="note">
          <p>
            <strong>{t.forecast.noticeStrong}</strong>
            {t.forecast.noticeBody}
          </p>
        </div>
      </div>

      <section className="outlook__map" aria-label={t.forecast.mapAria(units, weekLabel(current.week_start, lang))}>
        <Suspense fallback={<div className="map map--loading">{t.earlyWarning.mapLoading}</div>}>
          <RiskMap
            cells={mapCells}
            context={context}
            centers={centers}
            selected={selection}
            area={area}
            drawing={mode === "draw"}
            draft={draft}
            onAddVertex={chosen.addVertex}
            theme={theme}
          />
        </Suspense>
        <SiMark place="map" />
        <div className="map__legend ratio-legend">
          <span>{t.forecast.legendTitle(weekLabel(current.week_start, lang))}</span>
          <span className="ratio-legend__bar" style={{ background: RAMP }} aria-hidden="true" />
          <span className="ratio-legend__labels" aria-hidden="true">
            <span>¼×</span>
            <span>{t.forecast.usual}</span>
            <span>4×</span>
          </span>
        </div>
      </section>

      <aside className="outlook__side">
        <section className="panel" aria-labelledby="horizon-title">
          <h2 id="horizon-title" className="panel__title">
            {t.forecast.weekAhead}
          </h2>
          <fieldset className="segmented segmented--wrap" aria-label={t.forecast.forecastWeekAria}>
            {weeks.map((week) => (
              <label key={week.horizon}>
                <input type="radio" name="forecast-horizon" checked={horizon === week.horizon} onChange={() => setHorizon(week.horizon)} />
                {weekLabel(week.week_start, lang)}
              </label>
            ))}
          </fieldset>
        </section>
        <AreaControls
          mode={mode}
          onModeChange={chosen.changeMode}
          area={area}
          draftVertices={draft.length}
          onFinishDrawing={chosen.finishDrawing}
          onCancelDrawing={chosen.cancelDrawing}
          onApplyBox={chosen.applyBox}
          regionBounds={regionBounds}
          selectedCells={selectedCount}
          totalCells={region.centers.length}
        />
        <section className="panel" aria-labelledby="forecast-summary-title">
          <h2 id="forecast-summary-title" className="panel__title">
            {areaLabel(area, selectedCount, lang)}
          </h2>
          <p className="summary__total">
            {value(current.expected)}
            <span>{t.forecast.expectedUnits(units, weekLabel(current.week_start, lang))}</span>
          </p>
          <dl className="month-detail__list">
            <div>
              <dt>{t.forecast.range90}</dt>
              <dd>
                {value(current.low)} – {value(current.high)}
              </dd>
            </div>
            <div>
              <dt>{t.forecast.usualThisWeek}</dt>
              <dd>{value(current.climatology)}</dd>
            </div>
          </dl>
          <p className={`summary__note outlook-tone outlook-tone--${outlookOf(current)}`}>{outlookText[outlookOf(current)]}</p>
        </section>
      </aside>

      <section className="panel outlook__table" aria-labelledby="forecast-weeks-title">
        <h2 id="forecast-weeks-title" className="panel__title">
          {t.forecast.nextWeeks(weeks.length)}
        </h2>
        <SiMark place="section" />
        <div className="forecast-body">
          <ForecastChart weeks={weeks} unit={forecast.unit} horizon={horizon} />
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t.forecast.weekCol}</th>
                  <th scope="col">{t.forecast.expectedCol}</th>
                  <th scope="col">{t.forecast.range90Col}</th>
                  <th scope="col">{t.forecast.usualCol}</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((week) => (
                  <tr key={week.horizon} aria-current={week.horizon === horizon || undefined}>
                    <th scope="row">{weekLabel(week.week_start, lang)}</th>
                    <td>{value(week.expected)}</td>
                    <td>
                      {value(week.low)} – {value(week.high)}
                    </td>
                    <td>{value(week.climatology)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {selection !== null && (
          <p className="summary__note">
            {t.forecast.subAreaNote}
          </p>
        )}
      </section>

      <p className="outlook__method">
        {t.forecast.methodNote(weekLabel(forecast.issued_week, lang))}
      </p>
    </div>
  );
}
