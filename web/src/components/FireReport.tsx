import { type FormEvent, useId, useState } from "react";
import { EMERGENCY, type FireCheck, describe, fireCheckUrl, parsePoint } from "../util/fireReport";

/** Base URL of the alert service; reports stay closed until it is set. */
const ALERTS_API = (import.meta.env.VITE_ALERTS_API_URL as string | undefined)?.replace(/\/+$/, "");

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; result: FireCheck }
  | { kind: "error"; message: string };

/**
 * "I see a fire here": the visitor shares their location, or types a point,
 * and gets what the satellites saw around it. The fire brigade numbers come
 * first and stay on screen, because a report to aeros reaches no one on the
 * ground. The point is sent once for the answer and is not stored.
 */
export function FireReport() {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const check = async (lat: number, lon: number) => {
    if (!ALERTS_API) return;
    setStatus({ kind: "checking" });
    try {
      const response = await fetch(fireCheckUrl(ALERTS_API, lat, lon));
      if (!response.ok) throw new Error(`The service answered ${response.status}.`);
      setStatus({ kind: "done", result: (await response.json()) as FireCheck });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const locate = () => {
    if (!("geolocation" in navigator)) return setHint("This browser cannot share a location; type the point instead.");
    setHint("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setHint(null);
        void check(coords.latitude, coords.longitude);
      },
      () => setHint("The location was not shared; type the point instead."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const point = parsePoint(typed);
    if (!point) return setHint("Write the point as latitude, longitude, like -25.3, -60.9.");
    setHint(null);
    void check(point.lat, point.lon);
  };

  const answer = status.kind === "done" ? describe(status.result, new Date()) : null;

  return (
    <div className="report">
      <p className="report__brigade" role="note">
        <strong>See fire? Call the fire brigade first:</strong>{" "}
        {EMERGENCY.map((entry, index) => (
          <span key={entry.country}>
            {index > 0 && " · "}
            {entry.country}{" "}
            <a href={`tel:${entry.number}`} className="report__number">
              {entry.number}
            </a>
          </span>
        ))}
      </p>
      <form className="report__form" onSubmit={submit} noValidate>
        <button type="button" className="button" onClick={locate} disabled={!ALERTS_API || status.kind === "checking"}>
          Use my location
        </button>
        <label className="report__point" htmlFor={`${id}-point`}>
          <span className="visually-hidden">Point, as latitude and longitude</span>
          <input
            id={`${id}-point`}
            inputMode="decimal"
            placeholder="or type -25.3, -60.9"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
        <button type="submit" className="button" disabled={!ALERTS_API || status.kind === "checking"}>
          {status.kind === "checking" ? "Checking…" : "Check"}
        </button>
      </form>
      {hint && <p className="summary__note">{hint}</p>}
      {!ALERTS_API && <p className="summary__note">Reports open when the alert service goes live.</p>}
      {status.kind === "error" && (
        <p className="report__error" role="alert">
          {status.message} Try again in a few minutes.
        </p>
      )}
      {answer && status.kind === "done" && (
        <div className={`report__answer report__answer--${status.result.verdict}`} role="status">
          <p className="report__title">{answer.title}</p>
          {answer.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="summary__note">
            A satellite early warning, not an emergency service. Your location is used for this answer and not stored.
          </p>
        </div>
      )}
    </div>
  );
}
