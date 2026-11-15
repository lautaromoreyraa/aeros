// Cloudflare Access sits in front of the Worker and rejects anyone without a
// valid identity or service token. The Worker still verifies the signed
// assertion Access forwards: if the route were ever exposed without Access
// (a misconfigured hostname, workers.dev left on), requests would carry no
// valid assertion and fail here instead of reaching the tools.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessConfig {
  teamDomain: string; // e.g. "aeros.cloudflareaccess.com"
  audience: string; // Access application AUD tag
}

export interface Identity {
  /** Email for people, `service:<client id>` for service tokens (Devin, Grok). */
  author: string;
  kind: "user" | "service";
}

export class AccessError extends Error {}

const keySets = new Map<string, JWTVerifyGetKey>();

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

export async function verifyAccess(
  request: Request,
  config: AccessConfig,
  keys: JWTVerifyGetKey = remoteKeys(config.teamDomain),
): Promise<Identity> {
  if (!config.teamDomain || !config.audience) {
    throw new AccessError("Access is not configured");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AccessError("missing Access assertion");
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
    });
    if (typeof payload.email === "string" && payload.email) {
      return { author: payload.email, kind: "user" };
    }
    if (typeof payload.common_name === "string" && payload.common_name) {
      return { author: `service:${payload.common_name}`, kind: "service" };
    }
    throw new AccessError("assertion carries no identity");
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError("invalid Access assertion");
  }
}
