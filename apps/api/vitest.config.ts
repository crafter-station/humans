import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 300_000,
    testTimeout: 300_000,
  },
});
