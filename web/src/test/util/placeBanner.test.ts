import { describe, expect, it } from "vitest";
import { latLngToCell } from "h3-js";
import type { AlertDecision } from "../../util/earlyWarning";
import { type Place, type PlaceIndex } from "../../util/places";
import { decidePlaceBanner, formatMultiplier } from "../../util/placeBanner";

const RES = 4;

function makeDecision(cells: { cell: string; ratio: number | null; observed: number; expected: number; p_value: number }[]): AlertDecision {
  return {
    active: cells.length > 0,
    region: false,
    cells,
  };
}

const RESISTENCIA: Place = {
  name: "Resistencia",
  region: "Chaco",
  country: "AR",
  lat: -27.45,
  lng: -58.98,
  population: 290000,
};

const CORRIENTES: Place = {
  name: "Corrientes",
  region: "Corrientes",
  country: "AR",
  lat: -27.48,
  lng: -58.83,
  population: 350000,
};

const FORMOSA: Place = {
  name: "Formosa",
  region: "Formosa",
  country: "AR",
  lat: -26.18,
  lng: -58.17,
  population: 220000,
};

function makePlaceIndex(places: Place[]): PlaceIndex {
  const inCell = new Map<string, Place>();
  for (const p of places) {
    const c = latLngToCell(p.lat, p.lng, RES);
    inCell.set(c, p);
  }
  return {
    places,
    resolution: RES,
    inCell,
    near: new Map(),
  };
}

describe("formatMultiplier", () => {
  it("formats null ratio", () => {
    expect(formatMultiplier(null)).toBe("an unusual amount");
  });

  it("formats ratio < 1", () => {
    expect(formatMultiplier(0.4)).toBe("less than 1 times");
  });

  it("formats ratio between 1 and 10 with one decimal", () => {
    expect(formatMultiplier(3.42)).toBe("3.4 times");
    expect(formatMultiplier(9.94)).toBe("9.9 times");
  });

  it("rounds ratio >= 10", () => {
    expect(formatMultiplier(14.2)).toBe("14 times");
    expect(formatMultiplier(339.67)).toBe("340 times");
  });
});

