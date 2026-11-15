import { Suspense, lazy, useMemo } from "react";
import type { EarlyWarning } from "../api/types";
import { AlertBanner } from "../components/AlertBanner";
import { FireReport } from "../components/FireReport";
import { FireWeatherDays } from "../components/FireWeatherDays";
import type { RiskCell } from "../components/RiskMap";
import { useFireWeather } from "../hooks/useFireWeather";
import type { Loadable } from "../hooks/useOutlook";
import type { LoadedRegion } from "../hooks/useRegion";
import { useI18n } from "../i18n/I18nContext";
import { ratioColor } from "../util/forecast";
import { alertDecision, calmMessage, daysBetween, formatDay, formatPValue, windowCoverage } from "../util/earlyWarning";
import { daysAhead, nodesNear, summarizeDays } from "../util/fireWeather";
import { formatCount, formatPlace, formatRatio } from "../util/format";
import { cellCenters } from "../util/geo";

const RiskMap = lazy(() => import("../components/RiskMap"));

const formatUpdated = (iso: string, locale: "en" | "es" = "en") => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat(locale === "es" ? "es-ES" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(time) + " UTC";
};

interface Props {
  state: Loadable<EarlyWarning | null>;
  onRetry: () => void;
  region: LoadedRegion;
  theme: "light" | "dark";
}

