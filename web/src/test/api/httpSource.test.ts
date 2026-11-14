import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpCalendarSource } from "../../api/httpSource";
import { monthKey } from "../../util/months";

const regionSource = { loadRegion: vi.fn(), forecast: vi.fn() };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpCalendarSource", () => {
  it("sends the body hash CloudFront needs to sign the request for Lambda", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpCalendarSource("https://example.test/api", regionSource).calendar({
      unit: "hotspots",
      cells: ["a", "b"],
      start: monthKey(2001, 1),
      end: monthKey(2002, 12),
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = init.body as string;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://example.test/api/calendar");
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
  });
});
