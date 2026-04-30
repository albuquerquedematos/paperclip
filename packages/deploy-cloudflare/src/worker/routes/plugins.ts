/**
 * routes/plugins.ts
 *
 * CF-native handlers for the plugin REST API.
 *
 * The server-side pluginRoutes() relies on an in-process plugin registry
 * (worker processes, SSE, child_process) that does not exist in a CF Worker.
 * These handlers split the work two ways:
 *
 *   1. DB-derived routes — list, get, dashboard, config, jobs, job runs,
 *      health, ui-contributions: read directly from Hyperdrive. The plugin
 *      registry state (`status`, `manifest_json`, `last_error`) is written
 *      by the sidecar at install/lifecycle transitions and stays in sync.
 *
 *   2. Process-dependent routes — install, upgrade, enable, disable, delete,
 *      logs, config-test, jobs/trigger, webhooks, examples: proxied to the
 *      sidecar companion server (SidecarContainer DO or SIDECAR_URL env var).
 *      These need npm, child_process, or a running plugin worker.
 *
 * Auth: every handler resolves an actor (board user or agent) before doing
 * anything. Unauthenticated requests get 401.
 */

import type { Context, Hono } from "hono";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  plugins,
  pluginConfig,
  pluginJobs,
  pluginJobRuns,
  pluginWebhookDeliveries,
} from "@paperclipai/db";
import { getPluginUiContributionMetadata } from "../../../../../server/src/services/plugin-loader.js";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

/**
 * Proxy a request to the sidecar companion server. Caller Authorization
 * headers are stripped: the SIDECAR_SERVICE DO uses internal CF network auth;
 * direct SIDECAR_URL calls use SIDECAR_API_KEY.
 */
async function proxySidecar(env: Env, path: string, req: Request): Promise<Response> {
  const ct = req.headers.get("Content-Type");
  const internalHeaders = new Headers();
  if (ct) internalHeaders.set("Content-Type", ct);

  if (env.SIDECAR_SERVICE) {
    const stub = env.SIDECAR_SERVICE.get(env.SIDECAR_SERVICE.idFromName("sidecar"));
    return stub.fetch(`http://sidecar${path}`, {
      method: req.method,
      headers: internalHeaders,
      body: req.body,
    });
  }
  const baseUrl = env.SIDECAR_URL;
  if (!baseUrl) {
    return Response.json(
      { error: "Plugin operation not available: configure SIDECAR_URL or SIDECAR_SERVICE" },
      { status: 503 },
    );
  }
  if (env.SIDECAR_API_KEY) internalHeaders.set("Authorization", `Bearer ${env.SIDECAR_API_KEY}`);
  return fetch(`${baseUrl}${path}`, { method: req.method, headers: internalHeaders, body: req.body });
}

/** Forward a sidecar response back through Hono, preserving status and JSON content-type. */
async function relaySidecarResponse(env: Env, path: string, req: Request): Promise<Response> {
  try {
    const resp = await proxySidecar(env, path, req);
    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return Response.json(
      { error: "Plugin operation requires the Node.js server to be running (pnpm dev or bun run dev)" },
      { status: 503 },
    );
  }
}

