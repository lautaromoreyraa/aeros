import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Unit } from "../api/types";
import { AnnualChart } from "../components/AnnualChart";
import { CalendarHeatmap, countScaleMax, type CalendarView } from "../components/CalendarHeatmap";
import { FireWeatherDays } from "../components/FireWeatherDays";
import { Legend } from "../components/Legend";
import { MonthTimeline } from "../components/MonthTimeline";
import { SectorOverview } from "../components/SectorOverview";
import type { MapFocus } from "../components/HexMap";
import { useFireWeather } from "../hooks/useFireWeather";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import { useRememberedChoice } from "../hooks/useRememberedChoice";
import type { LoadedRegion } from "../hooks/useRegion";
import { useSectorCalendars } from "../hooks/useSectorCalendars";
import { useWind } from "../hooks/useWind";
import { cellTotals, yearlyTotals, type CellTotal } from "../util/aggregation";
import type { Area, LngLat } from "../util/area";
import { BLAZE, toCss } from "../util/colorRamp";
import { criticalPeriod } from "../util/criticalPeriod";
import { formatDay } from "../util/earlyWarning";
import { daysAhead, nodesNear, summarizeDays } from "../util/fireWeather";
import { unitLabel } from "../util/format";
import { monthKey, monthOfYear, yearOf } from "../util/months";
import { eraComparison, recordAt } from "../util/sectorKpis";
import { WHOLE_REGION, cellsOfSector, demoSectors } from "../util/sectors";
import { hourIndexAt } from "../util/wind";

const HexMap = lazy(() => import("../components/HexMap"));

type Tab = "overview" | "calendar" | "anomalies" | "trend";

const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "calendar", label: "Calendar" },
  { value: "anomalies", label: "Anomalies" },
  { value: "trend", label: "Trend" },
];

const UNITS: Unit[] = ["hotspots", "cell_days"];

// Stable references: a new object per render would rebuild the map layers.
const WHOLE: Area = { kind: "region" };
const NO_DRAFT: LngLat[] = [];
const NOTHING = () => {};

/** How fast the timeline advances while it plays. */
const STEP_MS = 450;

interface Props {
  region: LoadedRegion;
  unit: Unit;
  onUnitChange: (unit: Unit) => void;
}

const busiestCell = (totals: CellTotal[], cells: string[]): string | null => {
  const wanted = new Set(cells);
  let best: CellTotal | null = null;
  for (const cell of totals) if (wanted.has(cell.cell) && (!best || cell.harmonized > best.harmonized)) best = cell;
  return best?.cell ?? null;
};

const percent = (change: number) => `${change >= 0 ? "+" : "−"}${Math.abs(Math.round(change * 100))} %`;

/**
 * One screen: the terrain fills it and a timeline moves every figure. Tapping a
 * zone on the map floats its dashboard over the map; closing it, pressing
 * Escape or tapping empty ground puts the map back in full. The page only
 * composes; the figures come from `util/sectorKpis` and the sectors from
 * `util/sectors`.
 */
