import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { FlyToInterpolator, WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { cellToBoundary, cellToLatLng } from "h3-js";
import type { Unit } from "../api/types";
import type { CellTotal } from "../util/aggregation";
import { boundsOf, type Area, type LngLat } from "../util/area";
import { type Rgb, VIRIDIS, sampleRamp, sqrtScale } from "../util/colorRamp";
import { formatCount, unitLabel } from "../util/format";
import { focusPadding, leaderEnd, type Point } from "../util/mapFocus";
import type { WindField } from "../util/wind";
import { BitmapLayer } from "@deck.gl/layers";
import { WindParticles, windSpeedImage } from "./WindParticles";
import { BASEMAP, ON_TOP, areaLayers, initialView, rasterLayer } from "./mapLayers";

/** Where the camera should go, and the cell a line to the panel starts from. */
export interface MapFocus {
  /** The camera fits these cells. */
  cells: string[];
  anchor: string | null;
}

/** Close enough to read a town's name next to its cell, not so close the cell fills the screen. */
const FOCUS_MAX_ZOOM = 9.5;
/** From this zoom, place names are drawn over the columns so a town is never hidden by its own cell. */
const LABELS_ON_TOP_ZOOM = 6.5;
const ELEVATION = 60000;

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
  /** Colour ramp of the columns; viridis unless a view asks for another. */
  ramp?: Rgb[];
  /** A click outside drawing mode: the cell under the pointer, or `null` on empty ground. */
  onPick?: (cell: string | null) => void;
  /** Flies to these cells and links the anchor to {@link panel} with a line. */
  focus?: MapFocus | null;
  /** The floating panel the focus belongs to; the camera leaves its part of the map free. */
  panel?: RefObject<HTMLElement | null>;
  /** Animated wind over the columns, at one hour of the field. */
  wind?: { field: WindField; hour: number } | null;
}

