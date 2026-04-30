/**
 * route-registry.ts
 *
 * Builds the full set of compiled route definitions for every request.
 *
 * Because CF Workers prohibits reusing TCP sockets (and therefore postgres
 * connections) across requests, we rebuild the Drizzle DB instance, all
 * service instances, and all route handler closures on every request.
 *
 * Route path patterns (regexp + paramNames) are purely static and are
 * cached at the module level so they survive across requests in the same
 * isolate — only the handler closures (which capture the DB) are rebuilt.
 */

import { createHyperdriveDb } from "../db/hyperdrive.js";
import { R2Provider } from "../storage/r2-provider.js";
import { createCfStorageService } from "../storage/cf-storage-service.js";
import { extractRoutesFromRouter } from "../http/express-router-bridge.js";
import { extractAllRoutesFromRouter } from "../http/cf-express-bridge.js";
import { resolveDeploymentMode } from "./env.js";
import type { Env } from "./env.js";
import type { RouteDefinition } from "../../../../server/src/http/types.js";
import type { StorageService } from "../../../../server/src/storage/types.js";
import type { Db } from "@paperclipai/db";

// Route factory imports
import { companyRoutes } from "../../../../server/src/routes/companies.js";
import { accessRoutes } from "../../../../server/src/routes/access.js";
import { adapterRoutes } from "../../../../server/src/routes/adapters.js";
import { agentRoutes } from "../../../../server/src/routes/agents.js";
import { assetRoutes } from "../../../../server/src/routes/assets.js";
import { projectRoutes } from "../../../../server/src/routes/projects.js";
import { issueRoutes } from "../../../../server/src/routes/issues.js";
import { issueTreeControlRoutes } from "../../../../server/src/routes/issue-tree-control.js";
import { routineRoutes } from "../../../../server/src/routes/routines.js";
import { environmentRoutes } from "../../../../server/src/routes/environments.js";
import { executionWorkspaceRoutes } from "../../../../server/src/routes/execution-workspaces.js";
import { goalRoutes } from "../../../../server/src/routes/goals.js";
import { approvalRoutes } from "../../../../server/src/routes/approvals.js";
import { secretRoutes } from "../../../../server/src/routes/secrets.js";
import { costRoutes } from "../../../../server/src/routes/costs.js";
import { activityRoutes } from "../../../../server/src/routes/activity.js";
import { dashboardRoutes } from "../../../../server/src/routes/dashboard.js";
import { userProfileRoutes } from "../../../../server/src/routes/user-profiles.js";
import { sidebarBadgeRoutes } from "../../../../server/src/routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "../../../../server/src/routes/sidebar-preferences.js";
import { inboxDismissalRoutes } from "../../../../server/src/routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "../../../../server/src/routes/instance-settings.js";
import { llmRoutes } from "../../../../server/src/routes/llms.js";
import { authRoutes } from "../../../../server/src/routes/auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompiledRoute {
  route: RouteDefinition;
  re: RegExp;
  paramNames: string[];
}

export interface RequestResources {
  compiled: CompiledRoute[];
  db: Db;
  storage: StorageService;
}

// ---------------------------------------------------------------------------
// Path pattern compilation
// ---------------------------------------------------------------------------

// Cached route path patterns. These are stateless (no DB reference) and safe
// to reuse across requests within the same isolate.
// Keyed by a path-order fingerprint so any change in routes (add, remove,
// reorder) invalidates the cache instead of silently misaligning patterns.
let compiledPathCache: {
  fingerprint: string;
  patterns: Array<{ re: RegExp; paramNames: string[] }>;
} | null = null;

/** Converts an Express-style path (with :param segments) to a RegExp + param names. */
function pathToRegex(path: string): { re: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
  return { re: new RegExp(`^${pattern}$`), paramNames };
}

function ext(router: unknown, prefix: string): RouteDefinition[] {
  return extractRoutesFromRouter(router, prefix);
}

// ---------------------------------------------------------------------------
// Per-request resource builder
// ---------------------------------------------------------------------------

