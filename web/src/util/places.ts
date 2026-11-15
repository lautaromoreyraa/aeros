import { cellToLatLng, latLngToCell } from "h3-js";

/**
 * The gazetteer of `data/places.json` (built by scripts/places.mjs from
 * GeoNames) and the way a cell gets a name a visitor knows: the biggest town
 * inside it, or the distance and direction from the nearest known town, in
 * the words the alert text uses.
 */

export interface Place {
  name: string;
  /** Province, department or state. */
  region: string;
  /** ISO two-letter code. */
  country: string;
  lat: number;
  lng: number;
  population: number;
}

export interface PlacesFile {
  generated_at: string;
  source: string;
  license: string;
  columns: string[];
  places: [name: string, region: string, country: string, lat: number, lng: number, population: number][];
}

export interface Nearby {
  place: Place;
  /** From the town to the cell's centre; 0 when the town is inside the cell. */
  km: number;
  /** Compass point from the town towards the cell; null inside the cell. */
  direction: string | null;
}

export interface PlaceIndex {
  places: Place[];
  resolution: number;
  /** The biggest town inside each cell that holds one. */
  inCell: Map<string, Place>;
  /** Answers already worked out. */
  near: Map<string, Nearby | null>;
}

/** Short country names the interface shows, keyed by ISO code. */
export const COUNTRY_NAMES: Record<string, string> = {
  AR: "Argentina",
  BO: "Bolivia",
  BR: "Brazil",
  CL: "Chile",
  PE: "Peru",
  PY: "Paraguay",
  UY: "Uruguay",
};

/** Expands the compact rows of the file into places and indexes them by cell. */
export function indexPlaces(file: PlacesFile, resolution: number): PlaceIndex {
  const places = file.places.map(([name, region, country, lat, lng, population]) => ({ name, region, country, lat, lng, population }));
  const inCell = new Map<string, Place>();
  for (const place of places) {
    const cell = latLngToCell(place.lat, place.lng, resolution);
    const held = inCell.get(cell);
    if (!held || place.population > held.population) inCell.set(cell, place);
  }
  return { places, resolution, inCell, near: new Map() };
}

/** Haversine distance in km (Earth radius 6371 km). */
export function distanceKm(from: [lng: number, lat: number], to: [lng: number, lat: number]): number {
  const radians = Math.PI / 180;
  const [lng1, lat1] = [from[0] * radians, from[1] * radians];
  const [lng2, lat2] = [to[0] * radians, to[1] * radians];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Initial great-circle bearing, degrees clockwise from north, 0-360. */
export function bearing(from: [lng: number, lat: number], to: [lng: number, lat: number]): number {
  const radians = Math.PI / 180;
  const [lng1, lat1] = [from[0] * radians, from[1] * radians];
  const [lng2, lat2] = [to[0] * radians, to[1] * radians];
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  return (Math.atan2(y, x) / radians + 360) % 360;
}

const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** The eight compass points, as the alert text names them. */
export function compass(degrees: number): string {
  return POINTS[Math.round(degrees / 45) % 8]!;
}

/**
 * What a cell is called for a reader. A town inside the cell names it (the
 * biggest one); otherwise the nearest town to the cell's centre sets a
 * distance d, and among the towns within max(d * 1.5, d + 15) km of the
 * centre the biggest names the cell — a known town a little farther beats a
 * hamlet — with its own km and the direction from that town towards the
 * centre. `null` when the gazetteer is empty. Memoized in index.near.
 */
export function placeNear(index: PlaceIndex, cell: string): Nearby | null {
  const held = index.near.get(cell);
  if (held !== undefined) return held;
  let answer: Nearby | null = null;
  const inside = index.inCell.get(cell);
  if (inside) {
    answer = { place: inside, km: 0, direction: null };
  } else if (index.places.length > 0) {
    const [lat, lng] = cellToLatLng(cell);
    const centre: [number, number] = [lng, lat];
    let nearest = Infinity;
    for (const place of index.places) {
      const km = distanceKm([place.lng, place.lat], centre);
      if (km < nearest) nearest = km;
    }
    const within = Math.max(nearest * 1.5, nearest + 15);
    let best: { place: Place; km: number } | null = null;
    for (const place of index.places) {
      const km = distanceKm([place.lng, place.lat], centre);
      if (km <= within && (!best || place.population > best.place.population)) best = { place, km };
    }
    if (best) {
      answer = {
        place: best.place,
        km: best.km,
        direction: compass(bearing([best.place.lng, best.place.lat], centre)),
      };
    }
  }
  index.near.set(cell, answer);
  return answer;
}

/** "General José de San Martín, Chaco"; only the name when the region is empty. */
export function placeName(place: Place): string {
  return place.region ? `${place.name}, ${place.region}` : place.name;
}

/**
 * The panel title for a tapped cell: the town's own name when it is inside
 * the cell, or the cell placed by distance and direction from it — the alert
 * text's wording, rounded to 5 km below 100 km and to 10 km from there on.
 */
export function placeLabel(nearby: Nearby): string {
  if (nearby.direction === null) return placeName(nearby.place);
  if (nearby.km < 5) return `Very near ${placeName(nearby.place)}`;
  const km = nearby.km < 100 ? Math.round(nearby.km / 5) * 5 : Math.round(nearby.km / 10) * 10;
  return `About ${km} km ${nearby.direction} of ${placeName(nearby.place)}`;
}
