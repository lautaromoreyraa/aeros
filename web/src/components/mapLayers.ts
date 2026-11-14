import { WebMercatorViewport, type MapViewState } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { boundsOf, boxToRing, type Area, type LngLat } from "../util/area";

/* Pieces every deck.gl map of the app shares: the basemap, the first framing
   of the region and the outline of the chosen area. */

/**
 * Esri basemaps need no API key; their attribution is shown in the corner as
 * the terms ask. The grey canvases stay quiet under the data. The physical one
 * shows relief, rivers and vegetation with borders and place names over it, so
 * a reader can tell the Pilcomayo from a province line.
 */
const ESRI = "https://services.arcgisonline.com/arcgis/rest/services";
const tiles = (service: string) => `${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`;
const STREET_CREDIT = "Esri, HERE, Garmin, © OpenStreetMap contributors";
export const BASEMAP = {
  light: {
    base: tiles("Canvas/World_Light_Gray_Base"),
    labels: tiles("Canvas/World_Light_Gray_Reference"),
    maxZoom: 16,
    attribution: `Basemap: ${STREET_CREDIT}`,
  },
  dark: {
    base: tiles("Canvas/World_Dark_Gray_Base"),
    labels: tiles("Canvas/World_Dark_Gray_Reference"),
    maxZoom: 16,
    attribution: `Basemap: ${STREET_CREDIT}`,
  },
  physical: {
    // Blue sea, land coloured by vegetation and relief; the names and borders
    // come as their own layer so they can be drawn over the columns close up.
    base: tiles("World_Physical_Map"),
    labels: tiles("Reference/World_Boundaries_and_Places"),
    // The relief stops at 8; past it the last tiles are stretched, which a
    // shaded relief tolerates while the names above stay sharp.
    maxZoom: 8,
    attribution: `Basemap: US National Park Service, Esri; borders and places: ${STREET_CREDIT}`,
  },
};
export type Basemap = keyof typeof BASEMAP;

/**
 * Esri World Imagery: real satellite and aerial imagery, also keyless. Google's
 * photorealistic tiles would need an API key and a billing account.
 */
export const SATELLITE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const SATELLITE_ATTRIBUTION = "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community";

/** `parameters` lets a layer draw over the 3D columns, as place names do close up. */
export function rasterLayer(id: string, url: string, parameters?: typeof ON_TOP, maxZoom = 16) {
  return new TileLayer<ImageBitmap>({
    id,
    data: url,
    minZoom: 0,
    maxZoom,
    tileSize: 256,
    renderSubLayers: (sub) => {
      const [min, max] = sub.tile.boundingBox;
      return new BitmapLayer({
        ...sub,
        data: undefined,
        image: sub.data,
        bounds: [min[0] ?? 0, min[1] ?? 0, max[0] ?? 0, max[1] ?? 0],
        ...(parameters && { parameters }),
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
