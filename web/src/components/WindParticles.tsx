import { useEffect, useRef } from "react";
import type { WebMercatorViewport } from "@deck.gl/core";
import { sampleWind, windStroke, type WindField } from "../util/wind";

interface Props {
  field: WindField;
  hour: number;
  /** The map's current projection; read every frame so the particles follow pans and zooms. */
  viewport: () => WebMercatorViewport | null;
  /** A value that changes whenever the camera moves, so old trails are wiped instead of smeared. */
  cameraKey: string;
  reducedMotion: boolean;
  /** Light streaks for a dark ground, dark ones for a light ground. */
  ink: "light" | "dark";
}

/** Particles per 10 000 px² of map. */
const DENSITY = 3;
const MAX_AGE = 110;
/** Trails keep this share every frame: long, soft tails. */
const FADE = 0.955;

interface Particle {
  lng: number;
  lat: number;
  age: number;
}

/**
 * Wind as moving streaks: particles are carried across the u/v field and
 * leave fading trails whose brightness and pace both follow the speed. Positions
 * live in lon/lat, so the streaks stay on the ground while the map moves.
 */
export function WindParticles({ field, hour, viewport, cameraKey, reducedMotion, ink }: Props) {
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
      context.lineCap = "round";

      if (view) {
        for (const particle of particles.current) {
          const wind = sampleWind(field, hour, particle.lng, particle.lat);
          if (!wind || particle.age++ > MAX_AGE) {
            spawn(particle);
            continue;
          }
          const [u, v] = wind;
          const speed = Math.hypot(u, v);
          const stroke = windStroke(speed);
          const [x, y] = view.project([particle.lng, particle.lat]) as [number, number];
          const scale = speed > 0 ? stroke.pixels / speed : 0;
          const nx = x + u * scale;
          const ny = y - v * scale;
          const [lng, lat] = view.unproject([nx, ny]) as [number, number];
          particle.lng = lng;
          particle.lat = lat;
          if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;
          context.strokeStyle = `rgba(${ink === "light" ? "255, 255, 255" : "18, 28, 40"}, ${stroke.alpha})`;
          context.lineWidth = stroke.width;
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
  }, [field, hour, viewport, reducedMotion, ink]);

  return <canvas ref={canvas} className="map__wind" aria-hidden="true" />;
}

