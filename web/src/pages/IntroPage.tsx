import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { LoadedRegion } from "../hooks/useRegion";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";

const IntroScene = lazy(() => import("../components/IntroScene"));

const LINES = [
  { at: 0.4, text: "Twenty-six years of fire over the Gran Chaco." },
  { at: 2.6, text: "Three satellites counted it. Each one counts differently." },
  { at: 4.8, text: "aeros puts every year on the same scale." },
];
const DURATION = 9;

export function IntroPage({ region, onDone }: { region: LoadedRegion | null; onDone: () => void }) {
  const still = usePrefersReducedMotion();
  const [elapsed, setElapsed] = useState(0);
  const skipRef = useRef<HTMLButtonElement>(null);

  const cells = useMemo(() => {
    if (!region) return [];
    const totals = region.cells.cells.map((cell) => cell.values.reduce((sum, row) => sum + row[1], 0));
    const max = Math.max(1, ...totals);
    return region.centers.map((center, index) => ({ center: center.center, weight: Math.sqrt((totals[index] ?? 0) / max) }));
  }, [region]);

  useEffect(() => {
    skipRef.current?.focus();
    // The page behind keeps its layout; it just must not scroll under the intro.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    if (still) return;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const seconds = (performance.now() - started) / 1000;
      setElapsed(seconds);
      if (seconds >= DURATION) onDone();
    }, 100);
    return () => window.clearInterval(timer);
  }, [still, onDone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onDone();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  return (
    <div className="intro" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <Suspense fallback={<div className="intro__canvas intro__canvas--fallback" />}>
        {region && <IntroScene cells={cells} still={still} />}
      </Suspense>
      <div className="intro__veil" />
      <div className="intro__copy">
        <p className="intro__eyebrow">NASA Space Apps 2026 · MODIS × VIIRS</p>
        <h1 id="intro-title" className="intro__title">
          aeros
        </h1>
        <ol className="intro__lines">
          {LINES.map((line) => (
            <li key={line.text} className={still || elapsed >= line.at ? "is-visible" : undefined}>
              {line.text}
            </li>
          ))}
        </ol>
      </div>
      <div className="intro__actions">
        {still ? (
          <button ref={skipRef} type="button" className="button button--primary" onClick={onDone}>
            Open the calendar
          </button>
        ) : (
          <>
            <div className="intro__progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.min(1, elapsed / DURATION)})` }} />
            </div>
            <button ref={skipRef} type="button" className="intro__skip" onClick={onDone}>
              Skip intro
            </button>
          </>
        )}
      </div>
    </div>
  );
}
