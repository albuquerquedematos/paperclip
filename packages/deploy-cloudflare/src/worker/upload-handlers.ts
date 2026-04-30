/**
 * upload-handlers.ts
 *
 * R2-native file upload endpoints.
 *
 * These are registered on the Hono app BEFORE the generic `/api/*` catch-all
 * so they take priority. They write directly to R2 rather than going through
 * the multer-based Express middleware (which is shimmed as a no-op in CF).
 */

import type { Hono } from "hono";
import { buildRequestResources } from "./route-registry.js";
import { resolveActorFromRequest } from "../auth/resolve-actor.js";
import { HttpError } from "../../../../server/src/errors.js";
import type { Env } from "./env.js";
import { resolveDeploymentMode } from "./env.js";

export function registerUploadHandlers(app: Hono<{ Bindings: Env }>): void {
  // PUT /api/assets/:assetId/upload
  // Streams the request body directly into R2 under assets/<companyId>/<assetId>.
  app.put("/api/assets/:assetId/upload", async (c) => {
    const { assets } = await import("../../../db/src/schema/index.js");
    const { eq } = await import("drizzle-orm");
    const { forbidden, notFound, badRequest } = await import("../../../../server/src/errors.js");

    const env = c.env;
    const { db } = buildRequestResources(env);
    const actor = await resolveActorFromRequest(c.req.raw, db, { deploymentMode: resolveDeploymentMode(env) });

    try {
      const assetId = c.req.param("assetId");
      if (!assetId) return c.json({ error: "Missing assetId" }, 400);

      const assetRow = await db.select().from(assets).where(eq(assets.id, assetId)).then((rows) => rows[0] ?? null);
      if (!assetRow) throw notFound("Asset not found");

      if (!actor) throw forbidden("Authentication required");
      if (actor.type === "board" && !actor.isInstanceAdmin && !actor.companyIds?.includes(assetRow.companyId)) {
        throw forbidden("No access to this company");
      }
      if (actor.type === "agent" && actor.companyId !== assetRow.companyId) {
        throw forbidden("No access to this company");
      }

      const body = c.req.raw.body;
      if (!body) throw badRequest("Empty request body");
      const key = `assets/${assetRow.companyId}/${assetId}`;
      await env.PAPERCLIP_STORAGE.put(key, body, {
        httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
      });
      return c.json({ ok: true, key });
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400 | 403 | 404);
      console.error("[CF Worker] PUT /api/assets/:assetId/upload", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/issues/:issueId/attachments/upload
  // Streams the request body into R2 under issues/<companyId>/<issueId>/attachments/<filename>.
  app.post("/api/issues/:issueId/attachments/upload", async (c) => {
    const { issues } = await import("../../../db/src/schema/index.js");
    const { eq } = await import("drizzle-orm");
    const { forbidden, notFound, badRequest } = await import("../../../../server/src/errors.js");

    const env = c.env;
    const { db } = buildRequestResources(env);
    const actor = await resolveActorFromRequest(c.req.raw, db, { deploymentMode: resolveDeploymentMode(env) });

    try {
      const issueId = c.req.param("issueId");
      if (!issueId) return c.json({ error: "Missing issueId" }, 400);

      const issueRow = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issueRow) throw notFound("Issue not found");

      if (!actor) throw forbidden("Authentication required");
      if (actor.type === "board" && !actor.isInstanceAdmin && !actor.companyIds?.includes(issueRow.companyId)) {
        throw forbidden("No access to this company");
      }
      if (actor.type === "agent" && actor.companyId !== issueRow.companyId) {
        throw forbidden("No access to this company");
      }

      const body = c.req.raw.body;
      if (!body) throw badRequest("Empty request body");
      const filename = (c.req.header("x-filename") ?? "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `issues/${issueRow.companyId}/${issueId}/attachments/${filename}`;
      await env.PAPERCLIP_STORAGE.put(key, body, {
        httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
      });
      return c.json({ ok: true, key, filename });
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400 | 403 | 404);
      console.error("[CF Worker] POST /api/issues/:issueId/attachments/upload", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });
}
