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
 *   routes/adapters.ts       — GET /api/adapters
 *   routes/plugins.ts        — GET /api/plugins, GET /api/plugins/ui-contributions
 *   routes/company-access.ts — GET /api/companies/:id/join-requests,
 *                               GET /api/companies/:id/user-directory
 *   routes/company-skills-cf.ts — GET /api/companies/:id/skills
 *   routes/events.ts         — GET /api/companies/:id/events/ws
 *
 * All routes in this barrel require an authenticated actor (board or agent key,
 * or local_trusted mode). Unauthenticated requests receive 401.
 */

import type { Hono } from "hono";
import type { Env } from "./env.js";
import { registerAdapterRoutes } from "./routes/adapters.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerCompanyAccessRoutes } from "./routes/company-access.js";
import { registerCompanySkillRoutes } from "./routes/company-skills-cf.js";
import { registerEventRoutes } from "./routes/events.js";

export function registerCfExtraRoutes(app: Hono<{ Bindings: Env }>): void {
  registerAdapterRoutes(app);
  registerPluginRoutes(app);
  registerCompanyAccessRoutes(app);
  registerCompanySkillRoutes(app);
  registerEventRoutes(app);
}
