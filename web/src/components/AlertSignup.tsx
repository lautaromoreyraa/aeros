import { type FormEvent, useId, useMemo, useState } from "react";
import { gridDisk, latLngToCell } from "h3-js";
import type { Sector } from "../util/sectors";
import { CHANNELS, type Channel, normalizeAddress, subscriptionRequest } from "../util/subscription";

/** Base URL of the alert service; sign-ups stay closed until it is set. */
const ALERTS_API = (import.meta.env.VITE_ALERTS_API_URL as string | undefined)?.replace(/\/+$/, "");

type Place = { kind: "zone"; id: string } | { kind: "here"; cell: string; zoneId: string | null };

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; channel: Channel }
  | { kind: "error"; message: string };

interface Props {
  sectors: Sector[];
  /** Every cell of the study region. */
  regionCells: string[];
  resolution: number;
}

/**
 * Sign-up for the early warning of one area: a zone, or the cells around the
 * visitor's own position, and the channel to be told on. The service sends
 * a confirmation first; nothing is sent until it is answered.
 */
export function AlertSignup({ sectors, regionCells, resolution }: Props) {
  const id = useId();
  const [place, setPlace] = useState<Place>({ kind: "zone", id: sectors[0]?.id ?? "" });
  const [channel, setChannel] = useState<Channel>("telegram");
  const [address, setAddress] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [locating, setLocating] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const region = useMemo(() => new Set(regionCells), [regionCells]);
  const option = CHANNELS.find((entry) => entry.value === channel)!;

  const cells = useMemo(() => {
    if (place.kind === "zone") return sectors.find((sector) => sector.id === place.id)?.cells ?? [];
    // The visitor's cell and the ring around it: a fire next door counts too.
    return gridDisk(place.cell, 1).filter((cell) => region.has(cell));
  }, [place, sectors, region]);

  const locate = () => {
    if (!("geolocation" in navigator)) return setLocating("This browser cannot share a location; choose a zone instead.");
    setLocating("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const cell = latLngToCell(coords.latitude, coords.longitude, resolution);
        if (!gridDisk(cell, 1).some((near) => region.has(near)))
          return setLocating("Your location is outside the area aeros watches today; choose a zone instead.");
        const zone = sectors.find((sector) => sector.cells.includes(cell));
        setPlace({ kind: "here", cell, zoneId: zone?.id ?? null });
        setLocating(`Alerts for your area${zone ? `, in ${zone.name}` : ""}.`);
      },
      () => setLocating("The location was not shared; choose a zone instead."),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const checked = normalizeAddress(channel, address);
    if ("error" in checked) return setFieldError(checked.error);
    setFieldError(null);
    if (!ALERTS_API) return;
    setStatus({ kind: "sending" });
    try {
      const zoneId = place.kind === "zone" ? place.id : (place.zoneId ?? undefined);
      const response = await fetch(`${ALERTS_API}/alerts/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionRequest(channel, checked.address, cells, zoneId)),
      });
      if (!response.ok) throw new Error(`The alert service answered ${response.status}.`);
      setStatus({ kind: "sent", channel });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (status.kind === "sent")
    return (
      <div className="signup signup--done" role="status">
        <p className="signup__title">Check your {CHANNELS.find((entry) => entry.value === status.channel)!.label}</p>
        <p>We sent a confirmation. Alerts for this area start once you answer it.</p>
      </div>
    );

  return (
    <form className="signup" onSubmit={submit} noValidate>
      <fieldset className="signup__group">
        <legend>Area</legend>
        <div className="signup__row">
          <select
            aria-label="Zone"
            value={place.kind === "zone" ? place.id : ""}
            onChange={(event) => {
              setPlace({ kind: "zone", id: event.target.value });
              setLocating(null);
            }}
          >
            {place.kind === "here" && <option value="">Around my location</option>}
            {sectors.map((sector) => (
              <option key={sector.id} value={sector.id}>
                {sector.name}
              </option>
            ))}
          </select>
          <button type="button" className="signup__locate" onClick={locate}>
            Use my location
          </button>
        </div>
        {locating && <p className="signup__hint">{locating}</p>}
      </fieldset>

      <fieldset className="signup__group">
        <legend>Channel</legend>
        <div className="signup__channels">
          {CHANNELS.map((entry) => (
            <label key={entry.value} className={`signup__channel signup__channel--${entry.value}`}>
              <input
                type="radio"
                name={`${id}-channel`}
                checked={channel === entry.value}
                onChange={() => {
                  setChannel(entry.value);
                  setFieldError(null);
                }}
              />
              {entry.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="signup__group" htmlFor={`${id}-address`}>
        <span className="signup__label">{option.field}</span>
        <input
          id={`${id}-address`}
          type={channel === "email" ? "email" : channel === "whatsapp" ? "tel" : "text"}
          autoComplete={channel === "email" ? "email" : channel === "whatsapp" ? "tel" : "off"}
          placeholder={option.placeholder}
          value={address}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${id}-error` : undefined}
          onChange={(event) => setAddress(event.target.value)}
        />
        {fieldError && (
          <span id={`${id}-error`} className="signup__error">
            {fieldError}
          </span>
        )}
      </label>

      <button type="submit" className="landing__cta" disabled={!ALERTS_API || status.kind === "sending" || cells.length === 0}>
        {status.kind === "sending" ? "Signing up…" : "Get alerts for this area"}
      </button>
      {!ALERTS_API && (
        <p className="signup__hint">Sign-ups open when the alert service goes live; nothing is sent from this preview.</p>
      )}
      {status.kind === "error" && (
        <p className="signup__error" role="alert">
          {status.message} Try again in a few minutes.
        </p>
      )}
    </form>
  );
}
