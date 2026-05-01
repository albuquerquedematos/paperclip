#!/usr/bin/env node
/**
 * dev-cf.mjs — orchestrate `dev:cf` with port auto-discovery.
 *
 * The Node server falls back to the next free port when its requested port
 * is busy. Wrangler reads SIDECAR_URL once at boot from .dev.vars, so it
 * stops matching the server whenever a previous dev:cf left a process behind
 * on the canonical port (or another tool is using it).
 *
 * This script:
 *   1. Finds a free TCP port starting from PAPERCLIP_DEV_SERVER_PORT
 *      (default 3100), walking up until one binds successfully.
 *   2. Builds the worker bundle once (so wrangler has dist/worker.js).
 *   3. Spawns three children via concurrently:
 *        - server:   PORT=<picked> pnpm --filter @paperclipai/server dev:watch
 *        - esbuild:  pnpm --filter @paperclipai/deploy-cloudflare build:watch
 *        - wrangler: same as before, but with --var SIDECAR_URL=http://127.0.0.1:<picked>
 *      so wrangler's runtime env overrides whatever .dev.vars says.
 *
 * --kill-others-on-fail makes a single Ctrl+C (or any child crashing) tear
 * the whole tree down cleanly. Subsequent runs always start clean.
 */
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const START_PORT = Number(process.env.PAPERCLIP_DEV_SERVER_PORT ?? 3100);
const MAX_ATTEMPTS = 20;

/** Resolve to the first port from `start` that is free; throws after `max` tries. */
async function findFreePort(start, max) {
  for (let port = start; port < start + max; port++) {
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`No free port found in [${start}, ${start + max})`);
}

const port = await findFreePort(START_PORT, MAX_ATTEMPTS);
const sidecarUrl = `http://127.0.0.1:${port}`;
console.log(`[dev:cf] picked server port ${port} (sidecarUrl=${sidecarUrl})`);

// Build the worker bundle once before launching wrangler. esbuild --watch
// keeps it fresh thereafter.
const buildResult = spawn("node", ["build-worker.mjs"], {
  cwd: path.join(repoRoot, "packages/deploy-cloudflare"),
  stdio: "inherit",
});
const buildExit = await new Promise((resolve) => buildResult.once("exit", resolve));
if (buildExit !== 0) {
  console.error(`[dev:cf] initial worker build failed (exit ${buildExit})`);
  process.exit(buildExit ?? 1);
}

// concurrently is at the root; reach it directly so this script doesn't depend
// on workspace-package CLI resolution.
const concurrentlyBin = path.join(repoRoot, "node_modules/.bin/concurrently");

const wranglerCmd = [
  "bash",
  "-c",
  `source "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 && wrangler dev --no-bundle --local --var SIDECAR_URL:${sidecarUrl}`,
].map((s) => JSON.stringify(s)).join(" ");

const args = [
  "--kill-others-on-fail",
  "--names", "server,esbuild,wrangler",
  "--prefix-colors", "blue,yellow,green",
  // server: pinned to the picked port
  `PORT=${port} pnpm --filter @paperclipai/server dev:watch`,
  // esbuild watch: rebuilds dist/worker.js on source edits
  "pnpm --filter @paperclipai/deploy-cloudflare build:watch",
  // wrangler: same launch as before, but injects SIDECAR_URL via --var so
  // it always matches the picked port, regardless of .dev.vars contents.
  wranglerCmd,
];

const child = spawn(concurrentlyBin, args, { cwd: repoRoot, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  console.error("[dev:cf] failed to spawn concurrently:", err);
  process.exit(1);
});
