/**
 * Main Cloudflare Worker entry point for the Paperclip API.
 *
 * This file:
 *   1. Creates a Hono app and mounts route definitions.
 *   2. Implements the first-run setup gate (redirects to /setup until KV flag is set).
 *   3. Handles Cloudflare Queues message batches (plugin job fanout).
 *   4. Handles Cloudflare Cron Triggers (heartbeat sweep, budget checks, DB backup).
 *   5. Re-exports all Durable Object and Workflow classes so Wrangler can
 *      register them — they must be named exports from the Worker's main module.
 */

import { Hono } from "hono";
import { createSetupApp } from "./setup.js";
import { bootCloudflare } from "../boot.js";
import { SidecarClient } from "../sidecar-client.js";
import { CfCompanySkillsService } from "../services/cf-company-skills.js";
import { CfAgentInstructionsService } from "../services/cf-agent-instructions.js";

// createHyperdriveDb is imported here to make it available for use when the
// HTTP adapter migration lands (PR #6/#7). Remove the comment and use it in
// the fetch handler once route modules are mounted.
// import { createHyperdriveDb } from "../db/hyperdrive.js";

// ---------------------------------------------------------------------------
// Env — Cloudflare bindings injected at runtime
// ---------------------------------------------------------------------------

export interface Env {
  // Databases
  HYPERDRIVE: { connectionString: string };

  // Object storage
  PAPERCLIP_STORAGE: R2Bucket;

  // KV — setup flags, hot config, session cache
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

  // Secrets (set via `wrangler secret put`)
  // MASTER_ENCRYPTION_KEY: string  — encrypts all other secrets stored in DB
  // SANDBOX_BRIDGE_URL: string
  // SANDBOX_BRIDGE_API_KEY: string

  // Sidecar — the Node server running alongside the Workers deployment.
  // Workers delegate filesystem, child-process, and plugin-loading operations
  // to this process over HTTP (see SidecarClient).
  SIDECAR_URL: string;
  SIDECAR_API_KEY: string;
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Health check — always reachable, no auth, no setup gate
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    platform: c.env.DEPLOYMENT_PLATFORM ?? "cloudflare",
    mode: c.env.DEPLOYMENT_MODE ?? "authenticated",
    ts: new Date().toISOString(),
  }),
);

