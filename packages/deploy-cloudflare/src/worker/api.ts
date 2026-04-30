/**
 * Main Cloudflare Worker entry point for the Paperclip API.
 *
 * This file:
 *   1. Creates a Hono app and mounts route definitions extracted from the
 *      server's Express routers via the express-router-bridge.
 *   2. Implements the first-run setup gate (redirects to /setup until KV flag is set).
 *   3. Handles Cloudflare Queues message batches (plugin job fanout, heartbeat dispatch).
 *   4. Handles Cloudflare Cron Triggers (heartbeat sweep, budget checks, DB backup).
 *   5. Re-exports all Durable Object and Workflow classes so Wrangler can
 *      register them -- they must be named exports from the Worker's main module.
 *
 * Routes skipped (use Node-only features -- left as 501 TODOs):
 *   - adapterRoutes       -- reads packages from disk
 *   - pluginRoutes        -- SSE, child processes, scoped plugin API
 *   - pluginUiStaticRoutes -- fs.readFileSync / res.sendFile
 *   - companySkillRoutes  -- local filesystem (CF version: cf-company-skills.ts)
 *   - accessRoutes        -- reads bundled SKILL.md files from disk
 *   - instanceDatabaseBackupRoutes -- pg_dump
 *
 * Architecture note on per-request DB injection:
 *   Route handlers (Handler functions) capture a `db` and `storage` reference
 *   from the service factories at the time the Express Router is built. Because
 *   the real `db` comes from Hyperdrive (a per-request binding), we rebuild the
 *   Express Routers on the FIRST request of each cold start and cache the
 *   extracted route definitions for subsequent requests in the same isolate.
 *
 *   Hono routes are registered at module load time as thin proxies that
 *   forward to the lazily-built route definitions.
 */

import { Hono } from "hono";
import { createSetupApp } from "./setup.js";
import { bootCloudflare } from "../boot.js";
import { SidecarClient } from "../sidecar-client.js";
import { CfCompanySkillsService } from "../services/cf-company-skills.js";
import { CfAgentInstructionsService } from "../services/cf-agent-instructions.js";
import { createHyperdriveDb } from "../db/hyperdrive.js";
import { R2Provider } from "../storage/r2-provider.js";
import { createCfStorageService } from "../storage/cf-storage-service.js";
import { extractRoutesFromRouter } from "../http/express-router-bridge.js";
import { resolveActorFromRequest } from "../auth/resolve-actor.js";
import { runHeartbeatSweep } from "../cron/heartbeat-sweep.js";
import { HttpError } from "../../../../server/src/errors.js";
import type { RouteDefinition } from "../../../../server/src/http/types.js";
import type { StorageService } from "../../../../server/src/storage/types.js";
import type { Db } from "@paperclipai/db";

// Server-side route factories
import { companyRoutes } from "../../../../server/src/routes/companies.js";
import { agentRoutes } from "../../../../server/src/routes/agents.js";
import { assetRoutes } from "../../../../server/src/routes/assets.js";
import { projectRoutes } from "../../../../server/src/routes/projects.js";
import { issueRoutes } from "../../../../server/src/routes/issues.js";
import { issueTreeControlRoutes } from "../../../../server/src/routes/issue-tree-control.js";
import { routineRoutes } from "../../../../server/src/routes/routines.js";
import { environmentRoutes } from "../../../../server/src/routes/environments.js";
import { executionWorkspaceRoutes } from "../../../../server/src/routes/execution-workspaces.js";
import { goalRoutes } from "../../../../server/src/routes/goals.js";
import { approvalRoutes } from "../../../../server/src/routes/approvals.js";
import { secretRoutes } from "../../../../server/src/routes/secrets.js";
import { costRoutes } from "../../../../server/src/routes/costs.js";
import { activityRoutes } from "../../../../server/src/routes/activity.js";
import { dashboardRoutes } from "../../../../server/src/routes/dashboard.js";
import { userProfileRoutes } from "../../../../server/src/routes/user-profiles.js";
import { sidebarBadgeRoutes } from "../../../../server/src/routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "../../../../server/src/routes/sidebar-preferences.js";
import { inboxDismissalRoutes } from "../../../../server/src/routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "../../../../server/src/routes/instance-settings.js";
import { llmRoutes } from "../../../../server/src/routes/llms.js";
import { authRoutes } from "../../../../server/src/routes/auth.js";

// ---------------------------------------------------------------------------
// Env -- Cloudflare bindings injected at runtime
// ---------------------------------------------------------------------------

export interface Env {
  // Databases
  HYPERDRIVE: { connectionString: string };

  // Object storage
  PAPERCLIP_STORAGE: R2Bucket;

  // KV -- setup flags, hot config, session cache
  PAPERCLIP_KV: KVNamespace;