/**
 * Builds a fresh DB instance, storage provider, and route handler closures
 * for the current request.
 *
 * Call once per request (not at module load time) because:
 *   - The Drizzle DB wraps a postgres-js pool backed by a Hyperdrive TCP
 *     connection that CF Workers prohibits reusing across requests.
 *   - Route handler closures capture `db` and `storage`, so they must be
 *     rebuilt whenever the DB instance is replaced.
 *
 * Route path regexps are compiled once and reused via `compiledPathCache`.
 */
export function buildRequestResources(env: Env): RequestResources {
  const db = createHyperdriveDb(env.HYPERDRIVE);
  const r2Provider = new R2Provider(env.PAPERCLIP_STORAGE, {
    bucket: env.STORAGE_R2_BUCKET ?? "paperclip-storage",
    prefix: env.STORAGE_R2_PREFIX ?? "",
  });
  const storage = createCfStorageService(r2Provider) as unknown as StorageService;

  const routes: RouteDefinition[] = [
    ...ext(companyRoutes(db, storage), "/api/companies"),
    ...ext(agentRoutes(db, {}), "/api"),
    ...ext(assetRoutes(db, storage), "/api"),
    ...ext(projectRoutes(db), "/api"),
    ...ext(issueRoutes(db, storage, {}), "/api"),
    ...ext(issueTreeControlRoutes(db), "/api"),
    ...ext(routineRoutes(db, {}), "/api"),
    ...ext(environmentRoutes(db, {}), "/api"),
    ...ext(executionWorkspaceRoutes(db), "/api"),
    ...ext(goalRoutes(db), "/api"),
    ...ext(approvalRoutes(db, {}), "/api"),
    ...ext(secretRoutes(db), "/api"),
    ...ext(costRoutes(db, {}), "/api"),
    ...ext(activityRoutes(db), "/api"),
    ...ext(dashboardRoutes(db), "/api"),
    ...ext(userProfileRoutes(db), "/api"),
    ...ext(sidebarBadgeRoutes(db), "/api"),
    ...ext(sidebarPreferenceRoutes(db), "/api"),
    ...ext(inboxDismissalRoutes(db), "/api"),
    ...ext(instanceSettingsRoutes(db), "/api"),
    ...ext(llmRoutes(db), "/api"),
    ...ext(authRoutes(db), "/api/auth"),
    // adapterRoutes() needs no db/storage: its handlers read from an in-memory
    // registry populated at bundle time (no DB lookups, no filesystem I/O).
    // Passing sentinel Proxy objects satisfies TypeScript without touching DB.
    ...ext(adapterRoutes(), "/api"),
    // accessRoutes uses raw Express handlers (not the expressHandler adapter),
    // so extractRoutesFromRouter cannot see them via __handler tags.
    // extractAllRoutesFromRouter walks the full router stack and wraps raw
    // handlers via bridgeExpressHandlers, making them transport-agnostic.
    ...extractAllRoutesFromRouter(
      accessRoutes(db, {
        deploymentMode: resolveDeploymentMode(env),
        deploymentExposure: (env.DEPLOYMENT_EXPOSURE ?? "private") as "private" | "public",
        bindHost: "",
        allowedHostnames: [],
      }),
      "/api",
    ),
  ];

  // Populate or invalidate the path-pattern cache.
  //
  // Route path patterns are purely static (no DB reference) and are safe to
  // reuse across requests in the same isolate. The fingerprint is the ordered
  // concatenation of all route paths, so any add/remove/reorder invalidates
  // the cache rather than silently misaligning handlers with patterns.
  const fingerprint = routes.map((r) => r.path).join("|");
  if (compiledPathCache?.fingerprint !== fingerprint) {
    compiledPathCache = {
      fingerprint,
      patterns: routes.map((r) => pathToRegex(r.path)),
    };
    // Fires once per isolate cold start.
    console.debug(`[CF Worker] Compiled ${compiledPathCache.patterns.length} route patterns`);
  }

  const compiled: CompiledRoute[] = routes.map((route, i) => ({
    route,
    re: compiledPathCache!.patterns[i]!.re,
    paramNames: compiledPathCache!.patterns[i]!.paramNames,
  }));

  return { compiled, db, storage };
}
