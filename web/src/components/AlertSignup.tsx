import { type FormEvent, useId, useState } from "react";
import {
  CHANNELS,
  type Channel,
  type Place,
  type SubscriptionAnswer,
  alertLanguage,
  normalizeEmail,
  normalizePhone,
  placeFromPosition,
  placeLabel,
  placesUrl,
  subscriptionRequest,
  telegramLink,
} from "../util/subscription";

/** Base URL of the alert service; sign-ups stay closed until it is set. */
const ALERTS_API = (import.meta.env.VITE_ALERTS_API_URL as string | undefined)?.replace(/\/+$/, "");

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "telegram"; link: string | null }
  | { kind: "email" }
  | { kind: "sms" }
  | { kind: "error"; message: string };

/** The service's own error text when it sends one, which never echoes what was typed. */
async function failure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return `${body.error.charAt(0).toUpperCase()}${body.error.slice(1)}.`;
  } catch {
    // not JSON: fall through
  }
  return `The alert service answered ${response.status}.`;
}

/**
 * Sign-up for alerts about a possible fire near a town: find the town (or
 * share a location), pick Telegram, SMS or e-mail, confirm. Nothing is sent
 * until the person confirms. SMS needs cellular signal, not mobile data.
 */
export function AlertSignup() {
  const id = useId();
  const language = alertLanguage(typeof navigator === "undefined" ? undefined : navigator.language);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[] | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>("telegram");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const search = async () => {
    if (!ALERTS_API || query.trim().length < 2) return setHint("Write at least two letters of the town.");
    setHint("Looking the town up…");
    try {
      const response = await fetch(placesUrl(ALERTS_API, query, language));
      if (!response.ok) throw new Error(await failure(response));
      const places = ((await response.json()) as { places?: Place[] }).places ?? [];
      setFound(places);
      setPlace(places.length === 1 ? places[0]! : null);
      setHint(places.length ? null : "No town by that name in the Gran Chaco; try one nearby.");
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    }
  };

  const locate = () => {
    if (!("geolocation" in navigator)) return setHint("This browser cannot share a location; search for the town instead.");
    setHint("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setPlace(placeFromPosition(coords.latitude, coords.longitude));
        setFound(null);
        setHint(null);
      },
      () => setHint("The location was not shared; search for the town instead."),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ALERTS_API || !place) return;
    let address: string | undefined;
    if (channel === "email") {
      const checked = normalizeEmail(email);
      if ("error" in checked) return setFieldError(checked.error);
      address = checked.address;
    }
    if (channel === "sms") {
      const checked = normalizePhone(phone);
      if ("error" in checked) return setFieldError(checked.error);
      address = checked.address;
    }
    setFieldError(null);
    setStatus({ kind: "sending" });
    try {
      const response = await fetch(`${ALERTS_API}/alerts/subscriptions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionRequest(channel, place, language, address)),
      });
      if (!response.ok) throw new Error(await failure(response));
      const answer = (await response.json()) as SubscriptionAnswer;
      setStatus(
        channel === "telegram"
          ? { kind: "telegram", link: telegramLink(answer) }
          : channel === "sms"
            ? { kind: "sms" }
            : { kind: "email" },
      );
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (status.kind === "telegram")
    return (
      <div className="signup signup--done" role="status">
        <p className="signup__title">One step left: confirm in Telegram</p>
        {status.link ? (
          <>
            <p>Open the bot and press Start. Alerts for {place && placeLabel(place)} begin then.</p>
            <a className="landing__cta" href={status.link} target="_blank" rel="noopener noreferrer">
              Open Telegram to confirm
            </a>
          </>
        ) : (
          <p>The Telegram bot is not connected yet, so this sign-up cannot be confirmed. Try e-mail instead.</p>
        )}
      </div>
    );
  if (status.kind === "sms")
    return (
      <div className="signup signup--done" role="status">
        <p className="signup__title">Check the phone</p>
        <p>
          We sent a text to confirm alerts for {place && placeLabel(place)}. Reply YES. It arrives without mobile
          data, as long as the phone has signal.
        </p>
      </div>
    );
  if (status.kind === "email")
    return (
      <div className="signup signup--done" role="status">
        <p className="signup__title">Check your email</p>
        <p>We sent a confirmation link. Alerts for {place && placeLabel(place)} begin once you open it.</p>
      </div>
    );

  return (
    <form className="signup" onSubmit={submit} noValidate>
      <fieldset className="signup__group">
        <legend>Town</legend>
        <div className="signup__row">
          <input
            type="text"
            aria-label="Town"
            placeholder="Resistencia, Filadelfia, Tartagal…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
          />
          <button type="button" className="signup__locate" onClick={() => void search()} disabled={!ALERTS_API}>
            Find
          </button>
          <button type="button" className="signup__locate" onClick={locate} disabled={!ALERTS_API}>
            Use my location
          </button>
        </div>
        {found && found.length > 1 && (
          <div className="signup__channels" role="radiogroup" aria-label="Matching towns">
            {found.map((option) => (
              <label key={`${option.lat},${option.lng},${option.name}`} className="signup__channel">
                <input type="radio" name={`${id}-place`} checked={place === option} onChange={() => setPlace(option)} />
                {placeLabel(option)}
              </label>
            ))}
          </div>
        )}
        {place && <p className="signup__hint">Alerts about a possible fire within about 50 km of {placeLabel(place)}.</p>}
        {hint && <p className="signup__hint">{hint}</p>}
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

      {channel === "sms" && (
        <label className="signup__group" htmlFor={`${id}-phone`}>
          <span className="signup__label">Phone number with country code</span>
          <input
            id={`${id}-phone`}
            type="tel"
            autoComplete="tel"
            placeholder="+54 9 362 400 0000"
            value={phone}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-error` : undefined}
            onChange={(event) => setPhone(event.target.value)}
          />
          <span className="signup__hint">Works without mobile data. The phone still needs cellular signal.</span>
          {fieldError && (
            <span id={`${id}-error`} className="signup__error">
              {fieldError}
            </span>
          )}
        </label>
      )}

      {channel === "email" && (
        <label className="signup__group" htmlFor={`${id}-address`}>
          <span className="signup__label">Email address</span>
          <input
            id={`${id}-address`}
            type="email"
            autoComplete="email"
            placeholder="name@example.org"
            value={email}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-error` : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
          {fieldError && (
            <span id={`${id}-error`} className="signup__error">
              {fieldError}
            </span>
          )}
        </label>
      )}

      <button type="submit" className="landing__cta" disabled={!ALERTS_API || !place || status.kind === "sending"}>
        {status.kind === "sending" ? "Signing up…" : "Get alerts for this town"}
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
