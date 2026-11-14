import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import type { MapViewState, PickingInfo } from "@deck.gl/core";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { Unit } from "../api/types";
import type { CellTotal } from "../util/aggregation";
import type { Area, LngLat } from "../util/area";
import { VIRIDIS, sampleRamp, sqrtScale } from "../util/colorRamp";
import { formatCount, unitLabel } from "../util/format";
import { BASEMAP, areaLayers, initialView, rasterLayer } from "./mapLayers";

interface Props {
  totals: CellTotal[];
  selected: ReadonlySet<string> | null;
  centers: LngLat[];
  showRaw: boolean;
  unit: Unit;
  area: Area;
  drawing: boolean;
  draft: LngLat[];
  onAddVertex: (point: LngLat) => void;
  theme: "light" | "dark";
  reducedMotion: boolean;
}

export default function HexMap(props: Props) {
  const { totals, selected, centers, showRaw, unit, area, drawing, draft, onAddVertex, theme, reducedMotion } = props;
  const container = useRef<HTMLDivElement>(null);
  const fit = () => initialView(centers, container.current?.clientWidth ?? 0, container.current?.clientHeight ?? 0);
  const [viewState, setViewState] = useState<MapViewState>(() => initialView(centers, 0, 0));

  // Frame the region for the map's real size, which differs a lot between a
  // desktop column and a phone. The container can still be unsized when the
  // map mounts (right after the intro), so the first real size wins; from
  // then on the visitor owns the camera.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
      setViewState(fit());
      observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
    // Runs once: re-framing on every resize would fight the visitor's camera.
  }, []);

  // Corners are placed on the ground, so drawing happens from straight above
  // where no column hides the spot being clicked.
  useEffect(() => {
    if (drawing) setViewState((state) => ({ ...state, pitch: 0, bearing: 0 }));
  }, [drawing]);

  // Same scale for raw and harmonized so the toggle shows the real difference.
  const max = useMemo(() => totals.reduce((value, cell) => Math.max(value, cell.harmonized, cell.stacked), 0), [totals]);

  const layers = useMemo(() => {
    const value = (cell: CellTotal) => (showRaw ? cell.stacked : cell.harmonized);
    return [
      rasterLayer(`basemap-${theme}`, BASEMAP[theme].base),
      // Place names sit under the columns: context, never covering the data.
      rasterLayer(`labels-${theme}`, BASEMAP[theme].labels),
      new H3HexagonLayer<CellTotal>({
        id: "cells",
        data: totals,
        getHexagon: (cell) => cell.cell,
        extruded: true,
        elevationScale: 1,
        getElevation: (cell) => sqrtScale(value(cell), max) * 60000,
        getFillColor: (cell) => {
          const [r, g, b] = sampleRamp(VIRIDIS, sqrtScale(value(cell), max));
          const dimmed = selected !== null && !selected.has(cell.cell);
          return [r, g, b, dimmed ? 50 : 235];
        },
        material: { ambient: 0.5, diffuse: 0.6, shininess: 24 },
        pickable: !drawing,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 90],
        coverage: 0.92,
        transitions: reducedMotion ? undefined : { getElevation: 600, getFillColor: 300 },
        updateTriggers: { getElevation: [showRaw, max], getFillColor: [showRaw, max, selected] },
      }),
      ...areaLayers(area, draft, theme),
    ];
  }, [totals, selected, showRaw, area, draft, drawing, theme, max, reducedMotion]);

  const tooltip = ({ object }: PickingInfo<CellTotal>) =>
    object && {
      html: `<strong>${formatCount(object.harmonized)}</strong> harmonized ${unitLabel(unit)}<br/>${formatCount(object.stacked)} raw stacked`,
      className: "map-tooltip",
    };

  return (
    <div ref={container} className={drawing ? "map map--drawing" : "map"}>
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: next }) => setViewState(next as MapViewState)}
        controller={{ doubleClickZoom: !drawing, dragRotate: !drawing }}
        layers={layers}
        getTooltip={tooltip as never}
        getCursor={({ isDragging }) => (drawing ? "crosshair" : isDragging ? "grabbing" : "grab")}
        onClick={(info) => {
          if (drawing && info.coordinate) onAddVertex([info.coordinate[0]!, info.coordinate[1]!]);
        }}
      />
      <div className="map__controls">
        <button
          type="button"
          className="map__button"
          onClick={() => setViewState(fit())}
        >
          Reset view
        </button>
        <button
          type="button"
          className="map__button"
          aria-pressed={viewState.pitch === 0}
          onClick={() => setViewState((state) => ({ ...state, pitch: state.pitch ? 0 : 45, bearing: state.pitch ? 0 : -12 }))}
        >
          {viewState.pitch ? "Flat" : "3D"}
        </button>
      </div>
      <p className="map__attribution">Basemap: Esri, HERE, Garmin, © OpenStreetMap contributors</p>
    </div>
  );
}
