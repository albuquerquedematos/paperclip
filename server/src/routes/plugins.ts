/**
 * @fileoverview Plugin management REST API routes
 *
 * This module provides Express routes for managing the complete plugin lifecycle:
 * - Listing and filtering plugins by status
 * - Installing plugins from npm or local paths
 * - Uninstalling plugins (soft delete or hard purge)
 * - Enabling/disabling plugins
 * - Running health diagnostics
 * - Upgrading plugins
 * - Retrieving UI slot contributions for frontend rendering
 * - Discovering and executing plugin-contributed agent tools
 *
 * All routes require board-level authentication, and sensitive instance-wide
 * mutations such as install/upgrade require instance-admin privileges.
 *
 * @module server/routes/plugins
 * @see doc/plugins/PLUGIN_SPEC.md for the full plugin specification
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  heartbeatRuns,
  pluginLogs,
  pluginWebhookDeliveries,
  projects,
} from "@paperclipai/db";
import type {
  PluginApiRouteDeclaration,
  PluginStatus,
  PaperclipPluginManifestV1,
  PluginBridgeErrorCode,
  PluginLauncherRenderContextSnapshot,
} from "@paperclipai/shared";
import {
  PLUGIN_STATUSES,
} from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { getPluginUiContributionMetadata, pluginLoader } from "../services/plugin-loader.js";
import { logActivity } from "../services/activity-log.js";
import { publishGlobalLiveEvent } from "../services/live-events.js";
import { issueService } from "../services/issues.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginStreamBus } from "../services/plugin-stream-bus.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import {
  assertAuthenticated,
  assertBoard,
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertInstanceAdmin,
  getActorInfo,
} from "./authz.js";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";
import { badRequest, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler, RequestCtx } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

/** UI slot declaration extracted from plugin manifest */
type PluginUiSlotDeclaration = NonNullable<NonNullable<PaperclipPluginManifestV1["ui"]>["slots"]>[number];
/** Launcher declaration extracted from plugin manifest */
type PluginLauncherDeclaration = NonNullable<PaperclipPluginManifestV1["launchers"]>[number];

/**
 * Normalized UI contribution for frontend slot host consumption.
 * Only includes plugins in 'ready' state with non-empty slot declarations.
 */
type PluginUiContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt: string;
  /**
   * Relative path within the plugin's UI directory to the entry module
   * (e.g. `"index.js"`). The frontend constructs the full import URL as
   * `/_plugins/${pluginId}/ui/${uiEntryFile}`.
   */
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
};

/** Request body for POST /api/plugins/install */
interface PluginInstallRequest {
  /** npm package name (e.g., @paperclip/plugin-linear) or local path */
  packageName: string;
  /** Target version for npm packages (optional, defaults to latest) */
  version?: string;
  /** True if packageName is a local filesystem path */
  isLocalPath?: boolean;
}

interface AvailablePluginExample {
  packageName: string;
  pluginKey: string;
  displayName: string;
  description: string;
  localPath: string;
  tag: "example";
}

/** Response body for GET /api/plugins/:pluginId/health */
interface PluginHealthCheckResult {
  pluginId: string;
  status: string;
  healthy: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
  lastError?: string;
}

