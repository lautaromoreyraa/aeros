import { useEffect, useState } from "react";
import { calendarSource } from "../api/client";
import type { CalendarQuery, CalendarRecord } from "../api/types";

type State =
  | { status: "loading"; records: CalendarRecord[] }
  | { status: "ready"; records: CalendarRecord[] }
  | { status: "error"; records: CalendarRecord[]; message: string };

/**
 * Calendar of the selected area. Keeps the previous records while a new query
 * runs, so the heat map does not flash empty on every change of area or range.
 */
export function useCalendar(query: CalendarQuery | null): State {
  const [state, setState] = useState<State>({ status: "loading", records: [] });
  const cellsKey = query?.cells === null ? "region" : (query?.cells ?? []).join(",");

  useEffect(() => {
    if (!query) return;
    let active = true;
    setState((previous) => ({ status: "loading", records: previous.records }));
    calendarSource
      .calendar(query)
      .then((records) => active && setState({ status: "ready", records }))
      .catch(
        (error: unknown) =>
          active &&
          setState((previous) => ({
            status: "error",
            records: previous.records,
            message: error instanceof Error ? error.message : String(error),
          })),
      );
    return () => {
      active = false;
    };
    // The cell list is compared by content, not identity, so a new array with
    // the same cells does not trigger a new request.
  }, [query?.unit, cellsKey, query?.start, query?.end, query !== null]);

  return state;
}
