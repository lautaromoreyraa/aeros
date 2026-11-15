import { useLayoutEffect, useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PathLayer } from "@deck.gl/layers";
import { cellToLatLng } from "h3-js";
import { boundsOf, type LngLat } from "../util/area";
import { formatCount } from "../util/format";
import { busiestCells, emberColor, type BurntCell, type PastFire } from "../util/pastFires";
import { BASEMAP, SATELLITE, SATELLITE_ATTRIBUTION, rasterLayer } from "./mapLayers";

/**
 * Frames the fire at its height. Closer than the region maps allow: a city
 * fire is a few kilometres wide and would be lost in a province view.
 */
function frame(points: LngLat[], width: number, height: number): MapViewState {
  const bounds = boundsOf(points.length ? points : [[-61, -24]]);
  const viewport = new WebMercatorViewport({ width: Math.max(width, 320), height: Math.max(height, 240) });
  const { longitude, latitude, zoom } = viewport.fitBounds(
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    { padding: Math.min(48, Math.max(width, 320) / 10) },
  );
  return { longitude, latitude, zoom: Math.min(zoom, 11.5), pitch: 0, bearing: 0 };
}

interface Props {
  fire: PastFire;
  cells: BurntCell[];
  /** Index of the step on the timeline; -1 before the first one. */
  current: number;
  /** When a step happened, as the page writes it. */
  timeOf: (step: number) => string;
}

/** The burnt cells of a past fire over satellite imagery. */
export default function PastFireMap({ fire, cells, current, timeOf }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const reach = useMemo<LngLat[]>(
    () =>
      busiestCells(fire.steps).map((cell) => {
        const [lat, lng] = cellToLatLng(cell);
        return [lng, lat];
      }),
    [fire],
  );
  // The first view is measured on the real container before the map draws;
  // each reset remounts the map on a freshly measured one.
  const [view, setView] = useState<MapViewState | null>(null);
  const [resets, setResets] = useState(0);
  useLayoutEffect(() => {
    const element = container.current;
    if (element) setView(frame(reach, element.clientWidth, element.clientHeight));
  }, [reach, resets]);

  const layers = useMemo(
    () => [
      rasterLayer("imagery", SATELLITE),
      rasterLayer("places", BASEMAP.physical.labels),
      fire.outline &&
        new PathLayer<LngLat[]>({
          id: "outline",
          data: [fire.outline],
          getPath: (path) => path,
          getColor: [255, 255, 255, 150],
          widthMinPixels: 1.5,
        }),
      new H3HexagonLayer<BurntCell>({
        id: "burnt",
        data: cells,
        getHexagon: (cell) => cell.cell,
        extruded: false,
        stroked: false,
        getFillColor: (cell) => emberColor(current - cell.last),
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 90],
        updateTriggers: { getFillColor: [current] },
      }),
    ],
    [fire, cells, current],
  );

  const tooltip = ({ object }: PickingInfo<BurntCell>) =>
    object && {
      html: [
        `<strong>${formatCount(object.detections)} fire detections</strong>`,
        `${formatCount(object.frp)} MW of radiative power`,
        `Last seen ${timeOf(object.last)}`,
      ].join("<br/>"),
      className: "map-tooltip",
    };

  return (
    <div ref={container} className="map">
      {view && (
        <DeckGL
          key={resets}
          initialViewState={view}
          controller={{ dragRotate: false }}
          layers={layers}
          getTooltip={tooltip as never}
        />
      )}
      <div className="map__controls">
        <button type="button" className="map__button" onClick={() => setResets((count) => count + 1)}>
          Reset view
        </button>
      </div>
      <p className="map__attribution">{SATELLITE_ATTRIBUTION}. Places: Esri, HERE, Garmin, © OpenStreetMap contributors</p>
    </div>
  );
}
