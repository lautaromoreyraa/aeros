import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { orbitAngle, type SatelliteSpec, type SceneClock } from "./motion";
import { foilNormalTexture, solarCellTexture } from "./textures";

/** The satellite marks only the last quarter of its orbit. */
const TRAIL = Math.PI / 2;

/** Points along the orbit from angle `from` to `to`; angle 0 is the ascending node, +x is the way it flies. */
function arc(radius: number, from: number, to: number, steps: number): number[] {
  const points: number[] = [];
  for (let step = 0; step <= steps; step++) {
    const angle = from + ((to - from) * step) / steps;
    points.push(radius * Math.sin(angle), 0, radius * Math.cos(angle));
  }
  return points;
}

/**
 * The quarter of the orbit just flown, as a white hairline fading to nothing
 * behind the satellite: below the bloom threshold, so the eye finds the
 * craft and the fires first. Line2 keeps the width in screen pixels at any
 * distance.
 */
function trajectory(radius: number): Line2 {
  const steps = 96;
  const tail = new LineGeometry();
  tail.setPositions(arc(radius, -TRAIL, 0, steps));
  tail.setColors(
    Array.from({ length: steps + 1 }, (_, step) => {
      const fade = 0.85 * (step / steps) ** 2;
      return [fade, fade, fade];
    }).flat(),
  );
  return new Line2(
    tail,
    new LineMaterial({ vertexColors: true, linewidth: 0.6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
}

/** The camera sits close to the orbits, so the craft are kept small to stay a detail of the frame. */
const CRAFT_SCALE = 0.42;
/** A slight fixed roll, so the arrays catch the sun at some point of every day-side pass. */
const ATTITUDE = [-0.25, 0, 0.35, "YXZ"] as const;

/**
 * A commercial Earth-observation satellite: a bus wrapped in gold foil, a
 * white radiator facing space, a telescope looking down, and two wings of
 * cells under glass that throw a glint when they mirror the sun at the
 * camera. Local axes: +x the way it flies, -z down to the Earth.
 */
function Spacecraft() {
  const parts = useMemo(() => {
    const foil = foilNormalTexture();
    const cells = solarCellTexture();
    return {
      textures: [foil, cells],
      materials: {
        foil: new THREE.MeshStandardMaterial({
          color: "#c99a3a",
          metalness: 0.8,
          roughness: 0.35,
          normalMap: foil,
          normalScale: new THREE.Vector2(0.9, 0.9),
        }),
        // A mirror-smooth coat would put thousands of times the sunlight into
        // a few pixels and bloom them into fog; this one flashes and fades.
        cells: new THREE.MeshPhysicalMaterial({
          map: cells,
          metalness: 0.5,
          roughness: 0.2,
          clearcoat: 1,
          clearcoatRoughness: 0.22,
        }),
        composite: new THREE.MeshStandardMaterial({ color: "#111111", metalness: 0.25, roughness: 0.6 }),
        radiator: new THREE.MeshStandardMaterial({ color: "#d8dce2", metalness: 0.1, roughness: 0.45 }),
        lens: new THREE.MeshPhysicalMaterial({ color: "#0b1a2c", roughness: 0.05, clearcoat: 1 }),
      },
    };
  }, []);
  useEffect(
    () => () => {
      parts.textures.forEach((texture) => texture.dispose());
      Object.values(parts.materials).forEach((material) => material.dispose());
    },
    [parts],
  );
  const { foil, cells, composite, radiator, lens } = parts.materials;

  return (
    <group rotation={ATTITUDE} scale={CRAFT_SCALE}>
      <mesh material={foil}>
        <boxGeometry args={[0.075, 0.07, 0.1]} />
      </mesh>
      <mesh material={radiator} position={[0, 0, 0.052]}>
        <boxGeometry args={[0.072, 0.067, 0.004]} />
      </mesh>
      <mesh material={composite} position={[0, 0, -0.064]} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.02, 0.023, 0.028, 24]} />
      </mesh>
      <mesh material={lens} position={[0, 0, -0.0785]} rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.016, 0.016, 0.002, 24]} />
      </mesh>
      <mesh material={composite} position={[0.012, 0.045, -0.025]} rotation-x={-0.4}>
        <sphereGeometry args={[0.022, 24, 8, 0, Math.PI * 2, 0, 0.8]} />
      </mesh>
      <mesh material={composite} position={[0.02, 0.02, 0.085]}>
        <cylinderGeometry args={[0.0015, 0.0015, 0.06, 6]} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 0.0375, 0, 0]}>
          <mesh material={composite} position={[side * 0.012, 0, 0]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.003, 0.003, 0.024, 8]} />
          </mesh>
          <mesh material={cells} position={[side * 0.114, 0, 0]}>
            <boxGeometry args={[0.18, 0.062, 0.003]} />
          </mesh>
        </group>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={side} material={composite} position={[-0.043, side * 0.022, -0.03]} rotation-z={Math.PI / 2}>
          <coneGeometry args={[0.006, 0.012, 12]} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * One satellite on its staged orbit in front of the viewer: the craft rides
 * a carrier that turns about the plane's normal, so it always looks down at
 * the ground and flies along its track, marking the last quarter of it.
 */
export function Satellite({ spec, radius, clock }: { spec: SatelliteSpec; radius: number; clock: SceneClock }) {
  const orbit = spec.radius * radius;
  const trail = useMemo(() => trajectory(orbit), [orbit]);
  useEffect(
    () => () => {
      trail.geometry.dispose();
      trail.material.dispose();
    },
    [trail],
  );
  const carrier = useRef<THREE.Group>(null);
  useFrame(() => {
    carrier.current!.rotation.y = orbitAngle(spec, clock.seconds());
  });

  return (
    <group rotation-x={spec.inclination}>
      <group ref={carrier}>
        <primitive object={trail} />
        <group position={[0, 0, orbit]}>
          <Spacecraft />
        </group>
      </group>
    </group>
  );
}
