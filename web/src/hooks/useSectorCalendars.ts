import { useEffect, useState } from "react";
import { calendarSource } from "../api/client";
import type { CalendarRecord, Unit } from "../api/types";
import { WHOLE_REGION, type Sector } from "../util/sectors";

type State =
  | { status: "loading"; byId: Record<string, CalendarRecord[]> }
  | { status: "ready"; byId: Record<string, CalendarRecord[]> }
  | { status: "error"; byId: Record<string, CalendarRecord[]>; message: string };

/**
 * The calendar of the whole region and of every sector, keyed by sector id
 * (the whole region under `WHOLE_REGION`). All of them are needed at once: the
 * sector list shows the chosen month for each one. The previous calendars stay
 * while new ones load, so the panel does not blink when the unit changes.
 */
export function useSectorCalendars(unit: Unit, sectors: Sector[], start: number, end: number): State {
  const [state, setState] = useState<State>({ status: "loading", byId: {} });
  // Sectors are compared by content, not identity, like the cells of an area query.
  const sectorsKey = sectors.map((sector) => `${sector.id}:${sector.cells.length}`).join("|");

  useEffect(() => {
    let active = true;
    setState((previous) => ({ status: "loading", byId: previous.byId }));
    const requests = [{ id: WHOLE_REGION, cells: null }, ...sectors.map(({ id, cells }) => ({ id, cells }))];
    Promise.all(
      requests.map(({ id, cells }) =>
        calendarSource.calendar({ unit, cells, start, end }).then((records) => [id, records] as const),
      ),
    )
      .then((entries) => active && setState({ status: "ready", byId: Object.fromEntries(entries) }))
      .catch(
        (error: unknown) =>
          active &&
          setState((previous) => ({
            status: "error",
            byId: previous.byId,
            message: error instanceof Error ? error.message : String(error),
          })),
      );
    return () => {
      active = false;
    };
    // `sectors` is represented by its key above.
  }, [unit, sectorsKey, start, end]);

  return state;
}
