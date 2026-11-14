import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Synthesizing a full app takes a few seconds on a cold cache.
    testTimeout: 60_000,
  },
});