// First-run setup gate — redirect to /setup until SETUP_COMPLETED is "true"
app.use("*", async (c, next) => {
  // Allow the setup routes and health check through unconditionally
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
// createSetupApp returns a Hono instance whose routes are relative to "/",
// so we strip the "/setup" prefix before forwarding.
app.all("/setup/*", async (c) => {
  const setupSub = createSetupApp(c.env);
  const url = new URL(c.req.url);
  // Strip leading "/setup" so routes inside the sub-app match against "/"
  url.pathname = url.pathname.replace(/^\/setup/, "") || "/";
  const rewritten = new Request(url.toString(), c.req.raw);
  return setupSub.fetch(rewritten);
});

// Exact "/setup" (no trailing slash) — forward as "/"
app.all("/setup", async (c) => {
  const setupSub = createSetupApp(c.env);
  const url = new URL(c.req.url);
  url.pathname = "/";
  const rewritten = new Request(url.toString(), c.req.raw);
  return setupSub.fetch(rewritten);
});

// ---------------------------------------------------------------------------
// API routes
// TODO: mount migrated route modules here once the HTTP adapter
// migration (PR #6/#7) is complete. Pattern:
//
//   import { mountRoutes } from "../http/hono-adapter.js";
//   import { companyRoutes } from "../../../server/src/routes/companies.js";
//   mountRoutes(app, companyRoutes, { db, storage, resolveActor });
// ---------------------------------------------------------------------------

// Placeholder API fallthrough for any unmounted routes
app.all("/api/*", (c) => c.json({ error: "API route not yet mounted in CF Worker" }, 501));

// Catch-all for non-API requests — serve the Pages SPA (handled by Cloudflare Pages
// when the Worker is linked to a Pages project; this handler is only reached in
// local `wrangler dev` mode).
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
// Default export — Workers fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Boot the Cloudflare implementations on first request
    // (idempotent — registerStorageProvider uses a Map, safe to call multiple times)
    bootCloudflare(env);

    // ---------------------------------------------------------------------------
    // CF service layer — instantiated per-request (Workers are stateless).
    //
    // SidecarClient delegates Node-only operations (filesystem, child processes,
    // plugin loading) to the Paperclip Node server running alongside this Worker.
    //
    // CfCompanySkillsService stores skill file content in R2 under the key
    // pattern `skills/{companyId}/{skillId}/{relativePath}` and falls back to
    // the sidecar for local_path / catalog source types.
    //
    // CfAgentInstructionsService stores per-agent Markdown instruction files in
    // R2 under `instructions/{companyId}/{agentId}/{filename}`.
    //
    // TODO(PR #6/#7): pass these instances into the Hono context (via app.use)
    // or directly into route handler factories once route modules are mounted:
    //
    //   app.use("*", async (c, next) => {
    //     c.set("sidecar", sidecar);
    //     c.set("skills", skillsService);
    //     c.set("instructions", instructionsService);
    //     return next();
    //   });
    // ---------------------------------------------------------------------------
    const sidecar = new SidecarClient({
      baseUrl: env.SIDECAR_URL,
      apiKey: env.SIDECAR_API_KEY,
    });
    const skillsService = new CfCompanySkillsService(env.PAPERCLIP_STORAGE, sidecar);
    const instructionsService = new CfAgentInstructionsService(env.PAPERCLIP_STORAGE);

    // Suppress unused-variable warnings until routes are mounted.
    void skillsService;
    void instructionsService;

    return app.fetch(request, env, ctx);
  },

  // -------------------------------------------------------------------------
  // Queues consumer — processes plugin job dispatch messages
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
            // Use the job ID as the Workflow instance ID for deduplication
            id: `plugin-job-${pluginJobId}`,
            params: { pluginJobId, pluginSlug, companyId, executorMode },
          });
          message.ack();
        } catch (err) {
          // Let the queue retry this message
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

      // Unknown message type — ack to avoid infinite retries
      console.warn(`[Queue] Unknown message type: ${type}`);
      message.ack();
    }
  },

  // -------------------------------------------------------------------------
  // Cron Triggers — heartbeat sweep, budget checks, DB backup
  // -------------------------------------------------------------------------
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    console.log(`[Cron] Firing cron: ${cron}`);

    // TODO: replace with calls to the scheduler DO or direct internal API
    // endpoints once the HTTP adapter migration lands.
    if (cron === "*/5 * * * *") {
      // Heartbeat sweep — find agents that are due and enqueue heartbeat jobs
      // TODO: implement by querying the DB for due agents and posting to PAPERCLIP_QUEUE
      console.log("[Cron] Heartbeat sweep — not yet implemented");
    } else if (cron === "0 * * * *") {
      // Budget threshold check
      // TODO: implement by calling the internal budget service endpoint
      console.log("[Cron] Budget check — not yet implemented");
    } else if (cron === "0 3 * * *") {
      // Daily DB backup to R2
      // TODO: implement by triggering a Workflow that dumps Postgres to R2
      console.log("[Cron] DB backup — not yet implemented");
    }
  },
};

// ---------------------------------------------------------------------------
// Named Durable Object + Workflow exports
//
// Wrangler requires that DO classes and Workflow classes be named exports from
// the Worker's main module (the file pointed to by `main` in wrangler.toml).
// ---------------------------------------------------------------------------

export { TaskDO } from "../runtime/task-do.js";
export { AgentRunDO } from "../runtime/agent-run-do.js";
export { SchedulerDO } from "../scheduler/scheduler-do.js";
export { HeartbeatWorkflow } from "../runtime/workflows/heartbeat.js";
export { PluginDispatchWorkflow } from "../runtime/workflows/plugin-dispatch.js";
