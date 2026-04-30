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
 * Architecture note: Hono route registration happens once at module load time.
 * Per-request dependencies (db, storage, actor) are resolved inside each route
 * handler by reading the Env binding from the Hono context. This avoids the
 * anti-pattern of re-registering routes on every request.
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
import { mountRoutes } from "../http/hono-adapter.js";
import { resolveActorFromRequest } from "../auth/resolve-actor.js";
import { runHeartbeatSweep } from "../cron/heartbeat-sweep.js";
import { mountUploadRoutes } from "../routes/cf-uploads.js";
import type { RouteDefinition } from "../../../server/src/http/types.js";

// Server-side route factories (transport-agnostic, no Node-only deps at factory
// call time -- Node deps are only invoked inside individual handler closures).
import { companyRoutes } from "../../../server/src/routes/companies.js";
import { agentRoutes } from "../../../server/src/routes/agents.js";
import { assetRoutes } from "../../../server/src/routes/assets.js";
import { projectRoutes } from "../../../server/src/routes/projects.js";
import { issueRoutes } from "../../../server/src/routes/issues.js";
import { issueTreeControlRoutes } from "../../../server/src/routes/issue-tree-control.js";
import { routineRoutes } from "../../../server/src/routes/routines.js";
import { environmentRoutes } from "../../../server/src/routes/environments.js";
import { executionWorkspaceRoutes } from "../../../server/src/routes/execution-workspaces.js";
import { goalRoutes } from "../../../server/src/routes/goals.js";
import { approvalRoutes } from "../../../server/src/routes/approvals.js";
import { secretRoutes } from "../../../server/src/routes/secrets.js";
import { costRoutes } from "../../../server/src/routes/costs.js";
import { activityRoutes } from "../../../server/src/routes/activity.js";
import { dashboardRoutes } from "../../../server/src/routes/dashboard.js";
import { userProfileRoutes } from "../../../server/src/routes/user-profiles.js";
import { sidebarBadgeRoutes } from "../../../server/src/routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "../../../server/src/routes/sidebar-preferences.js";
import { inboxDismissalRoutes } from "../../../server/src/routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "../../../server/src/routes/instance-settings.js";
import { llmRoutes } from "../../../server/src/routes/llms.js";
import { authRoutes } from "../../../server/src/routes/auth.js";

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

  // Secrets (set via `wrangler secret put`)
  // MASTER_ENCRYPTION_KEY: string  -- encrypts all other secrets stored in DB
  // SANDBOX_BRIDGE_URL: string
  // SANDBOX_BRIDGE_API_KEY: string

  // Sidecar -- the Node server running alongside the Workers deployment.
  SIDECAR_URL: string;
  SIDECAR_API_KEY: string;
}

// ---------------------------------------------------------------------------
// Route extraction -- done once at module load time.
//
// We create a throwaway DB stub to satisfy TypeScript. The route factories only
// use the db at request time (inside handler closures). At module load, they
// just construct a Router and call router.get/post/etc which is synchronous and
// has no DB access.
//
// IMPORTANT: The stub is never used at runtime -- each handler gets a real DB
// from the Hono middleware defined below.
// ---------------------------------------------------------------------------

/**
 * Build a null-object stub that satisfies the Db type for route factory calls.
 * Throws if any method is called (which would only happen if the factory tried
 * to query the DB during initialization, which none of them do).
 */
function makeDbStub(): import("@paperclipai/db").Db {
  return new Proxy({} as import("@paperclipai/db").Db, {
    get(_target, prop) {
      throw new Error(
        `[CF Worker] DB method '${String(prop)}' called during route factory initialization. ` +
        "Route factories must not perform DB queries at initialization time.",
      );
    },
  });
}

function makeStorageStub(): import("../../../server/src/storage/types.js").StorageService {
  return new Proxy({} as import("../../../server/src/storage/types.js").StorageService, {
    get(_target, prop) {
      throw new Error(
        `[CF Worker] StorageService method '${String(prop)}' called during route factory initialization.`,
      );
    },
  });
}

const _stubDb = makeDbStub();
const _stubStorage = makeStorageStub();

/**
 * Extract RouteDefinitions from an Express Router, prepending prefix to each path.
 * The router is built with the stub DB/storage which are never actually called
 * during extraction -- only the router's structural metadata is read.
 */
function extractWithPrefix(router: unknown, prefix: string): RouteDefinition[] {
  return extractRoutesFromRouter(router, prefix);
}

