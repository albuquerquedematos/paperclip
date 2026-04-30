/*
 * heartbeat-sweep.ts -- Cloudflare Cron Trigger handler for the heartbeat sweep.
 *
 * Fired every 5 minutes by the every-5-minutes cron trigger in wrangler.toml.
 *
 * Design: instead of running the full Node-based heartbeatService.tickTimers()
 * (which depends on node:fs, node:child_process, and other Worker-incompatible
 * APIs to provision workspace directories), we perform only the scheduling query:
 *
 * 1. Select all active agents that have a heartbeat policy enabled and whose
 *    last heartbeat is older than policy.intervalSec seconds.
 * 2. For each due agent, enqueue a heartbeat_dispatch message to the
 *    PAPERCLIP_QUEUE which the queue consumer handles by starting a
 *    HeartbeatWorkflow Durable Object instance.
 *
 * The actual heartbeat execution (adapter invocation, workspace provisioning)
 * happens inside the HeartbeatWorkflow, which can delegate Node-only operations
 * to the sidecar process via HTTP.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import type { Env } from "../worker/api.js";

/** Minimal heartbeat policy shape read from agent.runtimeConfig.heartbeat JSON. */
interface HeartbeatPolicy {
  enabled: boolean;
  intervalSec: number;
}

function parseHeartbeatPolicy(agent: { runtimeConfig?: unknown }): HeartbeatPolicy {
  const runtimeConfig = agent.runtimeConfig;
  if (!runtimeConfig || typeof runtimeConfig !== "object") {
    return { enabled: false, intervalSec: 0 };
  }
  const rc = runtimeConfig as Record<string, unknown>;
  const heartbeat = rc["heartbeat"];
  if (!heartbeat || typeof heartbeat !== "object") {
    return { enabled: false, intervalSec: 0 };
  }
  const h = heartbeat as Record<string, unknown>;
  const enabled = Boolean(h["enabled"]);
  const intervalSec = typeof h["intervalSec"] === "number" ? h["intervalSec"] : 0;
  return { enabled, intervalSec };
}

/**
 * Runs the heartbeat sweep: finds agents that are due for a heartbeat based on
 * their configured interval, then enqueues `heartbeat_dispatch` messages for
 * each one. The queue consumer (`api.ts`) starts a `HeartbeatWorkflow` per message.
 *
 * @param env - The Worker Env bindings (provides `PAPERCLIP_QUEUE`).
 * @param db  - A Drizzle DB instance backed by Hyperdrive.
 */
export async function runHeartbeatSweep(env: Env, db: Db): Promise<void> {
  const now = new Date();

  // Fetch all non-paused, non-terminated agents. We filter in-process rather
  // than in SQL to keep the query simple and avoid importing drizzle operators
  // beyond what's needed. The agent count is expected to be in the hundreds,
  // not millions, so a full table scan is acceptable here.
  const allAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      status: agents.status,
      runtimeConfig: agents.runtimeConfig,
      lastHeartbeatAt: agents.lastHeartbeatAt,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(agents.status, "active"));

  const messagesToSend: Array<{
    agentId: string;
    companyId: string;
    runId: string;
    taskId?: string;
  }> = [];

  for (const agent of allAgents) {
    const policy = parseHeartbeatPolicy(agent);
    if (!policy.enabled || policy.intervalSec <= 0) continue;

    const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
    const elapsedMs = now.getTime() - baseline;
    if (elapsedMs < policy.intervalSec * 1000) continue;

    // Check if there is already a queued or running run for this agent to avoid
    // double-dispatching.
    const { and, inArray } = await import("drizzle-orm");
    const existingQueued = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agent.id),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .then((rows) => rows.length > 0);

    if (existingQueued) continue;

    // Generate a run ID for the heartbeat workflow instance.
    const runId = crypto.randomUUID();
    messagesToSend.push({
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
    });
  }

  if (messagesToSend.length === 0) {
    console.log("[HeartbeatSweep] No agents due for heartbeat.");
    return;
  }

  // Enqueue all messages. CF Queues supports batching up to 100 messages per call.
  const BATCH_SIZE = 100;
  for (let i = 0; i < messagesToSend.length; i += BATCH_SIZE) {
    const batch = messagesToSend.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((msg) =>
        env.PAPERCLIP_QUEUE.send({
          type: "heartbeat_dispatch",
          agentId: msg.agentId,
          companyId: msg.companyId,
          runId: msg.runId,
          taskId: msg.taskId,
        }),
      ),
    );
  }

  console.log(`[HeartbeatSweep] Dispatched ${messagesToSend.length} heartbeat(s).`);
}
