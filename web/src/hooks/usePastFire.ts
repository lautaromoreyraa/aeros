import { useEffect, useState } from "react";
import type { PastFire } from "../util/pastFires";
import type { Loadable } from "./useOutlook";

/** One past fire, loaded from `data/case-studies/<id>.json` when it is picked. */
export function usePastFire(id: string): Loadable<PastFire> {
  const [state, setState] = useState<Loadable<PastFire>>({ status: "loading" });
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    fetch(`${import.meta.env.BASE_URL}data/case-studies/${id}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`the file answered ${response.status}`);
        return response.json() as Promise<PastFire>;
      })
      .then((data) => active && setState({ status: "ready", data }))
      .catch((error: unknown) => {
        if (active) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, [id]);
  return state;
}
