import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler, RequestCtx } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

export function secretRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const configuredDefaultProvider = process.env.PAPERCLIP_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  // Storage is not needed by any secret handler.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`secret handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  // ---------------------------------------------------------------------------
  // Internal authz helpers operating on RequestCtx
  // ---------------------------------------------------------------------------

  function assertBoardCtx(ctx: RequestCtx) {
    if (!ctx.actor || ctx.actor.type !== "board") {
      throw forbidden("Board access required");
    }
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const listSecretProviders: Handler = async (ctx) => {
    assertBoardCtx(ctx);
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    return Response.json(svc.listProviders());
  };

  const listSecrets: Handler = async (ctx) => {
    assertBoardCtx(ctx);
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    const secrets = await svc.list(companyId);
    return Response.json(secrets);
  };

  const createSecret: Handler = async (ctx) => {
    assertBoardCtx(ctx);
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    const body = await ctx.json<Record<string, unknown>>();
    const actor = ctx.actor!;

    const created = await svc.create(
      companyId,
      {
        name: body.name as string,
        provider: (body.provider as SecretProvider | undefined) ?? defaultProvider,
        value: body.value as string,
        description: body.description as string | undefined,
        externalRef: body.externalRef as string | undefined,
      },
      { userId: actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    return Response.json(created, { status: 201 });
  };

  const rotateSecret: Handler = async (ctx) => {
    assertBoardCtx(ctx);
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Secret not found" }, { status: 404 });
    }
    const actor = ctx.actor!;
    const body = await ctx.json<Record<string, unknown>>();

    const rotated = await svc.rotate(
      id,
      {
        value: body.value as string | undefined,
        externalRef: body.externalRef as string | undefined,
      },
      { userId: actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    return Response.json(rotated);
  };

  const updateSecret: Handler = async (ctx) => {
    assertBoardCtx(ctx);
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Secret not found" }, { status: 404 });
    }
    const actor = ctx.actor!;
    const body = await ctx.json<Record<string, unknown>>();

    const updated = await svc.update(id, {
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      externalRef: body.externalRef as string | undefined,
    });

    if (!updated) {
      return Response.json({ error: "Secret not found" }, { status: 404 });
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    return Response.json(updated);
  };

  const deleteSecret: Handler = async (ctx) => {
    assertBoardCtx(ctx);
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Secret not found" }, { status: 404 });
    }
    const actor = ctx.actor!;

    const removed = await svc.remove(id);
    if (!removed) {
      return Response.json({ error: "Secret not found" }, { status: 404 });
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    return Response.json({ ok: true });
  };

  // ---------------------------------------------------------------------------
  // Wire handlers via expressHandler
  // ---------------------------------------------------------------------------

  const adapterDeps = { db, storage: storageSentinel };

  router.get("/companies/:companyId/secret-providers", expressHandler(listSecretProviders, adapterDeps));
  router.get("/companies/:companyId/secrets", expressHandler(listSecrets, adapterDeps));
  router.post("/companies/:companyId/secrets", validate(createSecretSchema), expressHandler(createSecret, adapterDeps));
  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), expressHandler(rotateSecret, adapterDeps));
  router.patch("/secrets/:id", validate(updateSecretSchema), expressHandler(updateSecret, adapterDeps));
  router.delete("/secrets/:id", expressHandler(deleteSecret, adapterDeps));

  return router;
}
