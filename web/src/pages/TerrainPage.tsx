import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { Unit } from "../api/types";
import { AnnualChart } from "../components/AnnualChart";
import { CalendarHeatmap, countScaleMax, type CalendarView } from "../components/CalendarHeatmap";
import { Legend } from "../components/Legend";
import { MonthTimeline } from "../components/MonthTimeline";
import { SectorList, type SectorRow } from "../components/SectorList";
import { SectorOverview } from "../components/SectorOverview";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { LoadedRegion } from "../hooks/useRegion";
import { useSectorCalendars } from "../hooks/useSectorCalendars";
import { cellTotals, yearlyTotals } from "../util/aggregation";
import type { Area, LngLat } from "../util/area";
import { FIRE } from "../util/colorRamp";
import { criticalPeriod } from "../util/criticalPeriod";
import { unitLabel } from "../util/format";
import { monthKey, monthOfYear, yearOf } from "../util/months";
import { eraComparison, recordAt } from "../util/sectorKpis";
import { WHOLE_REGION, cellsOfSector, demoSectors } from "../util/sectors";

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

const percent = (change: number) => `${change >= 0 ? "+" : "−"}${Math.abs(Math.round(change * 100))} %`;

/**
 * One screen: the terrain on the left, the sectors and the dashboard of the
 * chosen one on the right, and a timeline that moves every figure. The page only
 * composes; the figures come from `util/sectorKpis` and the sectors from
 * `util/sectors`.
 */
export function TerrainPage({ region, unit, onUnitChange }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const [sectorId, setSectorId] = useState(WHOLE_REGION);
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
    const cells = cellsOfSector(sectors, sectorId);
    return cells ? new Set(cells) : null;
  }, [sectors, sectorId]);

  const year = yearOf(month);
  const monthInYear = monthOfYear(month);
  const records = calendars.byId[sectorId] ?? [];
  const season = useMemo(() => criticalPeriod(records), [records]);
  const era = useMemo(() => eraComparison(yearlyTotals(records)), [records]);
  const view: CalendarView = tab === "anomalies" ? "anomaly" : "harmonized";
  const max = useMemo(() => countScaleMax(records), [records]);
  const focus = recordAt(records, year, monthInYear) ?? null;

  const rows: SectorRow[] = [
    { id: WHOLE_REGION, name: "Whole region", place: `${region.centers.length} H3 cells`, record: undefined },
    ...sectors.map((sector) => ({ id: sector.id, name: sector.name, place: sector.place, record: undefined })),
  ].map((row) => ({ ...row, record: recordAt(calendars.byId[row.id] ?? [], year, monthInYear) }));
  const current = rows.find((row) => row.id === sectorId) ?? rows[0]!;
  const units = unitLabel(region.unit);

  return (
    <div className="terrain">
      <section className="terrain__map" aria-label={`Terrain of ${units} per H3 cell`}>
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
            ramp={FIRE}
          />
        </Suspense>
        <p className="map__legend">Column height and colour: mean harmonized {units} over the whole record.</p>
      </section>

      <aside className="terrain__panel" aria-label="Sector dashboard">
        <div className="terrain__head">
          <div>
            <h2 className="panel__title">{current.name}</h2>
            <p className="summary__note">{current.place}</p>
          </div>
          <fieldset className="segmented" aria-label="Count">
            {UNITS.map((option) => (
              <label key={option}>
                <input type="radio" name="terrain-unit" checked={unit === option} onChange={() => onUnitChange(option)} />
                {unitLabel(option, "toggle")}
              </label>
            ))}
          </fieldset>
        </div>

        {calendars.status === "error" && (
          <p className="field-error" role="alert">
            Could not compute the sector calendars: {calendars.message}
          </p>
        )}

        <SectorList rows={rows} selectedId={sectorId} onSelect={setSectorId} />

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
