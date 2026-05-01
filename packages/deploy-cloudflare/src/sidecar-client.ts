/**
 * SidecarClient — HTTP client used by the Cloudflare Worker to delegate
 * operations that require Node.js capabilities (filesystem access, child
 * processes, plugin loading) to the Paperclip Node server running alongside
 * the Workers deployment.
 *
 * Background:
 *   - The Node server (heartbeat.ts) provisions git checkout directories and
 *     workspace paths via node:fs/promises and node:child_process, which are
 *     not available in the Workers runtime.
 *   - company-skills.ts reads and writes skill Markdown files on the local
 *     host filesystem; R2 replaces long-term storage but live validation and
 *     execution still need a process.
 *   - agent-instructions.ts manages a per-agent directory tree of Markdown
 *     files through node:fs/promises; R2 replaces storage but some operations
 *     require filesystem materialisation.
 *
 * The Worker authenticates every request to the sidecar with a shared secret
 * (Bearer token) so that only Workers traffic is accepted.
 *
 * All code here is Web-API-only — no Node imports.
 */

// ---------------------------------------------------------------------------
// Stream-proxy helper (for raw HTTP request forwarding from route handlers)
// ---------------------------------------------------------------------------

/**
 * Inputs every CF-native shadow handler needs to proxy an HTTP request to
 * the sidecar. We accept a request-like shape (method, url, headers,
 * body) so callers can forward raw streams (e.g. multipart uploads) and
 * a Hono context-like env wrapper.
 */
export interface SafeProxyInput {
  env: {
    SIDECAR_SERVICE?: DurableObjectNamespace;
    SIDECAR_URL?: string;
    SIDECAR_API_KEY?: string;
  };
  /** Path to forward (path + search). */
  path: string;
  method: string;
  /** Pulled from the original request; only Content-Type is forwarded. */
  contentType: string | null;
  /** Original request body stream, or null/undefined for GET-style. */
  body?: ReadableStream | ArrayBuffer | null;
}

/**
 * Forward a request to the sidecar with bullet-proof error handling.
 * NEVER throws — on any failure (sidecar unreachable, DO error, fetch
 * exception) returns a Response (503) instead. This is the single boundary
 * route handlers should use; uncaught throws here had been crashing
 * workerd as `Network connection lost` in dispatch().
 *
 * Caller authorization headers are intentionally stripped: the sidecar is
 * an internal endpoint and uses SIDECAR_API_KEY (or implicit DO-binding
 * auth in production CF deployments).
 */
