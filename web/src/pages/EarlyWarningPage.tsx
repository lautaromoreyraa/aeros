import { Suspense, lazy, useMemo } from "react";
import type { EarlyWarning } from "../api/types";
import { AlertBanner } from "../components/AlertBanner";
import { FireWeatherDays } from "../components/FireWeatherDays";
import type { RiskCell } from "../components/RiskMap";
import { useFireWeather } from "../hooks/useFireWeather";
import type { Loadable } from "../hooks/useOutlook";
import type { LoadedRegion } from "../hooks/useRegion";
import { ratioColor } from "../util/forecast";
import { alertDecision, daysBetween, formatDay, formatPValue, windowCoverage } from "../util/earlyWarning";
import { daysAhead, nodesNear, summarizeDays } from "../util/fireWeather";
import { formatCount, formatPlace, formatRatio } from "../util/format";
import { cellCenters } from "../util/geo";

const RiskMap = lazy(() => import("../components/RiskMap"));

const formatUpdated = (iso: string) => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(time) + " UTC";
};

interface Props {
  state: Loadable<EarlyWarning | null>;
  onRetry: () => void;
  region: LoadedRegion;
  theme: "light" | "dark";
}

export function EarlyWarningPage({ state, onRetry, region, theme }: Props) {
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
          `${formatRatio(cell.ratio)} the usual`,
          `${formatCount(cell.observed)} hotspots observed`,
          `${cell.expected < 10 ? cell.expected.toFixed(1) : formatCount(cell.expected)} expected`,
          formatPValue(cell.p_value),
        ],
      })),
    [decision.cells],
  );

  if (state.status === "loading") return <p className="status">Loading the early warning…</p>;
  if (state.status === "error")
    return (
      <div className="status" role="alert">
        <p>The early warning could not be loaded: {state.message}</p>
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  if (!report)
    return (
      <section className="panel outlook-empty">
        <h2 className="panel__title">Early warning</h2>
        <p className="summary__note">No early warning has been published yet. It is refreshed once a day from FIRMS near-real-time data.</p>
      </section>
    );

  const coverage = windowCoverage(report);
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
          <AlertBanner report={report} decision={decision} />
        ) : (
          <div className="calm-banner" role="status">
            <p>
              <strong>{report.region ? "No unusual fire activity." : "Not enough data to judge."}</strong>{" "}
              {report.region
                ? `Hotspots from ${formatDay(report.window[0])} to ${formatDay(report.window[1])} are within the range of earlier years, region-wide and in every cell.`
                : "No satellite day in this window returned detections, so nothing can be said about fire activity yet."}
            </p>
          </div>
        )}
      </div>

      <section className="outlook__map" aria-label="Map of cells with unusual fire activity">
        <Suspense fallback={<div className="map map--loading">Loading map…</div>}>
          <RiskMap cells={mapCells} context={context} centers={centers} theme={theme} />
        </Suspense>
        <div className="map__legend">
          <span>{decision.cells.length > 0 ? "Outlined cells: significantly above their usual activity for these days" : "No cell is above its usual activity"}</span>
        </div>
      </section>

      <aside className="outlook__side">
        <section className="panel" aria-labelledby="window-title">
          <div className="panel__head">
            <h2 id="window-title" className="panel__title">
              Last {coverage.windowDays} days
            </h2>
            <span className="panel__meta">
              {coverage.dataDays} of {coverage.windowDays} with data
            </span>
          </div>
          <ol className="day-strip">
            {days.map((day) => (
              <li key={day.date} className={day.status === "gap" ? "day day--gap" : "day"}>
                <span className="day__date">{formatDay(day.date)}</span>
                <span className="day__source">{day.status === "gap" ? "No data" : day.satellite ?? "VIIRS"}</span>
              </li>
            ))}
          </ol>
          {coverage.gapCount > 0 && (
            <p className="summary__note">
              {coverage.gapCount === 1 ? "One day" : `${coverage.gapCount} days`} had no VIIRS data at all (an outage or late
              processing). {coverage.gapCount === 1 ? "It is" : "They are"} left out of both the observed and the expected
              count, so a gap never looks like a quiet day.
            </p>
          )}
        </section>

        {weather && (
          <section className="panel" aria-labelledby="fire-weather-title">
            <div className="panel__head">
              <h2 id="fire-weather-title" className="panel__title">
                {weather.stale
                  ? "Fire weather"
                  : `Fire weather, next ${weather.days.length === 1 ? "day" : `${weather.days.length} days`}`}
              </h2>
              <span className="panel__meta">Issued {formatDay(weather.field.generated_at.slice(0, 10))}</span>
            </div>
            <FireWeatherDays days={weather.days} label="Fire weather by day" />
            <p className="summary__note">
              {weather.stale && "Every day of this forecast is already past. "}
              Each day shows the driest and windiest of the {weather.areas} forecast points over the region, ranked
              against the same days of {weather.field.climatology.years[0]}–{weather.field.climatology.years[1]}.
              Extreme: drier and windier than {weather.field.levels.extreme} % of them. A forecast, not a measurement.
            </p>
            <p className="summary__note">
              <a className="credit-link" href="https://open-meteo.com/">
                Weather data by Open-Meteo.com
              </a>
            </p>
          </section>
        )}

        {report.region && (
          <section className="panel" aria-labelledby="ew-region-title">
            <h2 id="ew-region-title" className="panel__title">
              Study region
            </h2>
            <p className="summary__total">
              {formatCount(report.region.observed)}
              <span> hotspots observed</span>
            </p>
            <dl className="month-detail__list">
              <div>
                <dt>Expected for these days</dt>
                <dd>{formatCount(report.region.expected)}</dd>
              </div>
              <div>
                <dt>Ratio</dt>
                <dd>{formatRatio(report.region.ratio)}</dd>
              </div>
              <div>
                <dt>Significance</dt>
                <dd>{formatPValue(report.region.p_value)}</dd>
              </div>
            </dl>
            <p className="summary__note">A region-wide alert needs at least twice the usual and p &lt; 0.01.</p>
          </section>
        )}
      </aside>

      {decision.cells.length > 0 && (
        <section className="panel outlook__table" aria-labelledby="flagged-title">
          <h2 id="flagged-title" className="panel__title">
            Cells above their usual activity
          </h2>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Cell center</th>
                  <th scope="col">Observed</th>
                  <th scope="col">Expected</th>
                  <th scope="col">Ratio</th>
                  <th scope="col">Significance</th>
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
        VIIRS near-real-time hotspots, one satellite per day (NOAA-20, or NOAA-21 when NOAA-20 has nothing). Expected: the
        median of the same calendar days {pastYears.length ? `in ${pastYears[0]}–${pastYears[pastYears.length - 1]}` : "in earlier years"} on
        the harmonized record. Test: one-sided Poisson, p &lt; 0.01. Updated {formatUpdated(report.generated_at)}.
      </p>
    </div>
  );
}
