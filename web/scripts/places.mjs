// Builds web/public/data/places.json: the towns of the study box (the wind
// box of util/wind.ts plus half a degree) from the GeoNames cities500 dump,
// filtered to populated places. GeoNames data is under CC BY 4.0, which the
// site's footers credit. The dump and the admin names are cached in the
// system temp directory between runs. Run from the repo root:
//   npx -y node@22 web/scripts/places.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE = join(tmpdir(), "aeros-geonames");
const CITIES = join(CACHE, "cities500.zip");
const ADMINS = join(CACHE, "admin1CodesASCII.txt");
const URLS = {
  [CITIES]: "https://download.geonames.org/export/dump/cities500.zip",
  [ADMINS]: "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
};

// West, south, east, north: util/wind.ts STUDY_BOX plus half a degree.
const BOX = [-69.5, -35.5, -52.5, -15.5];
const SKIP_CODES = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);

mkdirSync(CACHE, { recursive: true });
for (const [file, url] of Object.entries(URLS)) {
  if (!existsSync(file)) {
    console.log(`downloading ${url}`);
    execFileSync("curl", ["-fsSL", "-o", file, url]);
  }
}

// GeoNames spells a few of these without their accents and adds a suffix
// nobody says: a reader knows Córdoba and Boquerón, not "Cordoba" or
// "Boquerón Department".
const SPELLED = { Cordoba: "Córdoba", "Entre Rios": "Entre Ríos", Tucuman: "Tucumán", Asuncion: "Asunción" };
const adminNames = new Map();
for (const line of readFileSync(ADMINS, "utf8").split("\n")) {
  const [key, name] = line.split("\t");
  if (key && name) adminNames.set(key, SPELLED[name] ?? name.replace(/ Department$/, ""));
}

// The dump is a zip with a single tab-separated file inside; `unzip -p`
// streams it without unpacking the whole archive.
const text = execFileSync("unzip", ["-p", CITIES, "cities500.txt"], { maxBuffer: 512 * 1024 * 1024 }).toString("utf8");
const [west, south, east, north] = BOX;
const places = [];
for (const line of text.split("\n")) {
  const columns = line.split("\t");
  const featureClass = columns[6];
  const featureCode = columns[7];
  if (featureClass !== "P" || SKIP_CODES.has(featureCode)) continue;
  const lat = Number(columns[4]);
  const lng = Number(columns[5]);
  if (lat < south || lat > north || lng < west || lng > east) continue;
  const country = columns[8];
  const region = adminNames.get(`${country}.${columns[10]}`) ?? "";
  places.push([columns[1], region, country, Math.round(lat * 1000) / 1000, Math.round(lng * 1000) / 1000, Number(columns[14])]);
}
places.sort((a, b) => a[2].localeCompare(b[2]) || a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "places.json");
const header = {
  generated_at: new Date().toISOString().slice(0, 10),
  source: "GeoNames cities500, https://www.geonames.org/",
  license: "CC BY 4.0",
  box: BOX,
  columns: ["name", "region", "country", "lat", "lng", "population"],
};
// One line, like the other data files the site ships.
const body = JSON.stringify({ ...header, places });
writeFileSync(out, body);
console.log(`${places.length} places, ${Buffer.byteLength(body)} bytes -> ${out}`);
