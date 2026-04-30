import { defineConfig } from "vitest/config";

/**
 * CF Worker smoke suite config.
 *
 * Runs against a live `pnpm dev:cf` instance — never against ephemeral state.
 * Tests are sequential to avoid hammering the dev DB and to make failure
 * output easier to read.
 */
export default defineConfig({
  test: {
    include: ["tests/cf-smoke/**/*.spec.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["default"],
  },
});
