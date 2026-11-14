import { useCallback, useEffect, useMemo, useState } from "react";
import { calendarSource } from "../api/client";
import type { RegionData, Unit } from "../api/types";
import { cellCenters, type CellCenter } from "../util/geo";
import { parseMonth } from "../util/months";

export interface LoadedRegion extends RegionData {
  centers: CellCenter[];
  firstMonth: number;
  lastMonth: number;
}

type State =
  | { status: "loading"; data: LoadedRegion | null }
  | { status: "error"; message: string; data: LoadedRegion | null }
  | { status: "ready"; data: LoadedRegion };

/**
 * The region dataset of a unit. Switching units keeps the previous dataset on
 * screen until the new one arrives, so the explorer (and the area drawn in it)
 * is not torn down by the toggle.
 */
export function useRegion(unit: Unit) {
  const [state, setState] = useState<State>({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState((previous) => ({ status: "loading", data: previous.data }));
    calendarSource
      .loadRegion(unit)
      .then((region) => {
        if (!active) return;
        const months = region.cells.months;
        setState({
          status: "ready",
          data: {
            ...region,
            centers: cellCenters(region.cells.cells.map((cell) => cell.cell)),
            firstMonth: parseMonth(months[0] ?? "") ?? 0,
            lastMonth: parseMonth(months[months.length - 1] ?? "") ?? 0,
          },
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({ status: "error", message, data: previous.data }));
      });
    return () => {
      active = false;
    };
  }, [unit, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return useMemo(() => ({ state, retry }), [state, retry]);
}
