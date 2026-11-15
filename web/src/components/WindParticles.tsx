import { useEffect, useRef } from "react";
import type { WebMercatorViewport } from "@deck.gl/core";
import { STRONG_WIND, windStroke, type WindField } from "../util/wind";
import {
  advance,
  mark,
  spawn,
  spawnBox,
  stillPicture,
  streakCount,
  toScreen,
  TRAIL_STEP,
  type GeoBox,
  type Streak,
} from "../util/windStreaks";

interface Props {
  field: WindField;
  hour: number;
  /** The map's current projection; read every frame so the streaks follow pans and zooms. */
  viewport: () => WebMercatorViewport | null;
  /** A value that changes whenever the camera moves, so the picture is redrawn on it. */
  cameraKey: string;
  /** `false` draws a still picture that still follows the camera. */
  playing: boolean;
  /** The streak's own tone; it is cased in the opposite one so it reads on any ground. */
  ink: "light" | "dark";
}

/** The tail quarters get brighter towards the head, oldest to newest. */
const QUARTER_ALPHA = [0.2, 0.45, 0.7, 1];
/** How far past the canvas edge a streak may sit and still be drawn. */
const MARGIN = 40;
/** After the camera rests this long, the paused picture is rebuilt for the new view. */
const REBUILD_MS = 250;
/** The arrow takes the direction of a segment at least this long on screen. */
const ARROW_FROM_PX = 1;

/** The four speed classes a streak can fall in; each keeps the stroke of its middle speed. */
const speedClass = (speed: number) => Math.min(3, Math.floor(Math.min(speed / STRONG_WIND, 1) * 4));
const classStroke = (cls: number) => windStroke(((cls + 0.5) / 4) * STRONG_WIND);

const inBox = (streak: Streak, box: GeoBox) =>
  streak.lng >= box[0] && streak.lng <= box[2] && streak.lat >= box[1] && streak.lat <= box[3];

/**
 * Wind as streaks on the ground: each one remembers its tail as lon/lat
 * positions and is drawn with the camera of the moment, so the layer stays on
 * the ground and reads true compass directions however the map is turned.
 * Playing, they drift at a pace set per second and are born only where the
 * camera looks; paused, the picture follows the camera, carries arrowheads,
 * and is rebuilt for the view once the camera settles.
 */
