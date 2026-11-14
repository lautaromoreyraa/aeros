import { beforeEach, describe, expect, it } from "vitest";
import { GIT_WORKFLOW_ORDER, Store, TaskConflictError } from "../src/store";
import { migratedDatabase } from "./sqlite-d1";

const lautaro = { author: "lautaro@example.com", agent: "claude" };
const partner = { author: "service:devin-token", agent: "devin" };

describe("Store", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(migratedDatabase());
  });

  it("seeds the team conventions", async () => {
    const keys = (await store.conventions()).map((c) => c.key);
    expect(keys).toContain("language");
    expect(keys).toContain("branches");
    expect(keys).toContain("aws_free_plan");
    expect(keys).toContain("aws_docs");
  });

  it("lists the git workflow in the order a change goes through it", async () => {
    const steps = (await store.gitWorkflow()).map((c) => c.key);
    expect(steps).toEqual(GIT_WORKFLOW_ORDER);
    const sync = (await store.gitWorkflow()).find((c) => c.key === "sync_with_develop");
    expect(sync?.value).toContain("git rebase origin/develop");
  });

  it("returns progress newest first", async () => {
    await store.logProgress(lautaro, "model trained");
    await store.logProgress(partner, "calendar drawn");
    const entries = await store.recentProgress();
    expect(entries.map((e) => e.text)).toEqual(["calendar drawn", "model trained"]);
    expect(entries[0]?.agent).toBe("devin");
  });

  it("lets only one owner hold a task", async () => {
    await store.claimTask(lautaro, "web/src/map", "deck.gl layer");
    await expect(store.claimTask(partner, "web/src/map", "")).rejects.toBeInstanceOf(TaskConflictError);
    await expect(store.releaseTask(partner, "web/src/map")).rejects.toBeInstanceOf(TaskConflictError);
    expect(await store.releaseTask(lautaro, "web/src/map")).toBe(true);
    const claimed = await store.claimTask(partner, "web/src/map", "");
    expect(claimed.owner).toBe(partner.author);
  });

  it("re-claiming your own task updates its note", async () => {
    await store.claimTask(lautaro, "infra", "first");
    const again = await store.claimTask(lautaro, "infra", "second");
    expect(again.note).toBe("second");
    expect(await store.tasks()).toHaveLength(1);
  });

  it("overwrites a convention and records who changed it", async () => {
    await store.setConvention(partner, "language", "English only");
    const language = (await store.conventions()).find((c) => c.key === "language");
    expect(language?.value).toBe("English only");
    expect(language?.updated_by).toBe(partner.author);
  });
});
