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
  // GET /api/plugins/examples — proxy to sidecar.
  // The sidecar runs the server's listBundledPluginExamples() which checks
  // whether local monorepo paths exist and returns them with absolute paths.
  // In local dev the monorepo IS present so examples appear; in production
  // the sidecar container has a different filesystem and returns [].
  // -------------------------------------------------------------------------
  app.get("/api/plugins/examples", async (c) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const resp = await proxySidecar(c.env, "/api/plugins/examples", c.req.raw);
    if (!resp.ok) {
      // Sidecar unavailable or doesn't support this endpoint — return empty.
      return c.json([]);
    }
    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
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

    // CF has no local filesystem, so isLocalPath is never meaningful here.
    // If the UI sent isLocalPath: true with an npm package name (e.g. from
    // the examples list), rewrite the body to use npm install semantics.
    const body = await c.req.json<{ packageName?: string; version?: string; isLocalPath?: boolean }>();
    const isNpmPackage = !body.isLocalPath || !body.packageName?.startsWith("/");
    const rewritten = isNpmPackage
      ? { packageName: body.packageName, version: body.version, isLocalPath: false }
      : body;

    const resp = await proxySidecar(c.env, "/api/plugins/install",
      new Request(c.req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rewritten),
      }),
    );
    return new Response(resp.body, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}
