import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from "cloudflare:workers";

/**
 * Parameters for the PluginDispatchWorkflow.
 */
export interface PluginDispatchParams {
  /** The `plugin_jobs.id` primary key of the job to execute. */
  pluginJobId: string;
  /** Plugin slug — used for routing to the correct executor config. */
  pluginSlug: string;
  /** Company context. */
  companyId: string;
  /**
   * Executor mode: `sandbox_bridge` (default) routes to the existing E2B/SSH
   * sandbox bridge; `container` uses a Cloudflare Container binding.
   */
  executorMode: "sandbox_bridge" | "container";
}

/**
 * Env bindings required by the PluginDispatchWorkflow.
 */
interface Env {
  AGENT_RUN_DO: DurableObjectNamespace;
  PAPERCLIP_KV: KVNamespace;
  // TODO: PLUGIN_CONTAINER_SERVICE binding (Fetcher) for container executor mode
}

/**
 * PluginDispatchWorkflow — Cloudflare Workflow that executes one plugin job.
 *
 * Plugin jobs are discrete units of work enqueued by the plugin job scheduler
 * (replaced by a Cloudflare Queue consumer on CF deployments). Each job has a
 * `plugin_jobs` record in the database. The Workflow:
 *
 *   1. Marks the job as "running" via the internal API.
 *   2. Dispatches execution to the configured executor (sandbox bridge or
 *      Cloudflare Container), with timeout and retry semantics.
 *   3. Records the outcome — success or failure — via the internal API.
 *
 * Retries up to 2 times on transient executor failures before marking the
 * job as permanently failed.
 *
 * Triggered by the Cloudflare Queue consumer in `api.ts` when a
 * `plugin_job_dispatch` message arrives on `paperclip-jobs`.
 */
export class PluginDispatchWorkflow extends WorkflowEntrypoint<Env, PluginDispatchParams> {
  async run(event: WorkflowEvent<PluginDispatchParams>, step: WorkflowStep): Promise<void> {
    const { pluginJobId, pluginSlug, companyId, executorMode } = event.payload;

    // ------------------------------------------------------------------
    // Step 1: Claim the job — mark it as running to prevent duplicate dispatch
    // ------------------------------------------------------------------
    const claimed = await step.do("claim-job", async () => {
      // TODO: call the internal plugin job claim endpoint once the HTTP
      // adapter migration (PR #6/#7) lands.
      const bridgeUrl =
        (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ??
        "http://localhost:8788";
      const apiKey = await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY");

      const resp = await fetch(`${bridgeUrl}/internal/plugin-jobs/${pluginJobId}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ companyId }),
      });

      if (resp.status === 409) {
        // Already claimed by another worker — skip this invocation
        return { claimed: false };
      }
      if (!resp.ok) {
        throw new Error(`Claim failed: HTTP ${resp.status}`);
      }
      return { claimed: true };
    });

    if (!claimed.claimed) {
      // Another invocation already owns this job; exit cleanly
      return;
    }

    // ------------------------------------------------------------------
    // Step 2: Execute the plugin job
    // ------------------------------------------------------------------
    const executionResult = await step.do(
      "execute-job",
      {
        timeout: "10 minutes",
        retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
      },
      async () => {
        const bridgeUrl =
          (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ??
          "http://localhost:8788";
        const apiKey = await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY");

        let executionEndpoint: string;
        if (executorMode === "container") {
          // TODO: route to Cloudflare Container service binding
          // executionEndpoint = `http://container/plugin-jobs/${pluginJobId}/execute`;
          executionEndpoint = `${bridgeUrl}/internal/plugin-jobs/${pluginJobId}/execute`;
        } else {
          executionEndpoint = `${bridgeUrl}/internal/plugin-jobs/${pluginJobId}/execute`;
        }

        const resp = await fetch(executionEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ pluginJobId, pluginSlug, companyId }),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "(unreadable)");
          throw new Error(`Plugin job execution failed: HTTP ${resp.status}: ${body}`);
        }

        return (await resp.json()) as { status: string; exitCode?: number };
      },
    );

    // ------------------------------------------------------------------
    // Step 3: Record the result
    // ------------------------------------------------------------------
    await step.do("record-result", async () => {
      const bridgeUrl =
        (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ??
        "http://localhost:8788";
      const apiKey = await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY");

      const succeeded = executionResult?.status !== "failed";
      await fetch(`${bridgeUrl}/internal/plugin-jobs/${pluginJobId}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          companyId,
          status: succeeded ? "succeeded" : "failed",
          exitCode: executionResult?.exitCode,
          completedAt: new Date().toISOString(),
        }),
      });
    });
  }
}
