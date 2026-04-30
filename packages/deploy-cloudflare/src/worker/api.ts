/**
 * api.ts — Cloudflare Worker entry point
 *
 * This file is intentionally thin: it wires together the Hono app,
 * queue consumer, and cron handlers, then re-exports named Durable Object
 * and Workflow classes so Wrangler can register them.
 *
 * Routes skipped (use Node-only features — left as 501 TODOs):
 *   - adapterRoutes           reads packages from disk
 *   - pluginRoutes            SSE, child processes, scoped plugin API
 *   - pluginUiStaticRoutes    fs.readFileSync / res.sendFile
 *   - companySkillRoutes      local filesystem (CF version: cf-company-skills.ts)
 *   - accessRoutes            reads bundled SKILL.md files from disk
 *   - instanceDatabaseBackupRoutes  pg_dump
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
// Workers fetch handler
// ---------------------------------------------------------------------------

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Boot CF implementations (idempotent — safe to call on every request).
    bootCloudflare(env);
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
          console.error(`[Queue] Failed to start PluginDispatchWorkflow for job ${pluginJobId}: ${err instanceof Error ? err.message : String(err)}`);
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
          console.error(`[Queue] Failed to start HeartbeatWorkflow for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
          message.retry();
        }
        continue;
      }

      console.warn(`[Queue] Unknown message type: ${type ?? "(none)"}`);
      message.ack();
    }
  },

  // -------------------------------------------------------------------------
  // Cron triggers
  // -------------------------------------------------------------------------
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (event.cron === "*/5 * * * *") {
      const db = createHyperdriveDb(env.HYPERDRIVE);
      await runHeartbeatSweep(env, db);
      return;
    }
    // "0 * * * *"  — budget threshold check (not yet implemented)
    // "0 3 * * *"  — DB backup (not yet implemented)
  },
};

// ---------------------------------------------------------------------------
// Named Durable Object + Workflow exports
// Wrangler requires these to be named exports from the Worker's main module.
// ---------------------------------------------------------------------------

export { TaskDO } from "../runtime/task-do.js";
export { AgentRunDO } from "../runtime/agent-run-do.js";
export { SchedulerDO } from "../scheduler/scheduler-do.js";
export { HeartbeatWorkflow } from "../runtime/workflows/heartbeat.js";
export { PluginDispatchWorkflow } from "../runtime/workflows/plugin-dispatch.js";
