import { useCallback, useEffect, useState } from "react";
import { calendarSource } from "../api/client";
import type { EarlyWarning, Forecast } from "../api/types";

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

function useLoad<T>(load: () => Promise<T>): { state: Loadable<T>; retry: () => void } {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    load()
      .then((data) => active && setState({ status: "ready", data }))
      .catch((error: unknown) => {
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, [load, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}

const loadWarning = () => calendarSource.earlyWarning();
const loadForecast = () => calendarSource.forecast();

/** The latest early warning; loaded once for the banner and the view. */
export function useEarlyWarning() {
  return useLoad<EarlyWarning | null>(loadWarning);
}

/** The latest weekly forecast. */
export function useForecast() {
  return useLoad<Forecast | null>(loadForecast);
}
