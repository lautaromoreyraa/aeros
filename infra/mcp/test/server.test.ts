import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { PipelineData } from "../src/data";
import { buildServer } from "../src/server";
import { Store } from "../src/store";
import { migratedDatabase } from "./sqlite-d1";

// Talks to the real tool definitions through an in-memory transport, so the
// input schemas and the error mapping are exercised, not only the store.
async function connect() {
  const store = new Store(migratedDatabase());
  const data = new PipelineData("http://127.0.0.1:1");
  const server = buildServer(store, data, { author: "service:shared-token", kind: "service" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    return { text: block?.text ?? "", isError: Boolean(result.isError) };
  };
  return { call, client, store };
}

const turningPoint = {
  prompted_by: "lautaro",
  category: "scope",
  importance: 3,
  title: "Reuse David's downloader",
  prompt: "Sí, reencauzar",
  situation: "Both of us were downloading the same archive.",
  decision: "Use aeros fetch and drop the rectangular cut.",
  agent: "claude",
};

describe("steering prompt tools", () => {
  let session: Awaited<ReturnType<typeof connect>>;
  beforeEach(async () => {
    session = await connect();
  });

  it("lists the new tools and the convention that explains them", async () => {
    const names = (await session.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["record_steering_prompt", "steering_study"]));
    const keys = (await session.store.conventions()).map((c) => c.key);
    expect(keys).toContain("prompt_log");
  });

  it("records a prompt, counts it in the status and renders the study", async () => {
    const saved = await session.call("record_steering_prompt", turningPoint);
    expect(saved).toEqual({
      text: "steering prompt #1 recorded (scope, importance 3)",
      isError: false,
    });
    expect(JSON.parse((await session.call("project_status")).text).steering_prompts).toBe(1);

    const study = (await session.call("steering_study")).text;
    expect(study).toContain("### 1. Reuse David's downloader");
    expect(study).toContain("> Sí, reencauzar");

    const rows = JSON.parse((await session.call("steering_study", { format: "json" })).text);
    expect(rows[0]).toMatchObject({ prompted_by: "lautaro", agent: "claude" });
  });

  it("tells the caller to remove a credential and keeps nothing", async () => {
    const leaked = await session.call("record_steering_prompt", {
      ...turningPoint,
      prompt: "mi token es ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
    });
    expect(leaked.isError).toBe(true);
    expect(leaked.text).toContain("remove it and retry");
    expect(JSON.parse((await session.call("project_status")).text).steering_prompts).toBe(0);
  });

  it("rejects an unknown person and a future time before touching the store", async () => {
    const stranger = await session.call("record_steering_prompt", { ...turningPoint, prompted_by: "grok" });
    expect(stranger.isError).toBe(true);
    const future = await session.call("record_steering_prompt", {
      ...turningPoint,
      occurred_at: "2999-01-01",
    });
    expect(future.isError).toBe(true);
    expect(future.text).toContain("in the future");
  });

  it("filters the study by person", async () => {
    await session.call("record_steering_prompt", turningPoint);
    await session.call("record_steering_prompt", { ...turningPoint, prompted_by: "david", title: "Mine" });
    const onlyDavid = (await session.call("steering_study", { prompted_by: "david" })).text;
    expect(onlyDavid).toContain("Mine");
    expect(onlyDavid).not.toContain("Reuse David's downloader");
  });
});