// Extract all route definitions at module load time (once per cold start).
const allRoutes: RouteDefinition[] = [
  ...extractWithPrefix(companyRoutes(_stubDb, _stubStorage), "/api/companies"),
  ...extractWithPrefix(agentRoutes(_stubDb, {}), "/api"),
  ...extractWithPrefix(assetRoutes(_stubDb, _stubStorage), "/api"),
  ...extractWithPrefix(projectRoutes(_stubDb), "/api"),
  ...extractWithPrefix(issueRoutes(_stubDb, _stubStorage, {}), "/api"),
  ...extractWithPrefix(issueTreeControlRoutes(_stubDb), "/api"),
  ...extractWithPrefix(routineRoutes(_stubDb, {}), "/api"),
  ...extractWithPrefix(environmentRoutes(_stubDb, {}), "/api"),
  ...extractWithPrefix(executionWorkspaceRoutes(_stubDb), "/api"),
  ...extractWithPrefix(goalRoutes(_stubDb), "/api"),
  ...extractWithPrefix(approvalRoutes(_stubDb, {}), "/api"),
  ...extractWithPrefix(secretRoutes(_stubDb), "/api"),
  ...extractWithPrefix(costRoutes(_stubDb, {}), "/api"),
  ...extractWithPrefix(activityRoutes(_stubDb), "/api"),
  ...extractWithPrefix(dashboardRoutes(_stubDb), "/api"),
  ...extractWithPrefix(userProfileRoutes(_stubDb), "/api"),
  ...extractWithPrefix(sidebarBadgeRoutes(_stubDb), "/api"),
  ...extractWithPrefix(sidebarPreferenceRoutes(_stubDb), "/api"),
  ...extractWithPrefix(inboxDismissalRoutes(_stubDb), "/api"),
  ...extractWithPrefix(instanceSettingsRoutes(_stubDb), "/api"),
  ...extractWithPrefix(llmRoutes(_stubDb), "/api"),
  ...extractWithPrefix(authRoutes(_stubDb), "/api"),
];

// ---------------------------------------------------------------------------
// Hono app -- routes registered once at module load time
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Health check -- always reachable, no auth, no setup gate
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
  const setupCompleted = await c.env.PAPERCLIP_KV.get("SETUP_COMPLETED");
  if (setupCompleted !== "true") {
    return c.redirect("/setup");
  }
  return next();
});

// Delegate /setup/* to the setup sub-app.
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
// Mount API routes -- registered once, but resolved per-request via closures
// that capture the Hono context (c.env) to build real db/storage instances.
//
// `mountRoutes` registers one Hono handler per RouteDefinition. Each handler
// calls `resolveActor` and builds a `RequestCtx` inline. We pass lazy factories
// instead of concrete instances so the real DB/storage/actor are created fresh
// for each request from the Hono context env bindings.
// ---------------------------------------------------------------------------

