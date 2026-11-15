import { describe, expect, it } from "vitest";
import {
  alertLanguage,
  normalizeEmail,
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

describe("subscriptionRequest", () => {
  it("sends the town, never cells or zones", () => {
    const body = subscriptionRequest("telegram", RESISTENCIA, "es");
    expect(body).toEqual({ channel: "telegram", place: RESISTENCIA, language: "es" });
    expect(body).not.toHaveProperty("cells");
  });

  it("carries an address only for e-mail", () => {
    expect(subscriptionRequest("email", RESISTENCIA, "en", "a@b.co")).toHaveProperty("address", "a@b.co");
    expect(subscriptionRequest("telegram", RESISTENCIA, "es", "a@b.co")).not.toHaveProperty("address");
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
