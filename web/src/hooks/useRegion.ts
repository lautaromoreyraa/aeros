import { useCallback, useEffect, useMemo, useState } from "react";
import { calendarSource } from "../api/client";
import type { RegionData } from "../api/types";
import { cellCenters, type CellCenter } from "../util/geo";
import { parseMonth } from "../util/months";

export interface LoadedRegion extends RegionData {
  centers: CellCenter[];
  firstMonth: number;
  lastMonth: number;
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: LoadedRegion };

export function useRegion() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    calendarSource
      .loadRegion()
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
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return useMemo(() => ({ state, retry }), [state, retry]);
}
