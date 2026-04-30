/**
 * cf-extra-routes.ts — barrel for CF-native route modules.
 *
 * CF-native handlers for API endpoints that use raw Express handlers in the
 * server package (making them invisible to extractRoutesFromRouter) or depend
 * on runtime registries (adapters, plugins) that don't exist in a CF Worker.
 *
 * Registered in app.ts BEFORE the /api/* catch-all so they shadow the 501.
 *
 * Modules:
 *   routes/adapters.ts          — GET /api/adapters
 *   routes/plugins.ts           — full plugin REST surface (list, install,
 *                                  detail, dashboard, config, jobs, lifecycle)
 *   routes/plugin-ui-static.ts  — GET /_plugins/:pluginId/ui/* (proxies to
 *                                  sidecar; without this the SPA fallback
 *                                  serves index.html and breaks plugin UIs)
 *   routes/company-access.ts    — join-requests + user-directory
 *   routes/company-skills-cf.ts — skill list/detail (DB) + file ops (sidecar)
 *   routes/events.ts            — GET /api/companies/:id/events/ws
 *   routes/instance-backups.ts  — POST /api/instance/database-backups
 *
 * All routes in this barrel require an authenticated actor (board or agent key,
 * or local_trusted mode). Unauthenticated requests receive 401.
 */

import type { Hono } from "hono";
import type { Env } from "./env.js";
import { registerAdapterRoutes } from "./routes/adapters.js";
import { registerAgentCfRoutes } from "./routes/agents-cf.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerPluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { registerCompanyAccessRoutes } from "./routes/company-access.js";
import { registerCompanySkillRoutes } from "./routes/company-skills-cf.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerInstanceBackupRoutes } from "./routes/instance-backups.js";

export function registerCfExtraRoutes(app: Hono<{ Bindings: Env }>): void {
  registerAdapterRoutes(app);
  // CF shadows for agent routes that spawn `claude` or use node:fs.
  // Must register BEFORE the auto-bridge catch-all so they take precedence.
  registerAgentCfRoutes(app);
  registerPluginRoutes(app);
  registerPluginUiStaticRoutes(app);
  registerCompanyAccessRoutes(app);
  registerCompanySkillRoutes(app);
  registerEventRoutes(app);
  registerInstanceBackupRoutes(app);
}
