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

  // Sidecar — companion server for agent heartbeat execution and plugin jobs.
  // CF-native: use SIDECAR_SERVICE (Fetcher to a CF Container).
  // Fallback: set SIDECAR_URL + SIDECAR_API_KEY to point at an external server.
  SIDECAR_SERVICE?: Fetcher;
  SIDECAR_URL?: string;
  SIDECAR_API_KEY?: string;

  // Plugin sandbox — isolated command execution for adapter plugins.
  // CF-native: PLUGIN_CONTAINER is a Fetcher to a CF Container that exposes
  // POST /execute and POST /cancel/:runId (same interface as the sandbox bridge).
  PLUGIN_CONTAINER?: Fetcher;

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
