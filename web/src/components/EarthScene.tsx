import { Suspense, useCallback, useMemo, useRef } from "react";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import * as THREE from "three";
import type { LngLat } from "../util/area";

const RADIUS = 2;
/** Camera distance from the centre, in Earth radii: low enough for the fires to read up close. */
const CAMERA_HEIGHT = 1.45;
/** Tilts the southern hemisphere up until the Chaco's latitude (about 23° S) faces forward. */
const CHACO_TILT = -0.4;
/**
 * The planet turns one way and never stops. The camera rides with the Chaco,
 * as a geostationary satellite would, so the fires stay face to face while the
 * stars and the day-night line drift past: still to a glance, alive to a look.
 */
const SPIN = 0.012;
/** A polar orbit like the VIIRS satellites', sped up to a pass every 48 s, each one over the Chaco. */
const ORBIT_RADIUS = RADIUS * 1.12;
const ORBIT_PERIOD = 48;
const ORBIT_SKEW = THREE.MathUtils.degToRad(8);
const TRAIL = 0.9;
/** Half the VIIRS swath, about 1 500 km, as an angle seen from the centre of the Earth. */
const SWATH = 0.24;
/**
 * The opening, in seconds. The camera travels in from far out and lands; a
 * short stillness; then the satellite crosses the Chaco and its scan lights
 * the fires: the cause and its effect on the same frame.
 */
const ARRIVAL = 2.6;
const FIRST_PASS = 3.1;
/** How long a freshly scanned ember takes to settle back to its glow. */
const COOLING = 1.8;
/** The glow of an ember once the record has been seen. */
const SEEN = 0.38;
/** Light from the upper left and in front, so the Chaco is in daylight and the terminator grazes the right limb. */
const SUN = new THREE.Vector3(-0.55, 0.4, 1).normalize();
const TILT = new THREE.Euler(CHACO_TILT, 0, 0);
/** The Earth's axis as the camera sees it. */
const POLE = new THREE.Vector3(0, 1, 0).applyEuler(TILT);

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
    uniforms: { day: { value: day }, night: { value: night }, sun: { value: SUN.clone() } },
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
    uniforms: { sun: { value: SUN.clone() } },
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

function Earth({ material: onMaterial }: { material: (material: THREE.ShaderMaterial) => void }) {
  const [day, night] = useLoader(THREE.TextureLoader, [texturePath("earth-day.jpg"), texturePath("earth-night.jpg")]);
  const material = useMemo(() => {
    for (const texture of [day!, night!]) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 16;
    }
    const material = earthMaterial(day!, night!);
    onMaterial(material);
    return material;
  }, [day, night, onMaterial]);
  return (
    <mesh material={material}>
      <sphereGeometry args={[RADIUS, 96, 96]} />
    </mesh>
  );
}

/**
 * Embers that are dark until a satellite scans them. A pass flares each one
 * as the swath crosses it, then it cools to a steady glow: the record exists
 * once it has been seen. Drawn by a shader, so the glow has no square edge.
 */
const fireMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { scale: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float weight;
      attribute float heat;
      uniform float scale;
      varying float vWeight;
      varying float vHeat;
      varying float vFacing;
      void main() {
        vWeight = weight;
        vHeat = heat;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        // Embers on the far side of the planet are hidden behind it.
        vFacing = dot(normalize(mat3(modelViewMatrix) * position), vec3(0.0, 0.0, 1.0));
        gl_PointSize = scale * (3.0 + 9.0 * weight) * (0.7 + 0.6 * heat) / -view.z;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: /* glsl */ `
      varying float vWeight;
      varying float vHeat;
      varying float vFacing;
      void main() {
        if (vFacing < 0.05 || vHeat < 0.01) discard;
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float core = smoothstep(1.0, 0.0, d);
        vec3 ember = mix(vec3(0.9, 0.22, 0.03), vec3(1.0, 0.78, 0.4), core * core * max(vWeight, vHeat - 0.4));
        gl_FragColor = vec4(ember * core * 0.55 * vHeat, core * vHeat);
      }`,
  });

