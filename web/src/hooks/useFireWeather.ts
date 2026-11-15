import { useEffect, useState } from "react";
import type { FireWeatherField } from "../util/fireWeather";
import type { Loadable } from "./useOutlook";

/**
 * The fire weather of the next days, as `aeros fire-weather` publishes it in
 * `data/fire_weather.json`. Unlike the wind there is no fallback: ranking a
 * day needs ten years of reanalysis, so without the file the data is `null`
 * and the views leave the fire weather out.
 */
export function useFireWeather(): Loadable<FireWeatherField | null> {
  const [state, setState] = useState<Loadable<FireWeatherField | null>>({ status: "loading" });
  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}data/fire_weather.json`)
      .then((response) => {
        // A missing file comes back as the app's index.html on static hosts.
        const json = response.ok && response.headers.get("content-type")?.includes("json");
        return json ? (response.json() as Promise<FireWeatherField>) : null;
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
