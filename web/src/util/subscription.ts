export type Channel = "telegram" | "whatsapp" | "email";

export const CHANNELS: { value: Channel; label: string; field: string; placeholder: string }[] = [
  { value: "telegram", label: "Telegram", field: "Telegram username", placeholder: "@username" },
  { value: "whatsapp", label: "WhatsApp", field: "Phone number with country code", placeholder: "+54 9 362 400 0000" },
  { value: "email", label: "Email", field: "Email address", placeholder: "name@example.org" },
];

/** The body of `POST /alerts/subscriptions`, as agreed with the backend. */
export interface SubscriptionRequest {
  channel: Channel;
  address: string;
  /** H3 cells the subscriber wants to hear about. */
  cells: string[];
  zone_id?: string;
}

/** The address as the backend stores it, or the reason it cannot be used. */
export function normalizeAddress(channel: Channel, raw: string): { address: string } | { error: string } {
  const value = raw.trim();
  if (channel === "email")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { address: value.toLowerCase() } : { error: "Enter an email address like name@example.org." };
  if (channel === "whatsapp") {
    const digits = value.replace(/[\s().-]/g, "");
    return /^\+\d{8,15}$/.test(digits)
      ? { address: digits }
      : { error: "Enter the number with its country code, starting with +." };
  }
  const name = value.replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name)
    ? { address: `@${name}` }
    : { error: "Enter a Telegram username: 5 to 32 letters, digits or _." };
}

export function subscriptionRequest(channel: Channel, address: string, cells: string[], zoneId?: string): SubscriptionRequest {
  return { channel, address, cells, ...(zoneId && { zone_id: zoneId }) };
}