/** The satellite's place on its orbit at angle `a`; 0 is straight over the Chaco. */
interface Orbit {
  point: (a: number, target?: THREE.Vector3) => THREE.Vector3;
  /** Orbit angle at scene time `t`: north of the Chaco before the first pass, south after it. */
  angleAt: (t: number) => number;
}

function makeOrbit(chaco: THREE.Vector3): Orbit {
  const across = POLE.clone().sub(chaco.clone().multiplyScalar(POLE.dot(chaco))).normalize().applyAxisAngle(chaco, ORBIT_SKEW);
  return {
    point: (a, target = new THREE.Vector3()) =>
      target.copy(chaco).multiplyScalar(Math.cos(a)).addScaledVector(across, Math.sin(a)).multiplyScalar(ORBIT_RADIUS),
    angleAt: (t) => (-(t - FIRST_PASS) / ORBIT_PERIOD) * Math.PI * 2,
  };
}

interface Clock {
  /** Seconds since the planet first drew, frozen for reduced motion. */
  now: () => number;
}

function Fires({
  cells,
  orbit,
  clock,
  onFirstScan,
}: {
  cells: { world: THREE.Vector3; weight: number }[];
  orbit: Orbit;
  clock: Clock;
  onFirstScan: () => void;
}) {
  const material = useMemo(fireMaterial, []);
  const geometry = useRef<THREE.BufferGeometry>(null);
  const seen = useRef(false);
  const { size } = useThree();
  const { positions, weights, heat, directions } = useMemo(
    () => ({
      positions: Float32Array.from(cells.flatMap(({ world }) => world.clone().multiplyScalar(1.004).toArray())),
      weights: Float32Array.from(cells.map(({ weight }) => weight)),
      heat: new Float32Array(cells.length),
      directions: cells.map(({ world }) => world.clone().normalize()),
    }),
    [cells],
  );
  const below = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, delta) => {
    material.uniforms.scale!.value = size.height / 150;
    const t = clock.now();
    orbit.point(orbit.angleAt(t), below).normalize();
    const cool = Math.exp(-Math.min(delta, 0.1) / COOLING);
    let scanned = false;
    directions.forEach((direction, index) => {
      const floor = seen.current ? SEEN : 0;
      if (direction.angleTo(below) < SWATH) {
        heat[index] = 1;
        scanned = true;
      } else heat[index] = floor + Math.max(0, heat[index]! - floor) * cool;
    });
    if (scanned && !seen.current) {
      seen.current = true;
      onFirstScan();
    }
    if (geometry.current) geometry.current.attributes.heat!.needsUpdate = true;
  });
  return (
    <points material={material} frustumCulled={false}>
      <bufferGeometry ref={geometry}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-weight" args={[weights, 1]} />
        <bufferAttribute attach="attributes-heat" args={[heat, 1]} />
      </bufferGeometry>
    </points>
  );
}

/**
 * The satellite, its orbit and its scan: a faint beam to the ground and the
 * footprint of its swath sliding across the planet under it.
 */
