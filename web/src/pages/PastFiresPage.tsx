import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { usePastFire } from "../hooks/usePastFire";
import { formatCount } from "../util/format";
import { PAST_FIRES, burntUpTo, shownAt, type PastFire } from "../util/pastFires";

const PastFireMap = lazy(() => import("../components/PastFireMap"));

/** How long each step stays on screen while the replay plays. */
const STEP_MS = { pass: 650, day: 280 } as const;

/** Local time of the fire: the hour for satellite passes, the date for days. */
const formatTime = (fire: PastFire, iso: string) =>
  new Intl.DateTimeFormat(
    "en-US",
    fire.granularity === "pass"
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", timeZone: fire.time_zone }
      : { month: "short", day: "numeric", year: "numeric", timeZone: fire.time_zone },
  ).format(Date.parse(iso));

/**
 * Replays the satellite record of two fires where the alarm came late, pass
 * by pass: what the satellites saw, next to what happened on the ground.
 */
export function PastFiresPage() {
  const [id, setId] = useState<string>(PAST_FIRES[0].id);
  const state = usePastFire(id);
  const fire = state.status === "ready" ? state.data : null;
  /** Steps on screen, 0 to all of them. */
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);

  // A newly loaded fire opens whole; Play replays it from the start.
  useEffect(() => {
    setPlaying(false);
    setShown(fire ? fire.steps.length : 0);
  }, [fire]);

  useEffect(() => {
    if (!playing || !fire) return;
    const timer = window.setInterval(() => {
      setShown((count) => {
        if (count < fire.steps.length) return count + 1;
        setPlaying(false);
        return count;
      });
    }, STEP_MS[fire.granularity]);
    return () => window.clearInterval(timer);
  }, [playing, fire]);

  const cells = useMemo(() => (fire ? burntUpTo(fire.steps, shown) : []), [fire, shown]);
  const detections = cells.reduce((sum, cell) => sum + cell.detections, 0);
  const step = fire && shown > 0 ? fire.steps[shown - 1] : undefined;
  const now = step ? Date.parse(step.time) : Number.NEGATIVE_INFINITY;

  const togglePlay = () => {
    if (!fire) return;
    if (!playing && shown >= fire.steps.length) setShown(0);
    setPlaying((value) => !value);
  };
  const jump = (count: number) => {
    setPlaying(false);
    setShown(count);
  };

  return (
    <div className="past">
      <div className="past__head">
        <fieldset className="segmented" aria-label="Fire">
          {PAST_FIRES.map((option) => (
            <label key={option.id}>
              <input type="radio" name="past-fire" checked={id === option.id} onChange={() => setId(option.id)} />
              {option.label}
            </label>
          ))}
        </fieldset>
        {fire && (
          <div>
            <h2 className="panel__title">{fire.name}</h2>
            <p className="summary__note">{fire.detail}</p>
          </div>
        )}
      </div>

      <section className="past__map" aria-label="Map of the satellite fire detections">
        {state.status === "error" && (
          <p className="status" role="alert">
            This fire could not be loaded: {state.message}
          </p>
        )}
        {state.status === "loading" && <div className="map map--loading">Loading the fire…</div>}
        {fire && (
          <Suspense fallback={<div className="map map--loading">Loading map…</div>}>
            <PastFireMap
              key={fire.id}
              fire={fire}
              cells={cells}
              current={shown - 1}
              timeOf={(index) => formatTime(fire, fire.steps[index]?.time ?? "")}
            />
          </Suspense>
        )}
      </section>

      {fire && (
        <div className="timeline past__timeline">
          <button type="button" className="button" aria-pressed={playing} onClick={togglePlay}>
            {playing ? "Pause" : "Play"}
          </button>
          <input
            type="range"
            min={0}
            max={fire.steps.length}
            value={shown}
            aria-label={fire.granularity === "pass" ? "Satellite pass" : "Day"}
            aria-valuetext={step ? formatTime(fire, step.time) : "Before the first pass"}
            onChange={(event) => jump(Number(event.target.value))}
          />
          <output className="timeline__month">
            {step ? `${formatTime(fire, step.time)}, ${step.label}` : "Before the first pass"}
          </output>
        </div>
      )}

      {fire && (
        <aside className="past__side" aria-label="What happened">
          <p className="past__total">
            {formatCount(detections)}
            <span> fire detections so far</span>
          </p>
          <ol className="past-events">
            {fire.events.map((event) => (
              <li key={`${event.time}-${event.text}`}>
                <button
                  type="button"
                  className={Date.parse(event.time) <= now ? "past-event past-event--reached" : "past-event"}
                  onClick={() => jump(shownAt(fire.steps, event.time))}
                >
                  <span className="past-event__time">{formatTime(fire, event.time)}</span>
                  <span className="past-event__text">{event.text}</span>
                  <span className="past-event__source">{event.source}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="summary__note">
            Each hexagon is an area where satellites saw fire. The brightest ones burn in the{" "}
            {fire.granularity === "pass" ? "pass" : "day"} on the timeline; darker ones burned before. Tap a moment to
            see the map as it was then. Source: {fire.source}.
          </p>
        </aside>
      )}
    </div>
  );
}
