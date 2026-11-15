/**
 * The HyperFrames seek protocol for canvas and three.js content: the renderer
 * dispatches `hf-seek` on window with the timeline time of the frame it wants,
 * frames arrive in any order, and heavy setup is awaited through
 * `window.__hf.buildReady` before the first one. Each frame therefore has to
 * be drawn from that time alone, which is how the hero scene is built.
 */

interface SeekDetail {
  /** Seconds from the start of the composition. */
  time: number;
  /** Delays the capture until the promise settles; must be called synchronously. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

declare global {
  interface Window {
    __hf?: { buildReady?: Record<string, Promise<unknown>> };
  }
}

export function onSeek(draw: (seconds: number, waitUntil?: SeekDetail["waitUntil"]) => void): () => void {
  const listener = (event: Event) => {
    const { time, waitUntil } = (event as CustomEvent<SeekDetail>).detail;
    draw(time, waitUntil);
  };
  window.addEventListener("hf-seek", listener);
  return () => window.removeEventListener("hf-seek", listener);
}

/** Tells a HyperFrames renderer, when one is driving the page, to wait for `ready` before its first frame. */
export function announceBuild(key: string, ready: Promise<unknown>): void {
  if (!window.__hf) return;
  window.__hf.buildReady ??= {};
  window.__hf.buildReady[key] = ready;
}
