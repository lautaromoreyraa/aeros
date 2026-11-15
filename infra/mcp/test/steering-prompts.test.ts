import { beforeEach, describe, expect, it } from "vitest";
import {
  InvalidTimeError,
  type NewSteeringPrompt,
  SecretInTextError,
  Store,
} from "../src/store";
import { migratedDatabase } from "./sqlite-d1";

const claude = { author: "service:shared-token", agent: "claude" };
const devin = { author: "service:shared-token", agent: "devin" };
const now = new Date("2026-11-14T18:00:00Z");

function entry(overrides: Partial<NewSteeringPrompt> = {}): NewSteeringPrompt {
  return {
    promptedBy: "lautaro",
    category: "scope",
    importance: 3,
    title: "Reuse David's downloader",
    prompt: "Sí, reencauzar",
    situation: "Both of us were downloading the same FIRMS archive.",
    decision: "Drop the own downloader and the rectangular cut; use aeros fetch.",
    ...overrides,
  };
}

describe("steering prompts", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(migratedDatabase());
  });

  it("stores the prompt with who wrote it, who typed it and which assistant logged it", async () => {
    const saved = await store.recordSteeringPrompt(claude, entry(), now);
    expect(saved).toMatchObject({
      prompted_by: "lautaro",
      author: claude.author,
      agent: "claude",
      category: "scope",
      importance: 3,
      impact: "",
      refs: "",
    });
    expect(saved.id).toBeGreaterThan(0);
  });

  it("lists both people's prompts oldest first, by the time they happened", async () => {
    await store.recordSteeringPrompt(claude, entry({ title: "second", occurredAt: "2026-11-14T15:00:00Z" }), now);
    await store.recordSteeringPrompt(
      devin,
      entry({ promptedBy: "david", title: "first", occurredAt: "2026-11-13T09:30:00Z" }),
      now,
    );
    const titles = (await store.steeringPrompts()).map((p) => `${p.prompted_by}:${p.title}`);
    expect(titles).toEqual(["david:first", "lautaro:second"]);
  });

  it("filters by person, category, importance and start time", async () => {
    await store.recordSteeringPrompt(claude, entry({ title: "a", importance: 3 }), now);
    await store.recordSteeringPrompt(devin, entry({ title: "b", promptedBy: "david", category: "data", importance: 1 }), now);
    await store.recordSteeringPrompt(claude, entry({ title: "c", category: "data", importance: 2, occurredAt: "2026-01-01" }), now);

    const titles = async (f: Parameters<Store["steeringPrompts"]>[0]) =>
      (await store.steeringPrompts(f)).map((p) => p.title).sort();
    expect(await titles({ promptedBy: "david" })).toEqual(["b"]);
    expect(await titles({ category: "data" })).toEqual(["b", "c"]);
    expect(await titles({ minImportance: 2 })).toEqual(["a", "c"]);
    expect(await titles({ since: "2026-06-01" })).toEqual(["a", "b"]);
  });

  it("refuses a credential in any text field and stores nothing", async () => {
    const leak = "use ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    await expect(store.recordSteeringPrompt(claude, entry({ prompt: leak }), now)).rejects.toMatchObject({
      field: "prompt",
    });
    await expect(store.recordSteeringPrompt(claude, entry({ refs: leak }), now)).rejects.toBeInstanceOf(
      SecretInTextError,
    );
    expect(await store.steeringPrompts()).toEqual([]);
  });

  it("refuses times that are not dates or lie in the future", async () => {
    await expect(
      store.recordSteeringPrompt(claude, entry({ occurredAt: "yesterday-ish" }), now),
    ).rejects.toBeInstanceOf(InvalidTimeError);
    await expect(
      store.recordSteeringPrompt(claude, entry({ occurredAt: "2026-11-15T00:00:00Z" }), now),
    ).rejects.toBeInstanceOf(InvalidTimeError);
    expect(await store.steeringPrompts()).toEqual([]);
  });

  it("rejects a person the team does not have", async () => {
    await expect(
      store.recordSteeringPrompt(claude, entry({ promptedBy: "grok" as never }), now),
    ).rejects.toThrow();
  });
});
