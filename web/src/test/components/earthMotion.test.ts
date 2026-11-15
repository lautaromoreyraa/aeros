import { describe, expect, it } from "vitest";
import {
  AXIAL_TILT,
  DAY_SECONDS,
  FIRST_PASS,
  ORBITS_PER_TURN,
  FIRE_FRONTS,
  REVISIT_SECONDS,
  SHELL,
  SATELLITES,
  firePoints,
  frontHeat,
  subSatellite,
  cameraPathAt,
  faceLongitude,
  fireHeat,
  framing,
  geoToCartesian,
  poseAt,
  progressAt,
} from "../../components/earth/motion";

const TURN = Math.PI * 2;

describe("poseAt", () => {
  it("turns the planet once every five minutes and the satellite two and a half times as fast", () => {
    expect(DAY_SECONDS).toBe(300);
    expect(ORBITS_PER_TURN).toBe(2.5);
    for (const t of [0, 0.37, 1.8]) {
      const start = poseAt(t);
      const end = poseAt(t + 1);
      expect(end.earth - start.earth).toBeCloseTo(TURN);
      expect(end.satellite - start.satellite).toBeCloseTo(2.5 * TURN);
    }
  });

  it("drifts the clouds ahead of the ground by a tenth", () => {
    const pose = poseAt(0.5);
    expect(pose.clouds / pose.earth).toBeCloseTo(1.1);
  });

  it("puts the satellite in front of the planet at the first pass and after each of its orbits", () => {
    const pass = progressAt(FIRST_PASS);
    expect(poseAt(pass)).toEqual({ earth: 0, clouds: 0, satellite: 0 });
    const next = poseAt(pass + 1 / ORBITS_PER_TURN);
    expect(next.satellite).toBeCloseTo(TURN);
  });

  it("is the same pose for the same time, whatever came before", () => {
    const seconds = 41.3;
    expect(poseAt(progressAt(seconds))).toEqual(poseAt(progressAt(seconds)));
    expect(progressAt(DAY_SECONDS)).toBe(1);
  });
});

describe("the planet's frame", () => {
  it("leans the axis 23.44 degrees", () => {
    expect(AXIAL_TILT).toBeCloseTo(0.4091, 4);
  });

  it("keeps the four shells apart", () => {
    expect(SHELL.surface).toBeLessThan(SHELL.fires);
    expect(SHELL.fires).toBeLessThan(SHELL.clouds);
    expect(SHELL.clouds).toBeLessThan(SHELL.atmosphere);
  });
});

describe("geoToCartesian", () => {
  it("places the poles and the meridians where three.js maps the texture", () => {
    const [nx, ny, nz] = geoToCartesian(0, 90, 2);
    expect([nx, ny, nz].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 2, 0]);
    const [x0, , z0] = geoToCartesian(0, 0, 1);
    expect(x0).toBeCloseTo(1);
    expect(z0).toBeCloseTo(0);
    const [x90, , z90] = geoToCartesian(-90, 0, 1);
    expect(x90).toBeCloseTo(0);
    expect(z90).toBeCloseTo(1);
  });

  it("turns a longitude to face the camera", () => {
    for (const lon of [-68, 0, 120]) {
      const [x, , z] = geoToCartesian(lon, 0, 1);
      const yaw = faceLongitude(lon);
      // three.js rotation about +y.
      expect(x * Math.cos(yaw) + z * Math.sin(yaw)).toBeCloseTo(0);
      expect(-x * Math.sin(yaw) + z * Math.cos(yaw)).toBeCloseTo(1);
    }
  });
});

describe("framing", () => {
  const discShare = (aspect: number) => {
    const { distance } = framing(aspect, 40, 1);
    // Angular radius of the disc against the half field of view.
    return Math.tan(Math.asin(1 / distance)) / Math.tan(Math.PI / 9);
  };

  it("overflows the height of a landscape frame and keeps the limb inside it", () => {
    expect(discShare(16 / 9)).toBeCloseTo(1.55);
    const { shiftX, shiftY } = framing(16 / 9, 40, 1);
    expect(shiftX).toBeGreaterThanOrEqual(0);
    expect(shiftY).toBe(0);
    // The disc's right limb stays inside the frame.
    expect(0.5 + shiftX + 1.55 / (16 / 9) / 2).toBeLessThan(1);
  });

  it("overflows the width of a portrait frame and lifts the disc above the copy", () => {
    const aspect = 390 / 844;
    expect(discShare(aspect) / aspect).toBeCloseTo(1.52);
    const { shiftX, shiftY } = framing(aspect, 40, 1);
    expect(shiftX).toBe(0);
    expect(shiftY).toBeGreaterThan(0);
  });

  it("centres the disc on a square frame, where there is no room to move it", () => {
    expect(framing(1, 40, 1).shiftX).toBe(0);
  });
});

