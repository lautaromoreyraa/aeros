/**
 * The hero's timeline. Every moving part of the scene is a pure function of
 * one position `t`, where t = 0 → 1 is one turn of the planet: the browser
 * advances it with the wall clock and HyperFrames seeks it frame by frame, and
 * both draw the same frames. Nothing here touches three.js, so it is tested
 * on its own.
 */

const DEG = Math.PI / 180;

/** Seconds for one turn of the planet: a slow, smooth spin that still reads as motion. */
export const DAY_SECONDS = 300;
/** The satellite orbits two and a half times for each turn of the planet. */
export const ORBITS_PER_TURN = 2.5;
/** Winds aloft carry the cloud deck a tenth faster than the ground. */
export const CLOUD_DRIFT = 1.1;
/** The Earth's axial tilt: 23.44°, leaning the north pole to the upper left. */
export const AXIAL_TILT = 23.44 * DEG;

/** Seconds of the opening: the camera travels in and lands. */
export const ARRIVAL = 2.6;
/**
 * The satellite crosses the middle of the disc this long after the first
 * frame, a beat after the camera lands, lighting the fires as it sweeps
 * over them: the cue for the title.
 */
export const FIRST_PASS = 3.6;

/** Shells above the ground, in planet radii, far enough apart never to z-fight. */
export const SHELL = { surface: 1, fires: 1.002, clouds: 1.006, atmosphere: 1.018 } as const;

/** [longitude, latitude] facing the camera at the first pass: the heart of South America. */
export const VIEW_CENTER: readonly [number, number] = [-59, -17];
/**
 * Sunlight from the right, low and a little in front: morning over the
 * Americas, and a terminator that cuts night across the left of the disc,
 * behind the copy.
 */
export const SUN_DIRECTION: readonly [number, number, number] = normalize([0.86, 0.28, 0.42]);

const EARTH_KM = 6371;

/**
 * The two fire instruments of the record, flown in front of the viewer: the
 * orbits are staged nearly edge-on so each pass crosses between the camera
 * and the planet. What stays real is the pair: MODIS lower and a little
 * faster than VIIRS, in their real period ratio, each with its own swath.
 */
export interface SatelliteSpec {
  name: string;
  /** Orbit radius in planet radii, staged so the pass runs in front of the camera. */
  radius: number;
  /** Tilt of the staged orbit about the camera's horizontal axis. */
  inclination: number;
  periodMinutes: number;
  /** Half the width of the ground it images, in km. */
  halfSwathKm: number;
  /** Its angle from straight in front of the planet at the first pass, radians. */
  phase: number;
}

export const SATELLITES: readonly SatelliteSpec[] = [
  // VIIRS on NOAA-20, 824 km: the higher of the two, crossing in front at the first pass.
  { name: "VIIRS on NOAA-20", radius: 1.3, inclination: 2.2 * DEG, periodMinutes: 101.4, halfSwathKm: 1520, phase: 0 },
  // MODIS on Terra, 705 km: lower and a little faster, on a plane tilted the other way, a pass behind.
  { name: "MODIS on Terra", radius: 1.22, inclination: -5 * DEG, periodMinutes: 98.9, halfSwathKm: 1165, phase: -0.6 },
];

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** From the planet's frame (its axis leaning 23.44°, the view latitude facing the camera) to the scene's. */
export function toWorld([x, y, z]: Vec3): Vec3 {
  const lat = VIEW_CENTER[1] * DEG;
  const [ly, lz] = [y * Math.cos(lat) - z * Math.sin(lat), y * Math.sin(lat) + z * Math.cos(lat)];
  return [x * Math.cos(AXIAL_TILT) - ly * Math.sin(AXIAL_TILT), x * Math.sin(AXIAL_TILT) + ly * Math.cos(AXIAL_TILT), lz];
}

const REFERENCE_PERIOD = Math.max(...SATELLITES.map((spec) => spec.periodMinutes));

/** The satellite's angle from its ascending node at `seconds`. */
export const orbitAngle = (spec: SatelliteSpec, seconds: number): number =>
  spec.phase +
  ((seconds - FIRST_PASS) / DAY_SECONDS) * ORBITS_PER_TURN * (REFERENCE_PERIOD / spec.periodMinutes) * Math.PI * 2;

