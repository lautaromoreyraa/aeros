import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AccessError, verifyAccess } from "../src/access";

const config = { teamDomain: "team.cloudflareaccess.com", audience: "aud-123" };

let keys: ReturnType<typeof createLocalJWKSet>;
let sign: (claims: Record<string, unknown>, overrides?: { iss?: string; aud?: string }) => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
  sign = (claims, overrides = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(overrides.iss ?? `https://${config.teamDomain}`)
      .setAudience(overrides.aud ?? config.audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
});

function request(token?: string): Request {
  return new Request("https://mcp.example.dev/mcp", {
    headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
  });
}

describe("verifyAccess", () => {
  it("identifies people by email", async () => {
    const identity = await verifyAccess(request(await sign({ email: "a@b.dev" })), config, keys);
    expect(identity).toEqual({ author: "a@b.dev", kind: "user" });
  });

  it("identifies service tokens by client id", async () => {
    const identity = await verifyAccess(request(await sign({ common_name: "abc.access" })), config, keys);
    expect(identity).toEqual({ author: "service:abc.access", kind: "service" });
  });

  it("rejects a missing assertion", async () => {
    await expect(verifyAccess(request(), config, keys)).rejects.toBeInstanceOf(AccessError);
  });

  it("rejects another application's audience", async () => {
    const token = await sign({ email: "a@b.dev" }, { aud: "other-app" });
    await expect(verifyAccess(request(token), config, keys)).rejects.toBeInstanceOf(AccessError);
  });

  it("rejects another team's issuer", async () => {
    const token = await sign({ email: "a@b.dev" }, { iss: "https://evil.cloudflareaccess.com" });
    await expect(verifyAccess(request(token), config, keys)).rejects.toBeInstanceOf(AccessError);
  });

  it("refuses to run unconfigured", async () => {
    const token = await sign({ email: "a@b.dev" });
    await expect(
      verifyAccess(request(token), { teamDomain: "", audience: "" }, keys),
    ).rejects.toBeInstanceOf(AccessError);
  });
});
