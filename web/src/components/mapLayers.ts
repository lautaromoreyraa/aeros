import { WebMercatorViewport, type MapViewState } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { boundsOf, boxToRing, type Area, type LngLat } from "../util/area";

/* Pieces every deck.gl map of the app shares: the basemap, the first framing
   of the region and the outline of the chosen area. */

/**
 * Esri's grey canvas basemaps need no API key and stay quiet under the data;
 * their attribution is shown in the corner as the terms ask.
 */
const ESRI = "https://services.arcgisonline.com/arcgis/rest/services/Canvas";
export const BASEMAP = {
  light: {
    base: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
  dark: {
    base: `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
  },
};

export function rasterLayer(id: string, url: string) {
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
export const ON_TOP = { depthCompare: "always" } as const;

export function initialView(centers: LngLat[], width: number, height: number, tilt = true): MapViewState {
  const bounds = boundsOf(centers.length ? centers : [[-61, -24]]);
  const viewport = new WebMercatorViewport({ width: Math.max(width, 320), height: Math.max(height, 240) });
  const { longitude, latitude, zoom } = viewport.fitBounds(
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    { padding: Math.min(60, Math.max(width, 320) / 8) },
  );
  return { longitude, latitude, zoom: Math.min(zoom, 9), pitch: tilt ? 45 : 0, bearing: tilt ? -12 : 0 };
}


/** The chosen area's outline and the corners of an area being drawn. */
export function areaLayers(area: Area, draft: LngLat[], theme: "light" | "dark") {
  const areaRing = area.kind === "polygon" ? area.ring : area.kind === "box" ? boxToRing(area.box) : null;
  return [
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
}