export function registerPluginRoutes(app: Hono<{ Bindings: Env }>): void {
  // ---------------------------------------------------------------------------
  // Helpers — shared across handlers
  // ---------------------------------------------------------------------------

  /** Resolve an authenticated actor for a Hono request. */
  const resolveActor = async (c: Context<{ Bindings: Env }>) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    return { db, actor };
  };

  /** Look up a plugin by id; return the row or null. */
  const findPlugin = async (
    db: ReturnType<typeof createHyperdriveDb>,
    pluginId: string,
  ) => {
    const rows = await db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    return rows[0] ?? null;
  };

  // ---------------------------------------------------------------------------
  // GET /api/plugins — list installed plugins from DB
  // ---------------------------------------------------------------------------
  app.get("/api/plugins", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const rows = await db
      .select()
      .from(plugins)
      .where(ne(plugins.status, "uninstalled"))
      .orderBy(asc(plugins.installOrder));
    return c.json(rows);
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/ui-contributions — UI contribution metadata derived from
  // manifestJson. Must be registered before the :pluginId route.
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/ui-contributions", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const rows = await db
      .select()
      .from(plugins)
      .where(ne(plugins.status, "uninstalled"))
      .orderBy(asc(plugins.installOrder));

    const contributions = rows.flatMap((plugin) => {
      const manifest = plugin.manifestJson;
      if (!manifest) return [];
      const uiMetadata = getPluginUiContributionMetadata(manifest);
      if (!uiMetadata) return [];
      return [{
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        displayName: manifest.displayName,
        version: plugin.version,
        updatedAt: plugin.updatedAt.toISOString(),
        uiEntryFile: uiMetadata.uiEntryFile,
        slots: uiMetadata.slots,
        launchers: uiMetadata.launchers,
      }];
    });
    return c.json(contributions);
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/examples — proxy to sidecar (filesystem-aware).
  // Returns [] if the sidecar is unreachable (production CF without sidecar).
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/examples", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    try {
      const resp = await proxySidecar(c.env, "/api/plugins/examples", c.req.raw);
      if (!resp.ok) return c.json([]);
      return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
    } catch {
      return c.json([]);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/tools — list plugin tools (proxy: tools live in worker)
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/tools", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    return relaySidecarResponse(c.env, "/api/plugins/tools", c.req.raw);
  });

  app.post("/api/plugins/tools/execute", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    return relaySidecarResponse(c.env, "/api/plugins/tools/execute", c.req.raw);
  });

  // ---------------------------------------------------------------------------
  // POST /api/plugins/install — proxy to sidecar (needs npm + filesystem)
  // ---------------------------------------------------------------------------
  app.post("/api/plugins/install", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    // CF has no local filesystem. Rewrite isLocalPath:true to npm install
    // unless the path is absolute (which the sidecar can resolve in dev).
    const body = await c.req.json<{ packageName?: string; version?: string; isLocalPath?: boolean }>();
    const isNpmPackage = !body.isLocalPath || !body.packageName?.startsWith("/");
    const rewritten = isNpmPackage
      ? { packageName: body.packageName, version: body.version, isLocalPath: false }
      : body;

    try {
      const resp = await proxySidecar(c.env, "/api/plugins/install",
        new Request(c.req.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rewritten),
        }),
      );
      return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
    } catch {
      return c.json(
        { error: "Plugin install requires the Node.js server to be running (pnpm dev or bun run dev)" },
        503,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/:pluginId — single plugin record (DB read)
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/:pluginId", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const pluginId = c.req.param("pluginId");
    const plugin = await findPlugin(db, pluginId);
    if (!plugin) return c.json({ error: "Plugin not found" }, 404);

    // supportsConfigTest is only known by the running worker; without one we
    // report false (UI hides the "Test" button — equivalent to no worker).
    return c.json({ ...plugin, supportsConfigTest: false });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/plugins/:pluginId — proxy to sidecar (needs lifecycle.unload)
  // ---------------------------------------------------------------------------
  app.delete("/api/plugins/:pluginId", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    const purge = c.req.query("purge") === "true";
    return relaySidecarResponse(
      c.env,
      `/api/plugins/${encodeURIComponent(pluginId)}?purge=${purge}`,
      c.req.raw,
    );
  });

  app.post("/api/plugins/:pluginId/enable", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    return relaySidecarResponse(c.env, `/api/plugins/${encodeURIComponent(pluginId)}/enable`, c.req.raw);
  });

  app.post("/api/plugins/:pluginId/disable", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    return relaySidecarResponse(c.env, `/api/plugins/${encodeURIComponent(pluginId)}/disable`, c.req.raw);
  });

  app.post("/api/plugins/:pluginId/upgrade", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    return relaySidecarResponse(c.env, `/api/plugins/${encodeURIComponent(pluginId)}/upgrade`, c.req.raw);
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/:pluginId/health — derive from DB (status, lastError)
  // No worker process is queried; the UI gets the same checks the server does
  // when no worker is running.
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/:pluginId/health", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const pluginId = c.req.param("pluginId");
    const plugin = await findPlugin(db, pluginId);
    if (!plugin) return c.json({ error: "Plugin not found" }, 404);

    const checks: Array<{ name: string; passed: boolean; message?: string }> = [
      { name: "registry", passed: true, message: "Plugin found in registry" },
      {
        name: "manifest",
        passed: Boolean(plugin.manifestJson?.id),
        message: plugin.manifestJson?.id ? "Manifest is valid" : "Manifest is invalid or missing",
      },
      { name: "status", passed: plugin.status === "ready", message: `Current status: ${plugin.status}` },
    ];
    if (plugin.lastError) {
      checks.push({ name: "error_state", passed: false, message: plugin.lastError });
    }
    return c.json({
      pluginId: plugin.id,
      status: plugin.status,
      healthy: plugin.status === "ready" && Boolean(plugin.manifestJson?.id) && !plugin.lastError,
      checks,
      lastError: plugin.lastError ?? undefined,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/:pluginId/logs — proxy to sidecar (logs are in-process)
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/:pluginId/logs", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    const url = new URL(c.req.url);
    return relaySidecarResponse(
      c.env,
      `/api/plugins/${encodeURIComponent(pluginId)}/logs${url.search}`,
      c.req.raw,
    );
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/:pluginId/config — DB read
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/:pluginId/config", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const pluginId = c.req.param("pluginId");
    const plugin = await findPlugin(db, pluginId);
    if (!plugin) return c.json({ error: "Plugin not found" }, 404);

    const config = await db
      .select()
      .from(pluginConfig)
      .where(eq(pluginConfig.pluginId, plugin.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return c.json(config);
  });

  // ---------------------------------------------------------------------------
  // POST /api/plugins/:pluginId/config — proxy to sidecar (needs validateConfig
  // schema check + workerManager.call("configChanged") when worker is running)
  // ---------------------------------------------------------------------------
  app.post("/api/plugins/:pluginId/config", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    return relaySidecarResponse(c.env, `/api/plugins/${encodeURIComponent(pluginId)}/config`, c.req.raw);
  });

  app.post("/api/plugins/:pluginId/config/test", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    return relaySidecarResponse(c.env, `/api/plugins/${encodeURIComponent(pluginId)}/config/test`, c.req.raw);
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/:pluginId/jobs — DB read (filtered by status query)
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/:pluginId/jobs", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const pluginId = c.req.param("pluginId");
    const plugin = await findPlugin(db, pluginId);
    if (!plugin) return c.json({ error: "Plugin not found" }, 404);

    const status = c.req.query("status");
    const valid = ["active", "paused", "failed"];
    if (status !== undefined && !valid.includes(status)) {
      return c.json({ error: `Invalid status '${status}'. Must be one of: ${valid.join(", ")}` }, 400);
    }

    const where = status
      ? and(eq(pluginJobs.pluginId, plugin.id), eq(pluginJobs.status, status as "active" | "paused" | "failed"))
      : eq(pluginJobs.pluginId, plugin.id);

    const jobs = await db
      .select()
      .from(pluginJobs)
      .where(where)
      .orderBy(asc(pluginJobs.jobKey));
    return c.json(jobs);
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/:pluginId/jobs/:jobId/runs — DB read
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/:pluginId/jobs/:jobId/runs", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const pluginId = c.req.param("pluginId");
    const jobId = c.req.param("jobId");
    const plugin = await findPlugin(db, pluginId);
    if (!plugin) return c.json({ error: "Plugin not found" }, 404);

    const job = await db
      .select()
      .from(pluginJobs)
      .where(and(eq(pluginJobs.pluginId, plugin.id), eq(pluginJobs.id, jobId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!job) return c.json({ error: "Job not found" }, 404);

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 25;
    if (Number.isNaN(limit) || limit < 1 || limit > 500) {
      return c.json({ error: "limit must be a number between 1 and 500" }, 400);
    }

    const runs = await db
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.jobId, jobId))
      .orderBy(desc(pluginJobRuns.createdAt))
      .limit(limit);
    return c.json(runs);
  });

  // ---------------------------------------------------------------------------
  // POST /api/plugins/:pluginId/jobs/:jobId/trigger — proxy to sidecar
  // ---------------------------------------------------------------------------
  app.post("/api/plugins/:pluginId/jobs/:jobId/trigger", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    const jobId = c.req.param("jobId");
    return relaySidecarResponse(
      c.env,
      `/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/trigger`,
      c.req.raw,
    );
  });

  // ---------------------------------------------------------------------------
  // GET /api/plugins/:pluginId/dashboard — diagnostics page
  // Worker info comes back as null (no worker process in CF); job/webhook
  // history and health are read from the DB.
  // ---------------------------------------------------------------------------
  app.get("/api/plugins/:pluginId/dashboard", async (c) => {
    const { db, actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const pluginId = c.req.param("pluginId");
    const plugin = await findPlugin(db, pluginId);
    if (!plugin) return c.json({ error: "Plugin not found" }, 404);

    const [recentJobRunRows, jobRows, deliveryRows] = await Promise.all([
      db.select().from(pluginJobRuns)
        .where(eq(pluginJobRuns.pluginId, plugin.id))
        .orderBy(desc(pluginJobRuns.createdAt))
        .limit(10),
      db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, plugin.id)),
      db.select().from(pluginWebhookDeliveries)
        .where(eq(pluginWebhookDeliveries.pluginId, plugin.id))
        .orderBy(desc(pluginWebhookDeliveries.createdAt))
        .limit(10),
    ]);

    const jobKeyMap = new Map(jobRows.map((j) => [j.id, j.jobKey]));
    const recentJobRuns = recentJobRunRows.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      jobKey: jobKeyMap.get(r.jobId),
      trigger: r.trigger,
      status: r.status,
      durationMs: r.durationMs,
      error: r.error,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));

    const recentWebhookDeliveries = deliveryRows.map((d) => ({
      id: d.id,
      webhookKey: d.webhookKey,
      status: d.status,
      durationMs: d.durationMs,
      error: d.error,
      startedAt: d.startedAt ? d.startedAt.toISOString() : null,
      finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    }));

    const checks: Array<{ name: string; passed: boolean; message?: string }> = [
      { name: "registry", passed: true, message: "Plugin found in registry" },
      {
        name: "manifest",
        passed: Boolean(plugin.manifestJson?.id),
        message: plugin.manifestJson?.id ? "Manifest is valid" : "Manifest is invalid or missing",
      },
      { name: "status", passed: plugin.status === "ready", message: `Current status: ${plugin.status}` },
    ];
    if (plugin.lastError) checks.push({ name: "error_state", passed: false, message: plugin.lastError });

    return c.json({
      pluginId: plugin.id,
      worker: null, // No worker process in CF Workers; sidecar manages workers.
      recentJobRuns,
      recentWebhookDeliveries,
      health: {
        pluginId: plugin.id,
        status: plugin.status,
        healthy: plugin.status === "ready" && Boolean(plugin.manifestJson?.id) && !plugin.lastError,
        checks,
        lastError: plugin.lastError ?? undefined,
      },
      checkedAt: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/plugins/:pluginId/webhooks/:endpointKey — proxy to sidecar
  // (webhook receivers run inside the plugin worker)
  // ---------------------------------------------------------------------------
  app.post("/api/plugins/:pluginId/webhooks/:endpointKey", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    const endpointKey = c.req.param("endpointKey");
    return relaySidecarResponse(
      c.env,
      `/api/plugins/${encodeURIComponent(pluginId)}/webhooks/${encodeURIComponent(endpointKey)}`,
      c.req.raw,
    );
  });

  // ---------------------------------------------------------------------------
  // Plugin bridge / data / actions — all proxy to sidecar (in-process worker)
  // ---------------------------------------------------------------------------
  app.post("/api/plugins/:pluginId/bridge/data", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    return relaySidecarResponse(c.env, `/api/plugins/${encodeURIComponent(pluginId)}/bridge/data`, c.req.raw);
  });

  app.post("/api/plugins/:pluginId/bridge/action", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    return relaySidecarResponse(c.env, `/api/plugins/${encodeURIComponent(pluginId)}/bridge/action`, c.req.raw);
  });

  app.get("/api/plugins/:pluginId/bridge/stream/:channel", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    const channel = c.req.param("channel");
    return relaySidecarResponse(
      c.env,
      `/api/plugins/${encodeURIComponent(pluginId)}/bridge/stream/${encodeURIComponent(channel)}`,
      c.req.raw,
    );
  });

  app.post("/api/plugins/:pluginId/data/:key", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    const key = c.req.param("key");
    return relaySidecarResponse(
      c.env,
      `/api/plugins/${encodeURIComponent(pluginId)}/data/${encodeURIComponent(key)}`,
      c.req.raw,
    );
  });

  app.post("/api/plugins/:pluginId/actions/:key", async (c) => {
    const { actor } = await resolveActor(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const pluginId = c.req.param("pluginId");
    const key = c.req.param("key");
    return relaySidecarResponse(
      c.env,
      `/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(key)}`,
      c.req.raw,
    );
  });
}
