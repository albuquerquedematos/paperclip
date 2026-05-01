/**
 * routes/instance-backups.ts
 *
 * CF-native handler for POST /api/instance/database-backups.
 *
 * Database backups dump a snapshot of the embedded Postgres to disk via
 * pg_dump (a child process). Neither pg_dump nor a writable filesystem are
 * available in CF Workers, so we proxy to the sidecar — it runs the original
 * server handler against its local filesystem and uploads the resulting blob
 * to the configured StorageProvider (R2 in CF deployments).
 *
 * Auth: instance admin only (enforced server-side by the proxied handler).
 */

import type { Hono } from "hono";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { safeProxyToSidecar } from "../../sidecar-client.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

export function registerInstanceBackupRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/instance/database-backups", async (c) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    return safeProxyToSidecar({
      env: c.env,
      path: "/api/instance/database-backups",
      method: "POST",
      contentType: c.req.header("Content-Type") ?? null,
      body: c.req.raw.body,
    });
  });
}
