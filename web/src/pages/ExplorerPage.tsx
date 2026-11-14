import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { CalendarQuery, CalendarRecord, Unit } from "../api/types";
import { AnnualChart } from "../components/AnnualChart";
import { AreaControls, type AreaMode } from "../components/AreaControls";
import { CalendarHeatmap, countScaleMax, type CalendarView } from "../components/CalendarHeatmap";
import { CriticalPeriodNote } from "../components/CriticalPeriodNote";
import { DateRange } from "../components/DateRange";
import { Legend } from "../components/Legend";
import { MonthDetail } from "../components/MonthDetail";
import { useCalendar } from "../hooks/useCalendar";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { LoadedRegion } from "../hooks/useRegion";
import { cellTotals, inRange } from "../util/aggregation";
import { boundsOf, cellsInArea, type Area, type BoundingBox, type LngLat } from "../util/area";
import { criticalPeriod } from "../util/criticalPeriod";
import { calendarToCsv, csvFileName } from "../util/csv";
import { SATELLITE_NAMES, formatCount, unitLabel } from "../util/format";
import { formatMonth } from "../util/months";

const HexMap = lazy(() => import("../components/HexMap"));

const VIEWS: { value: CalendarView; label: string }[] = [
  { value: "harmonized", label: "Harmonized" },
  { value: "raw", label: "Raw stacked" },
  { value: "anomaly", label: "Anomaly" },
];

const UNITS: Unit[] = ["hotspots", "cell_days"];

function areaLabel(area: Area, cells: number): string {
  if (area.kind === "region") return "Gran Chaco study region";
  return `${area.kind === "box" ? "Lat-lon box" : "Drawn area"} (${cells} cells)`;
}

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
}

export function ExplorerPage({ region, theme, unit, onUnitChange }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const [mode, setMode] = useState<AreaMode>("region");
  const [area, setArea] = useState<Area>({ kind: "region" });
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [range, setRange] = useState({ start: region.firstMonth, end: region.lastMonth });
  const [view, setView] = useState<CalendarView>("harmonized");
  const [picked, setPicked] = useState<CalendarRecord | null>(null);

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
  const units = unitLabel(region.unit);
  const reference = region.meta?.reference_chain.map((name) => SATELLITE_NAMES[name] ?? name).join(", then ");

  const changeMode = useCallback((next: AreaMode) => {
    setMode(next);
    setDraft([]);
    if (next === "region") setArea({ kind: "region" });
  }, []);

  useEffect(() => {
    if (mode !== "draw") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const selectedCount = selection ? selection.size : region.centers.length;

  return (
    <div className="explorer">
      <section className="explorer__map" aria-label={`Map of ${units} per H3 cell`}>
        <Suspense fallback={<div className="map map--loading">Loading map…</div>}>
          <HexMap
            totals={totals}
            selected={selection}
            centers={centers}
            showRaw={view === "raw"}
            unit={region.unit}
            area={area}
            drawing={mode === "draw"}
            draft={draft}
            onAddVertex={(point) => setDraft((previous) => [...previous, point])}
            theme={theme}
            reducedMotion={reducedMotion}
          />
        </Suspense>
        <div className="map__legend">
          <span>
            Column height and colour: {view === "raw" ? "raw stacked" : "harmonized"} {units}, {formatMonth(range.start)}{" "}
            to {formatMonth(range.end)}
          </span>
        </div>
      </section>

      <aside className="explorer__side">
        <AreaControls
          mode={mode}
          onModeChange={changeMode}
          area={area}
          draftVertices={draft.length}
          onFinishDrawing={() => {
            setArea({ kind: "polygon", ring: draft });
            setDraft([]);
          }}
          onCancelDrawing={() => setDraft([])}
          onApplyBox={(box) => setArea({ kind: "box", box })}
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
            {areaLabel(area, selectedCount)}
          </h2>
          {selectedCount === 0 ? (
            <p className="summary__note">No cells in this area. Draw a larger area or pick the whole region.</p>
          ) : (
            <>
              <p className="summary__total">
                {formatCount(total.harmonized)}
                <span> harmonized {units} in range</span>
              </p>
              <p className="summary__note">
                A naive stack of MODIS and VIIRS counts {formatCount(total.raw)}: raw counts mix sensors that see
                fire differently, so years from different eras are not comparable.
                {reference && ` Every month is expressed as ${reference} would have seen it.`}
              </p>
              {latest && <MonthDetail record={latest} unit={region.unit} heading="Latest month in range vs. its usual value" />}
            </>
          )}
        </section>
      </aside>

      <section className="explorer__calendar panel" aria-labelledby="calendar-title">
        <div className="calendar-head">
          <div>
            <h2 id="calendar-title" className="panel__title">
              Burning calendar
            </h2>
            <p className="calendar-head__sub">
              {view === "anomaly"
                ? "Each month against the median of the same month in all other years."
                : view === "raw"
                  ? "What stacking raw detections gives: watch the jumps in 2002 and 2012."
                  : `VIIRS-equivalent ${units} per month, comparable across satellite eras.`}
            </p>
          </div>
          <div className="calendar-head__actions">
            <fieldset className="segmented" aria-label="Count">
              {UNITS.map((option) => (
                <label key={option} title={option === "cell_days" ? "H3 cells with at least one detection, per day" : undefined}>
                  <input type="radio" name="calendar-unit" checked={unit === option} onChange={() => onUnitChange(option)} />
                  {unitLabel(option, "toggle")}
                </label>
              ))}
            </fieldset>
            <fieldset className="segmented" aria-label="Calendar view">
              {VIEWS.map((option) => (
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
                  csvFileName(`${areaLabel(area, selectedCount)} ${region.unit}`, formatMonth(range.start), formatMonth(range.end)),
                )
              }
            >
              Download CSV
            </button>
          </div>
        </div>
        {calendar.status === "error" && (
          <p className="field-error" role="alert">
            Could not compute the calendar: {calendar.message}
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
              <MonthDetail record={focus} unit={region.unit} heading="Selected month" />
            ) : (
              <p className="summary__note">Pick a month in the calendar to see its numbers.</p>
            )}
            <AnnualChart records={records} unit={region.unit} showRaw={view !== "anomaly"} />
          </div>
        </div>
      </section>
    </div>
  );
}