export function EarlyWarningPage({ state, onRetry, region, theme }: Props) {
  const { lang, t } = useI18n();
  const report = state.status === "ready" ? state.data : null;
  const decision = useMemo(() => alertDecision(report), [report]);
  const context = useMemo(() => region.centers.map((cell) => cell.cell), [region.centers]);
  const centers = useMemo(() => region.centers.map((cell) => cell.center), [region.centers]);
  const fireWeather = useFireWeather();
  // Only the forecast points over the region count: the box around it also
  // takes in the dry Andes, which would read as extreme every day.
  const weather = useMemo(() => {
    if (fireWeather.status !== "ready" || !fireWeather.data) return null;
    const field = fireWeather.data;
    const nodes = nodesNear(field.grid, centers);
    return { field, areas: nodes.length, ...daysAhead(summarizeDays(field, nodes), new Date().toISOString().slice(0, 10)) };
  }, [fireWeather, centers]);
  const places = useMemo(
    () => new Map(cellCenters(decision.cells.map((cell) => cell.cell)).map((cell) => [cell.cell, cell.center])),
    [decision.cells],
  );
  const mapCells = useMemo<RiskCell[]>(
    () =>
      decision.cells.map((cell) => ({
        cell: cell.cell,
        color: ratioColor(cell.ratio, cell.observed),
        emphasis: true,
        tooltip: [
          `${formatRatio(cell.ratio)} ${lang === "es" ? "lo habitual" : "the usual"}`,
          `${formatCount(cell.observed)} ${lang === "es" ? "focos observados" : "hotspots observed"}`,
          `${cell.expected < 10 ? cell.expected.toFixed(1) : formatCount(cell.expected)} ${lang === "es" ? "esperados" : "expected"}`,
          formatPValue(cell.p_value),
        ],
      })),
    [decision.cells, lang],
  );

  if (state.status === "loading") return <p className="status">{t.earlyWarning.loading}</p>;
  if (state.status === "error")
    return (
      <div className="status" role="alert">
        <p>{t.earlyWarning.error(state.message)}</p>
        <button type="button" className="button" onClick={onRetry}>
          {t.earlyWarning.tryAgain}
        </button>
      </div>
    );
  if (!report)
    return (
      <section className="panel outlook-empty">
        <h2 className="panel__title">{t.earlyWarning.emptyTitle}</h2>
        <p className="summary__note">{t.earlyWarning.emptyNote}</p>
      </section>
    );

  const coverage = windowCoverage(report);
  const calm = calmMessage(report, coverage);
  const days = report.days ?? daysBetween(report.window[0], report.window[1]).map((date) => ({
    date,
    status: coverage.gapDates.includes(date) ? "gap" : "ok",
    satellite: null,
    detections: null,
  }));
  const pastYears = report.method?.past_years ?? [];

  return (
    <div className="outlook">
      <div className="outlook__lead">
        {decision.active ? (
          <AlertBanner report={report} decision={decision} resolution={region.cells.resolution} />
        ) : (
          <div className="calm-banner" role="status">
            <p>
              <strong>{calm.title}</strong> {calm.text}
            </p>
          </div>
        )}
      </div>

      <section className="outlook__map" aria-label={t.earlyWarning.mapAria}>
        <Suspense fallback={<div className="map map--loading">{t.earlyWarning.mapLoading}</div>}>
          <RiskMap cells={mapCells} context={context} centers={centers} theme={theme} />
        </Suspense>
        <div className="map__legend">
          <span>{decision.cells.length > 0 ? t.earlyWarning.legendOutlined : t.earlyWarning.legendNone}</span>
        </div>
      </section>

      <aside className="outlook__side">
        <section className="panel" aria-labelledby="window-title">
          <div className="panel__head">
            <h2 id="window-title" className="panel__title">
              {t.earlyWarning.lastDays(coverage.windowDays)}
            </h2>
            <span className="panel__meta">
              {t.earlyWarning.daysWithData(coverage.dataDays, coverage.windowDays)}
            </span>
          </div>
          <ol className="day-strip">
            {days.map((day) => (
              <li key={day.date} className={day.status === "gap" ? "day day--gap" : "day"}>
                <span className="day__date">{formatDay(day.date)}</span>
                <span className="day__source">{day.status === "gap" ? t.earlyWarning.noData : day.satellite ?? "VIIRS"}</span>
              </li>
            ))}
          </ol>
          {coverage.gapCount > 0 && (
            <p className="summary__note">
              {t.earlyWarning.gapNote(coverage.gapCount)}
            </p>
          )}
        </section>

        <section className="panel" aria-labelledby="report-title">
          <h2 id="report-title" className="panel__title">
            {t.earlyWarning.seeingFire}
          </h2>
          <p className="summary__note">{t.earlyWarning.seeingFireSubtitle}</p>
          <FireReport />
        </section>

        {weather && (
          <section className="panel" aria-labelledby="fire-weather-title">
            <div className="panel__head">
              <h2 id="fire-weather-title" className="panel__title">
                {weather.stale
                  ? t.earlyWarning.fireWeather
                  : t.earlyWarning.fireWeatherDays(weather.days.length)}
              </h2>
              <span className="panel__meta">{t.earlyWarning.issued(formatDay(weather.field.generated_at.slice(0, 10)))}</span>
            </div>
            <FireWeatherDays days={weather.days} label={t.earlyWarning.fireWeatherLabel} />
            <p className="summary__note">
              {t.earlyWarning.fireWeatherNote(
                weather.stale,
                weather.areas,
                weather.field.climatology.years[0],
                weather.field.climatology.years[1],
                weather.field.levels.extreme,
              )}
            </p>
            <p className="summary__note">
              <a className="credit-link" href="https://open-meteo.com/">
                {t.earlyWarning.weatherByOpenMeteo}
              </a>
            </p>
          </section>
        )}

        {report.region && (
          <section className="panel" aria-labelledby="ew-region-title">
            <h2 id="ew-region-title" className="panel__title">
              {t.earlyWarning.studyRegion}
            </h2>
            <p className="summary__total">
              {formatCount(report.region.observed)}
              <span> {t.earlyWarning.hotspotsObserved}</span>
            </p>
            <dl className="month-detail__list">
              <div>
                <dt>{t.earlyWarning.expectedTheseDays}</dt>
                <dd>{formatCount(report.region.expected)}</dd>
              </div>
              <div>
                <dt>{t.earlyWarning.ratio}</dt>
                <dd>{formatRatio(report.region.ratio)}</dd>
              </div>
              <div>
                <dt>{t.earlyWarning.significance}</dt>
                <dd>{formatPValue(report.region.p_value)}</dd>
              </div>
            </dl>
            <p className="summary__note">{t.earlyWarning.regionThresholdNote}</p>
          </section>
        )}
      </aside>

      {decision.cells.length > 0 && (
        <section className="panel outlook__table" aria-labelledby="flagged-title">
          <h2 id="flagged-title" className="panel__title">
            {lang === "es" ? "Celdas por encima de su actividad habitual" : "Cells above their usual activity"}
          </h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{lang === "es" ? "Centro de celda" : "Cell center"}</th>
                  <th scope="col">{lang === "es" ? "Observado" : "Observed"}</th>
                  <th scope="col">{lang === "es" ? "Esperado" : "Expected"}</th>
                  <th scope="col">{lang === "es" ? "Proporción" : "Ratio"}</th>
                  <th scope="col">{lang === "es" ? "Significancia" : "Significance"}</th>
                </tr>
              </thead>
              <tbody>
                {decision.cells.map((cell) => (
                  <tr key={cell.cell}>
                    <th scope="row">{places.has(cell.cell) ? formatPlace(places.get(cell.cell)!) : cell.cell}</th>
                    <td>{formatCount(cell.observed)}</td>
                    <td>{cell.expected < 10 ? cell.expected.toFixed(1) : formatCount(cell.expected)}</td>
                    <td>{formatRatio(cell.ratio)}</td>
                    <td>{formatPValue(cell.p_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="outlook__method">
        {lang === "es"
          ? `Focos en tiempo casi real de VIIRS, un satélite por día (NOAA-20, o NOAA-21 si NOAA-20 no tiene datos). Esperado: mediana de los mismos días calendario ${pastYears.length ? `en ${pastYears[0]}–${pastYears[pastYears.length - 1]}` : "en años anteriores"} del registro armonizado. Prueba: Poisson unilateral, p < 0,01. Actualizado ${formatUpdated(report.generated_at, lang)}.`
          : `VIIRS near-real-time hotspots, one satellite per day (NOAA-20, or NOAA-21 when NOAA-20 has nothing). Expected: the median of the same calendar days ${pastYears.length ? `in ${pastYears[0]}–${pastYears[pastYears.length - 1]}` : "in earlier years"} on the harmonized record. Test: one-sided Poisson, p < 0.01. Updated ${formatUpdated(report.generated_at, lang)}.`}
      </p>
    </div>
  );
}
