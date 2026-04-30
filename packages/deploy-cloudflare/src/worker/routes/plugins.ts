/**
 * routes/plugins.ts
 *
 * CF-native handlers for:
 *   GET /api/plugins
 *   GET /api/plugins/ui-contributions
 *
 * The server-side pluginRoutes() relies on an in-process plugin registry
 * (worker processes, SSE, child_process) that does not exist in a CF Worker.
 * These handlers derive the same data from the `plugins` DB table, which is
 * populated at install time and is always available via Hyperdrive.
 *
 * Auth: requires an authenticated actor (board or agent). Unauthenticated
 * requests receive 401.
 */

import type { Hono } from "hono";
import { asc, ne } from "drizzle-orm";
import { plugins } from "@paperclipai/db";
import { getPluginUiContributionMetadata } from "../../../../../server/src/services/plugin-loader.js";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

export function registerPluginRoutes(app: Hono<{ Bindings: Env }>): void {
  // -------------------------------------------------------------------------
  // GET /api/plugins — list installed plugins from DB (registry state comes
  // from manifestJson stored at install time; worker processes not available)
  // -------------------------------------------------------------------------
  app.get("/api/plugins", async (c) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const rows = await db
      .select()
      .from(plugins)
      .where(ne(plugins.status, "uninstalled"))
      .orderBy(asc(plugins.installOrder));
    return c.json(rows);
  });

  // -------------------------------------------------------------------------
  // GET /api/plugins/ui-contributions — derive UI contribution metadata from
  // manifestJson stored in the DB (no running plugin process needed).
  // Must be registered before /api/plugins so Hono matches it first.
  // -------------------------------------------------------------------------
  app.get("/api/plugins/ui-contributions", async (c) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const rows = await db
      .select()
      .from(plugins)
      .where(ne(plugins.status, "uninstalled"))
      .orderBy(asc(plugins.installOrder));

    const contributions = rows.flatMap((plugin) => {
      const manifest = plugin.manifestJson;
      if (!manifest) return [];
      const uiMetadata = getPluginUiContributionMetadata(manifest);
      if (!uiMetadata) return [];
      return [{
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        displayName: manifest.displayName,
        version: plugin.version,
        updatedAt: plugin.updatedAt.toISOString(),
        uiEntryFile: uiMetadata.uiEntryFile,
        slots: uiMetadata.slots,
        launchers: uiMetadata.launchers,
      }];
    });
    return c.json(contributions);
  });
}
