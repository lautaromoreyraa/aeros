import { describe, expect, it } from "vitest";
import { normalizeAddress, subscriptionRequest } from "../../util/subscription";

describe("normalizeAddress", () => {
  it("lower-cases a valid email and rejects a malformed one", () => {
    expect(normalizeAddress("email", " Brigada@Chaco.gob.ar ")).toEqual({ address: "brigada@chaco.gob.ar" });
    expect(normalizeAddress("email", "brigada@")).toHaveProperty("error");
  });

  it("keeps a phone number in international form", () => {
    expect(normalizeAddress("whatsapp", "+54 9 (362) 400-0000")).toEqual({ address: "+5493624000000" });
    expect(normalizeAddress("whatsapp", "362 400 0000")).toHaveProperty("error");
  });

  it("accepts a Telegram username with or without @", () => {
    expect(normalizeAddress("telegram", "brigada_chaco")).toEqual({ address: "@brigada_chaco" });
    expect(normalizeAddress("telegram", "@bc")).toHaveProperty("error");
  });
});

describe("subscriptionRequest", () => {
  it("sends the zone only when there is one", () => {
    expect(subscriptionRequest("email", "a@b.co", ["c1"], "py")).toEqual({ channel: "email", address: "a@b.co", cells: ["c1"], zone_id: "py" });
    expect(subscriptionRequest("email", "a@b.co", ["c1"])).not.toHaveProperty("zone_id");
  });
});