  // Durable Object namespaces
  TASK_DO: DurableObjectNamespace;
  AGENT_RUN_DO: DurableObjectNamespace;
  SCHEDULER_DO: DurableObjectNamespace;

  // Queues
  PAPERCLIP_QUEUE: Queue;

  // Workflows
  HEARTBEAT_WORKFLOW: Workflow;
  PLUGIN_DISPATCH_WORKFLOW: Workflow;

  // Vars (set in wrangler.toml [vars])
  DEPLOYMENT_PLATFORM: string;
  DEPLOYMENT_MODE: string;
  DEPLOYMENT_EXPOSURE: string;
  STORAGE_R2_BUCKET?: string;
  STORAGE_R2_PREFIX?: string;

  // Sidecar -- the Node server running alongside the Workers deployment.
  SIDECAR_URL: string;
  SIDECAR_API_KEY: string;
}

// ---------------------------------------------------------------------------
// Per-request route resolution
//
// Route handlers close over service instances which close over the DB
// connection. CF Workers prohibits reusing I/O objects (TCP sockets) across
// requests, so we rebuild DB + route tables on every request.
//
// Route path patterns (regexp, paramNames) are static and are cached.
// ---------------------------------------------------------------------------

interface CompiledRoute {
  route: RouteDefinition;
  re: RegExp;
  paramNames: string[];
}

// Cached route path patterns — these don't depend on DB so they survive
// across requests in the same isolate.
let compiledPathCache: Array<{ method: string; path: string; re: RegExp; paramNames: string[] }> | null = null;

// Convert an Express-style path pattern (with :param segments) to a RegExp.
function pathToRegex(path: string): { re: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
  return { re: new RegExp(`^${pattern}$`), paramNames };
}

function buildRequestResources(env: Env) {
  const db = createHyperdriveDb(env.HYPERDRIVE);
  const r2Provider = new R2Provider(env.PAPERCLIP_STORAGE, {
    bucket: env.STORAGE_R2_BUCKET ?? "paperclip-storage",
    prefix: env.STORAGE_R2_PREFIX ?? "",
  });
  const storage = createCfStorageService(r2Provider) as unknown as StorageService;

  function ext(router: unknown, prefix: string): RouteDefinition[] {
    return extractRoutesFromRouter(router, prefix);
  }

  const routes: RouteDefinition[] = [
    ...ext(companyRoutes(db, storage), "/api/companies"),
    ...ext(agentRoutes(db, {}), "/api"),
    ...ext(assetRoutes(db, storage), "/api"),
    ...ext(projectRoutes(db), "/api"),
    ...ext(issueRoutes(db, storage, {}), "/api"),
    ...ext(issueTreeControlRoutes(db), "/api"),
    ...ext(routineRoutes(db, {}), "/api"),
    ...ext(environmentRoutes(db, {}), "/api"),
    ...ext(executionWorkspaceRoutes(db), "/api"),
    ...ext(goalRoutes(db), "/api"),
    ...ext(approvalRoutes(db, {}), "/api"),
    ...ext(secretRoutes(db), "/api"),
    ...ext(costRoutes(db, {}), "/api"),
    ...ext(activityRoutes(db), "/api"),
    ...ext(dashboardRoutes(db), "/api"),
    ...ext(userProfileRoutes(db), "/api"),
    ...ext(sidebarBadgeRoutes(db), "/api"),
    ...ext(sidebarPreferenceRoutes(db), "/api"),
    ...ext(inboxDismissalRoutes(db), "/api"),
    ...ext(instanceSettingsRoutes(db), "/api"),
    ...ext(llmRoutes(db), "/api"),
    ...ext(authRoutes(db), "/api"),
  ];

  if (!compiledPathCache) {
    compiledPathCache = routes.map((r) => ({ method: r.method, path: r.path, ...pathToRegex(r.path) }));
    console.log(`[CF Worker] Compiled ${compiledPathCache.length} route patterns`);
  }

  const compiled: CompiledRoute[] = routes.map((route, i) => ({
    route,
    re: compiledPathCache![i]!.re,
    paramNames: compiledPathCache![i]!.paramNames,
  }));

  return { compiled, db, storage };
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Health check -- always reachable
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    platform: c.env.DEPLOYMENT_PLATFORM ?? "cloudflare",
    mode: c.env.DEPLOYMENT_MODE ?? "authenticated",
    ts: new Date().toISOString(),
  }),
);

// First-run setup gate
app.use("*", async (c, next) => {
  if (c.req.path === "/api/health" || c.req.path.startsWith("/setup")) {
    return next();
  }
  // In local_trusted mode the DB is already set up; skip the KV gate.
  if (c.env.DEPLOYMENT_MODE === "local_trusted") {
    return next();
  }
  const setupCompleted = await c.env.PAPERCLIP_KV.get("SETUP_COMPLETED");
  if (setupCompleted !== "true") {
    return c.redirect("/setup");
  }
  return next();
});

