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
  // image and proxies HTTP to it.  In local dev the DO falls back to
  // SIDECAR_URL (env var) or SANDBOX_BRIDGE_URL (KV) for its requests.
  SIDECAR_SERVICE?: DurableObjectNamespace;   // companion Node server
  PLUGIN_CONTAINER?: DurableObjectNamespace;  // isolated command executor

  // Direct sidecar URL — used by SidecarContainer as fallback when no Docker
  // container is running (local dev).  Set in .dev.vars or via wrangler secret.
  SIDECAR_URL?: string;
  SIDECAR_API_KEY?: string;

  // Optional: Anthropic API key for the worker-direct adapter path (future).
  // When present, agents configured to use the `claude-api` adapter call
  // api.anthropic.com directly from the worker — no sidecar needed for the
  // LLM call itself. Tools that require filesystem/exec still proxy to the
  // sidecar. Set via `wrangler secret put ANTHROPIC_API_KEY`. See
  // src/adapter-executor/anthropic-api.ts for the executor scaffold and the
  // outstanding work needed to make it production-ready.
  ANTHROPIC_API_KEY?: string;

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
