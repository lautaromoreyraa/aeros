/** A regular lon/lat grid; rows run north to south, columns west to east. */
export interface WindGrid {
  west: number;
  south: number;
  east: number;
  north: number;
  nx: number;
  ny: number;
}

/**
 * `wind.json` as the backend will publish it, and what the Open-Meteo fallback
 * is converted to: hourly u (eastward) and v (northward) wind at 10 m, in m/s,
 * each hour a row-major ny × nx field.
 */
export interface WindField {
  generated_at: string;
  source: string;
  grid: WindGrid;
  hours: string[];
  u: number[][];
  v: number[][];
}

/** The study box of the FIRMS downloads, west, south, east, north. */
export const STUDY_BOX: WindGrid = { west: -69, south: -35, east: -53, north: -16, nx: 12, ny: 12 };

/** Centre of every grid node, in row-major order (north row first). */
export function gridNodes({ west, south, east, north, nx, ny }: WindGrid): [lng: number, lat: number][] {
  const nodes: [number, number][] = [];
  for (let row = 0; row < ny; row++)
    for (let col = 0; col < nx; col++)
      nodes.push([west + ((east - west) * col) / (nx - 1), north - ((north - south) * row) / (ny - 1)]);
  return nodes;
}

/**
 * u and v from a speed and the meteorological direction, the bearing the
 * wind blows FROM: a north wind (0°) blows towards the south, so v < 0.
 */
export function toComponents(speed: number, fromDegrees: number): [u: number, v: number] {
  const radians = (fromDegrees * Math.PI) / 180;
  return [-speed * Math.sin(radians), -speed * Math.cos(radians)];
}

interface OpenMeteoPoint {
  hourly: { time: string[]; wind_speed_10m: (number | null)[]; wind_direction_10m: (number | null)[] };
}

/** Builds a field from an Open-Meteo multi-location response for {@link gridNodes}, in the same order. */
export function fromOpenMeteo(points: OpenMeteoPoint[], grid: WindGrid, generatedAt: string): WindField {
  const hours = points[0]?.hourly.time.map((time) => `${time}:00Z`) ?? [];
  const u = hours.map(() => new Array<number>(points.length).fill(0));
  const v = hours.map(() => new Array<number>(points.length).fill(0));
  points.forEach((point, node) => {
    hours.forEach((_, hour) => {
      const [east, north] = toComponents(point.hourly.wind_speed_10m[hour] ?? 0, point.hourly.wind_direction_10m[hour] ?? 0);
      u[hour]![node] = east;
      v[hour]![node] = north;
    });
  });
  return { generated_at: generatedAt, source: "Open-Meteo forecast, 10 m wind", grid, hours, u, v };
}

/** Wind at a point, bilinear between the four surrounding nodes; `null` outside the grid. */
export function sampleWind(field: WindField, hour: number, lng: number, lat: number): [u: number, v: number] | null {
  const { west, south, east, north, nx, ny } = field.grid;
  if (lng < west || lng > east || lat < south || lat > north) return null;
  const x = ((lng - west) / (east - west)) * (nx - 1);
  const y = ((north - lat) / (north - south)) * (ny - 1);
  const x0 = Math.min(Math.floor(x), nx - 2);
  const y0 = Math.min(Math.floor(y), ny - 2);
  const fx = x - x0;
  const fy = y - y0;
  const at = (values: number[], col: number, row: number) => values[row * nx + col] ?? 0;
  const mix = (values: number[]) =>
    (at(values, x0, y0) * (1 - fx) + at(values, x0 + 1, y0) * fx) * (1 - fy) +
    (at(values, x0, y0 + 1) * (1 - fx) + at(values, x0 + 1, y0 + 1) * fx) * fy;
  const u = field.u[hour];
  const v = field.v[hour];
  return u && v ? [mix(u), mix(v)] : null;
}

/** The hour of the field closest to `now`. */
export function hourIndexAt(field: WindField, now: number): number {
  let best = 0;
  field.hours.forEach((hour, index) => {
    if (Math.abs(Date.parse(hour) - now) < Math.abs(Date.parse(field.hours[best] ?? "") - now)) best = index;
  });
  return best;
}

/** From this speed on, in m/s, a streak is as bright and as fast as it gets. */
export const STRONG_WIND = 12;

/**
 * How a streak shows its wind speed, twice over: light wind draws a faint,
 * slow line; strong wind a bright, fast one. No colour is needed on top.
 */
export function windStroke(speed: number): { alpha: number; width: number; pixels: number } {
  const t = Math.min(Math.max(speed, 0) / STRONG_WIND, 1);
  return {
    alpha: 0.15 + 0.75 * t ** 0.7,
    width: 1 + 0.6 * t,
    // Pixels per frame: proportional to the speed and stretched at the top,
    // so a gale visibly outruns a breeze.
    pixels: Math.max(speed, 0) * 0.22 * (0.6 + 0.8 * t),
  };
}
