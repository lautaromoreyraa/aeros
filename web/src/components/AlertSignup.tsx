import { type FormEvent, useId, useState } from "react";
import { useI18n } from "../i18n/I18nContext";
import { signedJsonPost } from "../api/signedPost";
import {
  type Channel,
  type Place,
  type SubscriptionAnswer,
  answeredPlace,
  canSignUp,
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
  | { kind: "sms"; place: Place | null }
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
 * share a location), pick Telegram, SMS or e-mail. Telegram and e-mail send
 * nothing until the person confirms. SMS asks for no reply: the number is
 * subscribed at once and gets one text that says so. It may also leave the
 * town out, and the service then uses the one of the number's area code. SMS
 * needs cellular signal, not mobile data. A LoRa radio is not a channel here:
 * a gateway that has a connection relays the same short text onto the mesh.
 */
export function AlertSignup() {
  const { lang, t } = useI18n();
  const id = useId();
  const language = lang === "es" ? "es" : "en";
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[] | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>("telegram");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const channels: { value: Channel; label: string }[] = [
    { value: "telegram", label: lang === "es" ? "Telegram" : "Telegram" },
    { value: "email", label: lang === "es" ? "Correo electrónico" : "Email" },
  ];

  const search = async () => {
    if (!ALERTS_API || query.trim().length < 2) return setHint(t.signup.minLetters);
    setHint(t.signup.lookingUp);
    try {
      const response = await fetch(placesUrl(ALERTS_API, query, language));
      if (!response.ok) throw new Error(await failure(response));
      const places = ((await response.json()) as { places?: Place[] }).places ?? [];
      setFound(places);
      setPlace(places.length === 1 ? places[0]! : null);
      setHint(places.length ? null : t.signup.notFound);
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    }
  };

  const locate = () => {
    if (!("geolocation" in navigator)) return setHint(t.signup.noGeolocation);
    setHint(t.signup.findingLocation);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setPlace(placeFromPosition(coords.latitude, coords.longitude));
        setFound(null);
        setHint(null);
      },
      () => setHint(t.signup.locationDenied),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ALERTS_API || !canSignUp(channel, place)) return;
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
      const body = JSON.stringify(subscriptionRequest(channel, place, language, address));
      const response = await fetch(`${ALERTS_API}/alerts/subscriptions`, await signedJsonPost(body));
      if (!response.ok) throw new Error(await failure(response));
      const answer = (await response.json()) as SubscriptionAnswer;
      setStatus(
        channel === "telegram"
          ? { kind: "telegram", link: telegramLink(answer) }
          : channel === "sms"
            ? { kind: "sms", place: answeredPlace(answer) ?? place }
            : { kind: "email" },
      );
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (status.kind === "telegram")
    return (
      <div className="signup signup--done" role="status">
        <p className="signup__title">{t.signup.telegramConfirmTitle}</p>
        {status.link ? (
          <>
            <p>{t.signup.telegramConfirmBody(place ? placeLabel(place) : "")}</p>
            <a className="landing__cta" href={status.link} target="_blank" rel="noopener noreferrer">
              {t.signup.telegramBtn}
            </a>
          </>
        ) : (
          <p>{t.signup.telegramNotConnected}</p>
        )}
      </div>
    );
  if (status.kind === "sms")
    return (
      <div className="signup signup--done" role="status">
        <p className="signup__title">You are subscribed</p>
        <p>
          We sent a text to the phone to say so. From now on it gets a text when the satellites see a possible fire
          within about 50 km of {status.place ? placeLabel(status.place) : "your town"}. Nothing to reply: it
          arrives without mobile data, as long as the phone has signal.
        </p>
      </div>
    );
  if (status.kind === "email")
    return (
      <div className="signup signup--done" role="status">
        <p className="signup__title">{t.signup.emailConfirmTitle}</p>
        <p>{t.signup.emailConfirmBody(place ? placeLabel(place) : "")}</p>
      </div>
    );

  return (
    <form className="signup" onSubmit={submit} noValidate>
      <fieldset className="signup__group">
        <legend>{t.signup.townGroup}</legend>
        <div className="signup__row">
          <input
            type="text"
            aria-label={t.signup.townGroup}
            placeholder={t.signup.townPlaceholder}
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
            {t.signup.findBtn}
          </button>
          <button type="button" className="signup__locate" onClick={locate} disabled={!ALERTS_API}>
            {t.signup.useLocation}
          </button>
        </div>
        {found && found.length > 1 && (
          <div className="signup__channels" role="radiogroup" aria-label={lang === "es" ? "Localidades coincidentes" : "Matching towns"}>
            {found.map((option) => (
              <label key={`${option.lat},${option.lng},${option.name}`} className="signup__channel">
                <input type="radio" name={`${id}-place`} checked={place === option} onChange={() => setPlace(option)} />
                {placeLabel(option)}
              </label>
            ))}
          </div>
        )}
        {place && <p className="signup__hint">{t.signup.radiusHint(placeLabel(place))}</p>}
        {hint && <p className="signup__hint">{hint}</p>}
      </fieldset>

      <fieldset className="signup__group">
        <legend>{t.signup.channelGroup}</legend>
        <div className="signup__channels">
          {channels.map((entry) => (
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
          <span className="signup__hint">
            Works without mobile data. The phone still needs cellular signal.
            {!place && " With no town chosen above, the alerts are about the town of this number's area code."}
          </span>
          {fieldError && (
            <span id={`${id}-error`} className="signup__error">
              {fieldError}
            </span>
          )}
        </label>
      )}

      {channel === "email" && (
        <label className="signup__group" htmlFor={`${id}-address`}>
          <span className="signup__label">{t.signup.emailLabel}</span>
          <input
            id={`${id}-address`}
            type="email"
            autoComplete="email"
            placeholder={t.signup.emailPlaceholder}
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

      <button type="submit" className="landing__cta" disabled={!ALERTS_API || !canSignUp(channel, place) || status.kind === "sending"}>
        {status.kind === "sending" ? t.signup.submitting : t.signup.submitBtn}
      </button>
      {!ALERTS_API && (
        <p className="signup__hint">{t.signup.serviceClosed}</p>
      )}
      {status.kind === "error" && (
        <p className="signup__error" role="alert">
          {status.message} {t.fireReport.tryAgainLater}
        </p>
      )}
    </form>
  );
}
