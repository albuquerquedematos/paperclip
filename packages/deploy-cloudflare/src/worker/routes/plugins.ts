/**
 * routes/plugins.ts
 *
 * CF-native handlers for:
 *   GET /api/plugins
 *   GET /api/plugins/ui-contributions
 *   GET /api/plugins/examples
 *   POST /api/plugins/install
 *
 * The server-side pluginRoutes() relies on an in-process plugin registry
 * (worker processes, SSE, child_process) that does not exist in a CF Worker.
 * These handlers derive the same data from the `plugins` DB table, which is
 * populated at install time and is always available via Hyperdrive.
 *
 * install / examples notes:
 *   Plugin installation requires npm access and is delegated to the sidecar
 *   companion server (SidecarContainer DO or SIDECAR_URL env var).
 *   Examples are returned with localPath = packageName so the UI issues an
 *   npm install rather than a local-filesystem install.
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

// ---------------------------------------------------------------------------
// Static plugin examples catalogue (mirrors server/src/routes/plugins.ts).
// In CF Workers there is no local filesystem, so localPath is set to the npm
// package name — the UI uses this field as the install identifier.
// ---------------------------------------------------------------------------
const BUNDLED_PLUGIN_EXAMPLES = [
  {
    packageName: "@paperclipai/plugin-hello-world-example",
    pluginKey: "paperclip.hello-world-example",
    displayName: "Hello World Widget (Example)",
    description: "Reference UI plugin that adds a simple Hello World widget to the Paperclip dashboard.",
    localPath: "@paperclipai/plugin-hello-world-example",
    tag: "example" as const,
  },
  {
    packageName: "@paperclipai/plugin-file-browser-example",
    pluginKey: "paperclip-file-browser-example",
    displayName: "File Browser (Example)",
    description: "Example plugin that adds a Files link in project navigation plus a project detail file browser.",
    localPath: "@paperclipai/plugin-file-browser-example",
    tag: "example" as const,
  },
  {
    packageName: "@paperclipai/plugin-kitchen-sink-example",
    pluginKey: "paperclip-kitchen-sink-example",
    displayName: "Kitchen Sink (Example)",
    description: "Reference plugin that demonstrates the current Paperclip plugin API surface.",
    localPath: "@paperclipai/plugin-kitchen-sink-example",
    tag: "example" as const,
  },
];

/** Proxy a request to the sidecar companion server. */
async function proxySidecar(env: Env, path: string, req: Request): Promise<Response> {
  if (env.SIDECAR_SERVICE) {
    const id = env.SIDECAR_SERVICE.idFromName("sidecar");
    const stub = env.SIDECAR_SERVICE.get(id);
    return stub.fetch(`http://sidecar${path}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
  }
  const baseUrl = env.SIDECAR_URL;
  if (!baseUrl) {
    return Response.json(
      { error: "Plugin install not available: configure SIDECAR_URL or SIDECAR_SERVICE" },
      { status: 503 },
    );
  }
  const headers = new Headers(req.headers);
  if (env.SIDECAR_API_KEY) headers.set("Authorization", `Bearer ${env.SIDECAR_API_KEY}`);
  return fetch(`${baseUrl}${path}`, { method: req.method, headers, body: req.body });
}

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

  // -------------------------------------------------------------------------
  // GET /api/plugins/examples — static catalogue of bundled example plugins.
  // localPath is set to the npm package name (no local filesystem in CF).
  // -------------------------------------------------------------------------
  app.get("/api/plugins/examples", async (c) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    return c.json(BUNDLED_PLUGIN_EXAMPLES);
  });

  // -------------------------------------------------------------------------
  // POST /api/plugins/install — delegate to sidecar (needs npm + filesystem).
  // The sidecar installs the package, registers it in the DB, and returns the
  // plugin record. localPath values equal to a package name are treated as
  // npm installs by the sidecar's install handler.
  // -------------------------------------------------------------------------
  app.post("/api/plugins/install", async (c) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const resp = await proxySidecar(c.env, "/api/plugins/install", c.req.raw);
    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}
