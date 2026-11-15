import { useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  FIRE_FRONTS,
  SHELL,
  VIEW_CENTER,
  faceLongitude,
  firePoints,
  frontHeat,
  geoToCartesian,
  poseAt,
  progressAt,
  seeded,
  type SceneClock,
} from "./motion";
import { earthMaps, textureTier } from "./textures";

/**
 * Smooth enough on the water for a sun glint the size of a sea that just
 * reaches the bloom threshold, matte on land. Smoother water turns the glint
 * into a second sun that outshines the fires.
 */
const WATER_ROUGHNESS = 0.34;
const LAND_ROUGHNESS = 0.92;

/**
 * Day and night on one sphere: Blue Marble lit by the sun, with the relief and
 * the ocean mask driving the bump and the glint, and Black Marble's city
 * lights where the sun has set. The sunlit limb gets the blue of the air
 * seen edge-on.
 */
function surfaceMaterial(
  maps: Record<"day" | "night" | "relief" | "water", THREE.Texture>,
  sun: THREE.Vector3,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: maps.day,
    bumpMap: maps.relief,
    bumpScale: 2.4,
    roughnessMap: maps.water,
    metalness: 0,
    emissive: new THREE.Color(1, 1, 1),
    emissiveMap: maps.night,
    emissiveIntensity: 2.4,
  });
  const uniforms = {
    uSunDirection: { value: sun },
    uWaterRoughness: { value: WATER_ROUGHNESS },
    uLandRoughness: { value: LAND_ROUGHNESS },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform vec3 uSunDirection;
        uniform float uWaterRoughness;
        uniform float uLandRoughness;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        /* glsl */ `float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          // The map is the ocean mask: water smooth enough to mirror the sun, land matte.
          roughnessFactor = mix( uLandRoughness, uWaterRoughness, texture2D( roughnessMap, vRoughnessMapUv ).g );
        #endif`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        vec3 sunView = normalize( ( viewMatrix * vec4( uSunDirection, 0.0 ) ).xyz );
        float daylight = dot( nonPerturbedNormal, sunView );
        // City lights only once the sun has set, fading in across the twilight band.
        totalEmissiveRadiance *= 1.0 - smoothstep( -0.15, 0.15, daylight );`,
      )
      .replace(
        "#include <opaque_fragment>",
        /* glsl */ `{
          // Rayleigh haze: the sunlit air thickens towards the limb.
          float facing = clamp( dot( nonPerturbedNormal, normalize( vViewPosition ) ), 0.0, 1.0 );
          float haze = pow( 1.0 - facing, 3.0 ) * smoothstep( -0.2, 0.35, daylight );
          outgoingLight += vec3( 0.11, 0.36, 0.95 ) * haze * 0.85;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "aeros-earth-surface";
  return material;
}

/**
 * The deck of clouds, lit by the same sun, so it is white by day and gone at
 * night. The map's thin haze is cut so the ground shows between the weather
 * systems.
 */
function cloudMaterial(clouds: THREE.Texture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    alphaMap: clouds,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    blending: THREE.NormalBlending,
    roughness: 1,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <alphamap_fragment>",
      /* glsl */ `#ifdef USE_ALPHAMAP
        diffuseColor.a *= smoothstep( 0.2, 0.85, texture2D( alphaMap, vAlphaMapUv ).g );
      #endif`,
    );
  };
  material.customProgramCacheKey = () => "aeros-earth-clouds";
  return material;
}

/**
 * The limb glow. Each pixel of the shell outside the planet is a line of
 * sight grazing the air; the air thins exponentially with height, so the glow
 * is brightest right above the ground and fades out before the shell's edge.
 * Only the sunlit side glows.
 */
const atmosphereMaterial = (sun: THREE.Vector3, radius: number) =>
  new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection: { value: sun },
      uRadius: { value: radius },
      uScaleHeight: { value: radius * 0.0055 },
      uIntensity: { value: 1.6 },
    },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4( position, 1.0 );
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDirection;
      uniform float uRadius;
      uniform float uScaleHeight;
      uniform float uIntensity;
      varying vec3 vWorld;
      void main() {
        vec3 ray = normalize( vWorld - cameraPosition );
        // Where the line of sight passes closest to the planet's centre.
        vec3 closest = cameraPosition - ray * dot( cameraPosition, ray );
        float density = exp( - max( length( closest ) - uRadius, 0.0 ) / uScaleHeight );
        float lit = smoothstep( -0.3, 0.45, dot( normalize( closest ), uSunDirection ) );
        // The deep blue of the thin air outside, paling where it is thickest.
        vec3 color = mix( vec3( 0.05, 0.45, 0.95 ), vec3( 0.7, 0.88, 1.0 ), density * density );
        gl_FragColor = vec4( color * density * lit * uIntensity, 1.0 );
      }`,
  });

/**
 * The fire fronts as glowing points: an incandescent core, an orange body
 * and a deep red edge, breathing slowly with a faster flicker on top. Each
 * front has its own heat, so it flares while a satellite's swath sweeps
 * over it. Points on the far side are hidden by the planet's depth.
 */
const fireMaterial = () =>
  new THREE.ShaderMaterial({
    defines: { FRONTS: FIRE_FRONTS.length },
    uniforms: {
      uTime: { value: 0 },
      uHeat: { value: FIRE_FRONTS.map(() => 0) },
      uScale: { value: 1 },
      uCore: { value: new THREE.Color("#fff4cc") },
      uBody: { value: new THREE.Color("#ff4500") },
      uEdge: { value: new THREE.Color("#8b0000") },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float weight;
      attribute float seed;
      attribute float front;
      uniform float uTime;
      uniform float uHeat[ FRONTS ];
      uniform float uScale;
      varying float vWeight;
      varying float vGlow;
      void main() {
        float breathe = 0.84 + 0.16 * sin( uTime * 2.1 + seed * 6.2832 );
        float flicker = 0.9 + 0.1 * fract( sin( ( floor( uTime * 14.0 ) + seed * 113.0 ) * 12.9898 ) * 43758.5453 );
        vec4 view = modelViewMatrix * vec4( position, 1.0 );
        // Towards the limb the cells crowd into a thin band whose summed glow
        // would bloom into a false sunrise; they fade as they turn away.
        float facing = dot( normalize( mat3( modelViewMatrix ) * position ), normalize( - view.xyz ) );
        vGlow = uHeat[ int( front ) ] * breathe * flicker * smoothstep( 0.05, 0.4, facing );
        vWeight = weight;
        gl_PointSize = uScale * ( 1.4 + 4.2 * weight * weight ) * ( 0.75 + 0.25 * min( vGlow, 1.8 ) ) / - view.z;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uCore;
      uniform vec3 uBody;
      uniform vec3 uEdge;
      varying float vWeight;
      varying float vGlow;
      void main() {
        float d = length( gl_PointCoord - 0.5 ) * 2.0;
        if ( d > 1.0 ) discard;
        // smoothstep needs edge0 < edge1, so each falloff is 1 - smoothstep.
        // Bodies grow with the point's heat and only the hottest points, at
        // the core of a front, get a core bright enough to bloom.
        float share = vWeight * vWeight;
        vec3 color = uEdge * ( 1.0 - smoothstep( 0.35, 1.0, d ) ) * 0.25
          + uBody * ( 1.0 - smoothstep( 0.1, 0.8, d ) ) * ( 0.25 + 0.9 * share )
          + uCore * ( 1.0 - smoothstep( 0.0, 0.32, d ) ) * ( 0.2 + 4.5 * share * share );
        gl_FragColor = vec4( color * vGlow, 1.0 );
      }`,
  });

