/**
 * Contract with the aeros model. These shapes mirror the JSON artifacts written
 * by `python -m aeros demo` and the body the AWS `POST /calendar` endpoint will
 * return, so the UI never needs to know which of the two it is talking to.
 */

/** Which satellites the harmonized value of a month comes from. */
export type HarmonizedSource = "modeled_terra" | "modeled_terra_aqua" | "observed";

/** One month of the burning calendar for an area. */
export interface CalendarRecord {
  year: number;
  month_of_year: number;
  /** VIIRS-equivalent hotspot count. */
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
  /** H3 cells of the selected area; `null` means the whole region. */
  cells: string[] | null;
  start: MonthKey;
  end: MonthKey;
}

/** Everything the app needs to draw the region before any area is chosen. */
export interface RegionData {
  cells: CellsMonthly;
  region: CalendarRecord[];
  validation: Validation | null;
  morning: MorningRecord[];
}

/**
 * The one seam between the UI and wherever the numbers come from. The static
 * implementation aggregates the demo artifacts in the browser; the AWS one will
 * send the same query to `POST /calendar`.
 */
export interface CalendarDataSource {
  loadRegion(): Promise<RegionData>;
  calendar(query: CalendarQuery): Promise<CalendarRecord[]>;
}
