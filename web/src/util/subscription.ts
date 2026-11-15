/**
 * The alert sign-up, as the alert service takes it (`POST /alerts/subscriptions`):
 * a town, as `GET /alerts/places` returns it, and a channel. The service derives
 * the cells around the town itself and warns about a possible fire within about
 * 50 km of it, so the page never sends cells or zones.
 *
 * Telegram needs no address: the answer carries a `confirm_url` to the bot, and
 * pressing Start there is the confirmation. E-mail gets a confirmation link.
 * SMS asks for no reply: the number is subscribed at once and gets one text that
 * says so, which works without mobile data. An SMS sign-up may leave the town
 * out; the service then uses the town of the number's area code and says which.
 */

export type Channel = "telegram" | "sms" | "email";

export const CHANNELS: { value: Channel; label: string }[] = [
  { value: "telegram", label: "Telegram" },
  { value: "sms", label: "SMS" },
  { value: "email", label: "Email" },
];

export interface Place {
  name: string;
  region?: string;
  country?: string;
  lat: number;
  lng: number;
}

export interface SubscriptionRequest {
  channel: Channel;
  /** Left out only by an SMS sign-up with no town chosen. */
  place?: Place;
  address?: string;
  language: "es" | "en";
}

/**
 * The answer of a sign-up: Telegram ones carry the link that confirms them, and
 * SMS ones the town the alerts are about, which may come from the area code.
 */
export interface SubscriptionAnswer {
  id: string;
  status: string;
  confirm_url?: string;
  place?: Place;
}

/** Only SMS can sign up with no town: a phone number says where it is from. */
export function canSignUp(channel: Channel, place: Place | null): boolean {
  return place !== null || channel === "sms";
}

/** The town of an SMS answer, if it is one the page can show. */
export function answeredPlace(answer: SubscriptionAnswer): Place | null {
  const place = answer.place;
  return place && typeof place.name === "string" && Number.isFinite(place.lat) && Number.isFinite(place.lng)
    ? place
    : null;
}

/** "Resistencia, Chaco, Argentina", skipping what is missing or repeated. */
export function placeLabel(place: Place): string {
  const parts = [place.name, place.region, place.country].filter((part): part is string => Boolean(part));
  return parts.filter((part, index) => parts.indexOf(part) === index).join(", ");
}

export function normalizePhone(raw: string): { address: string } | { error: string } {
  const digits = raw.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(digits)
    ? { address: digits }
    : { error: "Enter the number with its country code, starting with +." };
}

export function normalizeEmail(raw: string): { address: string } | { error: string } {
  const value = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? { address: value.toLowerCase() }
    : { error: "Enter an email address like name@example.org." };
}

/** Spanish unless the browser says English: the alerts go to people in the Chaco. */
export function alertLanguage(browserLanguage: string | undefined): "es" | "en" {
  return (browserLanguage ?? "").toLowerCase().startsWith("en") ? "en" : "es";
}

/** The point the browser shares, as a place: rounded to about 1 km, as the service keeps it. */
export function placeFromPosition(lat: number, lng: number): Place {
  return { name: "My location", lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
}

export function placesUrl(base: string, query: string, language: "es" | "en"): string {
  return `${base.replace(/\/+$/, "")}/alerts/places?${new URLSearchParams({ q: query.trim(), language })}`;
}

export function subscriptionRequest(
  channel: Channel,
  place: Place | null,
  language: "es" | "en",
  address?: string,
): SubscriptionRequest {
  return {
    channel,
    ...(place && { place }),
    language,
    ...((channel === "email" || channel === "sms") && address && { address }),
  };
}

/** Only a t.me link is ever offered as the Telegram confirmation. */
export function telegramLink(answer: SubscriptionAnswer): string | null {
  const url = answer.confirm_url;
  return url && /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]{1,64}$/.test(url) ? url : null;
}
