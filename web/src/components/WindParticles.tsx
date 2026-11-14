import { useEffect, useRef } from "react";
import type { WebMercatorViewport } from "@deck.gl/core";
import { sampleWind, windColor, type WindField } from "../util/wind";

interface Props {
  field: WindField;
  hour: number;
  /** The map's current projection; read every frame so the particles follow pans and zooms. */
  viewport: () => WebMercatorViewport | null;
  /** A value that changes whenever the camera moves, so old trails are wiped instead of smeared. */
  cameraKey: string;
  reducedMotion: boolean;
}

/** Particles per 10 000 px² of map. */
const DENSITY = 4.5;
const MAX_AGE = 110;
/** Trails keep this share every frame: long, soft tails. */
const FADE = 0.955;
/** On-screen pixels a particle moves per frame for each m/s of wind. */
const PIXELS_PER_MS = 0.32;

interface Particle {
  lng: number;
  lat: number;
  age: number;
}

/**
 * Wind as moving streaks, the way weather maps draw it: particles are carried
 * across the u/v field and leave short trails coloured by speed. Positions
 * live in lon/lat, so the streaks stay on the ground while the map moves.
 */
export function WindParticles({ field, hour, viewport, cameraKey, reducedMotion }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const cleared = useRef(cameraKey);
  // The loop reads the latest camera without restarting.
  const cameraKeyRef = useRef(cameraKey);
  cameraKeyRef.current = cameraKey;

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const { west, south, east, north } = field.grid;
    const spawn = (particle: Particle) => {
      particle.lng = west + Math.random() * (east - west);
      particle.lat = south + Math.random() * (north - south);
      particle.age = Math.floor(Math.random() * MAX_AGE);
    };

    let frame = 0;
    const step = () => {
      const view = viewport();
      const ratio = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const wanted = Math.round(((width * height) / 10000) * DENSITY);
      while (particles.current.length < wanted) {
        const particle = { lng: 0, lat: 0, age: 0 };
        spawn(particle);
        particles.current.push(particle);
      }
      particles.current.length = Math.min(particles.current.length, wanted);

      // Fade what was drawn, or wipe it when the camera moved.
      context.globalCompositeOperation = "destination-in";
      context.fillStyle = `rgba(0, 0, 0, ${cleared.current === cameraKeyRef.current ? FADE : 0})`;
      context.fillRect(0, 0, width, height);
      cleared.current = cameraKeyRef.current;
      context.globalCompositeOperation = "source-over";
      context.lineWidth = 1.3;
      context.lineCap = "round";

      if (view) {
        for (const particle of particles.current) {
          const wind = sampleWind(field, hour, particle.lng, particle.lat);
          if (!wind || particle.age++ > MAX_AGE) {
            spawn(particle);
            continue;
          }
          const [u, v] = wind;
          const [x, y] = view.project([particle.lng, particle.lat]) as [number, number];
          const nx = x + u * PIXELS_PER_MS;
          const ny = y - v * PIXELS_PER_MS;
          const [lng, lat] = view.unproject([nx, ny]) as [number, number];
          particle.lng = lng;
          particle.lat = lat;
          if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;
          // Light streaks over the coloured speed field, as weather maps draw them.
          context.strokeStyle = `rgba(255, 255, 255, ${0.35 + 0.5 * Math.min(Math.hypot(u, v) / 8, 1)})`;
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(nx, ny);
          context.stroke();
        }
      }
      if (!reducedMotion) frame = requestAnimationFrame(step);
    };

    if (reducedMotion) {
      // A still picture: a few dozen steps drawn at once, then nothing moves.
      for (let index = 0; index < 40; index++) step();
    } else frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [field, hour, viewport, reducedMotion]);

  return <canvas ref={canvas} className="map__wind" aria-hidden="true" />;
}

/**
 * The wind speed of one hour as a smooth picture of the grid, to lay under
 * the streaks: each node is one pixel, and the browser's smoothing blends
 * them when the picture is scaled up.
 */
export function windSpeedImage(field: WindField, hour: number): HTMLCanvasElement {
  const { nx, ny } = field.grid;
  const small = document.createElement("canvas");
  small.width = nx;
  small.height = ny;
  const context = small.getContext("2d")!;
  const image = context.createImageData(nx, ny);
  const u = field.u[hour] ?? [];
  const v = field.v[hour] ?? [];
  for (let node = 0; node < nx * ny; node++) {
    const [r, g, b] = windColor(Math.hypot(u[node] ?? 0, v[node] ?? 0));
    image.data.set([r, g, b, 255], node * 4);
  }
  context.putImageData(image, 0, 0);
  const large = document.createElement("canvas");
  large.width = nx * 24;
  large.height = ny * 24;
  const out = large.getContext("2d")!;
  out.imageSmoothingEnabled = true;
  out.imageSmoothingQuality = "high";
  out.drawImage(small, 0, 0, large.width, large.height);
  return large;
}
