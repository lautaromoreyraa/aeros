import { useCallback, useEffect, useMemo, useState } from "react";
import type { AreaMode } from "../components/AreaControls";
import type { Area, BoundingBox, LngLat } from "../util/area";

/**
 * The area the visitor chose. It lives above the views so the calendar, the
 * early warning and the forecast all talk about the same place.
 */
export function useAreaSelection() {
  const [mode, setMode] = useState<AreaMode>("region");
  const [area, setArea] = useState<Area>({ kind: "region" });
  const [draft, setDraft] = useState<LngLat[]>([]);

  const changeMode = useCallback((next: AreaMode) => {
    setMode(next);
    setDraft([]);
    if (next === "region") setArea({ kind: "region" });
  }, []);
  const finishDrawing = useCallback(() => {
    setArea({ kind: "polygon", ring: draft });
    setDraft([]);
  }, [draft]);
  const cancelDrawing = useCallback(() => setDraft([]), []);
  const applyBox = useCallback((box: BoundingBox) => setArea({ kind: "box", box }), []);
  const addVertex = useCallback((point: LngLat) => setDraft((previous) => [...previous, point]), []);

  useEffect(() => {
    if (mode !== "draw") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraft([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  return useMemo(
    () => ({ mode, area, draft, changeMode, finishDrawing, cancelDrawing, applyBox, addVertex }),
    [mode, area, draft, changeMode, finishDrawing, cancelDrawing, applyBox, addVertex],
  );
}

export type AreaSelection = ReturnType<typeof useAreaSelection>;
