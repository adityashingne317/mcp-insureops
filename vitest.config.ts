import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      // In-memory SQLite for diffStore - no file I/O, isolated per test run.
      DB_PATH: ":memory:",
      DIFF_TTL_SECONDS: "900",
    },
  },
});