function Satellite({ orbit, clock, glow }: { orbit: Orbit; clock: Clock; glow: THREE.Texture }) {
  const craft = useRef<THREE.Group>(null);
  const beam = useRef<THREE.BufferGeometry>(null);
  const footprint = useRef<THREE.Mesh>(null);
  const ring = useMemo(
    () => new THREE.BufferGeometry().setFromPoints(Array.from({ length: 257 }, (_, index) => orbit.point((index / 256) * Math.PI * 2))),
    [orbit],
  );
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
  // A plain THREE.Line: its points move every frame, so it must never be culled.
  const trailLine = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }),
    );
    line.frustumCulled = false;
    return line;
  }, [trailPositions, trailColors]);
  const beamPositions = useMemo(() => new Float32Array(6), []);
  const here = useMemo(() => new THREE.Vector3(), []);
  const ground = useMemo(() => new THREE.Vector3(), []);
  const point = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const angle = orbit.angleAt(clock.now());
    orbit.point(angle, here);
    ground.copy(here).setLength(RADIUS * 1.003);
    if (craft.current) {
      craft.current.position.copy(here);
      craft.current.lookAt(0, 0, 0);
    }
    if (footprint.current) {
      footprint.current.position.copy(ground);
      footprint.current.lookAt(ground.clone().multiplyScalar(2));
    }
    beamPositions.set([...here.toArray(), ...ground.toArray()]);
    if (beam.current) beam.current.attributes.position!.needsUpdate = true;
    const count = trailPositions.length / 3;
    for (let index = 0; index < count; index++) {
      orbit.point(angle + TRAIL * (1 - index / (count - 1)), point);
      trailPositions.set([point.x, point.y, point.z], index * 3);
    }
    trailLine.geometry.attributes.position!.needsUpdate = true;
  });

  // The footprint's radius on the ground, from the swath angle.
  const reach = RADIUS * Math.sin(SWATH);
  return (
    <group>
      <lineLoop geometry={ring}>
        <lineBasicMaterial color="#9fc4ff" transparent opacity={0.14} />
      </lineLoop>
      <primitive object={trailLine} />
      <lineSegments frustumCulled={false}>
        <bufferGeometry ref={beam}>
          <bufferAttribute attach="attributes-position" args={[beamPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color="#8fd3f5" transparent opacity={0.35} blending={THREE.AdditiveBlending} />
      </lineSegments>
      <mesh ref={footprint}>
        <circleGeometry args={[reach, 48]} />
        <meshBasicMaterial map={glow} color="#8fd3f5" transparent opacity={0.22} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <group ref={craft}>
        <mesh>
          <boxGeometry args={[0.035, 0.035, 0.06]} />
          <meshBasicMaterial color="#d9d4c7" />
        </mesh>
        <mesh position={[0.07, 0, 0]}>
          <boxGeometry args={[0.09, 0.04, 0.003]} />
          <meshBasicMaterial color="#3a5f9e" />
        </mesh>
        <mesh position={[-0.07, 0, 0]}>
          <boxGeometry args={[0.09, 0.04, 0.003]} />
          <meshBasicMaterial color="#3a5f9e" />
        </mesh>
        <sprite scale={0.2}>
          <spriteMaterial map={glow} color="#fcffa4" transparent opacity={0.5} depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
      </group>
    </group>
  );
}

/** A camera position `height` Earth radii from the centre, 20° south of the Chaco. */
function orbitView(height: number): THREE.Vector3 {
  const angle = THREE.MathUtils.degToRad(-20);
  return new THREE.Vector3(0, Math.sin(angle), Math.cos(angle)).multiplyScalar(RADIUS * height);
}

const power4Out = (t: number) => 1 - (1 - t) ** 4;

/**
 * Camera with intent: it opens wide, high above the planet, travels in on a
 * decelerating curve and lands low over the Chaco with the horizon and space
 * behind it. Scrolling away pushes it on towards the ground, into the map
 * below. It never wobbles in place.
 */
function CameraRig({ clock }: { clock: Clock }) {
  const wide = useMemo(() => orbitView(CAMERA_HEIGHT * 2.3).applyAxisAngle(new THREE.Vector3(1, 0, 0), -0.35), []);
  const final = useMemo(() => orbitView(CAMERA_HEIGHT), []);
  const target = useMemo(() => new THREE.Vector3(0, RADIUS * 0.3, RADIUS * 0.8), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    const eased = power4Out(Math.min(1, clock.now() / ARRIVAL));
    const pushed = Math.min(1, Math.max(0, window.scrollY / Math.max(1, window.innerHeight)));
    camera.position.lerpVectors(wide, final, eased).multiplyScalar(1 - 0.16 * power4Out(pushed));
    look.copy(target).multiplyScalar(0.4 + 0.6 * eased);
    camera.lookAt(look);
    // Slide sideways so the fire lands right of the title instead of under it.
    if (size.width > size.height) camera.translateX(-0.4 * eased);
  });
  return null;
}

