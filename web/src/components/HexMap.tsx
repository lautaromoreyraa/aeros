import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import { BitmapLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { H3HexagonLayer, TileLayer } from "@deck.gl/geo-layers";
import type { CellTotal } from "../util/aggregation";
import { boundsOf, boxToRing, type Area, type LngLat } from "../util/area";
import { VIRIDIS, sampleRamp, sqrtScale } from "../util/colorRamp";
import { formatCount } from "../util/format";

interface Props {
  totals: CellTotal[];
  selected: ReadonlySet<string> | null;
  centers: LngLat[];
  showRaw: boolean;
  area: Area;
  drawing: boolean;
  draft: LngLat[];
  onAddVertex: (point: LngLat) => void;
  theme: "light" | "dark";
  reducedMotion: boolean;
}

/**
 * Esri's grey canvas basemaps need no API key and stay quiet under the data;
 * their attribution is shown in the corner as the terms ask.
 */
const ESRI = "https://services.arcgisonline.com/arcgis/rest/services/Canvas";
const BASEMAP = {
  light: {
    base: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
  dark: {
    base: `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
};

function rasterLayer(id: string, url: string) {
  return new TileLayer<ImageBitmap>({
    id,
    data: url,
    minZoom: 0,
    maxZoom: 16,
    tileSize: 256,
    renderSubLayers: (sub) => {
      const [min, max] = sub.tile.boundingBox;
      return new BitmapLayer({
        ...sub,
        data: undefined,
        image: sub.data,
        bounds: [min[0] ?? 0, min[1] ?? 0, max[0] ?? 0, max[1] ?? 0],
      });
    },
  });
}

/** The outline and the corners being drawn stay visible over the 3D columns. */
const ON_TOP = { depthCompare: "always" } as const;

function initialView(centers: LngLat[], width: number, height: number): MapViewState {
  const bounds = boundsOf(centers.length ? centers : [[-61, -24]]);
  const viewport = new WebMercatorViewport({ width: Math.max(width, 320), height: Math.max(height, 240) });
  const { longitude, latitude, zoom } = viewport.fitBounds(
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    { padding: Math.min(60, Math.max(width, 320) / 8) },
  );
  return { longitude, latitude, zoom: Math.min(zoom, 9), pitch: 45, bearing: -12 };
}

export default function HexMap(props: Props) {
  const { totals, selected, centers, showRaw, area, drawing, draft, onAddVertex, theme, reducedMotion } = props;
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
    const areaRing = area.kind === "polygon" ? area.ring : area.kind === "box" ? boxToRing(area.box) : null;
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
      areaRing &&
        new PolygonLayer<LngLat[]>({
          id: "area",
          parameters: ON_TOP,
          data: [areaRing],
          getPolygon: (ring) => ring,
          filled: true,
          stroked: true,
          getFillColor: theme === "dark" ? [255, 255, 255, 18] : [0, 0, 0, 14],
          getLineColor: [249, 160, 63, 255],
          lineWidthMinPixels: 2,
        }),
      draft.length > 0 &&
        new PathLayer<LngLat[]>({
          id: "draft-path",
          parameters: ON_TOP,
          data: [draft],
          getPath: (path) => path,
          getColor: [249, 160, 63, 255],
          widthMinPixels: 2,
        }),
      draft.length > 0 &&
        new ScatterplotLayer<LngLat>({
          id: "draft-points",
          parameters: ON_TOP,
          data: draft,
          getPosition: (point) => point,
          getFillColor: [249, 160, 63, 255],
          getLineColor: [20, 16, 10, 255],
          stroked: true,
          radiusMinPixels: 5,
          lineWidthMinPixels: 1,
        }),
    ];
  }, [totals, selected, showRaw, area, draft, drawing, theme, max, reducedMotion]);

  const tooltip = ({ object }: PickingInfo<CellTotal>) =>
    object && {
      html: `<strong>${formatCount(object.harmonized)}</strong> harmonized hotspots<br/>${formatCount(object.stacked)} raw stacked`,
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
