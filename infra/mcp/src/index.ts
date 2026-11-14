import { createMcpHandler } from "agents/mcp/server";
import { AccessError, type Identity, verifyAccess } from "./access";
import { PipelineData } from "./data";
import { buildServer } from "./server";
import { Store } from "./store";

export interface Env {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DATA_BASE_URL: string;
  /** Only for `wrangler dev`, set in .dev.vars; never defined in production. */
  LOCAL_DEV_IDENTITY?: string;
}

async function identify(request: Request, env: Env): Promise<Identity> {
  // The local identity is honored only while Access is not configured, so a
  // stray LOCAL_DEV_IDENTITY secret cannot open a deployed server.
  if (env.LOCAL_DEV_IDENTITY && !env.ACCESS_TEAM_DOMAIN) {
    return { author: env.LOCAL_DEV_IDENTITY, kind: "user" };
  }
  return verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

    let identity: Identity;
    try {
      identity = await identify(request, env);
    } catch (error) {
      const status = error instanceof AccessError ? 401 : 500;
      return new Response(status === 401 ? "unauthorized" : "error", { status });
    }

    const store = new Store(env.DB);
    const data = new PipelineData(env.DATA_BASE_URL);
    const handler = createMcpHandler(() => buildServer(store, data, identity), {
      route: "/mcp",
      authContext: { props: { author: identity.author } },
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