// We mount with placeholder options -- the real per-request deps are injected
// inside each route's Hono handler by wrapping via the custom resolver below.
//
// Rather than the generic mountRoutes (which needs db/storage upfront), we
// register each route directly to close over the Hono context:
for (const route of allRoutes) {
  const method = route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
  app[method](route.path, async (c) => {
    const env = c.env;

    // Build per-request DB and storage from Env bindings.
    const db = createHyperdriveDb(env.HYPERDRIVE);
    const r2Provider = new R2Provider(env.PAPERCLIP_STORAGE, {
      bucket: env.STORAGE_R2_BUCKET ?? "paperclip-storage",
      prefix: env.STORAGE_R2_PREFIX ?? "",
    });
    const storage = createCfStorageService(r2Provider) as unknown as import(
      "../../../server/src/storage/types.js"
    ).StorageService;

    const deploymentMode = env.DEPLOYMENT_MODE === "local_trusted"
      ? "local_trusted" as const
      : "authenticated" as const;

    const actor = await resolveActorFromRequest(c.req.raw, db, { deploymentMode });

    const ctx: import("../../../server/src/http/types.js").RequestCtx = {
      method: c.req.method,
      url: new URL(c.req.url),
      headers: new Headers(c.req.raw.headers),
      json<T>(): Promise<T> { return c.req.json<T>(); },
      text(): Promise<string> { return c.req.text(); },
      param(name: string): string | undefined { return c.req.param(name); },
      query(name: string): string | undefined { return c.req.query(name); },
      actor,
      db,
      storage,
    };

    try {
      return await route.handler(ctx);
    } catch (err) {
      const { HttpError } = await import("../../../server/src/errors.js");
      if (err instanceof HttpError) {
        return c.json(
          { error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
          err.status as 400 | 401 | 403 | 404 | 409 | 422 | 500,
        );
      }
      console.error(
        `[CF Worker] Unhandled error in ${route.method} ${route.path}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });
}

// R2-native upload endpoints (multer-free replacements).
// These are registered once here -- mountUploadRoutes takes a factory fn
// that creates per-request deps.
// NOTE: mountUploadRoutes needs per-request db which it reads from
// the Hono context env. We pass a marker db that is overridden inside.
// Actually, mountUploadRoutes uses a direct Hono handler, so we pass the app.
// The db is created inside each handler from c.env.
// We need to adjust mountUploadRoutes to build db from context.
// Since we can't change that signature without major refactoring, we inline
// the upload routes here instead.

// PUT /api/assets/:assetId/upload
app.put("/api/assets/:assetId/upload", async (c) => {
  const { assets } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const { forbidden, notFound, badRequest } = await import("../../../server/src/errors.js");

  const env = c.env;
  const db = createHyperdriveDb(env.HYPERDRIVE);
  const deploymentMode = env.DEPLOYMENT_MODE === "local_trusted" ? "local_trusted" as const : "authenticated" as const;
  const actor = await resolveActorFromRequest(c.req.raw, db, { deploymentMode });

  try {
    const assetId = c.req.param("assetId");
    if (!assetId) return c.json({ error: "Missing assetId" }, 400);

    const assetRow = await db.select().from(assets).where(eq(assets.id, assetId)).then((rows) => rows[0] ?? null);
    if (!assetRow) throw notFound("Asset not found");

    if (!actor) throw forbidden("Authentication required");
    if (actor.type === "board") {
      if (!actor.isInstanceAdmin && !actor.companyIds?.includes(assetRow.companyId)) {
        throw forbidden("No access to this company");
      }
    } else if (actor.type === "agent") {
      if (actor.companyId !== assetRow.companyId) throw forbidden("No access to this company");
    }

    const body = c.req.raw.body;
    if (!body) throw badRequest("Empty request body");

    const key = `assets/${assetRow.companyId}/${assetId}`;
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    await env.PAPERCLIP_STORAGE.put(key, body, { httpMetadata: { contentType } });

    return c.json({ ok: true, key });
  } catch (err) {
    const { HttpError } = await import("../../../server/src/errors.js");
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 403 | 404);
    }
    console.error("[CF Worker] PUT /api/assets/:assetId/upload", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// POST /api/issues/:issueId/attachments/upload
app.post("/api/issues/:issueId/attachments/upload", async (c) => {
  const { issues } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const { forbidden, notFound, badRequest } = await import("../../../server/src/errors.js");

  const env = c.env;
  const db = createHyperdriveDb(env.HYPERDRIVE);
  const deploymentMode = env.DEPLOYMENT_MODE === "local_trusted" ? "local_trusted" as const : "authenticated" as const;
  const actor = await resolveActorFromRequest(c.req.raw, db, { deploymentMode });

  try {
    const issueId = c.req.param("issueId");
    if (!issueId) return c.json({ error: "Missing issueId" }, 400);

    const issueRow = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issueRow) throw notFound("Issue not found");

    if (!actor) throw forbidden("Authentication required");
    if (actor.type === "board") {
      if (!actor.isInstanceAdmin && !actor.companyIds?.includes(issueRow.companyId)) {
        throw forbidden("No access to this company");
      }
    } else if (actor.type === "agent") {
      if (actor.companyId !== issueRow.companyId) throw forbidden("No access to this company");
    }

    const body = c.req.raw.body;
    if (!body) throw badRequest("Empty request body");

    const filename = (c.req.header("x-filename") ?? "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    const key = `issues/${issueRow.companyId}/${issueId}/attachments/${filename}`;
    await env.PAPERCLIP_STORAGE.put(key, body, { httpMetadata: { contentType } });

    return c.json({ ok: true, key, filename });
  } catch (err) {
    const { HttpError } = await import("../../../server/src/errors.js");
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 403 | 404);
    }
    console.error("[CF Worker] POST /api/issues/:issueId/attachments/upload", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Skipped routes placeholder
app.all("/api/*", (c) =>
  c.json(
    {
      error: "This API route is not available in the Cloudflare Workers deployment.",
      code: "NOT_IMPLEMENTED",
    },
    501,
  ),
);

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
