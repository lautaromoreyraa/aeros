import { useEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import type { MapViewState, PickingInfo } from "@deck.gl/core";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import type { Area, LngLat } from "../util/area";
import type { Rgb } from "../util/colorRamp";
import { BASEMAP, areaLayers, initialView, rasterLayer } from "./mapLayers";

export interface RiskCell {
  cell: string;
  color: Rgb;
  /** Plain text lines; the first one is shown in bold. */
  tooltip: string[];
  /** Drawn with a thick outline, for cells that need attention. */
  emphasis?: boolean;
}

interface Props {
  cells: RiskCell[];
  /** Every cell of the study region, drawn faintly so empty cells read as "nothing", not "no map". */
  context: string[];
  centers: LngLat[];
  /** Cells outside the chosen area are dimmed. */
  selected?: ReadonlySet<string> | null;
  area?: Area;
  drawing?: boolean;
  draft?: LngLat[];
  onAddVertex?: (point: LngLat) => void;
  theme: "light" | "dark";
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/**
 * A flat H3 map coloured by a precomputed value. Flat on purpose: the early
 * warning and the forecast are about where, and columns of different heights
 * would hide the cells behind them.
 */
export default function RiskMap(props: Props) {
  const { cells, context, centers, selected = null, area = { kind: "region" }, drawing = false, draft = [], onAddVertex, theme } = props;
  const container = useRef<HTMLDivElement>(null);
  const fit = () => initialView(centers, container.current?.clientWidth ?? 0, container.current?.clientHeight ?? 0, false);
  const [viewState, setViewState] = useState<MapViewState>(() => initialView(centers, 0, 0, false));

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
    // Runs once, like the calendar map: from then on the visitor owns the camera.
  }, []);

  const layers = useMemo(() => {
    const outline: [number, number, number, number] = theme === "dark" ? [236, 232, 225, 50] : [23, 24, 26, 45];
    return [
      rasterLayer(`basemap-${theme}`, BASEMAP[theme].base),
      rasterLayer(`labels-${theme}`, BASEMAP[theme].labels),
      new H3HexagonLayer<string>({
        id: "context",
        data: context,
        getHexagon: (cell) => cell,
        filled: false,
        stroked: true,
        extruded: false,
        getLineColor: outline,
        lineWidthMinPixels: 1,
      }),
      new H3HexagonLayer<RiskCell>({
        id: "risk",
        data: cells,
        getHexagon: (cell) => cell.cell,
        extruded: false,
        stroked: true,
        getFillColor: (cell) => {
          const dimmed = selected !== null && !selected.has(cell.cell);
          return [...cell.color, dimmed ? 60 : 215];
        },
        getLineColor: (cell) => (cell.emphasis ? (theme === "dark" ? [255, 255, 255, 255] : [20, 16, 10, 255]) : outline),
        getLineWidth: (cell) => (cell.emphasis ? 3 : 1),
        lineWidthUnits: "pixels",
        pickable: !drawing,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 90],
        updateTriggers: { getFillColor: [selected], getLineColor: [theme] },
      }),
      ...areaLayers(area, draft, theme),
    ];
  }, [cells, context, selected, area, draft, drawing, theme]);

  const tooltip = ({ object }: PickingInfo<RiskCell>) =>
    object && {
      html: object.tooltip.map((line, index) => (index ? escapeHtml(line) : `<strong>${escapeHtml(line)}</strong>`)).join("<br/>"),
      className: "map-tooltip",
    };

  return (
    <div ref={container} className={drawing ? "map map--drawing" : "map"}>
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: next }) => setViewState(next as MapViewState)}
        controller={{ doubleClickZoom: !drawing, dragRotate: false }}
        layers={layers}
        getTooltip={tooltip as never}
        getCursor={({ isDragging }) => (drawing ? "crosshair" : isDragging ? "grabbing" : "grab")}
        onClick={(info) => {
          if (drawing && info.coordinate && onAddVertex) onAddVertex([info.coordinate[0]!, info.coordinate[1]!]);
        }}
      />
      <div className="map__controls">
        <button type="button" className="map__button" onClick={() => setViewState(fit())}>
          Reset view
        </button>
      </div>
      <p className="map__attribution">Basemap: Esri, HERE, Garmin, © OpenStreetMap contributors</p>
    </div>
  );
}
