/**
 * containers.ts — Durable Object wrappers for Cloudflare Containers.
 *
 * CF Containers (2025) run Docker images alongside Workers. Each container
 * must be exposed via a Durable Object class: the DO acts as a per-container
 * controller that starts the container, monitors its lifecycle, and proxies
 * HTTP requests to it via `this.ctx.container.getTcpPort(port)`.
 *
 * Architecture:
 *   Worker / Workflow
 *     └─ DurableObjectNamespace.idFromName("sidecar").get().fetch(url, init)
 *          └─ SidecarContainer.fetch(request)
 *               ├─ [production] proxies to Docker container on port 8080
 *               └─ [local dev]  proxies to SANDBOX_BRIDGE_URL from KV
 *
 * Local dev fallback:
 *   `this.ctx.container` is undefined in `wrangler dev` (no Docker available).
 *   When absent, the DO reads SANDBOX_BRIDGE_URL + SANDBOX_BRIDGE_API_KEY from
 *   KV and proxies the request to the external bridge server.
 *
 * wrangler.toml requirements (already added):
 *   [[durable_objects.bindings]]   name = "SIDECAR_SERVICE"   class_name = "SidecarContainer"
 *   [[durable_objects.bindings]]   name = "PLUGIN_CONTAINER"  class_name = "PluginContainer"
 *   [[containers]]  class_name = "SidecarContainer"  image = "..."
 *   [[containers]]  class_name = "PluginContainer"   image = "..."
 */

import type { Env } from "./env.js";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

const SIDECAR_PORT = 8080;

/** Build fallback headers, appending auth if an API key is available. */
function bridgeHeaders(apiKey: string | null, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

// ---------------------------------------------------------------------------
// SidecarContainer — companion Node.js server
// ---------------------------------------------------------------------------

/**
 * Proxy DO for the sidecar companion server container.
 *
 * Exposes the same internal API as the external sidecar HTTP server:
 *   POST /internal/heartbeat
 *   POST /internal/plugin-jobs/:id/claim
 *   POST /internal/plugin-jobs/:id/execute
 *   POST /internal/plugin-jobs/:id/complete
 */
export class SidecarContainer implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;

    if (container) {
      // Production path: start the container if it isn't running yet, then
      // proxy the request to its HTTP port. getTcpPort returns a Fetcher that
      // speaks to that port.
      if (!container.running) {
        container.start();
      }
      const fetcher = container.getTcpPort(SIDECAR_PORT);
      return fetcher.fetch(request);
    }

    // Local-dev fallback: try SIDECAR_URL env var first (set in .dev.vars),
    // then fall back to SANDBOX_BRIDGE_URL from KV.
    const baseUrl =
      this.env.SIDECAR_URL ??
      (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ??
      "http://localhost:8788";
    const apiKey =
      this.env.SIDECAR_API_KEY ??
      await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY");

    const url = new URL(request.url);
    const proxyUrl = `${baseUrl}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);

    return fetch(proxyUrl, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error CF-specific option — prevents Request.body stream from being consumed twice
      duplex: "half",
    });
  }
}

// ---------------------------------------------------------------------------
// PluginContainer — isolated command executor for adapter plugins
// ---------------------------------------------------------------------------

/**
 * Proxy DO for the plugin sandbox container.
 *
 * Exposes the same wire format as the sandbox bridge command executor:
 *   POST /execute
 *   POST /cancel/:runId
 *
 * The container image must serve these endpoints on port 8080 (default).
 */
export class PluginContainer implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;

    if (container) {
      if (!container.running) {
        container.start();
      }
      const fetcher = container.getTcpPort(SIDECAR_PORT);
      return fetcher.fetch(request);
    }

    // Fallback: SIDECAR_URL env var → KV SANDBOX_BRIDGE_URL (same service hosts both).
    const baseUrl =
      this.env.SIDECAR_URL ??
      (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ??
      "http://localhost:8788";
    const apiKey =
      this.env.SIDECAR_API_KEY ??
      await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY");

    const url = new URL(request.url);
    const proxyUrl = `${baseUrl}${url.pathname}${url.search}`;
    const headers = new Headers(request.headers);
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);

    return fetch(proxyUrl, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error CF-specific option
      duplex: "half",
    });
  }
}
