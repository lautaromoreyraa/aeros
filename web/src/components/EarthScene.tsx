import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import * as THREE from "three";
import type { LngLat } from "../util/area";

const RADIUS = 2;
/**
 * The planet sways about the Chaco instead of turning away from it: the fires
 * stay face to face with the viewer while the globe never stops moving, too
 * slowly to notice at a glance.
 */
const SWAY = THREE.MathUtils.degToRad(16);
const SWAY_PERIOD = 140;
const CAMERA_DISTANCE = 7.7;
/** Tilts the southern hemisphere up until the Chaco's latitude (about 23° S) faces forward. */
const CHACO_TILT = -0.4;
/** A polar, sun-synchronous orbit like the VIIRS satellites', sped up to a pass every 48 s. */
const ORBIT_RADIUS = RADIUS * 1.22;
const ORBIT_PERIOD = 48;
const ORBIT_INCLINATION = THREE.MathUtils.degToRad(98.7);
const TRAIL = 0.9;
/** Light from the upper left and in front, so the Chaco is in daylight and the terminator grazes the right limb. */
const SUN = new THREE.Vector3(-0.55, 0.4, 1).normalize();

/** [lng, lat] on the sphere, matching three's equirectangular texture mapping. */
export function toSphere([lng, lat]: LngLat, radius = RADIUS): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lng + 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

const texturePath = (name: string) => `${import.meta.env.BASE_URL}textures/${name}`;

/** Blue Marble by day, Black Marble at night, blended across a soft terminator. */
const earthMaterial = (day: THREE.Texture, night: THREE.Texture) =>
  new THREE.ShaderMaterial({
    uniforms: { day: { value: day }, night: { value: night }, sun: { value: SUN } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D day;
      uniform sampler2D night;
      uniform vec3 sun;
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        float light = dot(normalize(vNormal), sun);
        float mixDay = smoothstep(-0.12, 0.22, light);
        vec3 dayColor = texture2D(day, vUv).rgb * (0.55 + 0.85 * max(light, 0.0));
        vec3 nightColor = texture2D(night, vUv).rgb * 1.8;
        gl_FragColor = vec4(mix(nightColor, dayColor, mixDay), 1.0);
        // The textures are decoded to linear on read; without this the disc renders far too dark.
        #include <colorspace_fragment>
      }`,
  });

/** A thin blue rim brightest towards the light, as the atmosphere looks from orbit. */
const atmosphereMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { sun: { value: SUN } },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(mat3(modelMatrix) * normal);
        vView = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sun;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float rim = pow(1.0 - abs(dot(vNormal, vView)), 3.0);
        float lit = 0.35 + 0.65 * smoothstep(-0.4, 0.6, dot(vNormal, sun));
        gl_FragColor = vec4(vec3(0.35, 0.62, 1.0) * rim * lit * 1.6, rim * lit);
      }`,
  });

/** A round, soft dot drawn once and reused by every glowing point. */
function glowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.8)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function Earth() {
  const [day, night] = useLoader(THREE.TextureLoader, [texturePath("earth-day.jpg"), texturePath("earth-night.jpg")]);
  const material = useMemo(() => {
    for (const texture of [day!, night!]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
    }
    return earthMaterial(day!, night!);
  }, [day, night]);
  return (
    <mesh material={material}>
      <sphereGeometry args={[RADIUS, 96, 96]} />
    </mesh>
  );
}

/** Soft round embers; drawn by a shader so the glow never shows a square edge. */
const fireMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { pulse: { value: 1 }, scale: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float weight;
      uniform float scale;
      varying float vWeight;
      varying float vFacing;
      void main() {
        vWeight = weight;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        // Embers on the far side of the planet are hidden behind it.
        vFacing = dot(normalize(mat3(modelViewMatrix) * position), vec3(0.0, 0.0, 1.0));
        gl_PointSize = scale * (3.0 + 9.0 * weight) / -view.z;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: /* glsl */ `
      uniform float pulse;
      varying float vWeight;
      varying float vFacing;
      void main() {
        if (vFacing < 0.05) discard;
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float core = smoothstep(1.0, 0.0, d);
        vec3 ember = mix(vec3(0.9, 0.22, 0.03), vec3(1.0, 0.72, 0.3), core * core * vWeight);
        gl_FragColor = vec4(ember * core * (0.35 + 0.25 * pulse), core);
      }`,
  });

