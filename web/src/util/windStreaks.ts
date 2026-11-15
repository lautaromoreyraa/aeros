import { sampleWind, windStroke, type WindField, type WindGrid } from "./wind";

/** A lon/lat box: west, south, east, north. */
export type GeoBox = [west: number, south: number, east: number, north: number];

/** Streaks per 10 000 px² of map showing the wind field. */
export const DENSITY = 4;
/** Fewest drawn while any of the field is in view. */
export const MIN_STREAKS = 40;
export const MAX_STREAKS = 900;
/** Positions a tail remembers. */
export const TRAIL_POINTS = 24;
/** Seconds between two of them. */
export const TRAIL_STEP = 1 / 30;
/** Seconds a streak lives before it is born again elsewhere. */
export const MAX_AGE = 1.8;

export interface Streak {
  lng: number;
  lat: number;
  /** Seconds since it was born. */
  age: number;
  /** Wind speed where it is, in m/s. */
  speed: number;
  /** lng, lat pairs, oldest first. */
  trail: number[];
}

/** Degrees of longitude one pixel spans at `zoom`: deck.gl's world is 512 px at zoom 0. */
export function degreesPerPixel(zoom: number): number {
  return 360 / (512 * 2 ** zoom);
}

/**
 * How far the wind carries a streak in `seconds`, in degrees. The pace on
 * screen is the stroke's pixels per frame times 60, the same at any zoom, so
 * the layer keeps its speed whether the camera is near or far. A pixel north
 * is cos(lat) times fewer degrees: Mercator stretches the map towards the poles.
 */
export function windDrift(u: number, v: number, lat: number, zoom: number, seconds: number): [dLng: number, dLat: number] {
  const speed = Math.hypot(u, v);
  if (speed === 0) return [0, 0];
  const d = windStroke(speed).pixels * 60 * seconds * degreesPerPixel(zoom);
  return [(u / speed) * d, (v / speed) * d * Math.cos((lat * Math.PI) / 180)];
}

/** The part of the field the camera sees, `null` when they do not meet. */
export function spawnBox(grid: WindGrid, visible: GeoBox): GeoBox | null {
  const west = Math.max(grid.west, visible[0]);
  const south = Math.max(grid.south, visible[1]);
  const east = Math.min(grid.east, visible[2]);
  const north = Math.min(grid.north, visible[3]);
  return west < east && south < north ? [west, south, east, north] : null;
}

/**
 * How many streaks the visible part of the field can carry: enough that the
 * layer reads as wind and not as a few stray lines, never more than the map
 * itself could hold.
 */
export function streakCount(box: GeoBox, zoom: number, width: number, height: number): number {
  const [west, south, east, north] = box;
  const dpp = degreesPerPixel(zoom);
  const midLat = (south + north) / 2;
  const area = Math.min(((east - west) / dpp) * ((north - south) / (dpp * Math.cos((midLat * Math.PI) / 180))), width * height);
  const wanted = Math.round((area / 10000) * DENSITY);
  return Math.min(Math.max(wanted, MIN_STREAKS), MAX_STREAKS);
}

/** Starts `streak` over at a uniform spot of the box, with no tail and a random age. */
export function spawn(streak: Streak, box: GeoBox, random: () => number = Math.random): void {
  streak.lng = box[0] + random() * (box[2] - box[0]);
  streak.lat = box[1] + random() * (box[3] - box[1]);
  streak.age = random() * MAX_AGE;
  streak.speed = 0;
  streak.trail = [];
}

/**
 * Carries the streak along the wind for `seconds`. `false` when there is no
 * wind where it is or when it has lived its span: the caller births it again.
 */
export function advance(streak: Streak, field: WindField, hour: number, zoom: number, seconds: number): boolean {
  const wind = sampleWind(field, hour, streak.lng, streak.lat);
  if (!wind) return false;
  const [u, v] = wind;
  streak.speed = Math.hypot(u, v);
  const [dLng, dLat] = windDrift(u, v, streak.lat, zoom, seconds);
  streak.lng += dLng;
  streak.lat += dLat;
  streak.age += seconds;
  return streak.age <= MAX_AGE;
}

/** Appends the current position to the tail, dropping the oldest beyond the remembered points. */
export function mark(streak: Streak): void {
  streak.trail.push(streak.lng, streak.lat);
  if (streak.trail.length > TRAIL_POINTS * 2) streak.trail.splice(0, streak.trail.length - TRAIL_POINTS * 2);
}

/**
 * The streaks of a paused picture: spawned in the box, then walked a tail's
 * worth of steps so the picture shows the same bent trails the moving layer
 * would. One that dies on the way is born again and keeps going, so its tail
 * is just shorter.
 */
export function stillPicture(count: number, box: GeoBox, field: WindField, hour: number, zoom: number, random: () => number = Math.random): Streak[] {
  const streaks = Array.from({ length: count }, () => {
    const streak: Streak = { lng: 0, lat: 0, age: 0, speed: 0, trail: [] };
    spawn(streak, box, random);
    return streak;
  });
  const inside = (streak: Streak) => streak.lng >= box[0] && streak.lng <= box[2] && streak.lat >= box[1] && streak.lat <= box[3];
  for (let index = 0; index < TRAIL_POINTS; index++)
    for (const streak of streaks) {
      if (!inside(streak)) spawn(streak, box, random);
      else {
        mark(streak);
        if (!advance(streak, field, hour, zoom, TRAIL_STEP) || !inside(streak)) spawn(streak, box, random);
      }
    }
  return streaks;
}

/** deck.gl world units: the map is a 512 px square at zoom 0, Mercator north stretched. */
export function toWorld(lng: number, lat: number): [x: number, y: number] {
  const x = ((lng + 180) / 360) * 512;
  const y = ((180 + (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360) * 512;
  return [x, y];
}

/**
 * The same answer as `viewport.project([lng, lat])` for
 * `viewport.pixelProjectionMatrix`, read straight off the matrix so a whole
 * field of tails can be projected without an allocation per point.
 */
export function toScreen(matrix: ArrayLike<number>, lng: number, lat: number): [x: number, y: number] {
  const [X, Y] = toWorld(lng, lat);
  const w = matrix[3]! * X + matrix[7]! * Y + matrix[15]!;
  const x = (matrix[0]! * X + matrix[4]! * Y + matrix[12]!) / w;
  const y = (matrix[1]! * X + matrix[5]! * Y + matrix[13]!) / w;
  return [x, y];
}
