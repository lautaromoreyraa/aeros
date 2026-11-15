/**
 * A fire report: someone shares where they see a fire and the alert service
 * answers what the satellites saw around that point (`GET /alerts/fire-check`).
 * The answer never confirms a fire; it says whether GOES-19 or a polar pass
 * saw heat nearby, and always starts with the fire brigade numbers.
 */

/** `unknown`: nothing seen, but the satellite data was missing or old, so nothing was really checked. */
export type Verdict = "seen_now" | "seen_recently" | "not_seen" | "unknown" | "outside";

export interface Emergency {
  country: string;
  number: string;
}

export interface FireCheck {
  verdict: Verdict;
  point: { lat: number; lon: number };
  radius_km?: number;
  checked_at: string;
  emergency: Emergency[];
  goes?: {
    available: boolean;
    fresh: boolean;
    nearest: { distance_km: number; last_seen?: string | null; confident: boolean } | null;
  };
  polar?: {
    lookback_hours: number;
    detections: number;
    nearest: { distance_km: number; when: string; satellite: string; confident: boolean } | null;
  };
}

/** The fire brigade of each country of the study area, shown before any answer arrives. */
export const EMERGENCY: Emergency[] = [
  { country: "Argentina", number: "100" },
  { country: "Paraguay", number: "132" },
  { country: "Bolivia", number: "119" },
];

/** "-25.1, -61.2" (or with a space or semicolon) as a point; null when it is not one. */
export function parsePoint(text: string): { lat: number; lon: number } | null {
  const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const [lat, lon] = parts.map(Number) as [number, number];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function fireCheckUrl(base: string, lat: number, lon: number): string {
  // About 100 m: plenty for a 15 km radius, and less precise than where someone stands.
  const query = new URLSearchParams({ lat: lat.toFixed(3), lon: lon.toFixed(3) });
  return `${base.replace(/\/+$/, "")}/alerts/fire-check?${query}`;
}

/** "12 min ago", "5 h ago" from an ISO time, against `now`. */
export function ago(iso: string | null | undefined, now: Date, locale: "en" | "es" = "en"): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((now.getTime() - then) / 60000));
  if (locale === "es") {
    return minutes < 120 ? `hace ${minutes} min` : `hace ${Math.floor(minutes / 60)} h`;
  }
  return minutes < 120 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

/** The headline and the evidence lines of an answer, in plain English or Spanish. */
export function describe(result: FireCheck, now: Date, locale: "en" | "es" = "en"): { title: string; lines: string[] } {
  const radius = Math.round(result.radius_km ?? 15);
  const goes = result.goes?.nearest ?? null;
  const polar = result.polar?.nearest ?? null;
  if (locale === "es") {
    switch (result.verdict) {
      case "outside":
        return {
          title: "Fuera del área de monitoreo de aeros",
          lines: ["Ese punto se encuentra fuera del Gran Chaco, por lo que no hay datos satelitales para cotejarlo."],
        };
      case "unknown":
        return {
          title: "No se pudo verificar ese punto",
          lines: [
            "Los datos satelitales no están disponibles o están desactualizados en este momento. Esto no indica ausencia de fuego.",
          ],
        };
      case "seen_now":
        return {
          title: "GOES-19 detecta calor cerca de usted en este momento",
          lines: [
            `Píxel de fuego confirmado a ${goes!.distance_km} km en sus últimos escaneos (${ago(goes!.last_seen, now, locale)}).`,
            ...(polar ? [`${polar.satellite} también detectó fuego a ${polar.distance_km} km, ${ago(polar.when, now, locale)}.`] : []),
          ],
        };
      case "seen_recently":
        return {
          title: "Los satélites detectaron fuego cerca de usted recientemente",
          lines: [
            ...(polar
              ? [
                  `${polar.satellite} detectó fuego a ${polar.distance_km} km, ${ago(polar.when, now, locale)} ` +
                    `(${result.polar!.detections} detecciones a menos de ${radius} km en las últimas ${result.polar!.lookback_hours} h).`,
                ]
              : []),
            ...(goes ? [`GOES-19 registró un píxel de fuego a ${goes.distance_km} km, ${ago(goes.last_seen, now, locale)}.`] : []),
          ],
        };
      default:
        return {
          title: "Ningún satélite detectó fuego cerca de usted",
          lines: [
            `Sin detecciones a menos de ${radius} km en las últimas 48 horas. Esto no garantiza la ausencia de fuego: un foco pequeño, nubes o humo pueden ocultarlo, y el próximo pase satelital podría captarlo.`,
          ],
        };
    }
  }
  switch (result.verdict) {
    case "outside":
      return {
        title: "Outside the area aeros watches",
        lines: ["That point is outside the Gran Chaco, so there is no satellite data to check it against."],
      };
    case "unknown":
      return {
        title: "Could not check that point",
        lines: [
          "The satellite data is missing or out of date right now. That says nothing about whether there is a fire.",
        ],
      };
    case "seen_now":
      return {
        title: "GOES-19 sees heat near you right now",
        lines: [
          `A confident fire pixel ${goes!.distance_km} km away in its latest scans (${ago(goes!.last_seen, now)}).`,
          ...(polar ? [`${polar.satellite} also saw fire ${polar.distance_km} km away, ${ago(polar.when, now)}.`] : []),
        ],
      };
    case "seen_recently":
      return {
        title: "Satellites saw fire near you recently",
        lines: [
          ...(polar
            ? [
                `${polar.satellite} saw fire ${polar.distance_km} km away, ${ago(polar.when, now)} ` +
                  `(${result.polar!.detections} detections within ${radius} km in the last ${result.polar!.lookback_hours} h).`,
              ]
            : []),
          ...(goes ? [`GOES-19 had a fire pixel ${goes.distance_km} km away, ${ago(goes.last_seen, now)}.`] : []),
        ],
      };
    default:
      return {
        title: "No satellite saw fire near you",
        lines: [
          `Nothing within ${radius} km in the last 48 hours. That does not mean there is no fire: a small one, clouds or smoke can hide it, and the next pass may catch it.`,
        ],
      };
  }
}
