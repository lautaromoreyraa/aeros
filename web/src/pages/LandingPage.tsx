import { type CSSProperties, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EarlyWarning } from "../api/types";
import { AlertPreview } from "../components/AlertPreview";
import { AlertSignup } from "../components/AlertSignup";
import { DataCredits } from "../components/DataCredits";
import { useInView } from "../hooks/useInView";
import { usePrefersReducedMotion } from "../hooks/useMediaQuery";
import type { Loadable } from "../hooks/useOutlook";
import type { LoadedRegion } from "../hooks/useRegion";
import { cellTotals } from "../util/aggregation";
import { alertMessage } from "../util/alertMessage";
import { alertDecision, formatDay } from "../util/earlyWarning";
import { unitLabel } from "../util/format";
import { demoSectors } from "../util/sectors";

const EarthScene = lazy(() => import("../components/earth/EarthScene"));
const SatelliteTerrain = lazy(() => import("../components/SatelliteTerrain"));

const NO_FLAGS: ReadonlySet<string> = new Set();

/**
 * The hero's waterfall, in order: when each piece starts after the scan, how
 * long it travels and how far. Heavy pieces go further and longer, light ones
 * snap; each starts a frame before the previous one settles.
 */
const CASCADE = {
  name: [0, 0.2, 80],
  claim: [0.17, 0.16, 56],
  lede1: [0.3, 0.14, 44],
  lede2: [0.4, 0.13, 44],
  primary: [0.49, 0.13, 40],
  telegram: [0.57, 0.12, 40],
  more: [0.64, 0.11, 32],
} as const;
const wf = (key: keyof typeof CASCADE) => {
  const [at, duration, travel] = CASCADE[key];
  return { "--wf-at": `${at}s`, "--wf-for": `${duration}s`, "--wf-y": `${travel}px` } as CSSProperties;
};
/** If the scene cannot cue the title (no WebGL, no data), it arrives on its own after this long. */
const CUE_FALLBACK_MS = 4200;

/** Complete years of the FIRMS archive behind the record, 2000 to 2025. */
const RECORD_YEARS = 26;

/**
 * The alert bot's t.me link, set at build time once the bot exists; until
 * then the button leads to the sign-up section on this page.
 */
const TELEGRAM_BOT = import.meta.env.VITE_TELEGRAM_BOT_URL as string | undefined;
const TELEGRAM_URL = TELEGRAM_BOT || "#alerts";
const TELEGRAM_EXTERNAL = Boolean(TELEGRAM_BOT);

const TelegramIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      fill="currentColor"
      d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13 1.4 11.5c-1-.3-1-1 .2-1.5L20.5 2.8c.9-.3 1.6.2 1.4 1.5Z"
    />
  </svg>
);

interface Props {
  region: LoadedRegion | null;
  warning: Loadable<EarlyWarning | null>;
  onEnter: () => void;
}

/**
 * The front page: the planet seen from orbit, then the record on
 * satellite imagery, then the message an early warning sends. Each part uses
 * the same artifacts as the dashboard it leads to.
 */
export function LandingPage({ region, warning, onEnter }: Props) {
  const still = usePrefersReducedMotion();
  const heroRef = useRef<HTMLElement>(null);
  const terrainRef = useRef<HTMLElement>(null);
  const heroVisible = useInView(heroRef);
  const [lit, setLit] = useState(false);
  const light = useCallback(() => setLit(true), []);
  useEffect(() => {
    const timer = window.setTimeout(light, CUE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [light]);
  // deck.gl compiles its shaders on the main thread, which would stall the
  // globe; the map starts only as the visitor scrolls towards it.
  const mapMounted = useInView(terrainRef, { rootMargin: "0px 0px 60% 0px", once: true });
  const risen = useInView(terrainRef, { threshold: 0.35, once: true });

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
        <section
          ref={heroRef}
          className={["hero", still && "hero--still", lit && "is-lit"].filter(Boolean).join(" ")}
          aria-labelledby="hero-title"
        >
          {/* The globe draws its own illustrative fires, so it starts without waiting for the record. */}
          <Suspense fallback={<div className="hero__canvas hero__canvas--fallback" />}>
            <div className="hero__canvas">
              <EarthScene still={still} paused={!heroVisible} onFirstScan={light} />
            </div>
          </Suspense>
          <div className="hero__veil" />
          <div className="hero__copy">
            <h1 id="hero-title" className="hero__title">
              <span className="hero__name wf" style={wf("name")}>
                aeros
              </span>
              <span className="hero__claim wf" style={wf("claim")}>
                Fire early warning
              </span>
            </h1>
            <p className="hero__lede">
              <span className="wf" style={wf("lede1")}>
                26 years of MODIS and VIIRS fire on a single scale.
              </span>{" "}
              <span className="wf" style={wf("lede2")}>
                An agent reads GOES-19 every 10 minutes to warn you.
              </span>
            </p>
            <div className="hero__actions">
              <button type="button" className="landing__cta wf" style={wf("primary")} onClick={onEnter}>
                Open the dashboard
              </button>
              <a
                className="landing__cta landing__cta--telegram wf"
                style={wf("telegram")}
                href={TELEGRAM_URL}
                {...(TELEGRAM_EXTERNAL && { target: "_blank", rel: "noopener" })}
              >
                <TelegramIcon />
                Get alerts on Telegram
              </a>
              <a className="hero__more wf" style={wf("more")} href="#record">
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
              {RECORD_YEARS} years of fire, on the ground it burned
            </h2>
            <p>
              Each column is one H3 cell; its height and colour, the harmonized{" "}
              {region ? unitLabel(region.unit) : "hotspots"} of the whole record. MODIS and VIIRS were joined on one
              scale to raise early warnings that help fire brigades, land managers and local governments tell a worse
              season from a change of satellite, plan for the critical months and act where an area burns above its
              normal.
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
              years. When an area burns well above that, the warning goes out by Telegram, WhatsApp or email to the
              people who signed up for that area and the ones next to it: where, how much more than usual, and how
              many of those days the satellites actually saw.
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

        <section id="alerts" className="alerts" aria-labelledby="alerts-title">
          <div className="warn__copy">
            <h2 id="alerts-title" className="landing__heading">
              Get the warning for your area
            </h2>
            <p>
              Choose a zone or share your location, and the channel to be told on. You get a confirmation first and
              an alert only when your area, or the one next to it, burns well above its normal.
            </p>
          </div>
          {region && (
            <AlertSignup
              sectors={sectors}
              regionCells={region.cells.cells.map((cell) => cell.cell)}
              resolution={region.cells.resolution}
            />
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
        <p>
          Hotspot counts are model outputs aggregated to H3 cells; the fires on the opening globe are illustrative. The
          early warning is statistical, not an official fire alert. Earth imagery: NASA Visible Earth, Blue Marble and
          Black Marble, with relief from Blue Marble Next Generation; clouds from{" "}
          <a className="credit-link" href="https://www.solarsystemscope.com/textures/">
            Solar System Scope
          </a>
          , under{" "}
          <a className="credit-link" href="https://creativecommons.org/licenses/by/4.0/">
            CC BY 4.0
          </a>
          , resized.
        </p>
        <DataCredits />
      </footer>
    </div>
  );
}
