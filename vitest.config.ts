import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Tests must never reach the real LMS; client tests inject a fake fetch.
    environment: "node",
    // Several files each run an in-process Postgres (PGlite); under parallel load single queries can take seconds.
    testTimeout: 20_000,
  },
});
