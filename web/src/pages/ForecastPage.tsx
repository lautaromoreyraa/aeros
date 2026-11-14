import { Suspense, lazy, useMemo, useState } from "react";
import type { Forecast } from "../api/types";
import { AreaControls } from "../components/AreaControls";
import { ForecastChart } from "../components/ForecastChart";
import type { RiskCell } from "../components/RiskMap";
import type { AreaSelection } from "../hooks/useAreaSelection";
import type { Loadable } from "../hooks/useOutlook";
import type { LoadedRegion } from "../hooks/useRegion";
import { areaLabel, boundsOf, cellsInArea } from "../util/area";
import { DIVERGING, toCss } from "../util/colorRamp";
import { formatCount, formatRatio, unitLabel } from "../util/format";
import { areaForecast, fitIntervalModel, outlookOf, ratioColor, weekLabel, type Outlook } from "../util/forecast";

const RiskMap = lazy(() => import("../components/RiskMap"));

const OUTLOOK_TEXT: Record<Outlook, string> = {
  above: "Above the usual: even the low end of the range exceeds what these weeks usually bring.",
  near: "Within the usual range: the forecast band includes what these weeks usually bring.",
  below: "Below the usual: even the high end of the range stays under what these weeks usually bring.",
};

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
  const units = forecast ? unitLabel(forecast.unit) : "hotspots";

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
            ratio === null ? "No fire usual in this week" : `${formatRatio(ratio)} the usual`,
            `${value(expected)} ${units} expected`,
            `90 % range ${value(low)} – ${value(high)}`,
          ],
        },
      ];
    });
  }, [forecast, horizon, units]);

  if (state.status === "loading") return <p className="status">Loading the forecast…</p>;
  if (state.status === "error")
    return (
      <div className="status" role="alert">
        <p>The forecast could not be loaded: {state.message}</p>
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  if (!forecast || weeks.length === 0)
    return (
      <section className="panel outlook-empty">
        <h2 className="panel__title">Forecast</h2>
        <p className="summary__note">No forecast has been published yet.</p>
      </section>
    );

  const current = weeks.find((week) => week.horizon === horizon) ?? weeks[0]!;
  const selectedCount = selection ? selection.size : region.centers.length;

  return (
    <div className="outlook">
      <div className="outlook__lead">
        <div className="notice" role="note">
          <p>
            <strong>Statistical forecast, not a guarantee.</strong> It projects how many hotspots the coming weeks are likely
            to bring from recent activity and what these weeks usually bring. It does not know the weather, and one week in
            ten is expected to fall outside the 90 % band.
          </p>
        </div>
      </div>

      <section className="outlook__map" aria-label={`Map of expected ${units} against the usual, ${weekLabel(current.week_start)}`}>
        <Suspense fallback={<div className="map map--loading">Loading map…</div>}>
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
        <div className="map__legend ratio-legend">
          <span>Expected vs. usual, {weekLabel(current.week_start)}</span>
          <span className="ratio-legend__bar" style={{ background: RAMP }} aria-hidden="true" />
          <span className="ratio-legend__labels" aria-hidden="true">
            <span>¼×</span>
            <span>usual</span>
            <span>4×</span>
          </span>
        </div>
      </section>

      <aside className="outlook__side">
        <section className="panel" aria-labelledby="horizon-title">
          <h2 id="horizon-title" className="panel__title">
            Week ahead
          </h2>
          <fieldset className="segmented segmented--wrap" aria-label="Forecast week">
            {weeks.map((week) => (
              <label key={week.horizon}>
                <input type="radio" name="forecast-horizon" checked={horizon === week.horizon} onChange={() => setHorizon(week.horizon)} />
                {weekLabel(week.week_start)}
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
            {areaLabel(area, selectedCount)}
          </h2>
          <p className="summary__total">
            {value(current.expected)}
            <span> {units} expected, {weekLabel(current.week_start)}</span>
          </p>
          <dl className="month-detail__list">
            <div>
              <dt>90 % range</dt>
              <dd>
                {value(current.low)} – {value(current.high)}
              </dd>
            </div>
            <div>
              <dt>Usual for this week</dt>
              <dd>{value(current.climatology)}</dd>
            </div>
          </dl>
          <p className={`summary__note outlook-tone outlook-tone--${outlookOf(current)}`}>{OUTLOOK_TEXT[outlookOf(current)]}</p>
        </section>
      </aside>

      <section className="panel outlook__table" aria-labelledby="forecast-weeks-title">
        <h2 id="forecast-weeks-title" className="panel__title">
          Next {weeks.length} weeks
        </h2>
        <div className="forecast-body">
          <ForecastChart weeks={weeks} unit={forecast.unit} horizon={horizon} />
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Week</th>
                  <th scope="col">Expected</th>
                  <th scope="col">90 % range</th>
                  <th scope="col">Usual</th>
                </tr>
              </thead>
              <tbody>
                {weeks.map((week) => (
                  <tr key={week.horizon} aria-current={week.horizon === horizon || undefined}>
                    <th scope="row">{weekLabel(week.week_start)}</th>
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
            The range for a chosen area is rebuilt from its cells with the model's own error terms: a shared error that grows
            with the total plus noise that partly cancels out across cells.
          </p>
        )}
      </section>

      <p className="outlook__method">
        Issued from the week of {weekLabel(forecast.issued_week)}, on the harmonized VIIRS-equivalent record. "Usual" is the
        mean of the same week of the year in earlier years.
      </p>
    </div>
  );
}