/** The Chaco's cells as embers, larger where the record burned more; they breathe slowly. */
function Fires({ cells, still }: { cells: { center: LngLat; weight: number }[]; still: boolean }) {
  const material = useMemo(fireMaterial, []);
  const { size } = useThree();
  const { positions, weights } = useMemo(() => {
    const burning = cells.filter((cell) => cell.weight > 0.08);
    const positions = new Float32Array(burning.length * 3);
    const weights = new Float32Array(burning.length);
    burning.forEach(({ center, weight }, index) => {
      positions.set(toSphere(center, RADIUS * 1.004).toArray(), index * 3);
      weights[index] = weight;
    });
    return { positions, weights };
  }, [cells]);
  useFrame(({ clock }) => {
    material.uniforms.scale!.value = size.height / 90;
    if (!still) material.uniforms.pulse!.value = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 1.3);
  });
  return (
    <points material={material}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-weight" args={[weights, 1]} />
      </bufferGeometry>
    </points>
  );
}

/** Position on the orbit at angle `a`, in the orbit's own (non-spinning) frame. */
const orbitPoint = (a: number, target = new THREE.Vector3()) =>
  target.set(Math.cos(a) * ORBIT_RADIUS, 0, Math.sin(a) * ORBIT_RADIUS);

/**
 * A satellite on a polar orbit and the ring it follows. The orbit does not
 * turn with the planet, so each pass crosses a slightly different strip of
 * ground, as a real sun-synchronous orbit does.
 */
function Satellite({ still, glow }: { still: boolean; glow: THREE.Texture }) {
  const craft = useRef<THREE.Group>(null);
  const trail = useRef<THREE.BufferGeometry>(null);
  const ring = useMemo(() => {
    const points = Array.from({ length: 257 }, (_, index) => orbitPoint((index / 256) * Math.PI * 2));
    return new THREE.BufferGeometry().setFromPoints(points);
  }, []);
  const trailColors = useMemo(() => {
    const count = 48;
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      const fade = (index / (count - 1)) ** 1.6;
      colors.set([0.99 * fade, 1 * fade, 0.64 * fade], index * 3);
    }
    return colors;
  }, []);
  const trailPositions = useMemo(() => new Float32Array(trailColors.length), [trailColors]);
  // Starts just before crossing the camera side, so the first pass comes soon.
  const phase = -1.1;

  useFrame(({ clock }) => {
    const angle = phase + (still ? 0 : (clock.elapsedTime / ORBIT_PERIOD) * Math.PI * 2);
    const here = orbitPoint(angle);
    craft.current?.position.copy(here);
    // Panels across the direction of flight.
    craft.current?.rotation.set(0, -angle, 0);
    const geometry = trail.current;
    if (!geometry) return;
    const count = trailPositions.length / 3;
    const point = new THREE.Vector3();
    for (let index = 0; index < count; index++) {
      orbitPoint(angle - TRAIL * (1 - index / (count - 1)), point);
      trailPositions.set([point.x, point.y, point.z], index * 3);
    }
    geometry.attributes.position!.needsUpdate = true;
  });

  return (
    <group rotation={[ORBIT_INCLINATION, 0, THREE.MathUtils.degToRad(-24)]}>
      <lineLoop geometry={ring}>
        <lineBasicMaterial color="#9fc4ff" transparent opacity={0.16} />
      </lineLoop>
      <line>
        <bufferGeometry ref={trail}>
          <bufferAttribute attach="attributes-position" args={[trailPositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[trailColors, 3]} />
        </bufferGeometry>
        <lineBasicMaterial vertexColors transparent opacity={0.9} blending={THREE.AdditiveBlending} />
      </line>
      <group ref={craft}>
        <mesh>
          <boxGeometry args={[0.035, 0.035, 0.06]} />
          <meshBasicMaterial color="#d9d4c7" />
        </mesh>
        <mesh position={[0.07, 0, 0]}>
          <boxGeometry args={[0.09, 0.003, 0.04]} />
          <meshBasicMaterial color="#3a5f9e" />
        </mesh>
        <mesh position={[-0.07, 0, 0]}>
          <boxGeometry args={[0.09, 0.003, 0.04]} />
          <meshBasicMaterial color="#3a5f9e" />
        </mesh>
        <sprite scale={0.22}>
          <spriteMaterial map={glow} color="#fcffa4" transparent opacity={0.55} depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
      </group>
    </group>
  );
}

