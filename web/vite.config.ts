/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    allowedHosts: true,
  },
  build: {
    // The map and the intro scene are split into their own chunks; deck.gl and
    // three are large by nature, so the default 500 kB warning is just noise.
    chunkSizeWarningLimit: 1600,
  },
  test: {
    environment: "node",
    include: ["src/test/**/*.test.ts"],
  },
});
