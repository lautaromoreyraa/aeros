import { describe, expect, it } from "vitest";
import {
  alertLanguage,
  answeredPlace,
  canSignUp,
  normalizeEmail,
  normalizePhone,
  placeFromPosition,
  placeLabel,
  placesUrl,
  subscriptionRequest,
  telegramLink,
} from "../../util/subscription";

const RESISTENCIA = { name: "Resistencia", region: "Chaco", country: "Argentina", lat: -27.45, lng: -58.99 };

describe("normalizeEmail", () => {
  it("lower-cases a valid email and rejects a malformed one", () => {
    expect(normalizeEmail(" Brigada@Chaco.gob.ar ")).toEqual({ address: "brigada@chaco.gob.ar" });
    expect(normalizeEmail("brigada@")).toHaveProperty("error");
  });
});

describe("normalizePhone", () => {
  it("keeps a number in international form", () => {
    expect(normalizePhone("+54 9 (362) 400-0000")).toEqual({ address: "+5493624000000" });
    expect(normalizePhone("362 400 0000")).toHaveProperty("error");
  });
});

describe("subscriptionRequest", () => {
  it("sends the town, never cells or zones", () => {
    const body = subscriptionRequest("telegram", RESISTENCIA, "es");
    expect(body).toEqual({ channel: "telegram", place: RESISTENCIA, language: "es" });
    expect(body).not.toHaveProperty("cells");
  });

  it("carries an address for e-mail and SMS, never for Telegram", () => {
    expect(subscriptionRequest("email", RESISTENCIA, "en", "a@b.co")).toHaveProperty("address", "a@b.co");
    expect(subscriptionRequest("sms", RESISTENCIA, "es", "+5493624000000")).toHaveProperty("address", "+5493624000000");
    expect(subscriptionRequest("telegram", RESISTENCIA, "es", "a@b.co")).not.toHaveProperty("address");
  });

  it("leaves the town out of an SMS sign-up that has none", () => {
    expect(subscriptionRequest("sms", null, "es", "+5493624000000")).toEqual({
      channel: "sms",
      language: "es",
      address: "+5493624000000",
    });
  });
});

describe("canSignUp", () => {
  it("lets only SMS go without a town", () => {
    expect(canSignUp("sms", null)).toBe(true);
    expect(canSignUp("telegram", null)).toBe(false);
    expect(canSignUp("email", null)).toBe(false);
    expect(canSignUp("email", RESISTENCIA)).toBe(true);
  });
});

describe("answeredPlace", () => {
  it("reads the town the service chose and ignores a malformed one", () => {
    expect(answeredPlace({ id: "x", status: "subscribed", place: RESISTENCIA })).toEqual(RESISTENCIA);
    expect(answeredPlace({ id: "x", status: "subscribed" })).toBeNull();
    const broken = { id: "x", status: "subscribed", place: { name: "Resistencia" } } as never;
    expect(answeredPlace(broken)).toBeNull();
  });
});

it("labels a town without repeating parts", () => {
  expect(placeLabel(RESISTENCIA)).toBe("Resistencia, Chaco, Argentina");
  expect(placeLabel({ name: "Asunción", region: "Asunción", country: "Paraguay", lat: 0, lng: 0 })).toBe(
    "Asunción, Paraguay",
  );
});

it("speaks Spanish unless the browser is in English", () => {
  expect(alertLanguage("en-US")).toBe("en");
  expect(alertLanguage("es-AR")).toBe("es");
  expect(alertLanguage("pt-BR")).toBe("es");
  expect(alertLanguage(undefined)).toBe("es");
});

it("rounds a shared position to about 1 km", () => {
  expect(placeFromPosition(-27.45678, -58.98712)).toEqual({ name: "My location", lat: -27.46, lng: -58.99 });
});

it("builds the town search URL", () => {
  expect(placesUrl("/api/", " Resistencia ", "es")).toBe("/api/alerts/places?q=Resistencia&language=es");
});

describe("telegramLink", () => {
  it("offers only a t.me start link", () => {
    expect(telegramLink({ id: "x", status: "p", confirm_url: "https://t.me/aeros_fire_alerts_bot?start=abc_1" })).toBe(
      "https://t.me/aeros_fire_alerts_bot?start=abc_1",
    );
    expect(telegramLink({ id: "x", status: "p", confirm_url: "https://evil.example/t.me" })).toBeNull();
    expect(telegramLink({ id: "x", status: "p" })).toBeNull();
  });
});
