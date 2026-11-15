import type { WindGrid } from "./wind";

/** The levels of `fire_weather.json`, calmest first. */
export type FireLevel = "normal" | "elevated" | "high" | "extreme";

/**
 * `fire_weather.json` as `aeros fire-weather` writes it: for each forecast day,
 * the surface Hot-Dry-Windy index of every node of the grid and its rank, 0 to
 * 100, against the same days of the past years; `null` where the forecast has
 * no value. Each day is a row-major ny × nx field, north row first.
 */
export interface FireWeatherField {
  generated_at: string;
  source: string;
  index: string;
  grid: WindGrid;
  days: string[];
  hdw: (number | null)[][];
  percentile: (number | null)[][];
  levels: { extreme: number; high: number; elevated: number };
  climatology: { years: [number, number]; half_window_days: number; samples_per_node: number };
}

/** The level a rank reaches, as `aeros.fireweather.level`; `null` without a rank. */
export function levelOf(percentile: number | null, levels: FireWeatherField["levels"]): FireLevel | null {
  if (percentile === null) return null;
  if (percentile >= levels.extreme) return "extreme";
  if (percentile >= levels.high) return "high";
  if (percentile >= levels.elevated) return "elevated";
  return "normal";
}

/** Index of the grid node nearest a point; `null` outside the grid. */
export function nearestNode({ west, south, east, north, nx, ny }: WindGrid, lng: number, lat: number): number | null {
  if (lng < west || lng > east || lat < south || lat > north) return null;
  const col = Math.round(((lng - west) / (east - west)) * (nx - 1));
  const row = Math.round(((north - lat) / (north - south)) * (ny - 1));
  return row * nx + col;
}

/**
 * The nodes that stand for a set of places, each place counting for its
 * nearest node. Summing over these instead of the whole grid keeps out the
 * edges of the box that are not the study region, such as the dry Andes.
 */
export function nodesNear(grid: WindGrid, points: [lng: number, lat: number][]): number[] {
  const nodes = new Set<number>();
  for (const [lng, lat] of points) {
    const node = nearestNode(grid, lng, lat);
    if (node !== null) nodes.add(node);
  }
  return [...nodes].sort((a, b) => a - b);
}

/** How one forecast day looks over a set of nodes. */
export interface FireWeatherDay {
  day: string;
  /** The highest rank among the nodes; `null` when none has a value. */
  top: number | null;
  level: FireLevel | null;
  /** Nodes at or above the extreme rank. */
  extreme: number;
  /** Nodes looked at. */
  nodes: number;
}

/**
 * One line per day over `nodes` (the whole grid when omitted), as
 * `aeros.fireweather.summarize`: the highest rank, its level and how many
 * nodes are extreme.
 */
export function summarizeDays(field: FireWeatherField, nodes?: number[]): FireWeatherDay[] {
  return field.days.map((day, index) => {
    const row = field.percentile[index] ?? [];
    const picked = nodes ? nodes.map((node) => row[node] ?? null) : row;
    const ranks = picked.filter((rank): rank is number => rank !== null);
    const top = ranks.length ? Math.max(...ranks) : null;
    return {
      day,
      top,
      level: levelOf(top, field.levels),
      extreme: ranks.filter((rank) => rank >= field.levels.extreme).length,
      nodes: picked.length,
    };
  });
}

/**
 * The days not yet past on `today` (YYYY-MM-DD, UTC). When the whole forecast
 * is past, every day is kept and flagged stale, so an old file still says what
 * it forecast instead of showing nothing.
 */
export function daysAhead(days: FireWeatherDay[], today: string): { days: FireWeatherDay[]; stale: boolean } {
  const ahead = days.filter((day) => day.day >= today);
  return ahead.length > 0 ? { days: ahead, stale: false } : { days, stale: true };
}