export function TerrainPage({ region, unit, onUnitChange }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  /** The zone whose dashboard is open; `null` while the map is shown alone. */
  const [sectorId, setSectorId] = useState<string | null>(null);
  /** The tapped cell: the camera closes in on it and the line starts there. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  // Wind is one more layer of the terrain, always on.
  const windState = useWind();
  const [windPlaying, setWindPlaying] = useRememberedChoice("aeros-wind", !reducedMotion);
  const wind = useMemo(
    () =>
      windState?.status === "ready"
        ? { field: windState.data, hour: hourIndexAt(windState.data, Date.now()), playing: windPlaying, onToggle: () => setWindPlaying(!windPlaying) }
        : null,
    [windState, windPlaying, setWindPlaying],
  );
  const [tab, setTab] = useState<Tab>("overview");
  const [month, setMonth] = useState(region.lastMonth);
  const [playing, setPlaying] = useState(false);

  const sectors = useMemo(() => demoSectors(region.centers), [region.centers]);
  const calendars = useSectorCalendars(region.unit, sectors, region.firstMonth, region.lastMonth);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(
      () => setMonth((current) => (current >= region.lastMonth ? region.firstMonth : current + 1)),
      STEP_MS,
    );
    return () => window.clearInterval(timer);
  }, [playing, region.firstMonth, region.lastMonth]);

  // The terrain is the mean of the whole record, so it does not move with the timeline.
  const totals = useMemo(
    () => cellTotals(region.cells, 0, region.lastMonth - region.firstMonth),
    [region.cells, region.firstMonth, region.lastMonth],
  );
  const centers = useMemo(() => region.centers.map((cell) => cell.center), [region.centers]);
  const selected = useMemo(() => {
    const cells = sectorId === null ? null : cellsOfSector(sectors, sectorId);
    return cells ? new Set(cells) : null;
  }, [sectors, sectorId]);
  const mapFocus = useMemo<MapFocus | null>(() => {
    if (sectorId === null) return null;
    // A tap closes in on that cell, near enough to read the towns in it; the
    // list frames the whole zone, as it names no cell.
    if (anchor && selected?.has(anchor)) return { cells: [anchor], anchor };
    return { cells: [...(selected ?? new Set(region.centers.map((cell) => cell.cell)))], anchor };
  }, [sectorId, anchor, selected, region.centers]);
  const sectorOfCell = useMemo(
    () => new Map(sectors.flatMap((sector) => sector.cells.map((cell) => [cell, sector.id] as const))),
    [sectors],
  );
  const fireWeather = useFireWeather();
  /** The next days of fire weather over the open zone: its worst forecast point each day. */
  const zoneWeather = useMemo(() => {
    if (sectorId === null || fireWeather.status !== "ready" || !fireWeather.data) return null;
    const field = fireWeather.data;
    const points = region.centers.filter((cell) => !selected || selected.has(cell.cell)).map((cell) => cell.center);
    return { field, ...daysAhead(summarizeDays(field, nodesNear(field.grid, points)), new Date().toISOString().slice(0, 10)) };
  }, [sectorId, fireWeather, selected, region.centers]);

  const close = useCallback(() => {
    setSectorId(null);
    setAnchor(null);
  }, []);
  const pick = useCallback(
    (cell: string | null) => {
      const id = cell ? sectorOfCell.get(cell) : undefined;
      if (!cell || !id) return close();
      setSectorId(id);
      setAnchor(cell);
    },
    [sectorOfCell, close],
  );
  /** Picked from the list instead of the map: the zone's busiest cell stands in for the tap. */
  const choose = useCallback(
    (id: string | null) => {
      const cells = id === null ? null : cellsOfSector(sectors, id);
      if (id === null) return close();
      setSectorId(id);
      setAnchor(cells ? busiestCell(totals, cells) : null);
    },
    [sectors, totals, close],
  );

  useEffect(() => {
    if (sectorId === null) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sectorId, close]);

  // A newly opened zone is announced by moving focus to its name.
  useEffect(() => {
    if (sectorId !== null) headingRef.current?.focus({ preventScroll: true });
  }, [sectorId]);

  const year = yearOf(month);
  const monthInYear = monthOfYear(month);
  const records = (sectorId !== null && calendars.byId[sectorId]) || [];
  const season = useMemo(() => criticalPeriod(records), [records]);
  const era = useMemo(() => eraComparison(yearlyTotals(records)), [records]);
  const view: CalendarView = tab === "anomalies" ? "anomaly" : "harmonized";
  const max = useMemo(() => countScaleMax(records), [records]);
  const focus = recordAt(records, year, monthInYear) ?? null;

  const zones = [
    { id: WHOLE_REGION, name: "Whole region", place: `${region.centers.length} H3 cells` },
    ...sectors.map(({ id, name, place }) => ({ id, name, place })),
  ];
  const current = zones.find((zone) => zone.id === sectorId);

  const windTime = wind
    ? (() => {
        const parsed = Date.parse(wind.field.hours[wind.hour] ?? "");
        return Number.isNaN(parsed) ? "" : ` (${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(parsed)})`;
      })()
    : "";
  const windLegend = wind
    ? windPlaying
      ? `Wind now${windTime}: the streaks move the way it blows; brighter and faster means stronger.`
      : `Wind now${windTime}: each arrow points the way it blows; brighter and longer means stronger.${
          reducedMotion ? " Paused because this device asks for less motion; press Play wind to see it move." : ""
        }`
    : null;

  return (
    <div className="terrain">
      <section className="terrain__map" aria-label={`Map of how much fire each area has had since ${yearOf(region.firstMonth)}`}>
        <Suspense fallback={<div className="map map--loading">Loading map…</div>}>
          <HexMap
            totals={totals}
            selected={selected}
            centers={centers}
            showRaw={false}
            unit={region.unit}
            area={WHOLE}
            drawing={false}
            draft={NO_DRAFT}
            onAddVertex={NOTHING}
            theme="dark"
            reducedMotion={reducedMotion}
            ramp={BLAZE}
            legible
            onPick={pick}
            focus={mapFocus}
            panel={panelRef}
            wind={wind}
            basemap="physical"
          />
        </Suspense>

        <div className="terrain__toolbar">
          <fieldset className="segmented" aria-label="Count">
            {UNITS.map((option) => (
              <label key={option}>
                <input type="radio" name="terrain-unit" checked={unit === option} onChange={() => onUnitChange(option)} />
                {unitLabel(option, "toggle")}
              </label>
            ))}
          </fieldset>
          {/* The same choice as tapping the map, for keyboards and screen readers. */}
          <select
            className="terrain__zone"
            aria-label="Zone"
            value={sectorId ?? ""}
            onChange={(event) => choose(event.target.value || null)}
          >
            <option value="">Tap a zone on the map</option>
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.name}
              </option>
            ))}
          </select>
          <div className="terrain__legend terrain__scale">
            <span>Less fire</span>
            <span
              className="terrain__ramp"
              style={{ background: `linear-gradient(to right, ${BLAZE.map((stop) => toCss(stop)).join(", ")})` }}
              aria-hidden="true"
            />
            <span>More fire</span>
          </div>
          <p className="terrain__legend">Taller and redder: more fire in that area since {yearOf(region.firstMonth)}.</p>
          {windState?.status === "error" && (
            <p className="terrain__legend" role="status">
              The wind could not be loaded: {windState.message}
            </p>
          )}
          {wind && (
            <p className="terrain__legend">
              {windLegend}{" "}
              <a className="credit-link" href="https://open-meteo.com/">
                Weather data by Open-Meteo.com
              </a>
            </p>
          )}
        </div>

        {current && (
          <aside ref={panelRef} className="terrain__panel" aria-labelledby="terrain-zone-title">
            <div className="terrain__head">
              <div>
                <h2 id="terrain-zone-title" ref={headingRef} tabIndex={-1} className="panel__title">
                  {current.name}
                </h2>
                <p className="summary__note">{current.place}</p>
              </div>
              <button type="button" className="terrain__close" onClick={close} aria-label={`Close ${current.name}`}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {zoneWeather && (
              <div className="terrain__weather">
                <p className="summary__note">
                  {zoneWeather.stale
                    ? `Fire weather forecast of ${formatDay(zoneWeather.field.generated_at.slice(0, 10))}`
                    : "Fire weather in this zone, next days"}
                </p>
                <FireWeatherDays days={zoneWeather.days} label={`Fire weather in ${current.name} by day`} />
                <p className="summary__note">
                  Against the same days of {zoneWeather.field.climatology.years[0]}–
                  {zoneWeather.field.climatology.years[1]}.{" "}
                  <a className="credit-link" href="https://open-meteo.com/">
                    Weather data by Open-Meteo.com
                  </a>
                </p>
              </div>
            )}

            {calendars.status === "error" && (
              <p className="field-error" role="alert">
                Could not compute the sector calendars: {calendars.message}
              </p>
            )}

            <div className="tabs tabs--panel" role="tablist" aria-label="Dashboard">
              {TABS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  id={`terrain-tab-${option.value}`}
                  aria-selected={tab === option.value}
                  aria-controls="terrain-tabpanel"
                  className="tabs__tab"
                  onClick={() => setTab(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div
              id="terrain-tabpanel"
              role="tabpanel"
              aria-labelledby={`terrain-tab-${tab}`}
              className="terrain__tabpanel"
              aria-busy={calendars.status === "loading"}
            >
              {tab === "overview" && <SectorOverview records={records} unit={region.unit} year={year} month={monthInYear} />}
              {(tab === "calendar" || tab === "anomalies") && (
                <>
                  <Legend view={view} max={max} unit={region.unit} />
                  <CalendarHeatmap
                    records={records}
                    view={view}
                    unit={region.unit}
                    criticalMonths={season.months}
                    peakMonth={season.peak_month ?? null}
                    selected={focus}
                    onSelect={(picked) => {
                      setPlaying(false);
                      setMonth(monthKey(picked.year, picked.month_of_year));
                    }}
                  />
                </>
              )}
              {tab === "trend" && (
                <>
                  <AnnualChart records={records} unit={region.unit} showRaw />
                  <p className="summary__note">
                    {era.stackedChange !== null && era.harmonizedChange !== null
                      ? `Stacked as delivered, ${era.late[0]}–${era.late[1]} looks ${percent(era.stackedChange)} busier than ${era.early[0]}–${era.early[1]}. Harmonized, the difference is ${percent(era.harmonizedChange)}: the part that is fire, not the change of satellite.`
                      : "There are not enough complete years to compare the satellite eras."}
                  </p>
                </>
              )}
            </div>
          </aside>
        )}
      </section>

      <MonthTimeline
        first={region.firstMonth}
        last={region.lastMonth}
        value={month}
        onChange={(next) => {
          setPlaying(false);
          setMonth(next);
        }}
        playing={playing}
        onTogglePlay={() => setPlaying((value) => !value)}
      />
    </div>
  );
}
