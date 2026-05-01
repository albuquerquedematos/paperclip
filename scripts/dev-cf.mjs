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

// Build the worker bundle and the UI dist BEFORE launching wrangler. The
// worker uses esbuild --watch, the UI uses vite build --watch — but the
// initial build has to be present on disk because:
//   • dist/worker.js is what wrangler --no-bundle loads at startup
//   • ui/dist/* is served by the ASSETS binding; if it's stale, wrangler
//     hands the operator an outdated SPA bundle even after edits to ui/src
async function runOnce(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit" });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  if (exitCode !== 0) {
    console.error(`[dev:cf] initial ${label} build failed (exit ${exitCode})`);
    process.exit(exitCode ?? 1);
  }
}
await runOnce("worker", "node", ["build-worker.mjs"], path.join(repoRoot, "packages/deploy-cloudflare"));
// Skip the UI build if dist already has a recent index. This keeps quick
// restarts fast (vite build is ~8s) while still guaranteeing freshness.
const uiDistFresh = await isUiDistFresh();
if (!uiDistFresh) {
  console.log("[dev:cf] ui/dist is stale or missing — running initial vite build (~8s)");
  await runOnce("ui", "pnpm", ["--filter", "@paperclipai/ui", "build"], repoRoot);
}

async function isUiDistFresh() {
  const fs = await import("node:fs/promises");
  const distAssets = path.join(repoRoot, "ui/dist/assets");
  const srcDir = path.join(repoRoot, "ui/src");
  try {
    const distFiles = await fs.readdir(distAssets);
    if (distFiles.length === 0) return false;
    // Newest dist mtime vs newest src mtime.
    async function newestMtime(dir) {
      let newest = 0;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(full));
        else newest = Math.max(newest, (await fs.stat(full)).mtimeMs);
      }
      return newest;
    }
    const distMtime = await newestMtime(distAssets);
    const srcMtime = await newestMtime(srcDir);
    return distMtime >= srcMtime;
  } catch {
    return false;
  }
}

// concurrently is at the root; reach it directly so this script doesn't depend
// on workspace-package CLI resolution.
const concurrentlyBin = path.join(repoRoot, "node_modules/.bin/concurrently");

// concurrently feeds each command string to a shell. We need wrangler to
// run from packages/deploy-cloudflare (where wrangler.toml lives), with
// nvm-loaded Node 22 and the picked SIDECAR_URL injected via --var.
//
// Boot race fix: poll the server's /api/health BEFORE starting wrangler.
// The server takes a few seconds to bring up embedded postgres; if wrangler
// starts first and the UI immediately fires requests, the worker tries to
// open a postgres TCP connection that fails with ECONNREFUSED, and the
// async rejection takes down workerd. Polling adds at most a couple of
// seconds at startup and eliminates that whole class of crash.
//
// Outer single quotes keep the bash -c argument verbatim; in JS template
// literals \${...} avoids JS interpolation.
const wranglerCmd =
  `bash -c 'echo "[dev:cf] waiting for server on ${sidecarUrl}/api/health ..." && ` +
  `for i in $(seq 1 60); do ` +
  `  curl -sf -o /dev/null --max-time 1 ${sidecarUrl}/api/health && ` +
  `    echo "[dev:cf] server ready, starting wrangler" && break; ` +
  `  sleep 1; ` +
  `done && ` +
  `cd packages/deploy-cloudflare && ` +
  `source "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use 22 && ` +
  `wrangler dev --no-bundle --local --var SIDECAR_URL:${sidecarUrl}'`;

const args = [
  "--kill-others-on-fail",
  "--names", "server,esbuild,vite,wrangler",
  "--prefix-colors", "blue,yellow,magenta,green",
  // server: pinned to the picked port
  `PORT=${port} pnpm --filter @paperclipai/server dev:watch`,
  // esbuild watch: rebuilds dist/worker.js on worker source edits
  "pnpm --filter @paperclipai/deploy-cloudflare build:watch",
  // vite watch: rebuilds ui/dist on UI source edits so wrangler's ASSETS
  // binding always serves the latest SPA bundle. Without this, edits to
  // ui/src/* never reach the browser via /api/*-relative dev:cf flow.
  "pnpm --filter @paperclipai/ui build:watch",
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
