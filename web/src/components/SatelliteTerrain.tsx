import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import type { MapViewState, PickingInfo } from "@deck.gl/core";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { Unit } from "../api/types";
import type { CellTotal } from "../util/aggregation";
import type { LngLat } from "../util/area";
import { FIRE, sampleRamp, sqrtScale } from "../util/colorRamp";
import { formatCount, unitLabel } from "../util/format";
import { ON_TOP, SATELLITE, SATELLITE_ATTRIBUTION, initialView, rasterLayer } from "./mapLayers";

interface Props {
  totals: CellTotal[];
  unit: Unit;
  centers: LngLat[];
  /** Cells the early warning flagged this week, outlined over the columns. */
  flagged: ReadonlySet<string>;
  /** Columns grow from the ground the first time this turns true. */
  risen: boolean;
  reducedMotion: boolean;
}

/**
 * The record's fire columns standing on satellite imagery: the same H3 cells
 * and harmonized totals as the terrain view, on the ground they burned.
 */
export default function SatelliteTerrain({ totals, unit, centers, flagged, risen, reducedMotion }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [viewState, setViewState] = useState<MapViewState>(() => initialView(centers, 0, 0));

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
      setViewState({ ...initialView(centers, entry.contentRect.width, entry.contentRect.height), pitch: 52, bearing: -18 });
      observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
    // Runs once: from then on the visitor owns the camera.
  }, []);

  const max = useMemo(() => totals.reduce((value, cell) => Math.max(value, cell.harmonized), 0), [totals]);
  const flaggedTotals = useMemo(() => totals.filter((cell) => flagged.has(cell.cell)), [totals, flagged]);
  const grown = risen || reducedMotion;

  const layers = useMemo(
    () => [
      rasterLayer("satellite", SATELLITE),
      new H3HexagonLayer<CellTotal>({
        id: "columns",
        data: totals,
        getHexagon: (cell) => cell.cell,
        extruded: true,
        getElevation: (cell) => (grown ? sqrtScale(cell.harmonized, max) * 70000 : 0),
        getFillColor: (cell) => [...sampleRamp(FIRE, 0.25 + 0.75 * sqrtScale(cell.harmonized, max)), 225],
        material: { ambient: 0.55, diffuse: 0.55, shininess: 20 },
        coverage: 0.86,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 80],
        transitions: reducedMotion ? undefined : { getElevation: { duration: 1800, easing: (t: number) => 1 - (1 - t) ** 3 } },
        updateTriggers: { getElevation: [grown, max], getFillColor: [max] },
      }),
      new H3HexagonLayer<CellTotal>({
        id: "flagged",
        parameters: ON_TOP,
        data: flaggedTotals,
        getHexagon: (cell) => cell.cell,
        filled: false,
        stroked: true,
        extruded: false,
        getLineColor: [255, 255, 255, 255],
        lineWidthUnits: "pixels",
        getLineWidth: 2.5,
      }),
    ],
    [totals, flaggedTotals, grown, max, reducedMotion],
  );

  const tooltip = ({ object }: PickingInfo<CellTotal>) =>
    object && {
      html: `<strong>${formatCount(object.harmonized)}</strong> harmonized ${unitLabel(unit)} over the record${flagged.has(object.cell) ? "<br/>Burning well above normal this week" : ""}`,
      className: "map-tooltip",
    };

  return (
    <div ref={container} className="map">
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: next }) => setViewState(next as MapViewState)}
        // The page scrolls past the map, so the wheel must not zoom it.
        controller={{ scrollZoom: false }}
        layers={layers}
        getTooltip={tooltip as never}
      />
      <p className="map__attribution">{SATELLITE_ATTRIBUTION}</p>
    </div>
  );
}