export default function HexMap(props: Props) {
  const { totals, selected, centers, showRaw, unit, area, drawing, draft, onAddVertex, theme, reducedMotion, onPick, focus = null, panel, wind = null } = props;
  const ramp = props.ramp ?? VIRIDIS;
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

  // The panel is mounted in the same commit as the focus, so its size is
  // known here; the camera fits the cells in the part of the map left free.
  useEffect(() => {
    const element = container.current;
    if (!focus || !element || element.clientWidth === 0 || element.clientHeight === 0) return;
    const points = focus.cells.flatMap((cell) => cellToBoundary(cell).map(([lat, lng]): LngLat => [lng, lat]));
    if (points.length === 0) return;
    const { west, south, east, north } = boundsOf(points);
    const rect = element.getBoundingClientRect();
    const viewport = new WebMercatorViewport({ width: rect.width, height: rect.height });
    const { longitude, latitude, zoom } = viewport.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: focusPadding(rect, panel?.current?.getBoundingClientRect() ?? null) },
    );
    setViewState((state) => ({
      ...state,
      longitude,
      latitude,
      zoom: Math.min(zoom, FOCUS_MAX_ZOOM),
      ...(reducedMotion ? {} : { transitionDuration: 1100, transitionInterpolator: new FlyToInterpolator({ curve: 1.2 }) }),
    }));
    // Only a new focus moves the camera; dragging afterwards is the visitor's.
  }, [focus]);

  // The particles project with the camera of the latest render.
  const latestView = useRef(viewState);
  latestView.current = viewState;
  const projection = useCallback(() => {
    const element = container.current;
    if (!element || element.clientWidth === 0) return null;
    return new WebMercatorViewport({ ...latestView.current, width: element.clientWidth, height: element.clientHeight });
  }, []);
  const cameraKey = [viewState.longitude, viewState.latitude, viewState.zoom, viewState.pitch, viewState.bearing]
    .map((value) => (value ?? 0).toFixed(5))
    .join(",");

  // Same scale for raw and harmonized so the toggle shows the real difference.
  const max = useMemo(() => totals.reduce((value, cell) => Math.max(value, cell.harmonized, cell.stacked), 0), [totals]);

  const value = (cell: CellTotal) => (showRaw ? cell.stacked : cell.harmonized);
  const closeUp = viewState.zoom >= LABELS_ON_TOP_ZOOM;

  const windImage = useMemo(() => wind && windSpeedImage(wind.field, wind.hour), [wind]);

  const layers = useMemo(() => {
    const grid = wind?.field.grid;
    return [
      rasterLayer(`basemap-${theme}`, BASEMAP[theme].base),
      windImage &&
        grid &&
        new BitmapLayer({
          id: "wind-speed",
          image: windImage,
          bounds: [grid.west, grid.south, grid.east, grid.north],
          opacity: 0.38,
        }),
      // Seen from afar, place names sit under the columns: context, never
      // covering the data. Close up they go on top, so a town can be found.
      !closeUp && rasterLayer(`labels-${theme}`, BASEMAP[theme].labels),
      new H3HexagonLayer<CellTotal>({
        id: "cells",
        data: totals,
        getHexagon: (cell) => cell.cell,
        extruded: true,
        elevationScale: 1,
        getElevation: (cell) => sqrtScale(value(cell), max) * 60000,
        getFillColor: (cell) => {
          const [r, g, b] = sampleRamp(ramp, sqrtScale(value(cell), max));
          const dimmed = selected !== null && !selected.has(cell.cell);
          return [r, g, b, dimmed ? 50 : 235];
        },
        material: { ambient: 0.5, diffuse: 0.6, shininess: 24 },
        pickable: !drawing,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 90],
        coverage: 0.92,
        transitions: reducedMotion ? undefined : { getElevation: 600, getFillColor: 300 },
        updateTriggers: { getElevation: [showRaw, max], getFillColor: [showRaw, max, selected, ramp] },
      }),
      ...areaLayers(area, draft, theme),
      closeUp && rasterLayer(`labels-top-${theme}`, BASEMAP[theme].labels, ON_TOP),
    ];
  }, [totals, selected, showRaw, area, draft, drawing, theme, max, reducedMotion, ramp, closeUp, windImage, wind]);

  // The line follows the camera, so it is recomputed on every view change.
  const anchorTotal = useMemo(() => totals.find((cell) => cell.cell === focus?.anchor), [totals, focus]);
  let leader: { from: Point; to: Point } | null = null;
  const element = container.current;
  const panelElement = panel?.current;
  if (focus?.anchor && element && panelElement && element.clientWidth > 0) {
    const rect = element.getBoundingClientRect();
    const [lat, lng] = cellToLatLng(focus.anchor);
    const top = anchorTotal ? sqrtScale(value(anchorTotal), max) * ELEVATION : 0;
    const viewport = new WebMercatorViewport({ ...viewState, width: rect.width, height: rect.height });
    const [x, y] = viewport.project([lng, lat, top]);
    const from: Point = [x ?? 0, y ?? 0];
    leader = { from, to: leaderEnd(from, rect, panelElement.getBoundingClientRect()) };
  }

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
          if (drawing) {
            if (info.coordinate) onAddVertex([info.coordinate[0]!, info.coordinate[1]!]);
          } else onPick?.((info.object as CellTotal | undefined)?.cell ?? null);
        }}
      />
      {wind && (
        <WindParticles field={wind.field} hour={wind.hour} viewport={projection} cameraKey={cameraKey} reducedMotion={reducedMotion} />
      )}
      {leader && (
        <svg className="map__leader" aria-hidden="true">
          <line x1={leader.from[0]} y1={leader.from[1]} x2={leader.to[0]} y2={leader.to[1]} />
          <circle cx={leader.from[0]} cy={leader.from[1]} r="4" />
          <circle cx={leader.to[0]} cy={leader.to[1]} r="2.5" />
        </svg>
      )}
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