/** The point under the satellite, as a unit vector in the scene: angle 0 is straight in front of the planet. */
export function subSatellite(spec: SatelliteSpec, seconds: number): Vec3 {
  const u = orbitAngle(spec, seconds);
  const i = spec.inclination;
  return [Math.sin(u), -Math.cos(u) * Math.sin(i), Math.cos(u) * Math.cos(i)];
}

export interface SceneClock {
  /** Seconds on the hero's timeline for the frame being drawn. */
  seconds(): number;
}

export interface Pose {
  /** Spin of the planet about its axis, radians. */
  earth: number;
  /** Spin of the cloud deck about the same axis. */
  clouds: number;
  /** The satellite's angle on its orbit; 0 is straight in front of the planet. */
  satellite: number;
}

export const progressAt = (seconds: number): number => seconds / DAY_SECONDS;

/**
 * Angles at timeline position `t`, all zero at the first pass. The satellite
 * turns ORBITS_PER_TURN times as fast as the planet.
 */
export function poseAt(t: number): Pose {
  const turn = (t - progressAt(FIRST_PASS)) * Math.PI * 2;
  return { earth: turn, clouds: turn * CLOUD_DRIFT, satellite: turn * ORBITS_PER_TURN };
}

/** WGS84 degrees to a point on a sphere, matching three.js' equirectangular UVs. */
export function geoToCartesian(lon: number, lat: number, radius: number): [number, number, number] {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return [-radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta)];
}

