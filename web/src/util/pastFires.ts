/** One satellite pass (or one local day) of a past fire: the H3 cells it saw burning. */
export interface PastFireStep {
  /** ISO time of the pass, or the start of the local day. */
  time: string;
  label: string;
  /** [H3 cell, detections, summed fire radiative power in MW] */
  cells: [cell: string, detections: number, frp: number][];
}

export interface PastFireEvent {
  time: string;
  text: string;
  source: string;
}

/** A past fire as `model/scripts/build_case_studies.py` writes it. */
export interface PastFire {
  id: string;
  name: string;
  detail: string;
  time_zone: string;
  granularity: "pass" | "day";
  resolution: number;
  source: string;
  outline?: [lng: number, lat: number][];
  steps: PastFireStep[];
  events: PastFireEvent[];
}

/** The fires the map can replay, in the order the pitch tells them. */
export const PAST_FIRES = [
  { id: "los-angeles-2025", label: "Los Angeles, 2025" },
  { id: "corrientes-2022", label: "Corrientes, 2022" },
] as const;

export interface BurntCell {
  cell: string;
  detections: number;
  frp: number;
  /** Index of the last step that saw the cell burning. */
  last: number;
}

/** Every cell the first `shown` steps saw, with its totals and the last step that saw it. */
export function burntUpTo(steps: PastFireStep[], shown: number): BurntCell[] {
  const cells = new Map<string, BurntCell>();
  steps.slice(0, Math.max(shown, 0)).forEach((step, index) => {
    for (const [cell, detections, frp] of step.cells) {
      const seen = cells.get(cell);
      if (seen) {
        seen.detections += detections;
        seen.frp += frp;
        seen.last = index;
      } else cells.set(cell, { cell, detections, frp, last: index });
    }
  });
  return [...cells.values()];
}

/**
 * The cells of the step with the most detections: the fire at its height,
 * which frames it better than every stray hot pixel the record holds.
 */
export function busiestCells(steps: PastFireStep[]): string[] {
  const total = (step: PastFireStep) => step.cells.reduce((sum, [, detections]) => sum + detections, 0);
  const busiest = steps.reduce<PastFireStep | null>((best, step) => (!best || total(step) > total(best) ? step : best), null);
  return busiest ? busiest.cells.map(([cell]) => cell) : [];
}

/** How many steps had happened by `time`: what the map shows at that moment. */
export function shownAt(steps: PastFireStep[], time: string): number {
  const at = Date.parse(time);
  return steps.filter((step) => Date.parse(step.time) <= at).length;
}

/**
 * Fire seen in the current step glows white-hot; what earlier steps saw cools
 * down to embers, so the front stands out from the ground already burnt.
 */
export function emberColor(age: number): [number, number, number, number] {
  if (age <= 0) return [255, 241, 168, 240];
  if (age <= 2) return [251, 182, 26, 220];
  if (age <= 6) return [237, 105, 37, 200];
  return [158, 40, 38, 175];
}