function Planet({ cells, still, onFirstScan }: { cells: { center: LngLat; weight: number }[]; still: boolean; onFirstScan: () => void }) {
  const sky = useRef<THREE.Group>(null);
  const glow = useMemo(glowTexture, []);
  const atmosphere = useMemo(atmosphereMaterial, []);
  const earth = useRef<THREE.ShaderMaterial | null>(null);
  const keepEarth = useCallback((material: THREE.ShaderMaterial) => (earth.current = material), []);

  // One clock for the whole opening, started on the first frame the planet
  // draws (after its textures), and frozen past the landing for reduced motion.
  const started = useRef<number | null>(null);
  const clock = useMemo<Clock>(
    () => ({
      now: () => (still ? FIRST_PASS : started.current === null ? 0 : performance.now() / 1000 - started.current),
    }),
    [still],
  );

  // Turn the Chaco to face the camera.
  const start = useMemo(() => {
    const centre = cells.length
      ? cells.reduce<LngLat>((sum, cell) => [sum[0] + cell.center[0] / cells.length, sum[1] + cell.center[1] / cells.length], [0, 0])
      : ([-61, -24] as LngLat);
    const point = toSphere(centre);
    return { yaw: -Math.atan2(point.x, point.z), centre };
  }, [cells]);
  const frame = useMemo(() => new THREE.Euler(CHACO_TILT, 0, 0), []);
  const toWorld = useCallback(
    (point: THREE.Vector3) => point.applyAxisAngle(new THREE.Vector3(0, 1, 0), start.yaw).applyEuler(frame),
    [start, frame],
  );
  const chaco = useMemo(() => toWorld(toSphere(start.centre)).normalize(), [toWorld, start]);
  const orbit = useMemo(() => makeOrbit(chaco), [chaco]);
  const embers = useMemo(
    () => cells.filter((cell) => cell.weight > 0.08).map(({ center, weight }) => ({ world: toWorld(toSphere(center)), weight })),
    [cells, toWorld],
  );

  const sun = useMemo(() => new THREE.Vector3(), []);
  const turn = useMemo(() => new THREE.Quaternion(), []);
  useFrame(() => {
    if (started.current === null) started.current = performance.now() / 1000;
    // The sky and the sun turn about the Earth's axis the other way: seen from
    // a camera that rides with the Chaco, that is the planet turning.
    turn.setFromAxisAngle(POLE, still ? 0 : -SPIN * clock.now());
    sky.current?.quaternion.copy(turn);
    sun.copy(SUN).applyQuaternion(turn);
    earth.current?.uniforms.sun!.value.copy(sun);
    atmosphere.uniforms.sun!.value.copy(sun);
  });

  return (
    <>
      <group ref={sky}>
        <Stars radius={60} depth={40} count={2600} factor={2.2} fade speed={0} />
      </group>
      <group rotation={[CHACO_TILT, 0, 0]}>
        <group rotation={[0, start.yaw, 0]}>
          <Earth material={keepEarth} />
        </group>
        <mesh scale={1.025} material={atmosphere}>
          <sphereGeometry args={[RADIUS, 96, 96]} />
        </mesh>
      </group>
      <Fires cells={embers} orbit={orbit} clock={clock} onFirstScan={onFirstScan} />
      <Satellite orbit={orbit} clock={clock} glow={glow} />
      <CameraRig clock={clock} />
    </>
  );
}

interface SceneProps {
  cells: { center: LngLat; weight: number }[];
  still: boolean;
  /** Stops rendering while the scene is scrolled out of view. */
  paused?: boolean;
  /** The first time the satellite's scan lights the fires: the cue for the title. */
  onFirstScan?: () => void;
}

const NOTHING = () => {};

export default function EarthScene({ cells, still, paused = false, onFirstScan = NOTHING }: SceneProps) {
  return (
    <Canvas
      camera={{ fov: 40, near: 0.05, far: 200, position: [0, 0, RADIUS * 3] }}
      dpr={[1, 2]}
      frameloop={still ? "demand" : paused ? "never" : "always"}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      aria-hidden="true"
    >
      <color attach="background" args={["#000000"]} />
      <Suspense fallback={null}>
        <Planet cells={cells} still={still} onFirstScan={onFirstScan} />
      </Suspense>
    </Canvas>
  );
}