export async function safeProxyToSidecar(input: SafeProxyInput): Promise<Response> {
  const { env, path, method, contentType, body } = input;
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", contentType);

  // Production / preferred: SIDECAR_SERVICE Durable Object.
  if (env.SIDECAR_SERVICE) {
    try {
      const stub = env.SIDECAR_SERVICE.get(env.SIDECAR_SERVICE.idFromName("sidecar"));
      return await stub.fetch(`http://sidecar${path}`, {
        method,
        headers,
        body: body ?? undefined,
      });
    } catch (err) {
      console.warn(`[safeProxyToSidecar] DO fetch failed for ${method} ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`);
      return Response.json(
        {
          error: "Sidecar unreachable",
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 503 },
      );
    }
  }

  // Local-dev / fallback: direct HTTP to SIDECAR_URL (set in .dev.vars or
  // via wrangler --var by scripts/dev-cf.mjs).
  const baseUrl = env.SIDECAR_URL;
  if (!baseUrl) {
    return Response.json(
      { error: "Sidecar route not configured (set SIDECAR_URL or bind SIDECAR_SERVICE)" },
      { status: 503 },
    );
  }
  if (env.SIDECAR_API_KEY) headers.set("Authorization", `Bearer ${env.SIDECAR_API_KEY}`);
  try {
    return await fetch(`${baseUrl}${path}`, { method, headers, body: body ?? undefined });
  } catch (err) {
    console.warn(`[safeProxyToSidecar] direct fetch failed for ${method} ${path}: ${
      err instanceof Error ? err.message : String(err)
    }`);
    return Response.json(
      {
        error: "Sidecar unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}

// ---------------------------------------------------------------------------
// Low-level routing primitive
// ---------------------------------------------------------------------------

/**
 * Route and call the sidecar internal API: use the SIDECAR_SERVICE DO when
 * available, otherwise fall back to a direct HTTP URL. Body is serialized as
 * JSON. For stream-proxy use cases (raw Request body), use the per-route
 * proxySidecar helper instead of this function.
 *
 * The caller is responsible for resolving `url` and `apiKey` from env vars or
 * KV before calling (so KV reads don't get retried alongside the actual call).
 * Returns `null` when no route is available (service absent AND url is null).
 */
export interface SidecarRouting {
  /** CF Container DO namespace — preferred path. */
  service?: DurableObjectNamespace | null;
  /** Direct fallback URL (already resolved from env var or KV). */
  url?: string | null;
  /** API key for the direct URL path. */
  apiKey?: string | null;
}

export async function callSidecarService(
  routing: SidecarRouting,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response | null> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (routing.service) {
    const stub = routing.service.get(routing.service.idFromName("sidecar"));
    return stub.fetch(`http://sidecar${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  if (!routing.url) return null;

  if (routing.apiKey) headers.Authorization = `Bearer ${routing.apiKey}`;
  return fetch(`${routing.url}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SidecarConfig {
  /** Base URL of the sidecar process, e.g. https://sidecar.internal */
  baseUrl: string;
  /** Shared secret for Worker → sidecar authentication (Bearer token). */
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Response shapes returned by the sidecar
// ---------------------------------------------------------------------------

export interface WorkspaceProvisionResult {
  workspacePath: string;
  leaseId: string;
}

export interface SkillBundleResult {
  /** Map of relative file path to file content string. */
  files: Record<string, string>;
}

export interface AgentInstructionsResult {
  content: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SidecarClient {
  constructor(private config: SidecarConfig) {}

  /**
   * Core HTTP helper. Issues a fetch to the sidecar, attaches the auth header,
   * and deserialises the JSON response. Throws on any non-2xx status.
   */
  private async call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const resp = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sidecar error ${resp.status}: ${text}`);
    }

    return resp.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Workspace provisioning
  //
  // The sidecar owns the host filesystem and all git operations. Workers ask
  // the sidecar to provision a workspace (clone / reset a repo into a temp
  // directory) and receive back a lease ID that is used to release the
  // workspace when the run completes. This mirrors the behaviour of
  // realizeExecutionWorkspace / releaseRuntimeServicesForRun in heartbeat.ts.
  // -------------------------------------------------------------------------

  async provisionWorkspace(params: {
    agentId: string;
    companyId: string;
    runId: string;
  }): Promise<WorkspaceProvisionResult> {
    return this.call<WorkspaceProvisionResult>("/sidecar/workspaces/provision", "POST", params);
  }

  async releaseWorkspace(leaseId: string): Promise<void> {
    await this.call<void>(`/sidecar/workspaces/${leaseId}/release`, "POST");
  }

  // -------------------------------------------------------------------------
  // Plugin execution
  //
  // Plugin loading and child-process spawning both require Node APIs that are
  // unavailable in Workers. The sidecar loads the plugin, runs the job, and
  // streams the result back as JSON. This replaces the in-process adapter
  // invocation path from heartbeat.ts.
  // -------------------------------------------------------------------------

  async executePlugin(params: {
    pluginId: string;
    jobId: string;
    input: unknown;
  }): Promise<unknown> {
    return this.call<unknown>("/sidecar/plugins/execute", "POST", params);
  }

  // -------------------------------------------------------------------------
  // Skill bundle access
  //
  // While CfCompanySkillsService handles long-term R2 storage, the sidecar
  // can still be asked for a live bundle (e.g. for local_path source types or
  // when a catalog skill needs runtime materialisation). This endpoint mirrors
  // the materializeRuntimeSkillFiles path in company-skills.ts.
  // -------------------------------------------------------------------------

  async getSkillBundle(companyId: string, skillId: string): Promise<SkillBundleResult> {
    return this.call<SkillBundleResult>(`/sidecar/skills/${companyId}/${skillId}/bundle`);
  }

  // -------------------------------------------------------------------------
  // Agent instructions
  //
  // Reads and writes mirror the managed bundle operations in
  // agent-instructions.ts. GET returns the rendered content of the entry file;
  // PUT replaces it. The sidecar applies the same AGENTS.md / CLAUDE.md
  // resolution logic it would use for a local run.
  // -------------------------------------------------------------------------

  async getAgentInstructions(
    agentId: string,
    companyId: string,
  ): Promise<AgentInstructionsResult> {
    return this.call<AgentInstructionsResult>(
      `/sidecar/agents/${agentId}/instructions?companyId=${encodeURIComponent(companyId)}`,
    );
  }

  async updateAgentInstructions(
    agentId: string,
    companyId: string,
    content: string,
  ): Promise<void> {
    await this.call<void>(`/sidecar/agents/${agentId}/instructions`, "PUT", {
      companyId,
      content,
    });
  }
}
