import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import * as THREE from "three";
import type { LngLat } from "../util/area";
import { sampleRamp, type Rgb } from "../util/colorRamp";

/** Embers for the intro only; the data views keep the colour-blind safe ramps. */
const EMBER: Rgb[] = [
  [120, 30, 20],
  [220, 80, 20],
  [249, 160, 63],
  [255, 236, 170],
];

const RADIUS = 2;

export function toSphere([lng, lat]: LngLat, radius = RADIUS): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lng + 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/** Evenly spread dots: a quiet globe that does not compete with the fire columns. */
function GlobeDots() {
  const positions = useMemo(() => {
    const count = 5200;
    const array = new Float32Array(count * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const angle = golden * i;
      array.set([Math.cos(angle) * r * RADIUS, y * RADIUS, Math.sin(angle) * r * RADIUS], i * 3);
    }
    return array;
  }, []);
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.02} color="#7f93ab" transparent opacity={0.85} sizeAttenuation />
    </points>
  );
}

/** One glowing column per H3 cell, its height the harmonized total of the whole record. */
function FireColumns({ cells }: { cells: { center: LngLat; weight: number }[] }) {
  const columns = useMemo(
    () =>
      cells.map(({ center, weight }) => {
        const base = toSphere(center);
        const height = 0.012 + weight * 0.1;
        const position = base.clone().add(base.clone().normalize().multiplyScalar(height / 2));
        const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), base.clone().normalize());
        const [r, g, b] = sampleRamp(EMBER, weight);
        return { position, quaternion, height, color: new THREE.Color(r / 255, g / 255, b / 255) };
      }),
    [cells],
  );
  return (
    <group>
      {columns.map((column, index) => (
        <mesh key={index} position={column.position} quaternion={column.quaternion}>
          <cylinderGeometry args={[0.0065, 0.0065, column.height, 6]} />
          <meshBasicMaterial color={column.color} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

const EARTH_ROTATION = THREE.MathUtils.degToRad(-10);

/**
 * The camera starts far out and settles over the Gran Chaco. With reduced
 * motion it is placed at the final framing and nothing moves.
 */
function CameraRig({ target, still }: { target: THREE.Vector3; still: boolean }) {
  const start = useRef<number | null>(null);
  const final = useMemo(
    () => target.clone().normalize().multiplyScalar(RADIUS * 1.9),
    [target],
  );
  const far = useMemo(
    () => target.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 1.1).normalize().multiplyScalar(RADIUS * 4.6),
    [target],
  );
  useFrame(({ camera, clock, size }) => {
    if (start.current === null) start.current = clock.elapsedTime;
    const t = still ? 1 : Math.min(1, (clock.elapsedTime - start.current) / 7);
    const eased = 1 - (1 - t) ** 3;
    camera.position.lerpVectors(far, final, eased);
    camera.position.y += (1 - eased) * 2;
    camera.lookAt(target.clone().multiplyScalar(0.55 + 0.45 * eased));
    // Slide sideways so the fire lands right of the title instead of under it.
    camera.translateX(-0.45 * eased * (size.width > size.height ? 1 : 0));
    camera.translateY(size.width > size.height ? 0 : -0.35 * eased);
  });
  return null;
}

export default function IntroScene({ cells, still }: { cells: { center: LngLat; weight: number }[]; still: boolean }) {
  const target = useMemo(() => {
    const centre = cells.reduce<LngLat>(
      (sum, cell) => [sum[0] + cell.center[0] / cells.length, sum[1] + cell.center[1] / cells.length],
      [0, 0],
    );
    return toSphere(cells.length ? centre : [-61, -24]);
  }, [cells]);

  return (
    <Canvas
      className="intro__canvas"
      camera={{ fov: 40, near: 0.1, far: 100, position: [0, 0, 8] }}
      dpr={[1, 2]}
      frameloop={still ? "demand" : "always"}
      gl={{ antialias: true, alpha: false }}
      aria-hidden="true"
    >
      <color attach="background" args={["#05070a"]} />
      <group rotation={[0, EARTH_ROTATION, 0]}>
        <mesh>
          <sphereGeometry args={[RADIUS * 0.995, 64, 64]} />
          <meshBasicMaterial color="#0b1118" />
        </mesh>
        <GlobeDots />
        <mesh scale={1.06}>
          <sphereGeometry args={[RADIUS, 64, 64]} />
          <meshBasicMaterial color="#2a5d8f" transparent opacity={0.12} side={THREE.BackSide} />
        </mesh>
        <FireColumns cells={cells} />
      </group>
      <Stars radius={40} depth={30} count={2500} factor={2.5} fade speed={still ? 0 : 0.6} />
      <CameraRig target={target.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), EARTH_ROTATION)} still={still} />
    </Canvas>
  );
}