describe("cameraPathAt", () => {
  it("starts far out and lands on the framed view", () => {
    expect(cameraPathAt(0).distance).toBeGreaterThan(2);
    const landed = cameraPathAt(10);
    expect(landed.distance).toBe(1);
    expect(landed.elevation).toBeCloseTo(0);
    expect(landed.azimuth).toBeCloseTo(0);
  });
});

describe("fireHeat", () => {
  it("keeps the fires dim until the first pass, flares them, then settles", () => {
    const before = fireHeat(FIRST_PASS - 1);
    const flare = fireHeat(FIRST_PASS + 0.15);
    const settled = fireHeat(FIRST_PASS + 20);
    expect(before).toBeLessThan(0.2);
    expect(flare).toBeGreaterThan(1.5);
    expect(settled).toBeCloseTo(1, 1);
  });

  it("stays dim before a front's own ignition", () => {
    expect(fireHeat(FIRST_PASS + 1, FIRST_PASS + 2)).toBeLessThan(0.2);
    expect(fireHeat(FIRST_PASS + 2.15, FIRST_PASS + 2)).toBeGreaterThan(1.5);
  });

  it("flares again, more softly, when the satellite is back over the same ground", () => {
    const back = poseAt(progressAt(FIRST_PASS + REVISIT_SECONDS));
    expect(back.satellite - back.earth).toBeCloseTo(TURN);
    const first = fireHeat(FIRST_PASS + 0.2);
    const second = fireHeat(FIRST_PASS + REVISIT_SECONDS + 0.2);
    expect(second).toBeGreaterThan(1.2);
    expect(second).toBeLessThan(first);
    expect(fireHeat(FIRST_PASS + REVISIT_SECONDS / 2)).toBeCloseTo(1, 1);
  });
});

describe("the fire fronts", () => {
  it("draws six fronts, four in South America and two in Australia, the same points on every load", () => {
    expect(FIRE_FRONTS).toHaveLength(6);
    expect(FIRE_FRONTS.filter(({ center: [lon] }) => lon > 110)).toHaveLength(2);
    const points = firePoints();
    expect(points).toEqual(firePoints());
    expect(points).toHaveLength(FIRE_FRONTS.reduce((sum, front) => sum + front.points, 0));
    expect(new Set(points.map((point) => point.front))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it("scatters each front around its centre, hottest at the core", () => {
    const points = firePoints();
    FIRE_FRONTS.forEach(({ center: [lon, lat], spread }, index) => {
      const own = points.filter((point) => point.front === index);
      const meanLat = own.reduce((sum, point) => sum + point.lat, 0) / own.length;
      expect(Math.abs(meanLat - lat)).toBeLessThan(spread / 2);
      const hottest = own.reduce((best, point) => (point.weight > best.weight ? point : best));
      expect(Math.hypot((hottest.lon - lon) * Math.cos((lat * Math.PI) / 180), hottest.lat - lat)).toBeLessThan(spread);
      for (const point of own) expect(point.weight).toBeLessThanOrEqual(1);
    });
  });

  it("burns steadily and flares only while a satellite is overhead, every front within twenty turns", () => {
    for (const { center } of FIRE_FRONTS) {
      const heats = Array.from({ length: 12000 }, (_, step) => frontHeat(center, step * 0.5));
      expect(Math.min(...heats)).toBeCloseTo(1);
      expect(Math.max(...heats)).toBeGreaterThan(1.3);
    }
  });
});

describe("the two satellites", () => {
  const [viirs, modis] = SATELLITES;

  it("fly VIIRS higher and MODIS lower and a little faster, in their real period ratio", () => {
    expect(viirs!.radius).toBeGreaterThan(modis!.radius);
    expect(modis!.periodMinutes).toBeLessThan(viirs!.periodMinutes);
  });

  it("cross in front of the planet, towards the camera, VIIRS at the first pass and MODIS after it", () => {
    const front = subSatellite(viirs!, FIRST_PASS);
    expect(front[2]).toBeCloseTo(Math.cos(viirs!.inclination));
    expect(Math.abs(front[0])).toBeLessThan(1e-9);
    const later = Array.from({ length: 600 }, (_, step) => FIRST_PASS + step * 0.1).find(
      (seconds) => Math.abs(subSatellite(modis!, seconds)[0]) < 0.01 && subSatellite(modis!, seconds)[2] > 0,
    );
    expect(later).toBeGreaterThan(FIRST_PASS);
  });
});
