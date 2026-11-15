import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Synthesizing a full app takes a few seconds on a cold cache, and every
    // file does it once in a beforeAll, so hooks get the same budget as tests:
    // on a slow CI runner the 10 s hook default ran out with nothing wrong.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
