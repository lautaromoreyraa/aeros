import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signedJsonPost } from "../../api/signedPost";

describe("signedJsonPost", () => {
  it("carries the hash of the exact body, which CloudFront needs to sign it", async () => {
    const body = JSON.stringify({ channel: "sms", address: "+5493624000000", language: "es" });
    const init = await signedJsonPost(body);
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("hashes accented text as UTF-8, as the body is sent", async () => {
    const body = JSON.stringify({ place: { name: "Presidencia Roque Sáenz Peña" } });
    const headers = (await signedJsonPost(body)).headers as Record<string, string>;
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
  });
});