// Setup sub-app
app.all("/setup/*", async (c) => {
  const setupSub = createSetupApp(c.env);
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/setup/, "") || "/";
  const rewritten = new Request(url.toString(), c.req.raw);
  return setupSub.fetch(rewritten);
});

app.all("/setup", async (c) => {
  const setupSub = createSetupApp(c.env);
  const url = new URL(c.req.url);
  url.pathname = "/";
  const rewritten = new Request(url.toString(), c.req.raw);
  return setupSub.fetch(rewritten);
});

// ---------------------------------------------------------------------------
// Main API catch-all -- routes through cached route definitions
//
// We use a single wildcard handler for /api/* rather than registering one
// Hono route per server route definition. This avoids blowing Hono's internal
// route trie limit and is simpler to reason about.
//
// Routing is done manually: iterate the route definitions, match method and
// path pattern, and delegate to the handler.
// ---------------------------------------------------------------------------

function getCompiledRoutes(env: Env) {
  return buildRequestResources(env);
}

// R2-native upload endpoints (registered before the catch-all)
app.put("/api/assets/:assetId/upload", async (c) => {
  const { assets } = await import("../../../db/src/schema/index.js");
  const { eq } = await import("drizzle-orm");
  const { forbidden, notFound, badRequest } = await import("../../../../server/src/errors.js");

  const env = c.env;
  const { db } = buildRequestResources(env);
  const deploymentMode = env.DEPLOYMENT_MODE === "local_trusted" ? "local_trusted" as const : "authenticated" as const;
  const actor = await resolveActorFromRequest(c.req.raw, db, { deploymentMode });

  try {
    const assetId = c.req.param("assetId");
    if (!assetId) return c.json({ error: "Missing assetId" }, 400);
    const assetRow = await db.select().from(assets).where(eq(assets.id, assetId)).then((rows) => rows[0] ?? null);
    if (!assetRow) throw notFound("Asset not found");

    if (!actor) throw forbidden("Authentication required");
    if (actor.type === "board" && !actor.isInstanceAdmin && !actor.companyIds?.includes(assetRow.companyId)) {
      throw forbidden("No access to this company");
    }
    if (actor.type === "agent" && actor.companyId !== assetRow.companyId) {
      throw forbidden("No access to this company");
    }

    const body = c.req.raw.body;
    if (!body) throw badRequest("Empty request body");
    const key = `assets/${assetRow.companyId}/${assetId}`;
    await env.PAPERCLIP_STORAGE.put(key, body, { httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" } });
    return c.json({ ok: true, key });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400 | 403 | 404);
    console.error("[CF Worker] PUT /api/assets/:assetId/upload", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.post("/api/issues/:issueId/attachments/upload", async (c) => {
  const { issues } = await import("../../../db/src/schema/index.js");
  const { eq } = await import("drizzle-orm");
  const { forbidden, notFound, badRequest } = await import("../../../../server/src/errors.js");

  const env = c.env;
  const { db } = buildRequestResources(env);
  const deploymentMode = env.DEPLOYMENT_MODE === "local_trusted" ? "local_trusted" as const : "authenticated" as const;
  const actor = await resolveActorFromRequest(c.req.raw, db, { deploymentMode });

  try {
    const issueId = c.req.param("issueId");
    if (!issueId) return c.json({ error: "Missing issueId" }, 400);
    const issueRow = await db.select({ id: issues.id, companyId: issues.companyId })
      .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    if (!issueRow) throw notFound("Issue not found");

    if (!actor) throw forbidden("Authentication required");
    if (actor.type === "board" && !actor.isInstanceAdmin && !actor.companyIds?.includes(issueRow.companyId)) {
      throw forbidden("No access to this company");
    }
    if (actor.type === "agent" && actor.companyId !== issueRow.companyId) {
      throw forbidden("No access to this company");
    }

    const body = c.req.raw.body;
    if (!body) throw badRequest("Empty request body");
    const filename = (c.req.header("x-filename") ?? "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `issues/${issueRow.companyId}/${issueId}/attachments/${filename}`;
    await env.PAPERCLIP_STORAGE.put(key, body, { httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" } });
    return c.json({ ok: true, key, filename });
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400 | 403 | 404);
    console.error("[CF Worker] POST /api/issues/:issueId/attachments/upload", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Main API catch-all -- manual routing through cached route definitions
app.all("/api/*", async (c) => {
  const { compiled, db, storage } = getCompiledRoutes(c.env);
  // Strip trailing slash so /api/companies/ matches /api/companies routes.
  const rawPathname = new URL(c.req.url).pathname;
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/$/, "") : rawPathname;
  const method = c.req.method.toUpperCase();

  for (const { route, re, paramNames } of compiled) {
    if (route.method !== method) continue;
    const match = re.exec(pathname);
    if (!match) continue;

    // Build param map for this match
    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]!] = match[i + 1]!;
    }

    // Wrap ctx.param to return from our extracted params
    const actor = await resolveActorFromRequest(
      c.req.raw,
      db,
      {
        deploymentMode: c.env.DEPLOYMENT_MODE === "local_trusted"
          ? "local_trusted"
          : "authenticated",
      },
    );

    const ctx: import("../../../../server/src/http/types.js").RequestCtx = {
      method: c.req.method,
      url: new URL(c.req.url),
      headers: new Headers(c.req.raw.headers),
      json<T>(): Promise<T> { return c.req.json<T>(); },
      text(): Promise<string> { return c.req.text(); },
      param(name: string): string | undefined { return params[name]; },
      query(name: string): string | undefined { return c.req.query(name); },
      actor,
      db,
      storage,
    };

    try {
      return await route.handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
          { status: err.status },
        );
      }
      console.error(
        `[CF Worker] Unhandled error in ${route.method} ${route.path}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  }

  // No route matched
  return c.json(
    {
      error: "This API route is not available in the Cloudflare Workers deployment.",
      code: "NOT_IMPLEMENTED",
    },
    501,
  );
});

// Catch-all SPA fallback
app.all("*", (c) =>
  c.html(
    `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Paperclip</title></head>
<body>
  <p>Loading Paperclip UI... If this persists, the Pages build may not be deployed yet.</p>
</body></html>`,
  ),
);

// ---------------------------------------------------------------------------
// Default export -- Workers fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Boot the Cloudflare implementations on first request (idempotent).
    bootCloudflare(env);

    // Route patterns are compiled lazily on first request; no warm-up needed.

    // CF service layer -- instantiated per-request (Workers are stateless).
    const sidecar = new SidecarClient({
      baseUrl: env.SIDECAR_URL,
      apiKey: env.SIDECAR_API_KEY,
    });
    const skillsService = new CfCompanySkillsService(env.PAPERCLIP_STORAGE, sidecar);
    const instructionsService = new CfAgentInstructionsService(env.PAPERCLIP_STORAGE);

    void skillsService;
    void instructionsService;

    return app.fetch(request, env, ctx);
  },

  // -------------------------------------------------------------------------
  // Queues consumer
  // -------------------------------------------------------------------------
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as Record<string, unknown>;
      const type = body?.type as string | undefined;

      if (type === "plugin_job_dispatch") {
        const pluginJobId = body.pluginJobId as string;
        const pluginSlug = body.pluginSlug as string;
        const companyId = body.companyId as string;
        const executorMode = (body.executorMode as "sandbox_bridge" | "container") ?? "sandbox_bridge";

        try {
          await env.PLUGIN_DISPATCH_WORKFLOW.create({
            id: `plugin-job-${pluginJobId}`,
            params: { pluginJobId, pluginSlug, companyId, executorMode },
          });
          message.ack();
        } catch (err) {
          console.error(
            `[Queue] Failed to start PluginDispatchWorkflow for job ${pluginJobId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          message.retry();
        }
        continue;
      }

      if (type === "heartbeat_dispatch") {
        const agentId = body.agentId as string;
        const companyId = body.companyId as string;
        const runId = body.runId as string;
        const taskId = body.taskId as string | undefined;

        try {
          await env.HEARTBEAT_WORKFLOW.create({
            id: `heartbeat-${runId}`,
            params: { agentId, companyId, runId, taskId },
          });
          message.ack();
        } catch (err) {
          console.error(
            `[Queue] Failed to start HeartbeatWorkflow for run ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          message.retry();
        }
        continue;
      }

      console.warn(`[Queue] Unknown message type: ${type}`);
      message.ack();
    }
  },

  // -------------------------------------------------------------------------
  // Cron Triggers
  // -------------------------------------------------------------------------
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    console.log(`[Cron] Firing cron: ${cron}`);

    if (cron === "*/5 * * * *") {
      const db = createHyperdriveDb(env.HYPERDRIVE);
      await runHeartbeatSweep(env, db);
    } else if (cron === "0 * * * *") {
      console.log("[Cron] Budget check -- not yet implemented");
    } else if (cron === "0 3 * * *") {
      console.log("[Cron] DB backup -- not yet implemented");
    }
  },
};

// ---------------------------------------------------------------------------
// Named Durable Object + Workflow exports
// ---------------------------------------------------------------------------

export { TaskDO } from "../runtime/task-do.js";
export { AgentRunDO } from "../runtime/agent-run-do.js";
export { SchedulerDO } from "../scheduler/scheduler-do.js";
export { HeartbeatWorkflow } from "../runtime/workflows/heartbeat.js";
export { PluginDispatchWorkflow } from "../runtime/workflows/plugin-dispatch.js";