export function WindParticles({ field, hour, viewport, cameraKey, playing, ink }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const streaks = useRef<Streak[]>([]);
  /** The playing effect leaves what a camera change means here; `null` until it mounts. */
  const onCameraMove = useRef<(() => void) | null>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;

    const inCanvas = (x: number, y: number, width: number, height: number) =>
      x >= -MARGIN && y >= -MARGIN && x <= width + MARGIN && y <= height + MARGIN;

    const draw = (view: WebMercatorViewport) => {
      const ratio = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!field.u[hour]) return;
      const matrix = view.pixelProjectionMatrix;
      const buckets = Array.from({ length: 16 }, () => new Path2D());
      for (const streak of streaks.current) {
        const points: [number, number][] = [];
        for (let index = 0; index < streak.trail.length; index += 2) points.push(toScreen(matrix, streak.trail[index]!, streak.trail[index + 1]!));
        points.push(toScreen(matrix, streak.lng, streak.lat));
        if (!points.some(([x, y]) => inCanvas(x, y, width, height))) continue;
        const cls = speedClass(streak.speed);
        const segments = points.length - 1;
        for (let index = 0; index < segments; index++) {
          const quarter = Math.min(3, Math.floor((index / segments) * 4));
          const path = buckets[cls * 4 + quarter]!;
          const [x0, y0] = points[index]!;
          const [x1, y1] = points[index + 1]!;
          path.moveTo(x0, y0);
          path.lineTo(x1, y1);
        }
        // Paused, nothing moves to show where the wind goes: the head carries an
        // arrow, along the direction it really came from, not a degenerate segment.
        if (!playing && segments > 0) {
          const [x1, y1] = points[segments]!;
          let tail: [number, number] | null = null;
          for (let index = segments - 1; index >= 0; index--) {
            const [x0, y0] = points[index]!;
            if (Math.hypot(x1 - x0, y1 - y0) >= ARROW_FROM_PX) {
              tail = [x0, y0];
              break;
            }
          }
          if (tail) {
            const angle = Math.atan2(y1 - tail[1], x1 - tail[0]);
            const path = buckets[cls * 4 + 3]!;
            for (const spread of [(150 * Math.PI) / 180, (-150 * Math.PI) / 180]) {
              path.moveTo(x1, y1);
              path.lineTo(x1 + 5 * Math.cos(angle + spread), y1 + 5 * Math.sin(angle + spread));
            }
          }
        }
      }
      // A casing in the opposite tone under every core, so a streak reads
      // over the cells and over the open ground alike.
      const rgb = ink === "light" ? "255, 255, 255" : "18, 28, 40";
      const casing = ink === "light" ? "18, 28, 40" : "255, 255, 255";
      context.lineCap = "round";
      buckets.forEach((path, index) => {
        const stroke = classStroke(Math.floor(index / 4));
        const coreAlpha = (0.35 + 0.65 * stroke.alpha) * QUARTER_ALPHA[index % 4]!;
        context.strokeStyle = `rgba(${casing}, ${coreAlpha * 0.6})`;
        context.lineWidth = stroke.width + 0.4 + 1.8;
        context.stroke(path);
      });
      buckets.forEach((path, index) => {
        const stroke = classStroke(Math.floor(index / 4));
        context.strokeStyle = `rgba(${rgb}, ${(0.35 + 0.65 * stroke.alpha) * QUARTER_ALPHA[index % 4]!})`;
        context.lineWidth = stroke.width + 0.4;
        context.stroke(path);
      });
    };

    const visibleBox = () => {
      const view = viewport();
      if (!view) return null;
      const [west, south, east, north] = view.getBounds();
      return { view, box: spawnBox(field.grid, [west!, south!, east!, north!]) };
    };

    const picture = (view: WebMercatorViewport, box: GeoBox) =>
      stillPicture(streakCount(box, view.zoom, element.clientWidth, element.clientHeight), box, field, hour, view.zoom);

    let frame = 0;
    let timer = 0;

    if (playing) {
      let last = performance.now();
      let unmarked = 0;
      const step = (now: number) => {
        const seconds = Math.min(Math.max(0, (now - last) / 1000), 0.1);
        last = now;
        const seen = visibleBox();
        if (seen?.box) {
          const { view, box } = seen;
          const wanted = streakCount(box, view.zoom, element.clientWidth, element.clientHeight);
          while (streaks.current.length < wanted) {
            const streak: Streak = { lng: 0, lat: 0, age: 0, speed: 0, trail: [] };
            spawn(streak, box);
            streaks.current.push(streak);
          }
          streaks.current.length = Math.min(streaks.current.length, wanted);
          unmarked += seconds;
          const marking = unmarked >= TRAIL_STEP;
          if (marking) unmarked %= TRAIL_STEP;
          for (const streak of streaks.current) {
            if (!inBox(streak, box) || !advance(streak, field, hour, view.zoom, seconds)) spawn(streak, box);
            else if (marking) mark(streak);
          }
        }
        // Drawn even when the camera sees none of the field, so the last
        // streaks are wiped instead of staying on the screen.
        if (seen) draw(seen.view);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
      // The loop already draws every frame with the camera it reads.
      onCameraMove.current = () => {};
    } else {
      const seen = visibleBox();
      if (seen?.box && (streaks.current.length === 0 || !streaks.current.some((streak) => inBox(streak, seen.box!)))) {
        streaks.current = picture(seen.view, seen.box);
      }
      if (seen) draw(seen.view);
      // Drawn on every camera change so the tails stay on the ground; once the
      // camera settles, the picture is rebuilt for the view it ended on.
      onCameraMove.current = () => {
        const moved = visibleBox();
        if (moved) draw(moved.view);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          const settled = visibleBox();
          if (settled?.box) streaks.current = picture(settled.view, settled.box);
          if (settled) draw(settled.view);
        }, REBUILD_MS);
      };
    }
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      onCameraMove.current = null;
    };
  }, [field, hour, viewport, playing, ink]);

  // A camera change does not restart the loop or the picture; it is only
  // reported to them.
  useEffect(() => {
    onCameraMove.current?.();
  }, [cameraKey]);

  return <canvas ref={canvas} className="map__wind" aria-hidden="true" />;
}