/**
 * The whole planet, small enough to be seen almost entire, set beside the
 * title on wide screens and above it on narrow ones. It eases in once and
 * then only turns, too slowly to notice at a glance.
 */
function Planet({ cells, still }: { cells: { center: LngLat; weight: number }[]; still: boolean }) {
  const sway = useRef<THREE.Group>(null);
  const frame = useRef<THREE.Group>(null);
  const { size } = useThree();
  const glow = useMemo(glowTexture, []);
  const atmosphere = useMemo(atmosphereMaterial, []);
  const wide = size.width > size.height;
  const offset: [number, number] = wide ? [2.15, 0.1] : [0, 1.1];
  // The globe sits off the camera's axis, so the side facing the viewer is
  // turned towards the camera by that angle; the Chaco is centred on it.
  const yaw = -Math.atan2(offset[0], CAMERA_DISTANCE);
  const pitch = CHACO_TILT + Math.atan2(offset[1], CAMERA_DISTANCE);

  // Turn the Chaco to face the camera.
  const start = useMemo(() => {
    const centre = cells.length
      ? cells.reduce<LngLat>((sum, cell) => [sum[0] + cell.center[0] / cells.length, sum[1] + cell.center[1] / cells.length], [0, 0])
      : ([-61, -24] as LngLat);
    const point = toSphere(centre);
    return -Math.atan2(point.x, point.z);
  }, [cells]);

  useFrame(({ clock }) => {
    if (sway.current) sway.current.rotation.y = yaw + (still ? 0 : SWAY * Math.sin((clock.elapsedTime / SWAY_PERIOD) * Math.PI * 2));
    if (frame.current) {
      const t = still ? 1 : Math.min(1, clock.elapsedTime / 3.2);
      const eased = 1 - (1 - t) ** 3;
      frame.current.scale.setScalar(0.9 + 0.1 * eased);
    }
  });

  return (
    <group ref={frame} position={[offset[0], offset[1], 0]}>
      {/* Tilted so the southern hemisphere, where the Chaco lies, faces the viewer. */}
      <group rotation={[pitch, 0, 0]}>
        <group ref={sway}>
          <group rotation={[0, start, 0]}>
            <Earth />
            <Fires cells={cells} still={still} />
          </group>
        </group>
        <mesh scale={1.035} material={atmosphere}>
          <sphereGeometry args={[RADIUS, 64, 64]} />
        </mesh>
        <Satellite still={still} glow={glow} />
      </group>
    </group>
  );
}

interface SceneProps {
  cells: { center: LngLat; weight: number }[];
  still: boolean;
  /** Stops rendering while the scene is scrolled out of view. */
  paused?: boolean;
}

export default function EarthScene({ cells, still, paused = false }: SceneProps) {
  return (
    <Canvas
      camera={{ fov: 34, near: 0.1, far: 200, position: [0, 0, CAMERA_DISTANCE] }}
      dpr={[1, 2]}
      frameloop={still ? "demand" : paused ? "never" : "always"}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      aria-hidden="true"
    >
      <color attach="background" args={["#000000"]} />
      <Stars radius={60} depth={40} count={2600} factor={2.2} fade speed={0} />
      <Suspense fallback={null}>
        <Planet cells={cells} still={still} />
      </Suspense>
    </Canvas>
  );
}