function Fires({ radius, clock }: { radius: number; clock: SceneClock }) {
  const height = useThree((state) => state.size.height);
  const material = useMemo(fireMaterial, []);
  const geometry = useMemo(() => {
    const points = firePoints();
    const positions = new Float32Array(points.length * 3);
    const weights = new Float32Array(points.length);
    const seeds = new Float32Array(points.length);
    const fronts = new Float32Array(points.length);
    points.forEach(({ lon, lat, weight, front }, index) => {
      positions.set(geoToCartesian(lon, lat, radius), index * 3);
      weights[index] = weight;
      seeds[index] = seeded(index);
      fronts[index] = front;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("weight", new THREE.BufferAttribute(weights, 1));
    geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute("front", new THREE.BufferAttribute(fronts, 1));
    return geometry;
  }, [radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    const seconds = clock.seconds();
    material.uniforms.uTime!.value = seconds;
    const heat = material.uniforms.uHeat!.value as number[];
    FIRE_FRONTS.forEach(({ center }, front) => (heat[front] = frontHeat(center, seconds)));
    material.uniforms.uScale!.value = height / 140;
  });
  return <points geometry={geometry} material={material} renderOrder={2} frustumCulled={false} />;
}

/**
 * The planet as four concentric shells, each a little above the last so no
 * two ever fight for the same depth: the ground, the fires, the clouds and the
 * air. The axis leans 23.44° and South America faces the camera at the first
 * pass; the ground and the clouds turn about that axis at their own speeds.
 */
export function Globe({ radius, sun, clock }: { radius: number; sun: THREE.Vector3; clock: SceneClock }) {
  const gl = useThree((state) => state.gl);
  const maps = useMemo(() => earthMaps(textureTier(window.innerWidth, gl.capabilities.maxTextureSize)), [gl]);
  const [day, night, relief, water, clouds] = useLoader(THREE.TextureLoader, [
    maps.day,
    maps.night,
    maps.relief,
    maps.water,
    maps.clouds,
  ]) as THREE.Texture[];

  const materials = useMemo(() => {
    const anisotropy = gl.capabilities.getMaxAnisotropy();
    for (const texture of [day!, night!, relief!, water!, clouds!]) {
      // The seam at the antimeridian samples across the edge instead of clamping.
      texture.wrapS = THREE.RepeatWrapping;
      texture.anisotropy = anisotropy;
    }
    day!.colorSpace = night!.colorSpace = THREE.SRGBColorSpace;
    return {
      surface: surfaceMaterial({ day: day!, night: night!, relief: relief!, water: water! }, sun),
      clouds: cloudMaterial(clouds!),
      atmosphere: atmosphereMaterial(sun, radius),
    };
  }, [gl, day, night, relief, water, clouds, sun, radius]);
  useEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);

  const ground = useRef<THREE.Group>(null);
  const deck = useRef<THREE.Group>(null);
  const facing = useMemo(() => faceLongitude(VIEW_CENTER[0]), []);
  useFrame(() => {
    const pose = poseAt(progressAt(clock.seconds()));
    ground.current!.rotation.y = facing + pose.earth;
    deck.current!.rotation.y = facing + pose.clouds;
  });

  return (
    <>
        <group ref={ground}>
          <mesh material={materials.surface}>
            <sphereGeometry args={[radius * SHELL.surface, 128, 128]} />
          </mesh>
          <Fires radius={radius * SHELL.fires} clock={clock} />
        </group>
        <group ref={deck}>
          <mesh material={materials.clouds} renderOrder={1}>
            <sphereGeometry args={[radius * SHELL.clouds, 128, 128]} />
          </mesh>
        </group>
        <mesh material={materials.atmosphere} renderOrder={3}>
          <sphereGeometry args={[radius * SHELL.atmosphere, 128, 64]} />
        </mesh>
    </>
  );
}
