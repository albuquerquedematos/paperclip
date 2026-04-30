import { Router, type Request, type Response } from "express";
import multer from "multer";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import type { Db } from "@paperclipai/db";
import { createAssetImageMetadataSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { assetService, logActivity } from "../services/index.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler } from "../http/types.js";

const SVG_CONTENT_TYPE = "image/svg+xml";
const ALLOWED_COMPANY_LOGO_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  SVG_CONTENT_TYPE,
]);

function sanitizeSvgBuffer(input: Buffer): Buffer | null {
  const raw = input.toString("utf8").trim();
  if (!raw) return null;

  const baseDom = new JSDOM("");
  const domPurify = createDOMPurify(
    baseDom.window as unknown as Parameters<typeof createDOMPurify>[0],
  );
  domPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    const attrName = data.attrName.toLowerCase();
    const attrValue = (data.attrValue ?? "").trim();

    if (attrName.startsWith("on")) {
      data.keepAttr = false;
      return;
    }

    if ((attrName === "href" || attrName === "xlink:href") && attrValue && !attrValue.startsWith("#")) {
      data.keepAttr = false;
    }
  });

  let parsedDom: JSDOM | null = null;
  try {
    const sanitized = domPurify.sanitize(raw, {
      USE_PROFILES: { svg: true, svgFilters: true, html: false },
      FORBID_TAGS: ["script", "foreignObject"],
      FORBID_CONTENTS: ["script", "foreignObject"],
      RETURN_TRUSTED_TYPE: false,
    });

    parsedDom = new JSDOM(sanitized, { contentType: SVG_CONTENT_TYPE });
    const document = parsedDom.window.document;
    const root = document.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return null;

    for (const el of Array.from(root.querySelectorAll("script, foreignObject"))) {
      el.remove();
    }
    for (const el of Array.from(root.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        const attrName = attr.name.toLowerCase();
        const attrValue = attr.value.trim();
        if (attrName.startsWith("on")) {
          el.removeAttribute(attr.name);
          continue;
        }
        if ((attrName === "href" || attrName === "xlink:href") && attrValue && !attrValue.startsWith("#")) {
          el.removeAttribute(attr.name);
        }
      }
    }

    const output = root.outerHTML.trim();
    if (!output || !/^<svg[\s>]/i.test(output)) return null;
    return Buffer.from(output, "utf8");
  } catch {
    return null;
  } finally {
    parsedDom?.window.close();
    baseDom.window.close();
  }
}

export function assetRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = assetService(db);
  const assetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });
  const companyLogoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  async function runSingleFileUpload(
    upload: ReturnType<typeof multer>,
    req: Request,
    res: Response,
  ) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // POST /companies/:companyId/assets/images
  // TODO(cloudflare): file upload requires R2 multipart
  // ---------------------------------------------------------------------------
  router.post("/companies/:companyId/assets/images", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      await runSingleFileUpload(assetUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const parsedMeta = createAssetImageMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid image metadata", details: parsedMeta.error.issues });
      return;
    }

    const namespaceSuffix = parsedMeta.data.namespace ?? "general";
    const contentType = (file.mimetype || "").toLowerCase();
    if (contentType !== SVG_CONTENT_TYPE && !isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported file type: ${contentType || "unknown"}` });
      return;
    }
    let fileBody = file.buffer;
    if (contentType === SVG_CONTENT_TYPE) {
      const sanitized = sanitizeSvgBuffer(file.buffer);
      if (!sanitized || sanitized.length <= 0) {
        res.status(422).json({ error: "SVG could not be sanitized" });
        return;
      }
      fileBody = sanitized;
    }
    if (fileBody.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `assets/${namespaceSuffix}`,
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
    });

    const asset = await svc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
      },
    });

    res.status(201).json({
      assetId: asset.id,
      companyId: asset.companyId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /companies/:companyId/logo
  // TODO(cloudflare): file upload requires R2 multipart
  // ---------------------------------------------------------------------------
  router.post("/companies/:companyId/logo", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    try {
      await runSingleFileUpload(companyLogoUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Image exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_COMPANY_LOGO_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}` });
      return;
    }

    let fileBody = file.buffer;
    if (contentType === SVG_CONTENT_TYPE) {
      const sanitized = sanitizeSvgBuffer(file.buffer);
      if (!sanitized || sanitized.length <= 0) {
        res.status(422).json({ error: "SVG could not be sanitized" });
        return;
      }
      fileBody = sanitized;
    }

    if (fileBody.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: "assets/companies",
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
    });

    const asset = await svc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        namespace: "assets/companies",
      },
    });

    res.status(201).json({
      assetId: asset.id,
      companyId: asset.companyId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /assets/:assetId/content — streaming response
  // ---------------------------------------------------------------------------

  const getAssetContent: Handler = async (ctx) => {
    const assetId = ctx.param("assetId");
    if (!assetId) return Response.json({ error: "Missing assetId" }, { status: 400 });
    const asset = await svc.getById(assetId);
    if (!asset) {
      return Response.json({ error: "Asset not found" }, { status: 404 });
    }
    if (!ctx.actor) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const object = await storage.getObject(asset.companyId, asset.objectKey);
    const responseContentType = asset.contentType || object.contentType || "application/octet-stream";
    const filename = asset.originalFilename ?? "asset";

    const headers: Record<string, string> = {
      "Content-Type": responseContentType,
      "Content-Length": String(asset.byteSize || object.contentLength || 0),
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${filename.replaceAll('"', '')}"`,
    };
    if (responseContentType === SVG_CONTENT_TYPE) {
      headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
    }

    return new Response(object.stream as unknown as ReadableStream, { headers });
  };

  router.get("/assets/:assetId/content", expressHandler(getAssetContent, { db, storage }));

  return router;
}
