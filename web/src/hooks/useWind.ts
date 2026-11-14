import { useEffect, useState } from "react";
import { STUDY_BOX, fromOpenMeteo, gridNodes, type WindField } from "../util/wind";
import type { Loadable } from "./useOutlook";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

/** The next 48 h of 10 m wind on the study grid, straight from Open-Meteo. */
async function fetchOpenMeteo(): Promise<WindField> {
  const nodes = gridNodes(STUDY_BOX);
  const params = new URLSearchParams({
    latitude: nodes.map(([, lat]) => lat.toFixed(2)).join(","),
    longitude: nodes.map(([lng]) => lng.toFixed(2)).join(","),
    hourly: "wind_speed_10m,wind_direction_10m",
    wind_speed_unit: "ms",
    timezone: "GMT",
    forecast_days: "2",
  });
  const response = await fetch(`${OPEN_METEO}?${params}`);
  if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}`);
  const body = (await response.json()) as Parameters<typeof fromOpenMeteo>[0] | Parameters<typeof fromOpenMeteo>[0][number];
  return fromOpenMeteo(Array.isArray(body) ? body : [body], STUDY_BOX, new Date().toISOString());
}

/**
 * The wind field for the map, loaded once when the terrain opens. The pipeline's `wind.json` wins when it is published; until then the
 * forecast comes from Open-Meteo for the same grid.
 */
export function useWind(): Loadable<WindField> | null {
  const [state, setState] = useState<Loadable<WindField> | null>(null);
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    fetch(`${import.meta.env.BASE_URL}data/wind.json`)
      .then((response) => {
        const json = response.ok && response.headers.get("content-type")?.includes("json");
        return json ? (response.json() as Promise<WindField>) : fetchOpenMeteo();
      })
      .then((data) => active && setState({ status: "ready", data }))
      .catch((error: unknown) => {
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, []);
  return state;
}
