import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from "cloudflare:workers";
import { callSidecarService } from "../../sidecar-client.js";

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
   * sandbox bridge; `container` uses the PLUGIN_CONTAINER CF Container binding.
   */
  executorMode: "sandbox_bridge" | "container";
}

/**
 * Env bindings required by the PluginDispatchWorkflow.
 * Keep in sync with `src/worker/env.ts`.
 */
interface Env {
  AGENT_RUN_DO: DurableObjectNamespace;
  PAPERCLIP_KV: KVNamespace;
  // CF-native: Container DO namespaces (proxy to Docker containers).
  // Absent in local dev → falls back to SANDBOX_BRIDGE_URL from KV.
  SIDECAR_SERVICE?: DurableObjectNamespace;   // plugin job lifecycle (claim/complete)
  PLUGIN_CONTAINER?: DurableObjectNamespace;  // command execution (POST /execute)
}

/**
 * PluginDispatchWorkflow — Cloudflare Workflow that executes one plugin job.
 *
 * Plugin jobs are discrete units of work enqueued by the plugin job scheduler
 * (replaced by a Cloudflare Queue consumer on CF deployments). Each job has a
 * `plugin_jobs` record in the database. The Workflow:
 *
 *   1. Marks the job as "running" via the sidecar internal API.
 *   2. Dispatches execution to the configured executor:
 *        - `container`     → PLUGIN_CONTAINER CF Container binding (CF-native)
 *        - `sandbox_bridge` → external sandbox bridge via HTTP (fallback)
 *      Falls back to SIDECAR_SERVICE or the KV-stored bridge URL when the
 *      preferred binding is absent.
 *   3. Records the outcome (success or failure) via the sidecar internal API.
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

    // Read fallback bridge config once per run (outside steps so it doesn't
    // count against step retry limits; fast KV reads are acceptable here).
    // Only performed when no CF Container binding is available.
    let bridgeUrl: string | null = null;
    let bridgeApiKey: string | null = null;
    if (!this.env.SIDECAR_SERVICE) {
      bridgeUrl = (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ?? "http://localhost:8788";
      bridgeApiKey = await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY");
    }

    const sidecarRouting = { service: this.env.SIDECAR_SERVICE, url: bridgeUrl, apiKey: bridgeApiKey };

    /** Call the sidecar internal API — SidecarContainer DO preferred, fallback to bridge. */
    const sidecarPost = async (path: string, body: unknown): Promise<Response> => {
      const resp = await callSidecarService(sidecarRouting, path, "POST", body);
      if (!resp) throw new Error("No sidecar route available: configure SIDECAR_SERVICE or SANDBOX_BRIDGE_URL");
      return resp;
    };

    // ------------------------------------------------------------------
    // Step 1: Claim the job — mark it as running to prevent duplicate dispatch
    // ------------------------------------------------------------------
    const claimed = await step.do("claim-job", async () => {
      const resp = await sidecarPost(`/internal/plugin-jobs/${pluginJobId}/claim`, { companyId });

      if (resp.status === 409) {
        return { claimed: false };
      }
      if (!resp.ok) {
        throw new Error(`Claim failed: HTTP ${resp.status}`);
      }
      return { claimed: true };
    });

    if (!claimed.claimed) {
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
        const body = { pluginJobId, pluginSlug, companyId };
        let resp: Response;

        if (executorMode === "container" && this.env.PLUGIN_CONTAINER) {
          // CF-native path: PluginContainer DO proxies command execution to
          // the Docker sandbox container.
          const id = this.env.PLUGIN_CONTAINER.idFromName(pluginJobId);
          const stub = this.env.PLUGIN_CONTAINER.get(id);
          resp = await stub.fetch(
            `http://plugin-container/internal/plugin-jobs/${pluginJobId}/execute`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
          );
        } else {
          // Fallback: sidecar internal API (CF Container or external bridge).
          resp = await sidecarPost(`/internal/plugin-jobs/${pluginJobId}/execute`, body);
        }

        if (!resp.ok) {
          const text = await resp.text().catch(() => "(unreadable)");
          throw new Error(`Plugin job execution failed: HTTP ${resp.status}: ${text}`);
        }

        return (await resp.json()) as { status: string; exitCode?: number };
      },
    );

    // ------------------------------------------------------------------
    // Step 3: Record the result
    // ------------------------------------------------------------------
    await step.do("record-result", async () => {
      const succeeded = executionResult?.status !== "failed";
      const resp = await sidecarPost(`/internal/plugin-jobs/${pluginJobId}/complete`, {
        companyId,
        status: succeeded ? "succeeded" : "failed",
        exitCode: executionResult?.exitCode,
        completedAt: new Date().toISOString(),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "(unreadable)");
        throw new Error(`Record result failed: HTTP ${resp.status}: ${text}`);
      }
    });
  }
}
