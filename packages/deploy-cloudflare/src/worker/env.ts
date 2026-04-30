/**
 * Cloudflare Worker environment bindings and deployment-mode helpers.
 *
 * Keeping `Env` in its own file lets every worker sub-module import it
 * without pulling in the full Hono app or route registry.
 */

// ---------------------------------------------------------------------------
// Env -- Cloudflare bindings injected at runtime by the Workers runtime
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

  // Vars (set in wrangler.toml [vars] or .dev.vars for local dev)
  DEPLOYMENT_PLATFORM: string;
  DEPLOYMENT_MODE: string;
  DEPLOYMENT_EXPOSURE: string;
  STORAGE_R2_BUCKET?: string;
  STORAGE_R2_PREFIX?: string;

  // Container DO namespaces — each wraps a CF Container that starts a Docker
  // image and proxies HTTP to it.  Absent in local dev (no Docker); the DO
  // transparently falls back to SANDBOX_BRIDGE_URL read from KV.
  SIDECAR_SERVICE?: DurableObjectNamespace;   // companion Node server
  PLUGIN_CONTAINER?: DurableObjectNamespace;  // isolated command executor

  // Static assets binding — serves ui/dist alongside the Worker.
  // Use env.ASSETS.fetch(request) to serve static files or let CF fall
  // back to index.html for SPA routes (not_found_handling = "single-page-application").
  ASSETS: Fetcher;
}

// ---------------------------------------------------------------------------
// Deployment mode
// ---------------------------------------------------------------------------

export type DeploymentMode = "local_trusted" | "authenticated";

/**
 * Returns the deployment mode for the current request.
 * `local_trusted` bypasses auth and the setup KV gate for local dev.
 */
export function resolveDeploymentMode(env: Env): DeploymentMode {
  return env.DEPLOYMENT_MODE === "local_trusted" ? "local_trusted" : "authenticated";
}
