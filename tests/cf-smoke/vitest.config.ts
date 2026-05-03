import { defineConfig } from "vitest/config";

/**
 * CF Worker smoke suite config.
 *
 * Runs against a live `pnpm dev:cf` instance — never against ephemeral state.
 * Tests are sequential to avoid hammering the dev DB and to make failure
 * output easier to read.
 *
 * Watch mode (pnpm test:cf-smoke:watch): forceRerunTriggers tells vitest to
 * re-run the suite when ANY of these glob-matched files change. Without
 * this, vitest only re-runs on spec-file edits — server route changes go
 * unnoticed because the spec talks to the running server over HTTP and has
 * no static import dependency on those files.
 *
 * Triggers cover the surfaces that can change observed API behaviour:
 *   - server/src/                       (route handlers, services)
 *   - packages/deploy-cloudflare/src/   (worker bundles, CF-native shadows)
 *   - packages/deploy-cloudflare/dist/worker.js  (the actual loaded worker)
 *   - packages/adapters/<slash>src/    (adapter behaviour — see globs below)
 *
 * The dev:cf orchestrator already rebuilds dist/worker.js on src changes
 * via esbuild --watch, so by the time vitest re-fires the suite the
 * worker has the latest code loaded.
 */
export default defineConfig({
  test: {
    include: ["tests/cf-smoke/**/*.spec.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["default"],
    forceRerunTriggers: [
      "**/package.json",
      "server/src/**/*.{ts,tsx,js,mjs}",
      "packages/deploy-cloudflare/src/**/*.{ts,tsx,js,mjs}",
      "packages/deploy-cloudflare/dist/worker.js",
      "packages/adapters/**/src/**/*.{ts,tsx,js,mjs}",
      "packages/adapter-utils/src/**/*.{ts,tsx,js,mjs}",
      "packages/db/src/**/*.{ts,tsx,js,mjs}",
      "packages/shared/src/**/*.{ts,tsx,js,mjs}",
    ],
  },
});