describe("decidePlaceBanner", () => {
  it("returns none when there are no flagged cells", () => {
    const decision = makeDecision([]);
    const outcome = decidePlaceBanner({
      decision,
      userPlace: RESISTENCIA,
      placesIndex: null,
      resolution: RES,
    });
    expect(outcome.kind).toBe("none");
  });

  it("returns near when a cell inside the town is flagged", () => {
    const resCell = latLngToCell(RESISTENCIA.lat, RESISTENCIA.lng, RES);
    const decision = makeDecision([
      { cell: resCell, ratio: 14.2, observed: 42, expected: 3, p_value: 0.0001 },
    ]);
    const outcome = decidePlaceBanner({
      decision,
      userPlace: RESISTENCIA,
      placesIndex: null,
      resolution: RES,
    });

    expect(outcome.kind).toBe("near");
    if (outcome.kind === "near") {
      expect(outcome.place.name).toBe("Resistencia");
      expect(outcome.cell).toBe(resCell);
      expect(outcome.multiplier).toBe("14 times");
      expect(outcome.text).toBe("Possible fire near Resistencia: about 14 times the usual this week");
      expect(outcome.action).toBe("See it on the map");
    }
  });

  it("returns near when an adjacent cell in the ring is flagged", () => {
    const corrCell = latLngToCell(CORRIENTES.lat, CORRIENTES.lng, RES);
    // Corrientes is just across the Paraná river from Resistencia, within gridDisk(resCell, 1) at res 4
    const decision = makeDecision([
      { cell: corrCell, ratio: 5.3, observed: 15, expected: 2.8, p_value: 0.002 },
    ]);
    const outcome = decidePlaceBanner({
      decision,
      userPlace: RESISTENCIA,
      placesIndex: null,
      resolution: RES,
    });

    expect(outcome.kind).toBe("near");
    if (outcome.kind === "near") {
      expect(outcome.place.name).toBe("Resistencia");
      expect(outcome.multiplier).toBe("5.3 times");
    }
  });

  it("picks the strongest flagged cell when multiple neighbours are flagged", () => {
    const resCell = latLngToCell(RESISTENCIA.lat, RESISTENCIA.lng, RES);
    const corrCell = latLngToCell(CORRIENTES.lat, CORRIENTES.lng, RES);
    const decision = makeDecision([
      { cell: resCell, ratio: 3.2, observed: 10, expected: 3, p_value: 0.01 },
      { cell: corrCell, ratio: 18.5, observed: 50, expected: 2.7, p_value: 0.0001 },
    ]);
    const outcome = decidePlaceBanner({
      decision,
      userPlace: RESISTENCIA,
      placesIndex: null,
      resolution: RES,
    });

    expect(outcome.kind).toBe("near");
    if (outcome.kind === "near") {
      expect(outcome.cell).toBe(corrCell);
      expect(outcome.multiplier).toBe("19 times");
    }
  });

  it("returns elsewhere when no user place is chosen", () => {
    const formCell = latLngToCell(FORMOSA.lat, FORMOSA.lng, RES);
    const index = makePlaceIndex([FORMOSA]);
    const decision = makeDecision([
      { cell: formCell, ratio: 8.2, observed: 25, expected: 3, p_value: 0.001 },
    ]);
    const outcome = decidePlaceBanner({
      decision,
      userPlace: null,
      placesIndex: index,
      resolution: RES,
    });

    expect(outcome.kind).toBe("elsewhere");
    if (outcome.kind === "elsewhere") {
      expect(outcome.userPlace).toBeNull();
      expect(outcome.places).toHaveLength(1);
      expect(outcome.places[0]?.place.name).toBe("Formosa");
      expect(outcome.places[0]?.multiplier).toBe("8.2 times");
      expect(outcome.places[0]?.text).toBe("Formosa, Formosa: about 8.2 times the usual");
    }
  });

  it("returns elsewhere when user place is far from any flagged cell", () => {
    const formCell = latLngToCell(FORMOSA.lat, FORMOSA.lng, RES);
    const index = makePlaceIndex([RESISTENCIA, FORMOSA]);
    const decision = makeDecision([
      { cell: formCell, ratio: 8.2, observed: 25, expected: 3, p_value: 0.001 },
    ]);
    const outcome = decidePlaceBanner({
      decision,
      userPlace: RESISTENCIA,
      placesIndex: index,
      resolution: RES,
    });

    expect(outcome.kind).toBe("elsewhere");
    if (outcome.kind === "elsewhere") {
      expect(outcome.userPlace?.name).toBe("Resistencia");
      expect(outcome.places).toHaveLength(1);
      expect(outcome.places[0]?.place.name).toBe("Formosa");
    }
  });

  it("deduplicates towns in elsewhere and sorts strongest first", () => {
    const formCell = latLngToCell(FORMOSA.lat, FORMOSA.lng, RES);
    const corrCell = latLngToCell(CORRIENTES.lat, CORRIENTES.lng, RES);
    const index = makePlaceIndex([FORMOSA, CORRIENTES]);
    const decision = makeDecision([
      { cell: formCell, ratio: 4.1, observed: 12, expected: 3, p_value: 0.01 },
      { cell: corrCell, ratio: 22.0, observed: 60, expected: 2.7, p_value: 0.0001 },
    ]);
    const outcome = decidePlaceBanner({
      decision,
      userPlace: null,
      placesIndex: index,
      resolution: RES,
    });

    expect(outcome.kind).toBe("elsewhere");
    if (outcome.kind === "elsewhere") {
      expect(outcome.places).toHaveLength(2);
      expect(outcome.places[0]?.place.name).toBe("Corrientes");
      expect(outcome.places[1]?.place.name).toBe("Formosa");
    }
  });
});
