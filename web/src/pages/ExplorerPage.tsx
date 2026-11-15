import { Suspense, lazy, useMemo, useState } from "react";
import type { CalendarQuery, CalendarRecord, Unit } from "../api/types";
import { AnnualChart } from "../components/AnnualChart";
import { AreaControls } from "../components/AreaControls";
import { CalendarHeatmap, countScaleMax, type CalendarView } from "../components/CalendarHeatmap";
import { CriticalPeriodNote } from "../components/CriticalPeriodNote";
import { DateRange } from "../components/DateRange";
import { Legend } from "../components/Legend";
import { MonthDetail } from "../components/MonthDetail";
import { useCalendar } from "../hooks/useCalendar";
import type { AreaSelection } from "../hooks/useAreaSelection";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { LoadedRegion } from "../hooks/useRegion";
import { useI18n } from "../i18n/I18nContext";
import { cellTotals, inRange } from "../util/aggregation";
import { areaLabel, boundsOf, cellsInArea, type BoundingBox } from "../util/area";
import { criticalPeriod } from "../util/criticalPeriod";
import { calendarToCsv, csvFileName } from "../util/csv";
import { SATELLITE_NAMES, formatCount, unitLabel } from "../util/format";
import { formatMonth } from "../util/months";

const HexMap = lazy(() => import("../components/HexMap"));

const UNITS: Unit[] = ["hotspots", "cell_days"];

