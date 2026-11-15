import { useEffect, useState } from "react";
import { indexPlaces, type PlaceIndex, type PlacesFile } from "../util/places";

// The gazetteer never changes inside a visit, so the fetch and one index per
// resolution are shared by every view that asks.
let promise: Promise<PlacesFile | null> | null = null;
const indexes = new Map<number, PlaceIndex>();

const load = () => {
  promise ??= fetch(`${import.meta.env.BASE_URL}data/places.json`)
    .then((response) => (response.ok && response.headers.get("content-type")?.includes("json") ? (response.json() as Promise<PlacesFile>) : null))
    .catch(() => null);
  return promise;
};

/** The gazetteer, loaded once per visit and shared by every view; `null` until it arrives or when none is published. */
export function usePlaces(resolution: number): PlaceIndex | null {
  const [file, setFile] = useState<PlacesFile | null>(null);
  useEffect(() => {
    let active = true;
    load().then((data) => {
      if (active && data) setFile(data);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!file) return null;
  let index = indexes.get(resolution);
  if (!index) {
    index = indexPlaces(file, resolution);
    indexes.set(resolution, index);
  }
  return index;
}
