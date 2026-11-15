import { cellToLatLng, latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import {
  bearing,
  compass,
  distanceKm,
  indexPlaces,
  placeLabel,
  placeName,
  placeNear,
  type PlacesFile,
} from "../../util/places";

const RESOLUTION = 4;

/** A tiny gazetteer in the file's own shape. */
const gazetteer = (
  places: [name: string, region: string, country: string, lat: number, lng: number, population: number][],
): PlacesFile => ({
  generated_at: "2025-11-14",
  source: "test",
  license: "test",
  columns: ["name", "region", "country", "lat", "lng", "population"],
  places,
});

const SAN_MARTIN: [string, string, string, number, number, number] = [
  "General José de San Martín",
  "Chaco",
  "AR",
  -26.537,
  -59.342,
  31758,
];

describe("placeNear inside a cell", () => {
  it("names the cell after the biggest town inside it", () => {
    const cell = latLngToCell(SAN_MARTIN[3], SAN_MARTIN[4], RESOLUTION);
    const [lat, lng] = cellToLatLng(cell);
    const index = indexPlaces(
      gazetteer([SAN_MARTIN, ["Colonia Chica", "Chaco", "AR", lat, lng, 600]]),
      RESOLUTION,
    );
    const near = placeNear(index, cell);
    expect(near?.place.name).toBe("General José de San Martín");
    expect(near?.km).toBe(0);
    expect(near?.direction).toBeNull();
    expect(placeLabel(near!)).toBe("General José de San Martín, Chaco");
  });
});

describe("placeNear for an empty cell", () => {
  it("prefers a known town a little farther over the nearest hamlet", () => {
    const cell = latLngToCell(-22.0, -61.5, RESOLUTION);
    const [lat, lng] = cellToLatLng(cell);
    const index = indexPlaces(
      gazetteer([
        ["Aldea", "", "BO", lat, lng + 0.5, 500],
        ["Filadelfia", "Boquerón", "PY", lat, lng + 0.7, 14000],
        ["Metrópolis", "", "AR", lat, lng + 3.0, 1000000],
      ]),
      RESOLUTION,
    );
    const near = placeNear(index, cell);
    expect(near?.place.name).toBe("Filadelfia");
    expect(near?.direction).toBe("west");
    const km = Math.round(distanceKm([lng + 0.7, lat], [lng, lat]) / 5) * 5;
    expect(placeLabel(near!)).toBe(`About ${km} km west of Filadelfia, Boquerón`);
  });
});

describe("measures", () => {
  it("distanceKm of one degree of latitude is about 111.2 km", () => {
    expect(distanceKm([-60, -25], [-60, -24])).toBeCloseTo(111.2, 0);
  });

  it("bearing due east is about 90 degrees", () => {
    expect(bearing([-61, -25], [-60, -25])).toBeCloseTo(90, 0);
  });

  it("compass wraps degrees to the eight points", () => {
    expect(compass(92)).toBe("east");
    expect(compass(350)).toBe("north");
    expect(compass(225)).toBe("south-west");
  });
});

describe("placeLabel", () => {
  const town = { name: "Filadelfia", region: "Boquerón", country: "PY", lat: -22.3, lng: -60.0, population: 14000 };
  it("says very near under 5 km", () => {
    expect(placeLabel({ place: town, km: 3, direction: "north" })).toBe("Very near Filadelfia, Boquerón");
  });

  it("rounds to 5 km below 100 and to 10 km from there on", () => {
    expect(placeLabel({ place: town, km: 72, direction: "east" })).toBe("About 70 km east of Filadelfia, Boquerón");
    expect(placeLabel({ place: town, km: 148, direction: "east" })).toBe("About 150 km east of Filadelfia, Boquerón");
  });
});

describe("placeName", () => {
  it("drops the region when it is empty", () => {
    expect(placeName({ name: "Aldea", region: "", country: "BO", lat: 0, lng: 0, population: 1 })).toBe("Aldea");
  });
});

describe("placeNear edges", () => {
  it("gives null for an empty gazetteer and memoizes answers", () => {
    const empty = indexPlaces(gazetteer([]), RESOLUTION);
    expect(placeNear(empty, latLngToCell(-22.0, -61.5, RESOLUTION))).toBeNull();
    const index = indexPlaces(gazetteer([SAN_MARTIN]), RESOLUTION);
    const cell = latLngToCell(SAN_MARTIN[3], SAN_MARTIN[4], RESOLUTION);
    expect(placeNear(index, cell)).toBe(placeNear(index, cell));
  });
});
