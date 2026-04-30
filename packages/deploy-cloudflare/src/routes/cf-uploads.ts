/**
 * cf-uploads.ts — R2-native file upload endpoints for the Cloudflare Worker.
 *
 * These replace the multer-based multipart upload routes from
 * `server/src/routes/assets.ts` and `server/src/routes/issues.ts` which
 * depend on Node.js streams and the `multer` middleware.
 *
 * Instead, we stream the raw request body directly to R2 using the Web Streams
 * API (`c.req.raw.body`), which is natively supported in the Workers runtime.
 *
 * Auth: the actor is read from the Hono context variable set by the per-request
 * `resolveActor` middleware in `api.ts`.
 */

import type { Hono } from "hono";
import type { Db } from "@paperclipai/db";
import { assets, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { forbidden, notFound, badRequest } from "../../../../server/src/errors.js";
import type { Env } from "../worker/api.js";
import type { ActorContext } from "../../../../server/src/http/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertCompanyAccess(actor: ActorContext | null, companyId: string): void {
  if (!actor) throw forbidden("Authentication required");
  if (actor.type === "board") {
    if (actor.isInstanceAdmin) return;
    if (actor.companyIds?.includes(companyId)) return;
    throw forbidden("No access to this company");
  }
  if (actor.type === "agent") {
    if (actor.companyId === companyId) return;
    throw forbidden("No access to this company");
  }
  throw forbidden("No access to this company");
}

function getActorFromCtx(actorRaw: unknown): ActorContext | null {
  if (!actorRaw || typeof actorRaw !== "object") return null;
  const a = actorRaw as Record<string, unknown>;
  if (a["type"] !== "board" && a["type"] !== "agent") return null;
  return actorRaw as ActorContext;
}

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

/**
 * Mount R2-native upload endpoints on the Hono app.
 *
 * Endpoints:
 *   PUT  /api/assets/:assetId/upload
 *        Streams the request body to R2 under `assets/{companyId}/{assetId}`.
 *        Looks up the asset record to derive companyId and validates access.
 *
 *   POST /api/issues/:issueId/attachments/upload
 *        Streams the request body to R2 under
 *        `issues/{companyId}/{issueId}/attachments/{filename}`.
 *        `filename` is taken from the `X-Filename` header or falls back to
 *        `attachment`.
 */
export function mountUploadRoutes(
  app: Hono<{ Bindings: Env }>,
  db: Db,
): void {
  // PUT /api/assets/:assetId/upload
  app.put("/api/assets/:assetId/upload", async (c) => {
    try {
      const assetId = c.req.param("assetId");
      if (!assetId) return c.json({ error: "Missing assetId" }, 400);

      const actor = getActorFromCtx(c.get("actor" as never));

      const assetRow = await db
        .select()
        .from(assets)
        .where(eq(assets.id, assetId))
        .then((rows) => rows[0] ?? null);

      if (!assetRow) throw notFound("Asset not found");

      assertCompanyAccess(actor, assetRow.companyId);

      const body = c.req.raw.body;
      if (!body) throw badRequest("Empty request body");

      const key = `assets/${assetRow.companyId}/${assetId}`;
      const contentType =
        c.req.header("content-type") ?? "application/octet-stream";

      await c.env.PAPERCLIP_STORAGE.put(key, body, {
        httpMetadata: { contentType },
      });

      return c.json({ ok: true, key });
    } catch (err) {
      if (err instanceof Error && "status" in err) {
        const he = err as { status: number; message: string };
        return c.json({ error: he.message }, he.status as 400 | 403 | 404);
      }
      console.error("[cf-uploads] PUT /api/assets/:assetId/upload", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/issues/:issueId/attachments/upload
  app.post("/api/issues/:issueId/attachments/upload", async (c) => {
    try {
      const issueId = c.req.param("issueId");
      if (!issueId) return c.json({ error: "Missing issueId" }, 400);

      const actor = getActorFromCtx(c.get("actor" as never));

      const issueRow = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issueRow) throw notFound("Issue not found");

      assertCompanyAccess(actor, issueRow.companyId);

      const body = c.req.raw.body;
      if (!body) throw badRequest("Empty request body");

      const filename =
        c.req.header("x-filename")?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "attachment";
      const contentType =
        c.req.header("content-type") ?? "application/octet-stream";

      const key = `issues/${issueRow.companyId}/${issueId}/attachments/${filename}`;

      await c.env.PAPERCLIP_STORAGE.put(key, body, {
        httpMetadata: { contentType },
      });

      return c.json({ ok: true, key, filename });
    } catch (err) {
      if (err instanceof Error && "status" in err) {
        const he = err as { status: number; message: string };
        return c.json({ error: he.message }, he.status as 400 | 403 | 404);
      }
      console.error("[cf-uploads] POST /api/issues/:issueId/attachments/upload", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });
}
