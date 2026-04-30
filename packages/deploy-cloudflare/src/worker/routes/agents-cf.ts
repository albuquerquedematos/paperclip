/**
 * routes/agents-cf.ts
 *
 * CF-native handlers for agent routes that the server implements with
 * `child_process.spawn(claude)` and `node:fs/promises`. Both are unavailable
 * in CF Workers, so these requests are proxied to the sidecar — the Node
 * server runs the original handler with full host capabilities.
 *
 * Routes covered:
 *   POST   /api/agents/:id/wakeup                       — heartbeatService.wakeup
 *   POST   /api/agents/:id/heartbeat/invoke             — heartbeatService.invoke
 *   POST   /api/agents/:id/claude-login                 — claude OAuth flow
 *   GET    /api/agents/:id/instructions-bundle          — fs read of bundle dir
 *   GET    /api/agents/:id/instructions-bundle/file     — fs read of one file
 *   PUT    /api/agents/:id/instructions-bundle/file     — fs write
 *   DELETE /api/agents/:id/instructions-bundle/file     — fs unlink
 *
 * Without these CF-native shadows the auto-bridged server handlers run
 * inside the worker and fail with `node:fs/promises not available` or
 * `Command not found in PATH: "claude"`.
 *
 * NOTE on Anthropic API direct mode: a future option is to add a CF-safe
 * adapter that calls api.anthropic.com from the worker (no sidecar required).
 * That requires reimplementing the agent loop and replacing CLI tools with
 * R2 + sidecar-exec equivalents — a significant rewrite. Until then, the
 * sidecar handles all real agent execution.
 *
 * Auth: every handler resolves an actor before proxying; unauthenticated
 * callers get 401 (matches the server's middleware).
 */

import type { Context, Hono } from "hono";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

/** Strip caller auth and forward the request to the sidecar at the same path. */
async function proxyToSidecar(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);
  const path = url.pathname + url.search;
  const ct = c.req.header("Content-Type");
  const headers = new Headers();
  if (ct) headers.set("Content-Type", ct);

  if (env.SIDECAR_SERVICE) {
    const stub = env.SIDECAR_SERVICE.get(env.SIDECAR_SERVICE.idFromName("sidecar"));
    return stub.fetch(`http://sidecar${path}`, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
    });
  }
  const baseUrl = env.SIDECAR_URL;
  if (!baseUrl) {
    return c.json(
      { error: "Agent execution requires the sidecar: configure SIDECAR_URL or SIDECAR_SERVICE" },
      503,
    );
  }
  if (env.SIDECAR_API_KEY) headers.set("Authorization", `Bearer ${env.SIDECAR_API_KEY}`);
  try {
    return await fetch(`${baseUrl}${path}`, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
    });
  } catch {
    return c.json(
      { error: "Sidecar unreachable. Start the Node server with `pnpm dev:server` (or `pnpm dev:cf` to run both)." },
      503,
    );
  }
}

export function registerAgentCfRoutes(app: Hono<{ Bindings: Env }>): void {
  const handler = async (c: Context<{ Bindings: Env }>) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    return proxyToSidecar(c);
  };

  app.post("/api/agents/:id/wakeup", handler);
  app.post("/api/agents/:id/heartbeat/invoke", handler);
  app.post("/api/agents/:id/claude-login", handler);

  app.get("/api/agents/:id/instructions-bundle", handler);
  app.get("/api/agents/:id/instructions-bundle/file", handler);
  app.put("/api/agents/:id/instructions-bundle/file", handler);
  app.delete("/api/agents/:id/instructions-bundle/file", handler);
}
