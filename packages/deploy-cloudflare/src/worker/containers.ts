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
 *               └─ [local dev]  proxies to SIDECAR_URL or SANDBOX_BRIDGE_URL from KV
 *
 * Local dev fallback:
 *   `this.ctx.container` is undefined in `wrangler dev` (no Docker available).
 *   When absent, the DO falls back to: SIDECAR_URL env var (.dev.vars)
 *   → KV SANDBOX_BRIDGE_URL → localhost:8788.
 *
 * Security: caller Authorization headers are never forwarded. The production
 * container path uses the internal CF network (no auth needed). The local-dev
 * fallback sets SIDECAR_API_KEY when available.
 *
 * wrangler.toml requirements (already added):
 *   [[durable_objects.bindings]]   name = "SIDECAR_SERVICE"   class_name = "SidecarContainer"
 *   [[durable_objects.bindings]]   name = "PLUGIN_CONTAINER"  class_name = "PluginContainer"
 *   [[containers]]  class_name = "SidecarContainer"  image = "..."
 *   [[containers]]  class_name = "PluginContainer"   image = "..."
 */

import type { Env } from "./env.js";

const SIDECAR_PORT = 8080;

/**
 * Build a clean internal request: strip caller headers, keep Content-Type,
 * and optionally set an Authorization key for the sidecar bridge.
 */
function buildInternalRequest(
  url: string,
  method: string,
  contentType: string | null,
  body: ReadableStream | null,
  apiKey?: string | null,
): Request {
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", contentType);
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  return new Request(url, { method, headers, body });
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
 *   GET  /api/plugins/examples
 *   POST /api/plugins/install
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
    const url = new URL(request.url);
    const ct = request.headers.get("Content-Type");

    if (container) {
      if (!container.running) {
        container.start();
      }
      // Internal CF network: no auth header needed; strip caller headers.
      const fetcher = container.getTcpPort(SIDECAR_PORT);
      return fetcher.fetch(
        buildInternalRequest(url.pathname + url.search, request.method, ct, request.body),
      );
    }

    // Local-dev fallback: SIDECAR_URL env var → KV SANDBOX_BRIDGE_URL → localhost:8788.
    const baseUrl =
      this.env.SIDECAR_URL ??
      (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ??
      "http://localhost:8788";
    const apiKey =
      this.env.SIDECAR_API_KEY ??
      (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY"));

    const proxyUrl = `${baseUrl}${url.pathname}${url.search}`;
    return fetch(
      buildInternalRequest(proxyUrl, request.method, ct, request.body, apiKey),
      // @ts-expect-error CF-specific duplex option
      { duplex: "half" },
    );
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
    const url = new URL(request.url);
    const ct = request.headers.get("Content-Type");

    if (container) {
      if (!container.running) {
        container.start();
      }
      const fetcher = container.getTcpPort(SIDECAR_PORT);
      return fetcher.fetch(
        buildInternalRequest(url.pathname + url.search, request.method, ct, request.body),
      );
    }

    // Fallback: same bridge service as SidecarContainer.
    const baseUrl =
      this.env.SIDECAR_URL ??
      (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_URL")) ??
      "http://localhost:8788";
    const apiKey =
      this.env.SIDECAR_API_KEY ??
      (await this.env.PAPERCLIP_KV.get("SANDBOX_BRIDGE_API_KEY"));

    const proxyUrl = `${baseUrl}${url.pathname}${url.search}`;
    return fetch(
      buildInternalRequest(proxyUrl, request.method, ct, request.body, apiKey),
      // @ts-expect-error CF-specific duplex option
      { duplex: "half" },
    );
  }
}
