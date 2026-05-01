/**
 * api.ts — Cloudflare Worker entry point
 *
 * This file is intentionally thin: it wires together the Hono app,
 * queue consumer, and cron handlers, then re-exports named Durable Object
 * and Workflow classes so Wrangler can register them.
 *
 * Stability: every entry point (fetch / queue / scheduled) is wrapped in a
 * top-level try/catch. An uncaught throw in any handler used to bubble up
 * to workerd and exit the dev server with code 1; now it logs and recovers.
 *
 * Routes skipped (use Node-only features):
 *   - pluginUiStaticRoutes    fs.readFileSync / res.sendFile
 *   - instanceDatabaseBackupRoutes  pg_dump
 *
 * Routes handled via CF-native modules (not in route-registry.ts):
 *   - adapterRoutes       → src/worker/routes/adapters.ts
 *   - pluginRoutes        → src/worker/routes/plugins.ts
 *   - companySkillRoutes  → src/worker/routes/company-skills-cf.ts
 *   - accessRoutes        → route-registry.ts (extractAllRoutesFromRouter)
 *
 * Architecture note on per-request DB injection:
 *   Route handlers capture a `db` reference via service factory closures.
 *   Because Hyperdrive connections cannot be reused across CF Workers requests,
 *   we rebuild the DB + route handlers on every request. Route path regexps
 *   are static and are cached at module level in route-registry.ts.
 */

import { bootCloudflare } from "../boot.js";
import { app } from "./app.js";
import { createHyperdriveDb } from "../db/hyperdrive.js";
import { runHeartbeatSweep } from "../cron/heartbeat-sweep.js";
import type { Env } from "./env.js";

// Re-export Env so other modules (e.g. heartbeat-sweep) can import it from here.
export type { Env };

// ---------------------------------------------------------------------------
// Process-level error guards
//
// Async failures that fire AFTER the request handler returned (e.g. postgres
// reconnect attempts, postgres-js pool maintenance) bypass our try/catch.
// In `wrangler dev --local` an unhandled rejection crashes workerd and the
// dev server exits with code 1. These listeners convert those into log
// lines so the worker stays alive across sidecar / DB restart races.
// ---------------------------------------------------------------------------

if (typeof addEventListener === "function") {
  try {
    addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
      const reason = ev.reason;
      const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
      console.warn(`[CF Worker] unhandledrejection: ${msg}`);
      ev.preventDefault();
    });
  } catch { /* not all runtimes accept this listener; safe to skip */ }
  try {
    addEventListener("error", (ev: ErrorEvent) => {
      const msg = ev.error instanceof Error
        ? ev.error.stack ?? ev.error.message
        : ev.message;
      console.warn(`[CF Worker] uncaught error event: ${msg}`);
      ev.preventDefault?.();
    });
  } catch { /* same */ }
}

// ---------------------------------------------------------------------------
// Workers fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // Boot CF implementations (idempotent — safe to call on every request).
      bootCloudflare(env);
      return await app.fetch(request, env, ctx);
    } catch (err) {
      // Last-line-of-defense: an uncaught throw from app.fetch reaches here
      // and would otherwise crash workerd. Convert to a 500 so wrangler dev
      // stays alive even if a handler hits an unexpected failure mode.
      console.error("[CF Worker] fetch handler threw:", err);
      return Response.json(
        { error: "Internal Server Error", code: "WORKER_FETCH_THREW" },
        { status: 500 },
      );
    }
  },

  // -------------------------------------------------------------------------
  // Queues consumer
  // -------------------------------------------------------------------------
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processQueueMessage(message, env);
      } catch (err) {
        console.error(
          `[Queue] message processing threw (id=${message.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Ack the message rather than retrying — retrying a malformed body
        // just thrashes. Real failures inside processQueueMessage already
        // call message.retry() themselves before throwing.
        try { message.ack(); } catch { /* nothing we can do */ }
      }
    }
  },

  // -------------------------------------------------------------------------
  // Cron triggers
  // -------------------------------------------------------------------------
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      if (event.cron === "*/5 * * * *") {
        const db = createHyperdriveDb(env.HYPERDRIVE);
        await runHeartbeatSweep(env, db);
      }
      // "0 * * * *"  — budget threshold check (not yet implemented)
      // "0 3 * * *"  — DB backup (not yet implemented)
    } catch (err) {
      // CF retries the cron later if we throw, but we don't want a single
      // bad sweep to take down the worker process.
      console.error(
        `[Cron] handler for ${event.cron} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

/** Extracted per-message handler so the outer loop can unconditionally try/catch. */
async function processQueueMessage(message: Message<unknown>, env: Env): Promise<void> {
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
        `[Queue] Failed to start PluginDispatchWorkflow for job ${pluginJobId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      message.retry();
    }
    return;
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
        `[Queue] Failed to start HeartbeatWorkflow for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      message.retry();
    }
    return;
  }

  console.warn(`[Queue] Unknown message type: ${type ?? "(none)"}`);
  message.ack();
}

// ---------------------------------------------------------------------------
// Named Durable Object + Workflow exports
// Wrangler requires these to be named exports from the Worker's main module.
// ---------------------------------------------------------------------------

export { TaskDO } from "../runtime/task-do.js";
export { AgentRunDO } from "../runtime/agent-run-do.js";
export { SchedulerDO } from "../scheduler/scheduler-do.js";
export { HeartbeatWorkflow } from "../runtime/workflows/heartbeat.js";
export { PluginDispatchWorkflow } from "../runtime/workflows/plugin-dispatch.js";
export { SidecarContainer, PluginContainer } from "./containers.js";
