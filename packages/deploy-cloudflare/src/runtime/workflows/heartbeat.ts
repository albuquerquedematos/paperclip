import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from "cloudflare:workers";
import { callSidecarService } from "../../sidecar-client.js";

/**
 * Parameters passed when triggering the HeartbeatWorkflow.
 */
export interface HeartbeatParams {
  /** The agent whose heartbeat is being executed. */
  agentId: string;
  /** Company the agent belongs to (used for scoped DB queries). */
  companyId: string;
  /** Unique identifier for this specific heartbeat run. */
  runId: string;
  /**
   * Optional task (issue) the agent is currently working on.
   * May be absent if the agent has no active checkout.
   */
  taskId?: string;
}

/**
 * Env bindings required by the HeartbeatWorkflow.
 * Keep in sync with `src/worker/env.ts`.
 */
interface Env {
  AGENT_RUN_DO: DurableObjectNamespace;
  TASK_DO: DurableObjectNamespace;
  HYPERDRIVE: { connectionString: string };
  PAPERCLIP_KV: KVNamespace;
  // CF-native: DO namespace for the SidecarContainer (proxies to Docker).
  // Local dev: absent → falls back to SANDBOX_BRIDGE_URL stored in KV.
  SIDECAR_SERVICE?: DurableObjectNamespace;
}

/**
 * HeartbeatWorkflow — Cloudflare Workflow that executes one agent heartbeat.
 *
 * A heartbeat is the fundamental unit of agent work in Paperclip: the agent
 * is woken up, runs an LLM turn (potentially using tools), and records the
 * outcome. The Workflow wraps this in durable, checkpointed steps so that a
 * Worker crash or timeout does not lose progress.
 *
 * Steps:
 *   1. init-run      — Create the AgentRunDO record; mark run as "running".
 *   2. execute       — Call the sidecar to run the actual heartbeat.
 *                      Retries up to 2 times with a 5-second delay on failure.
 *   3. record-result — Update the AgentRunDO with the final outcome; notify
 *                      the TaskDO so connected UIs receive a state update.
 *
 * Execution routing (step 2):
 *   - CF-native (preferred): SIDECAR_SERVICE Fetcher binding → CF Container.
 *   - Fallback: SANDBOX_BRIDGE_URL / SANDBOX_BRIDGE_API_KEY read from KV.
 *
 * The Workflow is triggered by the SchedulerDO alarm handler or the
 * `POST /api/agents/:agentId/wakeup` endpoint.
 *
 * Idempotency: `runId` is unique per invocation. Cloudflare Workflows
 * guarantee each step runs at most once per `runId`; duplicate triggers
 * are deduplicated by the Workflow engine using the instance ID.
 */
export class HeartbeatWorkflow extends WorkflowEntrypoint<Env, HeartbeatParams> {
  async run(event: WorkflowEvent<HeartbeatParams>, step: WorkflowStep): Promise<void> {
    const { agentId, companyId, runId, taskId } = event.payload;

    // ------------------------------------------------------------------
    // Step 1: Initialise the run record and mark it as running
    // ------------------------------------------------------------------
    await step.do("init-run", async () => {
      const id = this.env.AGENT_RUN_DO.idFromName(runId);
      const stub = this.env.AGENT_RUN_DO.get(id);

      const initResp = await stub.fetch("http://internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          agentId,
          companyId,
          taskId,
          status: "running",
          startedAt: new Date().toISOString(),
          logCount: 0,
        }),
      });
      if (!initResp.ok) {
        throw new Error(`AgentRunDO init failed: HTTP ${initResp.status}`);
      }

      if (taskId) {
        const taskId_ = this.env.TASK_DO.idFromName(taskId);
        const taskStub = this.env.TASK_DO.get(taskId_);
        await taskStub.fetch("http://internal/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId,
            status: "running",
            currentStep: "heartbeat",
            updatedAt: new Date().toISOString(),
          }),
        });
      }
    });

    // ------------------------------------------------------------------
    // Step 2: Execute the heartbeat via sidecar (CF Container or bridge)
    // ------------------------------------------------------------------
    const executeResult = await step.do(
      "execute",
      {
        timeout: "5 minutes",
        retries: { limit: 2, delay: "5 seconds", backoff: "linear" },
      },
      async () => {
        const bridgeUrl = this.env.SIDECAR_SERVICE
          ? null
          : ((await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ?? "http://localhost:8788");
        const apiKey = this.env.SIDECAR_SERVICE
          ? null
          : await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY");

        const resp = await callSidecarService(
          { service: this.env.SIDECAR_SERVICE, url: bridgeUrl, apiKey },
          "/internal/heartbeat",
          "POST",
          { agentId, companyId, runId, taskId },
        );
        if (!resp) throw new Error("No sidecar route available: configure SIDECAR_SERVICE or SANDBOX_BRIDGE_URL");
        if (!resp.ok) {
          const text = await resp.text().catch(() => "(unreadable)");
          throw new Error(`Heartbeat execution failed: HTTP ${resp.status}: ${text}`);
        }

        return (await resp.json()) as { status: string; liveness?: string };
      },
    );

    // ------------------------------------------------------------------
    // Step 3: Record the result in AgentRunDO and notify TaskDO
    // ------------------------------------------------------------------
    await step.do("record-result", async () => {
      const id = this.env.AGENT_RUN_DO.idFromName(runId);
      const stub = this.env.AGENT_RUN_DO.get(id);

      const succeeded = executeResult?.status !== "failed";
      await stub.fetch("http://internal/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: succeeded ? "succeeded" : "failed",
          completedAt: new Date().toISOString(),
        }),
      });

      if (taskId) {
        const taskId_ = this.env.TASK_DO.idFromName(taskId);
        const taskStub = this.env.TASK_DO.get(taskId_);
        await taskStub.fetch("http://internal/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId,
            status: succeeded ? "running" : "failed",
            currentStep: "idle",
            updatedAt: new Date().toISOString(),
          }),
        });
      }
    });
  }
}
