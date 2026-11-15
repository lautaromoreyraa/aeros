/**
 * Decides what the dashboard alert banner says for a visitor: an alarm when
 * their town is under a possible alert, otherwise a quiet ticker of fire
 * detected elsewhere.
 */
import { gridDisk, latLngToCell } from "h3-js";
import type { AlertDecision } from "./earlyWarning";
import { type Place, type PlaceIndex, placeName, placeNear } from "./places";

export interface PlaceBannerNear {
  kind: "near";
  place: Place;
  cell: string;
  ratio: number | null;
  multiplier: string;
  text: string;
  action: string;
}

export interface PlaceBannerElsewhereItem {
  place: Place;
  cell: string;
  ratio: number | null;
  observed: number;
  label: string;
  multiplier: string;
  text: string;
}

export interface PlaceBannerElsewhere {
  kind: "elsewhere";
  userPlace: Place | null;
  places: PlaceBannerElsewhereItem[];
}

export interface PlaceBannerNone {
  kind: "none";
}

export type PlaceBannerOutcome = PlaceBannerNear | PlaceBannerElsewhere | PlaceBannerNone;

/**
 * Multiplier formatted for the alert banner.
 * Values >= 10 are rounded to integers; values under 10 show one decimal.
 */
export function formatMultiplier(ratio: number | null): string {
  if (ratio === null) return "an unusual amount";
  if (ratio < 1) return "less than 1 times";
  if (ratio >= 10) return `${Math.round(ratio)} times`;
  return `${ratio.toFixed(1)} times`;
}

export interface DecidePlaceBannerOptions {
  decision: AlertDecision;
  userPlace: Place | null;
  placesIndex: PlaceIndex | null;
  resolution?: number;
}

/**
 * Evaluates whether an active alert should speak directly to the visitor's
 * town (near), run as a quiet ticker of fire detected elsewhere (elsewhere),
 * or stay hidden (none).
 */
export function decidePlaceBanner({
  decision,
  userPlace,
  placesIndex,
  resolution = 4,
}: DecidePlaceBannerOptions): PlaceBannerOutcome {
  if (!decision.cells || decision.cells.length === 0) {
    return { kind: "none" };
  }

  // 1. Near: visitor has set a town, and at least one flagged cell is within
  // the town's cell or its immediate ring (radius 1).
  if (userPlace) {
    const userCell = latLngToCell(userPlace.lat, userPlace.lng, resolution);
    const ring = new Set(gridDisk(userCell, 1));
    const nearCells = decision.cells.filter((c) => ring.has(c.cell));

    if (nearCells.length > 0) {
      // Pick the strongest flagged cell (highest ratio, or most observed).
      const sorted = [...nearCells].sort(
        (a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || b.observed - a.observed,
      );
      const strongest = sorted[0]!;
      const multiplier = formatMultiplier(strongest.ratio);
      return {
        kind: "near",
        place: userPlace,
        cell: strongest.cell,
        ratio: strongest.ratio,
        multiplier,
        text: `Possible fire near ${userPlace.name}: about ${multiplier} the usual this week`,
        action: "See it on the map",
      };
    }
  }

  // 2. Elsewhere: flagged cells exist, but not near the visitor's town.
  // Group by town, picking the strongest cell per town, and sort strongest first.
  const townMap = new Map<string, PlaceBannerElsewhereItem>();

  if (placesIndex) {
    for (const cell of decision.cells) {
      const nearby = placeNear(placesIndex, cell.cell);
      if (!nearby) continue;

      const key = `${nearby.place.name}:${nearby.place.region}:${nearby.place.country}`;
      const existing = townMap.get(key);
      const currentRatio = cell.ratio ?? 0;

      if (!existing || currentRatio > (existing.ratio ?? 0)) {
        const multiplier = formatMultiplier(cell.ratio);
        const label = placeName(nearby.place);
        townMap.set(key, {
          place: nearby.place,
          cell: cell.cell,
          ratio: cell.ratio,
          observed: cell.observed,
          label,
          multiplier,
          text: `${label}: about ${multiplier} the usual`,
        });
      }
    }
  }

  const items = Array.from(townMap.values()).sort(
    (a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || b.observed - a.observed,
  );

  return {
    kind: "elsewhere",
    userPlace,
    places: items,
  };
}