function download(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL is revoked.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Props {
  region: LoadedRegion;
  theme: "light" | "dark";
  unit: Unit;
  onUnitChange: (unit: Unit) => void;
  selection: AreaSelection;
}

export function ExplorerPage({ region, theme, unit, onUnitChange, selection: chosen }: Props) {
  const { lang, t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const { mode, area, draft } = chosen;
  const [range, setRange] = useState({ start: region.firstMonth, end: region.lastMonth });
  const [view, setView] = useState<CalendarView>("harmonized");
  const [picked, setPicked] = useState<CalendarRecord | null>(null);

  const views: { value: CalendarView; label: string }[] = [
    { value: "harmonized", label: lang === "es" ? "Armonizado" : "Harmonized" },
    { value: "raw", label: lang === "es" ? "Datos brutos" : "Raw stacked" },
    { value: "anomaly", label: lang === "es" ? "Anomalía" : "Anomaly" },
  ];

  const selection = useMemo(() => cellsInArea(region.centers, area), [region.centers, area]);
  // The whole record is requested: the critical period describes the area's
  // typical year, so it must not change with the date range.
  const query = useMemo<CalendarQuery>(
    () => ({
      unit: region.unit,
      cells: selection ? [...selection] : null,
      start: region.firstMonth,
      end: region.lastMonth,
    }),
    [region.unit, region.firstMonth, region.lastMonth, selection],
  );
  const calendar = useCalendar(query);
  const records = useMemo(() => inRange(calendar.records, range.start, range.end), [calendar.records, range]);
  const season = useMemo(
    () =>
      area.kind === "region" && region.criticalPeriod ? region.criticalPeriod : criticalPeriod(calendar.records),
    [area.kind, region.criticalPeriod, calendar.records],
  );

  const totals = useMemo(
    () => cellTotals(region.cells, range.start - region.firstMonth, range.end - region.firstMonth),
    [region, range],
  );
  const regionBounds: BoundingBox = useMemo(() => boundsOf(region.centers.map((cell) => cell.center)), [region]);
  const centers = useMemo(() => region.centers.map((cell) => cell.center), [region.centers]);

  const latest = records[records.length - 1] ?? null;
  const focus = (picked && records.find((r) => r.year === picked.year && r.month_of_year === picked.month_of_year)) ?? null;
  const max = useMemo(() => countScaleMax(records), [records]);
  const total = useMemo(
    () =>
      records.reduce(
        (sum, record) => ({ harmonized: sum.harmonized + record.harmonized, raw: sum.raw + record.stacked_raw }),
        { harmonized: 0, raw: 0 },
      ),
    [records],
  );
  const units = unitLabel(region.unit, "many", lang);
  const reference = region.meta?.reference_chain.map((name) => SATELLITE_NAMES[name] ?? name).join(", then ");

  const selectedCount = selection ? selection.size : region.centers.length;

  return (
    <div className="explorer">
      <section className="explorer__map" aria-label={t.explorer.mapAria(units)}>
        <Suspense fallback={<div className="map map--loading">{t.earlyWarning.mapLoading}</div>}>
          <HexMap
            totals={totals}
            selected={selection}
            centers={centers}
            showRaw={view === "raw"}
            unit={region.unit}
            area={area}
            drawing={mode === "draw"}
            draft={draft}
            onAddVertex={chosen.addVertex}
            theme={theme}
            reducedMotion={reducedMotion}
          />
        </Suspense>
        <div className="map__legend">
          <span>
            {t.explorer.mapLegend(
              view === "raw" ? (lang === "es" ? "datos brutos" : "raw stacked") : (lang === "es" ? "armonizado" : "harmonized"),
              units,
              formatMonth(range.start),
              formatMonth(range.end),
            )}
          </span>
        </div>
      </section>

      <aside className="explorer__side">
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
        <DateRange
          start={range.start}
          end={range.end}
          min={region.firstMonth}
          max={region.lastMonth}
          onChange={(start, end) => setRange({ start, end })}
        />
        <section className="panel summary" aria-labelledby="summary-title">
          <h2 id="summary-title" className="panel__title">
            {areaLabel(area, selectedCount, lang)}
          </h2>
          {selectedCount === 0 ? (
            <p className="summary__note">{t.explorer.noCellsInArea}</p>
          ) : (
            <>
              <p className="summary__total">
                {t.explorer.harmonizedInRange(formatCount(total.harmonized), units)}
              </p>
              <p className="summary__note">
                {t.explorer.rawComparisonNote(formatCount(total.raw), reference)}
              </p>
              {latest && <MonthDetail record={latest} unit={region.unit} heading={t.explorer.latestMonthPrompt} />}
            </>
          )}
        </section>
      </aside>

      <section className="explorer__calendar panel" aria-labelledby="calendar-title">
        <div className="calendar-head">
          <div>
            <h2 id="calendar-title" className="panel__title">
              {t.explorer.burningCalendar}
            </h2>
            <p className="calendar-head__sub">
              {view === "anomaly"
                ? t.explorer.viewSubAnomaly
                : view === "raw"
                  ? t.explorer.viewSubRaw
                  : t.explorer.viewSubHarmonized(units)}
            </p>
          </div>
          <div className="calendar-head__actions">
            <fieldset className="segmented" aria-label={t.explorer.hotspots}>
              {UNITS.map((option) => (
                <label key={option} title={option === "cell_days" ? (lang === "es" ? "Celdas H3 con al menos una detección por día" : "H3 cells with at least one detection, per day") : undefined}>
                  <input type="radio" name="calendar-unit" checked={unit === option} onChange={() => onUnitChange(option)} />
                  {unitLabel(option, "toggle", lang)}
                </label>
              ))}
            </fieldset>
            <fieldset className="segmented" aria-label={lang === "es" ? "Vista de calendario" : "Calendar view"}>
              {views.map((option) => (
                <label key={option.value}>
                  <input type="radio" name="calendar-view" checked={view === option.value} onChange={() => setView(option.value)} />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="button"
              disabled={records.length === 0}
              onClick={() =>
                download(
                  calendarToCsv(records),
                  csvFileName(`${areaLabel(area, selectedCount, lang)} ${region.unit}`, formatMonth(range.start), formatMonth(range.end)),
                )
              }
            >
              {t.explorer.downloadCsv}
            </button>
          </div>
        </div>
        {calendar.status === "error" && (
          <p className="field-error" role="alert">
            {t.explorer.computeError(calendar.message)}
          </p>
        )}
        <div className="calendar-body" aria-busy={calendar.status === "loading" || region.unit !== unit}>
          <div className="calendar-body__grid">
            <Legend view={view} max={max} unit={region.unit} />
            <CriticalPeriodNote period={season} />
            <CalendarHeatmap
              records={records}
              view={view}
              unit={region.unit}
              criticalMonths={season.months}
              peakMonth={season.peak_month ?? null}
              selected={focus}
              onSelect={setPicked}
            />
          </div>
          <div className="calendar-body__side">
            {focus ? (
              <MonthDetail record={focus} unit={region.unit} heading={t.explorer.selectedMonth} />
            ) : (
              <p className="summary__note">{t.explorer.pickMonthPrompt}</p>
            )}
            <AnnualChart records={records} unit={region.unit} showRaw={view !== "anomaly"} />
          </div>
        </div>
      </section>
    </div>
  );
}