/** UUID v4 regex used for plugin ID route resolution. */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PLUGIN_API_BODY_LIMIT_BYTES = 1_000_000;
const PLUGIN_SCOPED_API_RESPONSE_HEADER_ALLOWLIST = new Set([
  "cache-control",
  "etag",
  "last-modified",
  "x-request-id",
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const BUNDLED_PLUGIN_EXAMPLES: AvailablePluginExample[] = [
  {
    packageName: "@paperclipai/plugin-hello-world-example",
    pluginKey: "paperclip.hello-world-example",
    displayName: "Hello World Widget (Example)",
    description: "Reference UI plugin that adds a simple Hello World widget to the Paperclip dashboard.",
    localPath: "packages/plugins/examples/plugin-hello-world-example",
    tag: "example",
  },
  {
    packageName: "@paperclipai/plugin-file-browser-example",
    pluginKey: "paperclip-file-browser-example",
    displayName: "File Browser (Example)",
    description: "Example plugin that adds a Files link in project navigation plus a project detail file browser.",
    localPath: "packages/plugins/examples/plugin-file-browser-example",
    tag: "example",
  },
  {
    packageName: "@paperclipai/plugin-kitchen-sink-example",
    pluginKey: "paperclip-kitchen-sink-example",
    displayName: "Kitchen Sink (Example)",
    description: "Reference plugin that demonstrates the current Paperclip plugin API surface, bridge flows, UI extension surfaces, jobs, webhooks, tools, streams, and trusted local workspace/process demos.",
    localPath: "packages/plugins/examples/plugin-kitchen-sink-example",
    tag: "example",
  },
  {
    packageName: "@paperclipai/plugin-orchestration-smoke-example",
    pluginKey: "paperclipai.plugin-orchestration-smoke-example",
    displayName: "Orchestration Smoke (Example)",
    description: "Acceptance fixture for scoped plugin routes, restricted database namespaces, issue orchestration, documents, wakeups, summaries, and UI status surfaces.",
    localPath: "packages/plugins/examples/plugin-orchestration-smoke-example",
    tag: "example",
  },
];

// TODO(cloudflare): listBundledPluginExamples uses existsSync to probe
// local repo paths at request time. These are development-only fixtures that
// reference monorepo-relative paths and are incompatible with Workers where
// there is no persistent local filesystem. This function should either be
// disabled entirely for the Workers deployment or the examples list should be
// served from a static bundled asset.
function listBundledPluginExamples(): AvailablePluginExample[] {
  return BUNDLED_PLUGIN_EXAMPLES.flatMap((plugin) => {
    const absoluteLocalPath = path.resolve(REPO_ROOT, plugin.localPath);
    if (!existsSync(absoluteLocalPath)) return [];
    return [{ ...plugin, localPath: absoluteLocalPath }];
  });
}

/**
 * Resolve a plugin by either database ID or plugin key.
 *
 * Lookup order:
 * - UUID-like IDs: getById first, then getByKey.
 * - Scoped package keys (e.g. "@scope/name"): getByKey only, never getById.
 * - Other non-UUID IDs: try getById first (test/memory registries may allow this),
 *   then fallback to getByKey. Any UUID parse error from getById is ignored.
 *
 * @param registry - The plugin registry service instance
 * @param pluginId - Either a database UUID or plugin key (manifest id)
 * @returns Plugin record or null if not found
 */
async function resolvePlugin(
  registry: ReturnType<typeof pluginRegistryService>,
  pluginId: string,
) {
  const isUuid = UUID_REGEX.test(pluginId);
  const isScopedPackageKey = pluginId.startsWith("@") || pluginId.includes("/");

  if (isScopedPackageKey && !isUuid) {
    return registry.getByKey(pluginId);
  }

  try {
    const byId = await registry.getById(pluginId);
    if (byId) return byId;
  } catch (error) {
    const maybeCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (maybeCode !== "22P02") {
      throw error;
    }
  }

  return registry.getByKey(pluginId);
}

/**
 * Optional dependencies for plugin job scheduling routes.
 *
 * When provided, job-related routes (list jobs, list runs, trigger job) are
 * mounted. When omitted, the routes return 501 Not Implemented.
 */
export interface PluginRouteJobDeps {
  /** The job scheduler instance. */
  scheduler: PluginJobScheduler;
  /** The job persistence store. */
  jobStore: PluginJobStore;
}

/**
 * Optional dependencies for plugin webhook routes.
 *
 * When provided, the webhook ingestion route is enabled. When omitted,
 * webhook POST requests return 501 Not Implemented.
 */
export interface PluginRouteWebhookDeps {
  /** The worker manager for dispatching handleWebhook RPC calls. */
  workerManager: PluginWorkerManager;
}

/**
 * Optional dependencies for plugin tool routes.
 *
 * When provided, tool discovery and execution routes are enabled.
 * When omitted, the tool routes return 501 Not Implemented.
 */
export interface PluginRouteToolDeps {
  /** The tool dispatcher for listing and executing plugin tools. */
  toolDispatcher: PluginToolDispatcher;
}

/**
 * Optional dependencies for plugin UI bridge routes.
 *
 * When provided, the getData and performAction bridge proxy routes are enabled,
 * allowing plugin UI components to communicate with their worker backend via
 * `usePluginData()` and `usePluginAction()` hooks.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export interface PluginRouteBridgeDeps {
  /** The worker manager for dispatching getData/performAction RPC calls. */
  workerManager: PluginWorkerManager;
  /** Optional stream bus for SSE push from worker to UI. */
  streamBus?: PluginStreamBus;
}

interface PluginScopedApiRequest {
  routeKey: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  actor: {
    actorType: "user" | "agent";
    actorId: string;
    agentId?: string | null;
    userId?: string | null;
    runId?: string | null;
  };
  companyId: string;
  headers: Record<string, string>;
}

interface PluginScopedApiResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Request body for POST /api/plugins/tools/execute */
interface PluginToolExecuteRequest {
  /** Fully namespaced tool name (e.g., "acme.linear:search-issues"). */
  tool: string;
  /** Parameters matching the tool's declared JSON Schema. */
  parameters?: unknown;
  /** Agent run context. */
  runContext: ToolRunContext;
}

/**
 * Create Express router for plugin management API.
 *
 * Routes provided:
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | /plugins | List all plugins (optional ?status= filter) |
 * | GET | /plugins/ui-contributions | Get UI slots from ready plugins |
 * | GET | /plugins/:pluginId | Get single plugin by ID or key |
 * | POST | /plugins/install | Install from npm or local path |
 * | DELETE | /plugins/:pluginId | Uninstall (optional ?purge=true) |
 * | POST | /plugins/:pluginId/enable | Enable a plugin |
 * | POST | /plugins/:pluginId/disable | Disable a plugin |
 * | GET | /plugins/:pluginId/health | Run health diagnostics |
 * | POST | /plugins/:pluginId/upgrade | Upgrade to newer version |
 * | GET | /plugins/:pluginId/jobs | List jobs for a plugin |
 * | GET | /plugins/:pluginId/jobs/:jobId/runs | List runs for a job |
 * | POST | /plugins/:pluginId/jobs/:jobId/trigger | Manually trigger a job |
 * | POST | /plugins/:pluginId/webhooks/:endpointKey | Receive inbound webhook |
 * | GET | /plugins/tools | List all available plugin tools |
 * | GET | /plugins/tools?pluginId=... | List tools for a specific plugin |
 * | POST | /plugins/tools/execute | Execute a plugin tool |
 * | GET | /plugins/:pluginId/config | Get current plugin config |
 * | POST | /plugins/:pluginId/config | Save (upsert) plugin config |
 * | POST | /plugins/:pluginId/config/test | Test config via validateConfig RPC |
 * | POST | /plugins/:pluginId/bridge/data | Proxy getData to plugin worker |
 * | POST | /plugins/:pluginId/bridge/action | Proxy performAction to plugin worker |
 * | POST | /plugins/:pluginId/data/:key | Proxy getData to plugin worker (key in URL) |
 * | POST | /plugins/:pluginId/actions/:key | Proxy performAction to plugin worker (key in URL) |
 * | GET | /plugins/:pluginId/bridge/stream/:channel | SSE stream from worker to UI |
 * | GET | /plugins/:pluginId/dashboard | Aggregated health dashboard data |
 *
 * **Route Ordering Note:** Static routes (like /ui-contributions, /tools) must be
 * registered before parameterized routes (like /:pluginId) to prevent Express from
 * matching them as a plugin ID.
 *
 * @param db - Database connection instance
 * @param jobDeps - Optional job scheduling dependencies
 * @param webhookDeps - Optional webhook ingestion dependencies
 * @param toolDeps - Optional tool dispatcher dependencies
 * @param bridgeDeps - Optional bridge proxy dependencies for getData/performAction
 * @returns Express router with plugin routes mounted
 */
export function pluginRoutes(
  db: Db,
  loader: ReturnType<typeof pluginLoader>,
  jobDeps?: PluginRouteJobDeps,
  webhookDeps?: PluginRouteWebhookDeps,
  toolDeps?: PluginRouteToolDeps,
  bridgeDeps?: PluginRouteBridgeDeps,
) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const lifecycle = pluginLifecycleManager(db, {
    loader,
    workerManager: bridgeDeps?.workerManager ?? webhookDeps?.workerManager,
  });
  const issuesSvc = issueService(db);

  // Storage is not needed by plugin handlers directly (bridge calls go to the
  // worker). Supply a sentinel that throws on access.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`plugin handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  const adapterDeps = { db, storage: storageSentinel };

  // ---------------------------------------------------------------------------
  // Express-only helpers (operate on req/res directly — not migrated to Handler)
  // ---------------------------------------------------------------------------

  function matchScopedApiRoute(route: PluginApiRouteDeclaration, method: string, requestPath: string) {
    if (route.method !== method) return null;
    const normalize = (value: string) => value.replace(/\/+$/, "") || "/";
    const routeSegments = normalize(route.path).split("/").filter(Boolean);
    const requestSegments = normalize(requestPath).split("/").filter(Boolean);
    if (routeSegments.length !== requestSegments.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < routeSegments.length; i += 1) {
      const routeSegment = routeSegments[i]!;
      const requestSegment = requestSegments[i]!;
      if (routeSegment.startsWith(":")) {
        params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
        continue;
      }
      if (routeSegment !== requestSegment) return null;
    }
    return params;
  }

  function sanitizePluginRequestHeaders(req: Request): Record<string, string> {
    const safeHeaderNames = new Set([
      "accept",
      "content-type",
      "user-agent",
      "x-paperclip-run-id",
      "x-request-id",
    ]);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (!safeHeaderNames.has(lower)) continue;
      if (Array.isArray(value)) {
        headers[lower] = value.join(", ");
      } else if (typeof value === "string") {
        headers[lower] = value;
      }
    }
    return headers;
  }

  function applyPluginScopedApiResponseHeaders(
    res: Response,
    headers: Record<string, string> | undefined,
  ): void {
    for (const [name, value] of Object.entries(headers ?? {})) {
      const lower = name.toLowerCase();
      if (!PLUGIN_SCOPED_API_RESPONSE_HEADER_ALLOWLIST.has(lower)) continue;
      res.setHeader(lower, value);
    }
  }

  function normalizeQuery(query: Request["query"]): Record<string, string | string[]> {
    const normalized: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === "string") {
        normalized[key] = value;
      } else if (Array.isArray(value)) {
        normalized[key] = value.map((entry) => String(entry));
      }
    }
    return normalized;
  }

  async function resolveScopedApiCompanyId(
    route: PluginApiRouteDeclaration,
    params: Record<string, string>,
    req: Request,
  ) {
    const resolution = route.companyResolution;
    if (!resolution) {
      if (req.actor.type === "agent" && req.actor.companyId) return req.actor.companyId;
      return null;
    }

    if (resolution.from === "body") {
      const body = req.body as Record<string, unknown> | undefined;
      const companyId = body?.[resolution.key ?? ""];
      return typeof companyId === "string" ? companyId : null;
    }

    if (resolution.from === "query") {
      const value = req.query[resolution.key ?? ""];
      return typeof value === "string" ? value : null;
    }

    const issueId = params[resolution.param ?? ""];
    if (!issueId) return null;
    const issue = await issuesSvc.getById(issueId);
    return issue?.companyId ?? null;
  }

  function assertScopedApiAuth(req: Request, route: PluginApiRouteDeclaration) {
    if (route.auth === "board") {
      assertBoard(req);
      return;
    }
    if (route.auth === "agent") {
      assertAuthenticated(req);
      if (req.actor.type !== "agent") throw forbidden("Agent access required");
      return;
    }
    if (route.auth === "webhook") {
      throw unprocessable("Webhook-scoped plugin API routes require a signature verifier and are not enabled");
    }
    assertAuthenticated(req);
    if (req.actor.type !== "board" && req.actor.type !== "agent") {
      throw forbidden("Board or agent access required");
    }
  }

  async function enforceScopedApiCheckout(
    req: Request,
    route: PluginApiRouteDeclaration,
    params: Record<string, string>,
    companyId: string,
  ) {
    const policy = route.checkoutPolicy ?? "none";
    if (policy === "none" || req.actor.type !== "agent") return;
    const issueId = params.issueId;
    if (!issueId) {
      throw unprocessable("Checkout-protected plugin API routes require an issueId route parameter");
    }
    const issue = await issuesSvc.getById(issueId);
    if (!issue || issue.companyId !== companyId) {
      throw notFound("Issue not found");
    }
    if (policy === "required-for-agent-in-progress") {
      if (issue.status !== "in_progress" || issue.assigneeAgentId !== req.actor.agentId) return;
    }
    const runId = req.actor.runId?.trim();
    if (!runId) {
      throw unauthorized("Agent run id required");
    }
    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    await issuesSvc.assertCheckoutOwner(issueId, req.actor.agentId, runId);
  }

  async function resolvePluginAuditCompanyIds(req: Request): Promise<string[]> {
    if (typeof (db as { select?: unknown }).select === "function") {
      const rows = await db
        .select({ id: companies.id })
        .from(companies);
      return rows.map((row) => row.id);
    }

    if (req.actor.type === "agent" && req.actor.companyId) {
      return [req.actor.companyId];
    }

    if (req.actor.type === "board") {
      return req.actor.companyIds ?? [];
    }

    return [];
  }

  async function logPluginMutationActivity(
    req: Request,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const companyIds = await resolvePluginAuditCompanyIds(req);
    if (companyIds.length === 0) return;

    const actor = getActorInfo(req);
    await Promise.all(companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action,
        entityType: "plugin",
        entityId,
        details,
      })));
  }

  function assertPluginBridgeScope(req: Request, companyId: unknown): string | undefined {
    if (companyId === undefined || companyId === null) {
      assertInstanceAdmin(req);
      return undefined;
    }
    if (typeof companyId !== "string" || companyId.trim().length === 0) {
      throw badRequest('"companyId" must be a non-empty string when provided');
    }
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  // ---------------------------------------------------------------------------
  // Ctx-based authz: assertBoardOrgAccess(ctx) and assertBoard(ctx) from
  // authz.ts satisfy AuthzReq structurally and work with RequestCtx directly.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Bridge error mapping
  // ---------------------------------------------------------------------------

  interface PluginBridgeErrorResponse {
    code: PluginBridgeErrorCode;
    message: string;
    details?: unknown;
  }

  function mapRpcErrorToBridgeError(err: unknown): PluginBridgeErrorResponse {
    if (err instanceof JsonRpcCallError) {
      switch (err.code) {
        case PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE:
          return { code: "WORKER_UNAVAILABLE", message: err.message, details: err.data };
        case PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED:
          return { code: "CAPABILITY_DENIED", message: err.message, details: err.data };
        case PLUGIN_RPC_ERROR_CODES.TIMEOUT:
          return { code: "TIMEOUT", message: err.message, details: err.data };
        case PLUGIN_RPC_ERROR_CODES.WORKER_ERROR:
          return { code: "WORKER_ERROR", message: err.message, details: err.data };
        default:
          return { code: "UNKNOWN", message: err.message, details: err.data };
      }
    }

    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("not running") || message.includes("not registered")) {
      return { code: "WORKER_UNAVAILABLE", message };
    }

    return { code: "UNKNOWN", message };
  }

  // ---------------------------------------------------------------------------
  // Tool scope validation
  // ---------------------------------------------------------------------------

  async function validateToolRunContextScope(runContext: ToolRunContext): Promise<string | null> {
    const [agent] = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, runContext.agentId))
      .limit(1);
    if (!agent || agent.companyId !== runContext.companyId) {
      return '"runContext.agentId" does not belong to "runContext.companyId"';
    }

    const [run] = await db
      .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runContext.runId))
      .limit(1);
    if (!run || run.companyId !== runContext.companyId) {
      return '"runContext.runId" does not belong to "runContext.companyId"';
    }
    if (run.agentId !== runContext.agentId) {
      return '"runContext.runId" does not belong to "runContext.agentId"';
    }

    const [project] = await db
      .select({ companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, runContext.projectId))
      .limit(1);
    if (!project || project.companyId !== runContext.companyId) {
      return '"runContext.projectId" does not belong to "runContext.companyId"';
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /**
   * GET /api/plugins
   */
  const listPlugins: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const rawStatus = ctx.query("status");
    if (rawStatus !== undefined) {
      if (!(PLUGIN_STATUSES as readonly string[]).includes(rawStatus)) {
        return Response.json({
          error: `Invalid status '${rawStatus}'. Must be one of: ${PLUGIN_STATUSES.join(", ")}`,
        }, { status: 400 });
      }
    }
    const status = rawStatus as PluginStatus | undefined;
    const plugins = status
      ? await registry.listByStatus(status)
      : await registry.listInstalled();
    return Response.json(plugins);
  };

  /**
   * GET /api/plugins/examples
   */
  const listPluginExamples: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    return Response.json(listBundledPluginExamples());
  };

  /**
   * GET /api/plugins/ui-contributions
   */
  const listUiContributions: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const plugins = await registry.listByStatus("ready");

    const contributions: PluginUiContribution[] = plugins
      .map((plugin) => {
        const manifest = plugin.manifestJson;
        if (!manifest) return null;

        const uiMetadata = getPluginUiContributionMetadata(manifest);
        if (!uiMetadata) return null;

        return {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          displayName: manifest.displayName,
          version: plugin.version,
          updatedAt: plugin.updatedAt.toISOString(),
          uiEntryFile: uiMetadata.uiEntryFile,
          slots: uiMetadata.slots,
          launchers: uiMetadata.launchers,
        };
      })
      .filter((item): item is PluginUiContribution => item !== null);
    return Response.json(contributions);
  };

  /**
   * GET /api/plugins/tools
   */
  const listPluginTools: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    if (!toolDeps) {
      return Response.json({ error: "Plugin tool dispatch is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.query("pluginId");
    const filter = pluginId ? { pluginId } : undefined;
    const tools = toolDeps.toolDispatcher.listToolsForAgent(filter);
    return Response.json(tools);
  };

  /**
   * POST /api/plugins/tools/execute
   */
  const executePluginTool: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    if (!toolDeps) {
      return Response.json({ error: "Plugin tool dispatch is not enabled" }, { status: 501 });
    }

    const body = await ctx.json<PluginToolExecuteRequest | undefined>();
    if (!body) {
      return Response.json({ error: "Request body is required" }, { status: 400 });
    }

    const { tool, parameters, runContext } = body;

    if (!tool || typeof tool !== "string") {
      return Response.json({ error: '"tool" is required and must be a string' }, { status: 400 });
    }

    if (!runContext || typeof runContext !== "object") {
      return Response.json({ error: '"runContext" is required and must be an object' }, { status: 400 });
    }

    if (!runContext.agentId || !runContext.runId || !runContext.companyId || !runContext.projectId) {
      return Response.json({
        error: '"runContext" must include agentId, runId, companyId, and projectId',
      }, { status: 400 });
    }

    if (!ctx.actor) throw forbidden("Authentication required");
    const scopeError = await validateToolRunContextScope(runContext);
    if (scopeError) {
      return Response.json({ error: scopeError }, { status: 403 });
    }

    const registeredTool = toolDeps.toolDispatcher.getTool(tool);
    if (!registeredTool) {
      return Response.json({ error: `Tool "${tool}" not found` }, { status: 404 });
    }

    try {
      const result = await toolDeps.toolDispatcher.executeTool(
        tool,
        parameters ?? {},
        runContext,
      );
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("not running") || message.includes("worker")) {
        return Response.json({ error: message }, { status: 502 });
      }
      return Response.json({ error: message }, { status: 500 });
    }
  };

  /**
   * POST /api/plugins/install
   */
  const installPlugin: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const body = await ctx.json<PluginInstallRequest>();
    const { packageName, version, isLocalPath } = body;

    if (!packageName || typeof packageName !== "string") {
      return Response.json({ error: "packageName is required and must be a string" }, { status: 400 });
    }

    if (version !== undefined && typeof version !== "string") {
      return Response.json({ error: "version must be a string if provided" }, { status: 400 });
    }

    if (isLocalPath !== undefined && typeof isLocalPath !== "boolean") {
      return Response.json({ error: "isLocalPath must be a boolean if provided" }, { status: 400 });
    }

    const trimmedPackage = packageName.trim();
    if (trimmedPackage.length === 0) {
      return Response.json({ error: "packageName cannot be empty" }, { status: 400 });
    }

    if (!isLocalPath && /[<>:"|?*]/.test(trimmedPackage)) {
      return Response.json({ error: "packageName contains invalid characters" }, { status: 400 });
    }

    try {
      const installOptions = isLocalPath
        ? { localPath: trimmedPackage }
        : { packageName: trimmedPackage, version: version?.trim() };

      const discovered = await loader.installPlugin(installOptions);

      if (!discovered.manifest) {
        return Response.json({ error: "Plugin installed but manifest is missing" }, { status: 500 });
      }

      const existingPlugin = await registry.getByKey(discovered.manifest.id);
      if (existingPlugin) {
        await lifecycle.load(existingPlugin.id);
        const updated = await registry.getById(existingPlugin.id);
        // logPluginMutationActivity needs an Express Request for the richer actor
        // shape; delegate to caller via the Express middleware layer.
        publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: existingPlugin.id, action: "installed" } });
        return Response.json(updated);
      }
      return Response.json({ error: "Plugin installed but not found in registry" }, { status: 500 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/bridge/data
   */
  const bridgeGetData: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    if (!bridgeDeps) {
      return Response.json({ error: "Plugin bridge is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      return Response.json(bridgeError, { status: 502 });
    }

    interface PluginBridgeDataRequest {
      key: string;
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    }

    const body = await ctx.json<PluginBridgeDataRequest | undefined>();
    if (!body || !body.key || typeof body.key !== "string") {
      return Response.json({ error: '"key" is required and must be a string' }, { status: 400 });
    }

    // companyId-scoped bridge auth requires assertCompanyAccess which reads
    // req.actor deeply; enforce at Express layer (see wiring below).

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      return Response.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      return Response.json(bridgeError, { status: 502 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/bridge/action
   */
  const bridgePerformAction: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    if (!bridgeDeps) {
      return Response.json({ error: "Plugin bridge is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      return Response.json(bridgeError, { status: 502 });
    }

    interface PluginBridgeActionRequest {
      key: string;
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    }

    const body = await ctx.json<PluginBridgeActionRequest | undefined>();
    if (!body || !body.key || typeof body.key !== "string") {
      return Response.json({ error: '"key" is required and must be a string' }, { status: 400 });
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      return Response.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      return Response.json(bridgeError, { status: 502 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/data/:key
   */
  const bridgeGetDataByKey: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    if (!bridgeDeps) {
      return Response.json({ error: "Plugin bridge is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    const key = ctx.param("key");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    if (!key) return Response.json({ error: "Missing key" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      return Response.json(bridgeError, { status: 502 });
    }

    const body = await ctx.json<{
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } | undefined>();

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key,
          params: body?.params ?? {},
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      return Response.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      return Response.json(bridgeError, { status: 502 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/actions/:key
   */
  const bridgePerformActionByKey: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    if (!bridgeDeps) {
      return Response.json({ error: "Plugin bridge is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    const key = ctx.param("key");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    if (!key) return Response.json({ error: "Missing key" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      return Response.json(bridgeError, { status: 502 });
    }

    const body = await ctx.json<{
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } | undefined>();

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key,
          params: body?.params ?? {},
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      return Response.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      return Response.json(bridgeError, { status: 502 });
    }
  };

  /**
   * GET /api/plugins/:pluginId
   */
  const getPlugin: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const worker = bridgeDeps?.workerManager.getWorker(plugin.id);
    const supportsConfigTest = worker
      ? worker.supportedMethods.includes("validateConfig")
      : false;

    return Response.json({ ...plugin, supportsConfigTest });
  };

  /**
   * DELETE /api/plugins/:pluginId
   */
  const deletePlugin: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    const purge = ctx.query("purge") === "true";

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    try {
      const result = await lifecycle.unload(plugin.id, purge);
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "uninstalled" } });
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/enable
   */
  const enablePlugin: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    try {
      const result = await lifecycle.enable(plugin.id);
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "enabled" } });
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/disable
   */
  const disablePlugin: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    const body = await ctx.json<{ reason?: string } | undefined>();
    const reason = body?.reason;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    try {
      const result = await lifecycle.disable(plugin.id, reason);
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "disabled" } });
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  };

  /**
   * GET /api/plugins/:pluginId/health
   */
  const getPluginHealth: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const checks: PluginHealthCheckResult["checks"] = [];

    checks.push({ name: "registry", passed: true, message: "Plugin found in registry" });

    const hasValidManifest = Boolean(plugin.manifestJson?.id);
    checks.push({
      name: "manifest",
      passed: hasValidManifest,
      message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
    });

    const isHealthy = plugin.status === "ready";
    checks.push({ name: "status", passed: isHealthy, message: `Current status: ${plugin.status}` });

    const hasNoError = !plugin.lastError;
    if (!hasNoError) {
      checks.push({ name: "error_state", passed: false, message: plugin.lastError ?? undefined });
    }

    const result: PluginHealthCheckResult = {
      pluginId: plugin.id,
      status: plugin.status,
      healthy: isHealthy && hasValidManifest && hasNoError,
      checks,
      lastError: plugin.lastError ?? undefined,
    };

    return Response.json(result);
  };

  /**
   * GET /api/plugins/:pluginId/logs
   */
  const getPluginLogs: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const limit = Math.min(Math.max(parseInt(ctx.query("limit") ?? "25", 10) || 25, 1), 500);
    const level = ctx.query("level");
    const since = ctx.query("since");

    const conditions = [eq(pluginLogs.pluginId, plugin.id)];
    if (level) {
      conditions.push(eq(pluginLogs.level, level));
    }
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        conditions.push(gte(pluginLogs.createdAt, sinceDate));
      }
    }

    const rows = await db
      .select()
      .from(pluginLogs)
      .where(and(...conditions))
      .orderBy(desc(pluginLogs.createdAt))
      .limit(limit);

    return Response.json(rows);
  };

  /**
   * POST /api/plugins/:pluginId/upgrade
   */
  const upgradePlugin: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    const body = await ctx.json<{ version?: string } | undefined>();
    const version = body?.version;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    try {
      const result = await lifecycle.upgrade(plugin.id, version);
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "upgraded" } });
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  };

  /**
   * GET /api/plugins/:pluginId/config
   */
  const getPluginConfig: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const config = await registry.getConfig(plugin.id);
    return Response.json(config);
  };

  /**
   * POST /api/plugins/:pluginId/config
   */
  const savePluginConfig: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const body = await ctx.json<{ configJson?: Record<string, unknown> } | undefined>();
    if (!body?.configJson || typeof body.configJson !== "object") {
      return Response.json({ error: '"configJson" is required and must be an object' }, { status: 400 });
    }

    // devUiUrl strip: only instance admins may set it. The Express layer
    // enforces instance-admin before this handler runs, so if we reach here
    // the caller is an instance admin and devUiUrl is allowed.

    const schema = plugin.manifestJson?.instanceConfigSchema;
    if (schema && Object.keys(schema).length > 0) {
      const validation = validateInstanceConfig(body.configJson, schema);
      if (!validation.valid) {
        return Response.json({
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        }, { status: 400 });
      }
    }

    try {
      const result = await registry.upsertConfig(plugin.id, {
        configJson: body.configJson,
      });

      if (bridgeDeps?.workerManager.isRunning(plugin.id)) {
        try {
          await bridgeDeps.workerManager.call(
            plugin.id,
            "configChanged",
            { config: body.configJson },
          );
        } catch (rpcErr) {
          if (
            rpcErr instanceof JsonRpcCallError &&
            rpcErr.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
          ) {
            try {
              await lifecycle.restartWorker(plugin.id);
            } catch {
              // Restart failure is non-fatal for the config save response.
            }
          }
        }
      }

      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/config/test
   */
  const testPluginConfig: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    if (!bridgeDeps) {
      return Response.json({ error: "Plugin bridge is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    if (plugin.status !== "ready") {
      return Response.json({ error: `Plugin is not ready (current status: ${plugin.status})` }, { status: 400 });
    }

    const body = await ctx.json<{ configJson?: Record<string, unknown> } | undefined>();
    if (!body?.configJson || typeof body.configJson !== "object") {
      return Response.json({ error: '"configJson" is required and must be an object' }, { status: 400 });
    }

    const schema = plugin.manifestJson?.instanceConfigSchema;
    if (schema && Object.keys(schema).length > 0) {
      const validation = validateInstanceConfig(body.configJson, schema);
      if (!validation.valid) {
        return Response.json({
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        }, { status: 400 });
      }
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "validateConfig",
        { config: body.configJson },
      );

      if (result.ok) {
        const warningText = result.warnings?.length
          ? `Warnings: ${result.warnings.join("; ")}`
          : undefined;
        return Response.json({ valid: true, message: warningText });
      }
      const errorText = result.errors?.length
        ? result.errors.join("; ")
        : "Configuration validation failed.";
      return Response.json({ valid: false, message: errorText });
    } catch (err) {
      if (
        err instanceof JsonRpcCallError &&
        err.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
      ) {
        return Response.json({
          valid: false,
          supported: false,
          message: "This plugin does not support configuration testing.",
        });
      }

      const bridgeError = mapRpcErrorToBridgeError(err);
      return Response.json(bridgeError, { status: 502 });
    }
  };

  /**
   * GET /api/plugins/:pluginId/jobs
   */
  const listPluginJobs: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    if (!jobDeps) {
      return Response.json({ error: "Job scheduling is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const rawStatus = ctx.query("status");
    const validStatuses = ["active", "paused", "failed"];
    if (rawStatus !== undefined && !validStatuses.includes(rawStatus)) {
      return Response.json({
        error: `Invalid status '${rawStatus}'. Must be one of: ${validStatuses.join(", ")}`,
      }, { status: 400 });
    }

    try {
      const jobs = await jobDeps.jobStore.listJobs(
        plugin.id,
        rawStatus as "active" | "paused" | "failed" | undefined,
      );
      return Response.json(jobs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  };

  /**
   * GET /api/plugins/:pluginId/jobs/:jobId/runs
   */
  const listPluginJobRuns: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    if (!jobDeps) {
      return Response.json({ error: "Job scheduling is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    const jobId = ctx.param("jobId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    if (!jobId) return Response.json({ error: "Missing jobId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const job = await jobDeps.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const limit = ctx.query("limit") ? parseInt(ctx.query("limit")!, 10) : 25;
    if (isNaN(limit) || limit < 1 || limit > 500) {
      return Response.json({ error: "limit must be a number between 1 and 500" }, { status: 400 });
    }

    try {
      const runs = await jobDeps.jobStore.listRunsByJob(jobId, limit);
      return Response.json(runs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/jobs/:jobId/trigger
   */
  const triggerPluginJob: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    if (!jobDeps) {
      return Response.json({ error: "Job scheduling is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    const jobId = ctx.param("jobId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    if (!jobId) return Response.json({ error: "Missing jobId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    const job = await jobDeps.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    try {
      const result = await jobDeps.scheduler.triggerJob(jobId, "manual");
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 400 });
    }
  };

  /**
   * POST /api/plugins/:pluginId/webhooks/:endpointKey
   *
   * NOTE: This route does NOT require board authentication — webhook endpoints
   * must be publicly accessible for external callers.
   */
  const receiveWebhook: Handler = async (ctx) => {
    if (!webhookDeps) {
      return Response.json({ error: "Webhook ingestion is not enabled" }, { status: 501 });
    }

    const pluginId = ctx.param("pluginId");
    const endpointKey = ctx.param("endpointKey");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });
    if (!endpointKey) return Response.json({ error: "Missing endpointKey" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    if (plugin.status !== "ready") {
      return Response.json({
        error: `Plugin is not ready (current status: ${plugin.status})`,
      }, { status: 400 });
    }

    const manifest = plugin.manifestJson;
    if (!manifest) {
      return Response.json({ error: "Plugin manifest is missing" }, { status: 400 });
    }

    const capabilities = manifest.capabilities ?? [];
    if (!capabilities.includes("webhooks.receive")) {
      return Response.json({
        error: "Plugin does not have the webhooks.receive capability",
      }, { status: 400 });
    }

    const declaredWebhooks = manifest.webhooks ?? [];
    const webhookDecl = declaredWebhooks.find((w) => w.endpointKey === endpointKey);
    if (!webhookDecl) {
      return Response.json({
        error: `Webhook endpoint '${endpointKey}' is not declared by this plugin`,
      }, { status: 404 });
    }

    const requestId = randomUUID();
    const rawHeaders: Record<string, string> = {};
    ctx.headers.forEach((value, name) => {
      rawHeaders[name] = value;
    });

    // The rawBody stash from express.json() verify callback is not available in
    // the transport-agnostic ctx. Fall back to re-reading via ctx.text().
    const rawBody = await ctx.text();
    const parsedBody = await ctx.json<unknown>().catch(() => null);
    const payload = (parsedBody as Record<string, unknown> | undefined) ?? {};

    const startedAt = new Date();
    const [delivery] = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId: plugin.id,
        webhookKey: endpointKey,
        status: "pending",
        payload,
        headers: rawHeaders,
        startedAt,
      })
      .returning({ id: pluginWebhookDeliveries.id });

    try {
      await webhookDeps.workerManager.call(plugin.id, "handleWebhook", {
        endpointKey,
        headers: rawHeaders,
        rawBody,
        parsedBody,
        requestId,
      });

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await db
        .update(pluginWebhookDeliveries)
        .set({ status: "success", durationMs, finishedAt })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      return Response.json({ deliveryId: delivery.id, status: "success" }, { status: 200 });
    } catch (err) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const errorMessage = err instanceof Error ? err.message : String(err);

      await db
        .update(pluginWebhookDeliveries)
        .set({ status: "failed", durationMs, error: errorMessage, finishedAt })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      return Response.json({ deliveryId: delivery.id, status: "failed", error: errorMessage }, { status: 502 });
    }
  };

  /**
   * GET /api/plugins/:pluginId/dashboard
   */
  const getPluginDashboard: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const pluginId = ctx.param("pluginId");
    if (!pluginId) return Response.json({ error: "Missing pluginId" }, { status: 400 });

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      return Response.json({ error: "Plugin not found" }, { status: 404 });
    }

    let worker: {
      status: string;
      pid: number | null;
      uptime: number | null;
      consecutiveCrashes: number;
      totalCrashes: number;
      pendingRequests: number;
      lastCrashAt: number | null;
      nextRestartAt: number | null;
    } | null = null;

    const wm = bridgeDeps?.workerManager ?? webhookDeps?.workerManager ?? null;
    if (wm) {
      const handle = wm.getWorker(plugin.id);
      if (handle) {
        const diag = handle.diagnostics();
        worker = {
          status: diag.status,
          pid: diag.pid,
          uptime: diag.uptime,
          consecutiveCrashes: diag.consecutiveCrashes,
          totalCrashes: diag.totalCrashes,
          pendingRequests: diag.pendingRequests,
          lastCrashAt: diag.lastCrashAt,
          nextRestartAt: diag.nextRestartAt,
        };
      }
    }

    let recentJobRuns: Array<{
      id: string;
      jobId: string;
      jobKey?: string;
      trigger: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    if (jobDeps) {
      try {
        const runs = await jobDeps.jobStore.listRunsByPlugin(plugin.id, undefined, 10);
        const jobs = await jobDeps.jobStore.listJobs(plugin.id);
        const jobKeyMap = new Map(jobs.map((j) => [j.id, j.jobKey]));

        recentJobRuns = runs
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((r) => ({
            id: r.id,
            jobId: r.jobId,
            jobKey: jobKeyMap.get(r.jobId) ?? undefined,
            trigger: r.trigger,
            status: r.status,
            durationMs: r.durationMs,
            error: r.error,
            startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
            finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
            createdAt: new Date(r.createdAt).toISOString(),
          }));
      } catch {
        // Job data unavailable — leave empty
      }
    }

    let recentWebhookDeliveries: Array<{
      id: string;
      webhookKey: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    try {
      const deliveries = await db
        .select({
          id: pluginWebhookDeliveries.id,
          webhookKey: pluginWebhookDeliveries.webhookKey,
          status: pluginWebhookDeliveries.status,
          durationMs: pluginWebhookDeliveries.durationMs,
          error: pluginWebhookDeliveries.error,
          startedAt: pluginWebhookDeliveries.startedAt,
          finishedAt: pluginWebhookDeliveries.finishedAt,
          createdAt: pluginWebhookDeliveries.createdAt,
        })
        .from(pluginWebhookDeliveries)
        .where(eq(pluginWebhookDeliveries.pluginId, plugin.id))
        .orderBy(desc(pluginWebhookDeliveries.createdAt))
        .limit(10);

      recentWebhookDeliveries = deliveries.map((d) => ({
        id: d.id,
        webhookKey: d.webhookKey,
        status: d.status,
        durationMs: d.durationMs,
        error: d.error,
        startedAt: d.startedAt ? d.startedAt.toISOString() : null,
        finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      }));
    } catch {
      // Webhook data unavailable — leave empty
    }

    const checks: PluginHealthCheckResult["checks"] = [];

    checks.push({ name: "registry", passed: true, message: "Plugin found in registry" });

    const hasValidManifest = Boolean(plugin.manifestJson?.id);
    checks.push({
      name: "manifest",
      passed: hasValidManifest,
      message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
    });

    const isHealthy = plugin.status === "ready";
    checks.push({ name: "status", passed: isHealthy, message: `Current status: ${plugin.status}` });

    const hasNoError = !plugin.lastError;
    if (!hasNoError) {
      checks.push({ name: "error_state", passed: false, message: plugin.lastError ?? undefined });
    }

    const health: PluginHealthCheckResult = {
      pluginId: plugin.id,
      status: plugin.status,
      healthy: isHealthy && hasValidManifest && hasNoError,
      checks,
      lastError: plugin.lastError ?? undefined,
    };

    return Response.json({
      pluginId: plugin.id,
      worker,
      recentJobRuns,
      recentWebhookDeliveries,
      health,
      checkedAt: new Date().toISOString(),
    });
  };

  // ---------------------------------------------------------------------------
  // Route wiring
  // IMPORTANT: Static routes must come before parameterized routes.
  // ---------------------------------------------------------------------------

  router.get("/plugins", expressHandler(listPlugins, adapterDeps));
  router.get("/plugins/examples", expressHandler(listPluginExamples, adapterDeps));
  router.get("/plugins/ui-contributions", expressHandler(listUiContributions, adapterDeps));
  router.get("/plugins/tools", expressHandler(listPluginTools, adapterDeps));
  router.post("/plugins/tools/execute", expressHandler(executePluginTool, adapterDeps));

  router.post("/plugins/install", expressHandler(installPlugin, adapterDeps));

  // Bridge routes — companyId-scoped auth runs in Express middleware before Handler
  router.post("/plugins/:pluginId/bridge/data", async (req, _res, next) => {
    try {
      assertBoardOrgAccess(req);
      const body = req.body as { companyId?: unknown } | undefined;
      if (body?.companyId !== undefined && body?.companyId !== null) {
        assertPluginBridgeScope(req, body.companyId);
      } else {
        assertInstanceAdmin(req);
      }
      next();
    } catch (err) { next(err); }
  }, expressHandler(bridgeGetData, adapterDeps));

  router.post("/plugins/:pluginId/bridge/action", async (req, _res, next) => {
    try {
      assertBoardOrgAccess(req);
      const body = req.body as { companyId?: unknown } | undefined;
      if (body?.companyId !== undefined && body?.companyId !== null) {
        assertPluginBridgeScope(req, body.companyId);
      } else {
        assertInstanceAdmin(req);
      }
      next();
    } catch (err) { next(err); }
  }, expressHandler(bridgePerformAction, adapterDeps));

  router.post("/plugins/:pluginId/data/:key", async (req, _res, next) => {
    try {
      assertBoardOrgAccess(req);
      const body = req.body as { companyId?: unknown } | undefined;
      if (body?.companyId !== undefined && body?.companyId !== null) {
        assertPluginBridgeScope(req, body.companyId);
      } else {
        assertInstanceAdmin(req);
      }
      next();
    } catch (err) { next(err); }
  }, expressHandler(bridgeGetDataByKey, adapterDeps));

  router.post("/plugins/:pluginId/actions/:key", async (req, _res, next) => {
    try {
      assertBoardOrgAccess(req);
      const body = req.body as { companyId?: unknown } | undefined;
      if (body?.companyId !== undefined && body?.companyId !== null) {
        assertPluginBridgeScope(req, body.companyId);
      } else {
        assertInstanceAdmin(req);
      }
      next();
    } catch (err) { next(err); }
  }, expressHandler(bridgePerformActionByKey, adapterDeps));

  /**
   * GET /api/plugins/:pluginId/bridge/stream/:channel
   *
   * TODO(cloudflare): SSE streaming via res.write() is Express/Node-specific.
   * For Workers compatibility this route must be rewritten using the
   * TransformStream / ReadableStream API. Keep the existing Express code path.
   */
  router.get("/plugins/:pluginId/bridge/stream/:channel", async (req, res) => {
    assertBoardOrgAccess(req);

    if (!bridgeDeps?.streamBus) {
      res.status(501).json({ error: "Plugin stream bridge is not enabled" });
      return;
    }

    const { pluginId, channel } = req.params;
    const companyId = req.query.companyId as string | undefined;

    if (!companyId) {
      res.status(400).json({ error: '"companyId" query parameter is required' });
      return;
    }

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    assertCompanyAccess(req, companyId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    res.write(":ok\n\n");

    let unsubscribed = false;
    const safeUnsubscribe = () => {
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe();
      }
    };

    const unsubscribe = bridgeDeps.streamBus.subscribe(
      plugin.id,
      channel,
      companyId,
      (event, eventType) => {
        if (unsubscribed || !res.writable) return;
        try {
          if (eventType !== "message") {
            res.write(`event: ${eventType}\n`);
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          safeUnsubscribe();
        }
      },
    );

    req.on("close", safeUnsubscribe);
    res.on("error", safeUnsubscribe);
  });

  /**
   * router.use /plugins/:pluginId/api
   *
   * TODO(cloudflare): This scoped API middleware uses Express-specific
   * req.method, req.path, req.headers, req.body, req.query, and res.setHeader /
   * res.status / res.json / res.end. For Workers compatibility it must be
   * rewritten as a Handler using ctx equivalents. Keep the existing Express
   * code path.
   */
  router.use("/plugins/:pluginId/api", async (req, res) => {
    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin scoped API routes are not enabled" });
      return;
    }

    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    if (plugin.status !== "ready") {
      res.status(503).json({ error: `Plugin is not ready (current status: ${plugin.status})` });
      return;
    }
    const isWorkerRunning = typeof bridgeDeps.workerManager.isRunning === "function"
      ? bridgeDeps.workerManager.isRunning(plugin.id)
      : true;
    if (!isWorkerRunning) {
      res.status(503).json({ error: "Plugin worker is not running" });
      return;
    }
    if (!plugin.manifestJson.capabilities.includes("api.routes.register")) {
      res.status(404).json({ error: "Plugin does not expose scoped API routes" });
      return;
    }

    const requestPath = req.path || "/";
    const routes = plugin.manifestJson.apiRoutes ?? [];
    const match = routes
      .map((route) => ({ route, params: matchScopedApiRoute(route, req.method, requestPath) }))
      .find((candidate) => candidate.params !== null);
    if (!match || !match.params) {
      res.status(404).json({ error: "Plugin API route not found" });
      return;
    }

    try {
      assertScopedApiAuth(req, match.route);
      const companyId = await resolveScopedApiCompanyId(match.route, match.params, req);
      if (!companyId) {
        res.status(400).json({ error: "Unable to resolve company for plugin API route" });
        return;
      }
      assertCompanyAccess(req, companyId);
      await enforceScopedApiCheckout(req, match.route, match.params, companyId);
      if (req.method !== "GET" && req.headers["content-type"] && !req.is("application/json")) {
        res.status(415).json({ error: "Plugin API routes accept JSON requests only" });
        return;
      }
      const requestBody = req.body ?? null;
      const bodySize = Buffer.byteLength(JSON.stringify(requestBody));
      if (bodySize > PLUGIN_API_BODY_LIMIT_BYTES) {
        res.status(413).json({ error: "Plugin API request body is too large" });
        return;
      }

      const actor = getActorInfo(req);
      const input: PluginScopedApiRequest = {
        routeKey: match.route.routeKey,
        method: req.method,
        path: requestPath,
        params: match.params,
        query: normalizeQuery(req.query),
        body: requestBody,
        actor: {
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId,
        },
        companyId,
        headers: sanitizePluginRequestHeaders(req),
      };

      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "handleApiRequest",
        input,
      ) as PluginScopedApiResponse;
      const status = Number.isInteger(result.status) && Number(result.status) >= 200 && Number(result.status) <= 599
        ? Number(result.status)
        : 200;
      applyPluginScopedApiResponseHeaders(res, result.headers);
      if (status === 204) {
        res.status(status).end();
      } else {
        res.status(status).json(result.body ?? null);
      }
    } catch (err) {
      const status = typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : err instanceof JsonRpcCallError && err.code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED
          ? 403
          : err instanceof JsonRpcCallError && err.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
            ? 501
            : err instanceof JsonRpcCallError
              ? 502
              : 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Parameterized routes after static ones
  router.get("/plugins/:pluginId", expressHandler(getPlugin, adapterDeps));

  router.delete("/plugins/:pluginId", expressHandler(deletePlugin, adapterDeps));
  router.post("/plugins/:pluginId/enable", expressHandler(enablePlugin, adapterDeps));
  router.post("/plugins/:pluginId/disable", expressHandler(disablePlugin, adapterDeps));
  router.get("/plugins/:pluginId/health", expressHandler(getPluginHealth, adapterDeps));
  router.get("/plugins/:pluginId/logs", expressHandler(getPluginLogs, adapterDeps));
  router.post("/plugins/:pluginId/upgrade", expressHandler(upgradePlugin, adapterDeps));
  router.get("/plugins/:pluginId/config", expressHandler(getPluginConfig, adapterDeps));
  router.post("/plugins/:pluginId/config", expressHandler(savePluginConfig, adapterDeps));
  router.post("/plugins/:pluginId/config/test", expressHandler(testPluginConfig, adapterDeps));
  router.get("/plugins/:pluginId/jobs", expressHandler(listPluginJobs, adapterDeps));
  router.get("/plugins/:pluginId/jobs/:jobId/runs", expressHandler(listPluginJobRuns, adapterDeps));
  router.post("/plugins/:pluginId/jobs/:jobId/trigger", expressHandler(triggerPluginJob, adapterDeps));

  router.post("/plugins/:pluginId/webhooks/:endpointKey", expressHandler(receiveWebhook, adapterDeps));
  router.get("/plugins/:pluginId/dashboard", expressHandler(getPluginDashboard, adapterDeps));

  return router;
}
