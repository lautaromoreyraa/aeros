/**
 * Contract with the aeros model. These shapes mirror the JSON artifacts written
 * by `python -m aeros demo` and the body the AWS `POST /calendar` endpoint will
 * return, so the UI never needs to know which of the two it is talking to.
 */

/**
 * Where the value of a month comes from: observed by the VIIRS reference,
 * bridged by its successor while the reference is gone (NOAA-20 standing in
 * for Suomi NPP), or modeled from MODIS before VIIRS flew.
 */
export type HarmonizedSource = "observed" | "bridged" | "modeled_terra_aqua" | "modeled_terra";

/** What a count means: detections, or H3 cell-days with at least one detection. */
export type Unit = "hotspots" | "cell_days";

export interface DatasetMeta {
  unit: Unit;
  /** VIIRS satellites the series is expressed in, oldest first. */
  reference_chain: string[];
  resolution: number;
  model: string;
  first_month: string;
  last_month: string;
}

/** Shortest run of calendar months holding `share` of the typical yearly activity. */
export interface CriticalPeriod {
  share: number;
  held?: number;
  /** Calendar months 1-12, in season order (may wrap around the year end). */
  months: number[];
  start_month: number | null;
  end_month: number | null;
  peak_month?: number;
  /** Median over years of each calendar month, January first. */
  median_by_month?: number[];
}

/** One month of the burning calendar for an area. */
export interface CalendarRecord {
  year: number;
  month_of_year: number;
  /** VIIRS-equivalent count, in the unit of the dataset. */
  harmonized: number;
  /** Lower bound of the 90 % interval. */
  low: number;
  /** Upper bound of the 90 % interval. */
  high: number;
  /** MODIS and VIIRS detections simply added up, as a naive analysis would. */
  stacked_raw: number;
  /** Harmonized hotspots that could not be attached to a VIIRS footprint. */
  unattached: number;
  /** Median of the same calendar month over every other year. */
  median_same_month: number | null;
  anomaly: number | null;
  anomaly_ratio: number | null;
  source: HarmonizedSource | string;
}

/** Column order of each row in {@link CellsMonthly.cells}[].values. */
export type CellMonthRow = [month_index: number, harmonized: number, variance: number, stacked_raw: number];

/** Per-cell monthly series used by the map layer. Months without hotspots are omitted. */
export interface CellsMonthly {
  resolution: number;
  /** "YYYY-MM", indexed by `month_index`. */
  months: string[];
  columns: string[];
  cells: { cell: string; values: CellMonthRow[] }[];
}

export interface ValidationScores {
  mae_cell_week: number;
  mae_cell_year: number;
  pearson_cell_year: number;
  bias_total: number;
  max_abs_rel_error_year_total: number;
}

export interface Validation {
  split_year: number;
  winner: string;
  temporal: Record<string, ValidationScores>;
  spatial: Record<string, ValidationScores>;
  dispersion: Record<string, number>;
}

export interface MorningRecord {
  year: number;
  terra_only_cell_days: number;
  terra_cell_days: number;
  terra_only_share: number;
  terra_median_solar_hour: number;
}

/** A month expressed as `year * 12 + (month - 1)`, so ranges are plain integers. */
export type MonthKey = number;

export interface CalendarQuery {
  unit: Unit;
  /** H3 cells of the selected area; `null` means the whole region. */
  cells: string[] | null;
  start: MonthKey;
  end: MonthKey;
}

/** Everything the app needs to draw the region before any area is chosen. */
export interface RegionData {
  unit: Unit;
  meta: DatasetMeta | null;
  /** The model's own critical period for the whole region, when it shipped one. */
  criticalPeriod: CriticalPeriod | null;
  cells: CellsMonthly;
  region: CalendarRecord[];
  validation: Validation | null;
  morning: MorningRecord[];
}

/** Observed against expected for the early-warning window, region-wide or for one cell. */
export interface EarlyWarningScore {
  observed: number;
  expected: number;
  /** `null` when nothing was expected (the test then uses a small floor rate). */
  ratio: number | null;
  /** One-sided Poisson, P(X >= observed | expected). */
  p_value: number;
}

export interface EarlyWarningDay {
  date: string;
  /** "gap": no VIIRS source returned a single detection for the region that day. */
  status: "ok" | "gap" | string;
  satellite: string | null;
  detections: number | null;
}

/**
 * `early_warning.json`, written by the daily FIRMS NRT refresh. Days without
 * data are gaps left out of both sides of the comparison, never zero fire.
 */
export interface EarlyWarning {
  generated_at: string;
  /** First and last day of the window, "YYYY-MM-DD", inclusive. */
  window: [string, string];
  /** The data days themselves, or only how many there were. */
  days_with_data: string[] | number;
  gap_days?: string[];
  days?: EarlyWarningDay[];
  method?: { alpha?: number; past_years?: number[]; [key: string]: unknown };
  /** `null` when there was no data day or no climatology to compare with. */
  region: EarlyWarningScore | null;
  /** Only the cells that passed the test. */
  cells: (EarlyWarningScore & { cell: string })[];
}

/** One forecast week for the whole region. */
export interface ForecastWeek {
  /** Monday of the target week, "YYYY-MM-DD". */
  week_start: string;
  horizon: number;
  expected: number;
  /** 90 % interval. */
  low: number;
  high: number;
  /** Mean of the same week of the year in earlier years. */
  climatology: number;
}

/** Column order of {@link Forecast.cells}[].values. */
export type ForecastCellRow = [
  horizon: number,
  expected: number,
  low: number,
  high: number,
  ratio_to_climatology: number | null,
];

/**
 * `forecast.json`, the 1-4 week statistical forecast. Cells whose expected
 * value is negligible at every horizon are omitted.
 */
export interface Forecast {
  generated_at?: string;
  /** Monday of the last observed week the forecast starts from. */
  issued_week: string;
  unit: Unit;
  horizons: number[];
  region: ForecastWeek[];
  cells: { cell: string; values: ForecastCellRow[] }[];
}

/**
 * The one seam between the UI and wherever the numbers come from. The static
 * implementation aggregates the demo artifacts in the browser; the AWS one will
 * send the same query to `POST /calendar`. Each unit is a separate dataset.
 * The early warning and the forecast resolve to `null` when none is published.
 */
export interface CalendarDataSource {
  loadRegion(unit: Unit): Promise<RegionData>;
  calendar(query: CalendarQuery): Promise<CalendarRecord[]>;
  earlyWarning(): Promise<EarlyWarning | null>;
  forecast(): Promise<Forecast | null>;
}