/** The planet's rotation about its axis that turns `lon` to face the camera (+z). */
export function faceLongitude(lon: number): number {
  const [x, , z] = geoToCartesian(lon, 0, 1);
  return Math.atan2(-x, z);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const power4Out = (x: number): number => 1 - (1 - clamp(x, 0, 1)) ** 4;

/**
 * Share of the frame's height (landscape) or width (portrait) the planet's
 * disc spans: 30 % more than the size the old scroll push reached, so the
 * planet fills the frame and its limb shows only at the sides.
 */
const DISC_LANDSCAPE = 1.55;
const DISC_PORTRAIT = 1.52;
/** How far the disc moves off centre, as a share of the frame: right of the copy, or above it. */
const SHIFT_RIGHT = 0.12;
const SHIFT_UP = 0.24;
/** The disc never comes closer than this to the frame's edge when it moves. */
const MARGIN = 0.03;

export interface Framing {
  /** Camera distance from the planet's centre, in the same unit as `radius`. */
  distance: number;
  /** Where the disc's centre sits, as a share of the frame from its centre: +x right, +y up. */
  shiftX: number;
  shiftY: number;
}

/**
 * A close crop where the planet dominates: on a landscape screen its disc
 * overflows the height and sits right of the copy; on a portrait one it
 * overflows the width above the copy.
 */
export function framing(aspect: number, fovDegrees: number, radius: number): Framing {
  const tanHalf = Math.tan((fovDegrees * DEG) / 2);
  const landscape = aspect >= 1;
  const reach = landscape ? DISC_LANDSCAPE * tanHalf : DISC_PORTRAIT * tanHalf * aspect;
  const distance = radius / Math.sin(Math.atan(reach));
  // The disc's radius as a share of the frame's width or height.
  const half = landscape ? DISC_LANDSCAPE / aspect / 2 : (DISC_PORTRAIT * aspect) / 2;
  return {
    distance,
    shiftX: landscape ? clamp(0.5 - half - MARGIN, 0, SHIFT_RIGHT) : 0,
    shiftY: landscape ? 0 : clamp(0.5 - half - MARGIN, 0, SHIFT_UP),
  };
}

export interface CameraPath {
  /** Multiplies the framed distance: far out at first, 1 once landed. */
  distance: number;
  /** Radians above and to the side of the final line of sight. */
  elevation: number;
  azimuth: number;
}

/** The opening move: from high and wide, decelerating hard into the framed view. */
export function cameraPathAt(seconds: number): CameraPath {
  const left = 1 - power4Out(seconds / ARRIVAL);
  return { distance: 1 + 1.15 * left, elevation: 0.34 * left, azimuth: -0.5 * left };
}

/** The glow of a fire nobody has seen yet. */
const UNSEEN = 0.12;
/** How long a flare takes to settle, in seconds. */
const COOLING = 1.8;

/**
 * Seconds between two passes of the satellite over the same ground: it
 * gains one turn on the planet every DAY_SECONDS / (ORBITS_PER_TURN - 1).
 */
export const REVISIT_SECONDS = DAY_SECONDS / (ORBITS_PER_TURN - 1);

/**
 * How hot a fire front glows at `seconds`: a dim ember until the satellite
 * first passes over it at `ignition`, a flare as it does, then a steady glow
 * that flares again, more softly, each time the satellite comes back over it.
 */
export function fireHeat(seconds: number, ignition = FIRST_PASS): number {
  const ignite = smoothstep(ignition - 0.08, ignition + 0.12, seconds);
  if (ignite === 0) return UNSEEN;
  const since = Math.max(0, seconds - ignition);
  const flare = (since < REVISIT_SECONDS ? 0.9 : 0.45) * Math.exp(-(since % REVISIT_SECONDS) / COOLING);
  return UNSEEN + ignite * (1 - UNSEEN + flare);
}

export interface FireFront {
  /** Where the front burns, [longitude, latitude]. */
  center: readonly [number, number];
  /** Degrees from the centre within which most of its points fall. */
  spread: number;
  points: number;
}

/**
 * The fires the hero draws. They are illustrative, not read from the
 * record, so the opening never waits for data; they sit where South America
 * burns every dry season, listed west to east, the order in which the
 * satellite sweeps over them.
 */
export const FIRE_FRONTS: readonly FireFront[] = [
  // The arc of deforestation, Rondônia.
  { center: [-63.5, -10.5], spread: 1.9, points: 60 },
  // The dry forest further south.
  { center: [-61.5, -23], spread: 2.2, points: 70 },
  // The Pantanal.
  { center: [-57, -17.8], spread: 1.5, points: 45 },
  // The Cerrado of Mato Grosso.
  { center: [-52, -14.5], spread: 1.8, points: 55 },
  // The savanna of the Top End, Northern Territory.
  { center: [132.5, -14.5], spread: 2.2, points: 65 },
  // The bush of New South Wales.
  { center: [149.5, -33.5], spread: 1.7, points: 50 },
];

export interface FirePoint {
  lon: number;
  lat: number;
  /** 0 → 1: how hot the point burns, highest at the core of its front. */
  weight: number;
  /** Index of its front in FIRE_FRONTS. */
  front: number;
}

/** Every point of every front: a seeded gaussian cloud around each centre, the same on every load. */
export function firePoints(fronts: readonly FireFront[] = FIRE_FRONTS): FirePoint[] {
  return fronts.flatMap(({ center: [lon, lat], spread, points }, front) =>
    Array.from({ length: points }, (_, index) => {
      const seed = front * 1000 + index;
      const distance = 0.5 * Math.sqrt(-2 * Math.log(Math.max(seeded(seed), 1e-6)));
      const angle = seeded(seed + 0.5) * Math.PI * 2;
      return {
        lon: lon + (spread * distance * Math.cos(angle)) / Math.cos(lat * DEG),
        lat: lat + spread * distance * Math.sin(angle),
        weight: Math.exp(-1.6 * distance * distance) * (0.55 + 0.45 * seeded(seed + 0.25)),
        front,
      };
    }),
  );
}

/** Where a point of the ground is at `seconds`, as a unit vector in the planet's frame: it turns with the planet. */
export function groundAt([lon, lat]: readonly [number, number], seconds: number): Vec3 {
  const [x, y, z] = geoToCartesian(lon, lat, 1);
  const spin = faceLongitude(VIEW_CENTER[0]) + poseAt(progressAt(seconds)).earth;
  return [x * Math.cos(spin) + z * Math.sin(spin), y, -x * Math.sin(spin) + z * Math.cos(spin)];
}

/**
 * How hot a front glows at `seconds`: a steady burn, flaring while either
 * satellite's swath sweeps over it, strongest when it passes straight above.
 */
export function frontHeat(center: readonly [number, number], seconds: number): number {
  const ground = toWorld(groundAt(center, seconds));
  const overhead = Math.max(
    ...SATELLITES.map((spec) => {
      const reach = spec.halfSwathKm / EARTH_KM;
      const angle = Math.acos(Math.min(1, dot(ground, subSatellite(spec, seconds))));
      return 1 - smoothstep(0.35 * reach, reach, angle);
    }),
  );
  return 1 + 0.9 * overhead;
}

/** The one frame a reduced-motion visitor sees: Terra just past the first pass over South America. */
export const STILL_AT = FIRST_PASS + 0.5;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A stable pseudo-random number in [0, 1) for index `i`: same scene, same fires, every frame. */
export function seeded(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function normalize([x, y, z]: [number, number, number]): [number, number, number] {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
