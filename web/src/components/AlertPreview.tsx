import type { AlertMessage } from "../util/alertMessage";

const sentAt = (iso: string) => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(time);
};

const sentOn = (iso: string) => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(time) + " UTC";
};

const HexMark = () => (
  <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
    <polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="currentColor" />
  </svg>
);

interface Props {
  message: AlertMessage;
  /** When the report behind the message was written. */
  generatedAt: string;
}

/**
 * The same early-warning message as it lands in a text message and in an
 * inbox. Both are rendered from {@link AlertMessage}, the text the banner
 * stands behind, so the two channels can never disagree.
 */
export function AlertPreview({ message, generatedAt }: Props) {
  const more = message.more > 0 ? `and ${message.more} more ${message.more === 1 ? "area" : "areas"}` : null;
  return (
    <div className="alert-preview">
      <figure className="phone" aria-label="SMS message">
        <div className="phone__bar">
          <span className="phone__avatar">
            <HexMark />
          </span>
          <span>
            <strong>aeros early warning</strong>
            <small>SMS</small>
          </span>
        </div>
        <div className="phone__chat">
          <p className="phone__day">Today</p>
          <div className="bubble">
            <p className="bubble__title">{message.subject}</p>
            <p>{message.window}</p>
            {message.places.length > 0 && (
              <ul>
                {message.places.map((place) => (
                  <li key={place}>{place}</li>
                ))}
                {more && <li>{more}</li>}
              </ul>
            )}
            <p className="bubble__muted">{message.coverage}</p>
            <p className="bubble__time">{sentAt(generatedAt)}</p>
          </div>
        </div>
      </figure>

      <figure className="mail" aria-label="Email message">
        <dl className="mail__head">
          <dt>From</dt>
          <dd>aeros early warning</dd>
          <dt>Subject</dt>
          <dd>
            <strong>{message.subject}</strong>
          </dd>
          <dt>Sent</dt>
          <dd>{sentOn(generatedAt)}</dd>
        </dl>
        <div className="mail__body">
          <p>
            Satellite passes from {message.window} show{" "}
            {message.active ? "fire well above what these days usually bring:" : "no area burning above its normal."}
          </p>
          {message.places.length > 0 && (
            <ul>
              {message.places.map((place) => (
                <li key={place}>{place}</li>
              ))}
              {more && <li>{more}</li>}
            </ul>
          )}
          <p className="mail__muted">{message.coverage}</p>
          <p className="mail__muted">
            The usual is the median of the same days in earlier years. This is a statistical early warning, not an
            official fire alert.
          </p>
        </div>
      </figure>
    </div>
  );
}
