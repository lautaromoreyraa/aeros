import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, advance, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { Globe } from "./Globe";
import { Satellite } from "./Satellite";
import { announceBuild, onSeek } from "./hyperframes";
import {
  AXIAL_TILT,
  FIRST_PASS,
  SATELLITES,
  STILL_AT,
  SUN_DIRECTION,
  VIEW_CENTER,
  cameraPathAt,
  framing,
  type SceneClock,
} from "./motion";

/** The planet's radius in scene units. */
const RADIUS = 2;
/** A long lens for a planet: little distortion at the edge of the disc. */
const FOV = 40;
const SUN = new THREE.Vector3(...SUN_DIRECTION);
/**
 * Bloom only what outshines sunlit cloud: sun glints on the sea and on the
 * arrays, the fires, the limb and the trail's head. A lower threshold lets
 * the whole day side bloom and turns the planet milky.
 */
const BLOOM = { strength: 0.55, radius: 0.2, threshold: 1.35 };

/**
 * The scene's time, read once per frame so every part of a frame agrees:
 * the wall clock in the browser, a fixed moment for reduced motion, or the
 * time HyperFrames seeks to.
 */
class Timeline implements SceneClock {
  private origin: number | null = null;
  private now = 0;
  seeking = false;

  constructor(private readonly still: boolean) {}

  tick() {
    if (this.seeking) return;
    if (this.still) {
      this.now = STILL_AT;
      return;
    }
    const wall = performance.now() / 1000;
    this.origin ??= wall;
    this.now = wall - this.origin;
  }

  seek(seconds: number) {
    this.seeking = true;
    this.now = seconds;
  }

  seconds() {
    return this.now;
  }
}

/** Bloom on the renderer's own HDR buffer, before ACES tone mapping. */
function Bloom() {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const size = gl.getSize(new THREE.Vector2());
    const pass = new UnrealBloomPass(size, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    gl.setEffects([pass]);
    return () => {
      gl.setEffects(null);
      pass.dispose();
    };
  }, [gl]);
  return null;
}

/**
 * Starts the clock on the first frame drawn after the textures, cues the
 * title at the first pass, and hands the clock to HyperFrames when it seeks.
 */
function Director({ timeline, onFirstScan }: { timeline: Timeline; onFirstScan: () => void }) {
  const { gl, scene, camera, setFrameloop } = useThree();
  const cued = useRef(false);
  const cue = useRef(onFirstScan);
  cue.current = onFirstScan;

  useFrame(() => {
    timeline.tick();
    if (!cued.current && timeline.seconds() >= FIRST_PASS) {
      cued.current = true;
      cue.current();
    }
  }, -1);

  useEffect(() => {
    announceBuild("aeros-earth", gl.compileAsync(scene, camera));
    return onSeek((seconds) => {
      timeline.seek(seconds);
      setFrameloop("never");
      advance(performance.now() / 1000);
    });
  }, [gl, scene, camera, setFrameloop, timeline]);
  return null;
}

/**
 * The camera opens high and wide, decelerates into a close crop where the
 * planet overflows the frame, and lands there for good: scrolling does not
 * move it, since the hero is already leaving the screen by then.
 */
function CameraRig({ timeline }: { timeline: Timeline }) {
  useFrame(({ camera, size }) => {
    const fit = framing(size.width / size.height, FOV, RADIUS);
    const path = cameraPathAt(timeline.seconds());
    camera.position.setFromSphericalCoords(fit.distance * path.distance, Math.PI / 2 - path.elevation, path.azimuth);
    camera.lookAt(0, 0, 0);
    // A lens shift, not a turn: the disc moves aside and stays round.
    (camera as THREE.PerspectiveCamera).setViewOffset(
      size.width,
      size.height,
      -fit.shiftX * size.width,
      fit.shiftY * size.height,
      size.width,
      size.height,
    );
  });
  return null;
}

interface SceneProps {
  still: boolean;
  /** Stops rendering while the scene is scrolled out of view. */
  paused?: boolean;
  /** The first time the satellite's pass lights the fires: the cue for the title. */
  onFirstScan?: () => void;
}

const NOTHING = () => {};

export default function EarthScene({ still, paused = false, onFirstScan = NOTHING }: SceneProps) {
  const timeline = useMemo(() => new Timeline(still), [still]);
  return (
    <Canvas
      camera={{ fov: FOV, near: 0.05, far: 200, position: [0, 0, RADIUS * 6] }}
      dpr={[1, 1.75]}
      frameloop={still ? "demand" : paused ? "never" : "always"}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance", outputBufferType: THREE.HalfFloatType }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.15;
      }}
      aria-hidden="true"
    >
      <color attach="background" args={["#000000"]} />
      <ambientLight intensity={0.03} />
      <directionalLight position={SUN.clone().multiplyScalar(20)} intensity={4.2} />
      <Bloom />
      <Suspense fallback={null}>
        {/* The planet's frame: its axis leans 23.44° and the view latitude faces the camera; it does not turn. */}
        <group rotation-z={AXIAL_TILT}>
          <group rotation-x={THREE.MathUtils.degToRad(VIEW_CENTER[1])}>
            <Globe radius={RADIUS} sun={SUN} clock={timeline} />
          </group>
        </group>
        {/* The satellites fly in the scene's frame, so their passes cross in front of the camera. */}
        {SATELLITES.map((spec) => (
          <Satellite key={spec.name} spec={spec} radius={RADIUS} clock={timeline} />
        ))}
        <CameraRig timeline={timeline} />
        <Director timeline={timeline} onFirstScan={onFirstScan} />
      </Suspense>
    </Canvas>
  );
}
