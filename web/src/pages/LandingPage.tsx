import { Suspense, lazy, useMemo, useRef } from "react";
import type { EarlyWarning } from "../api/types";
import { AlertPreview } from "../components/AlertPreview";
import { useInView } from "../hooks/useInView";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { Loadable } from "../hooks/useOutlook";
import type { LoadedRegion } from "../hooks/useRegion";
import { cellTotals } from "../util/aggregation";
import { alertMessage } from "../util/alertMessage";
import { alertDecision, formatDay } from "../util/earlyWarning";
import { unitLabel } from "../util/format";
import { yearOf } from "../util/months";
import { demoSectors } from "../util/sectors";

const IntroScene = lazy(() => import("../components/IntroScene"));
const SatelliteTerrain = lazy(() => import("../components/SatelliteTerrain"));

const NO_FLAGS: ReadonlySet<string> = new Set();

interface Props {
  region: LoadedRegion | null;
  warning: Loadable<EarlyWarning | null>;
  onEnter: () => void;
}

/**
 * The front page: the planet turning to the Gran Chaco, then the record on
 * satellite imagery, then the message an early warning sends. Each part uses
 * the same artifacts as the dashboard it leads to.
 */
export function LandingPage({ region, warning, onEnter }: Props) {
  const still = usePrefersReducedMotion();
  const heroRef = useRef<HTMLElement>(null);
  const terrainRef = useRef<HTMLElement>(null);
  const heroVisible = useInView(heroRef);
  // deck.gl compiles its shaders on the main thread, which would stall the
  // globe; the map starts only as the visitor scrolls towards it.
  const mapMounted = useInView(terrainRef, { rootMargin: "0px 0px 60% 0px", once: true });
  const risen = useInView(terrainRef, { threshold: 0.35, once: true });

  const columns = useMemo(() => {
    if (!region) return [];
    const totals = region.cells.cells.map((cell) => cell.values.reduce((sum, row) => sum + row[1], 0));
    const max = Math.max(1, ...totals);
    return region.centers.map((center, index) => ({ center: center.center, weight: Math.sqrt((totals[index] ?? 0) / max) }));
  }, [region]);
  const totals = useMemo(
    () => (region ? cellTotals(region.cells, 0, region.lastMonth - region.firstMonth) : []),
    [region],
  );
  const centers = useMemo(() => region?.centers.map((cell) => cell.center) ?? [], [region]);
  const sectors = useMemo(() => (region ? demoSectors(region.centers) : []), [region]);

  const report = warning.status === "ready" ? warning.data : null;
  const decision = useMemo(() => alertDecision(report), [report]);
  const flagged = useMemo(
    () => (decision.cells.length ? new Set(decision.cells.map((cell) => cell.cell)) : NO_FLAGS),
    [decision.cells],
  );
  const message = useMemo(() => report && alertMessage(report, decision, sectors), [report, decision, sectors]);
  const years = region ? yearOf(region.lastMonth) - yearOf(region.firstMonth) + 1 : null;

  return (
    <div className="landing">
      <header className="landing__nav">
        <span className="brand">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
            <polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="currentColor" />
          </svg>
          <span>aeros</span>
        </span>
        <button type="button" className="landing__cta landing__cta--quiet" onClick={onEnter}>
          Open the dashboard
        </button>
      </header>

      <main>
        <section ref={heroRef} className={still ? "hero hero--still" : "hero"} aria-labelledby="hero-title">
          <Suspense fallback={<div className="hero__canvas hero__canvas--fallback" />}>
            {region && (
              <div className="hero__canvas">
                <IntroScene cells={columns} still={still} paused={!heroVisible} />
              </div>
            )}
          </Suspense>
          <div className="hero__veil" />
          <div className="hero__copy">
            <h1 id="hero-title" className="hero__title">
              Early warning for the Gran Chaco fires
            </h1>
            <p className="hero__lede">
              <span>An agent that reads every satellite pass over the Chaco</span>{" "}
              <span>and warns you the day an area burns past its normal.</span>
            </p>
            <div className="hero__actions">
              <button type="button" className="landing__cta" onClick={onEnter}>
                Open the dashboard
              </button>
              <a className="hero__more" href="#record">
                See the record
              </a>
            </div>
          </div>
        </section>

        <section id="record" ref={terrainRef} className="record" aria-labelledby="record-title">
          <div className="record__map">
            {mapMounted && region && (
              <Suspense fallback={null}>
                <SatelliteTerrain
                  totals={totals}
                  unit={region.unit}
                  centers={centers}
                  flagged={flagged}
                  risen={risen}
                  reducedMotion={still}
                />
              </Suspense>
            )}
          </div>
          <div className="record__copy">
            <h2 id="record-title" className="landing__heading">
              {years ? `${years} years of fire` : "Every year of fire"}, on the ground it burned
            </h2>
            <p>
              Each column is one H3 cell of the Gran Chaco. Its height and colour are the harmonized{" "}
              {region ? unitLabel(region.unit) : "hotspots"} of the whole record: MODIS and VIIRS counted on one
              scale, so 2004 and 2024 can be compared.
            </p>
            {flagged.size > 0 && report && (
              <p className="record__flag">
                <span className="record__swatch" aria-hidden="true" /> Outlined: burning well above normal,{" "}
                {formatDay(report.window[0])} – {formatDay(report.window[1])}.
              </p>
            )}
          </div>
        </section>

        <section className="warn" aria-labelledby="warn-title">
          <div className="warn__copy">
            <h2 id="warn-title" className="landing__heading">
              When an area burns past its normal, you hear about it
            </h2>
            <p>
              Every morning aeros compares the last seven days of VIIRS detections with the same days of earlier
              years. When an area burns well above that, the warning goes out by WhatsApp and email: where, how much
              more than usual, and how many of those days the satellites actually saw.
            </p>
          </div>
          {message && report ? (
            <>
              <AlertPreview message={message} generatedAt={report.generated_at} />
              <p className="warn__note">Preview built from the report of {formatDay(report.generated_at.slice(0, 10))}.</p>
            </>
          ) : (
            <p className="warn__note">
              {warning.status === "loading" ? "Loading this week's report…" : "No early-warning report has been published yet."}
            </p>
          )}
        </section>

        <section className="landing__end" aria-labelledby="end-title">
          <h2 id="end-title" className="landing__heading">
            See where it is burning now
          </h2>
          <button type="button" className="landing__cta" onClick={onEnter}>
            Open the dashboard
          </button>
        </section>
      </main>

      <footer className="landing__footer">
        Hotspot counts are model outputs aggregated to H3 cells. The early warning is statistical, not an official
        fire alert.
      </footer>
    </div>
  );
}
