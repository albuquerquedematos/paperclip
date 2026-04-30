import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { logActivity, sidebarPreferenceService } from "../services/index.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler, RequestCtx } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

/** Asserts board actor with a userId and returns the userId. */
function requireBoardUserIdCtx(ctx: RequestCtx): string {
  if (ctx.actor?.type !== "board") {
    throw forbidden("Board access required");
  }
  if (!ctx.actor.userId) {
    throw forbidden("Board user context required");
  }
  return ctx.actor.userId;
}

function buildHandlers(db: Db) {
  const svc = sidebarPreferenceService(db);

  // server/src/routes/sidebar-preferences.ts:21
  const getSidebarPreferencesMe: Handler = async (ctx) => {
    const userId = requireBoardUserIdCtx(ctx);
    return Response.json(await svc.getCompanyOrder(userId));
  };

  // server/src/routes/sidebar-preferences.ts:27
  const putSidebarPreferencesMe: Handler = async (ctx) => {
    const userId = requireBoardUserIdCtx(ctx);
    const body = await ctx.json();
    const parsed = upsertSidebarOrderPreferenceSchema.parse(body);
    return Response.json(await svc.upsertCompanyOrder(userId, parsed.orderedIds));
  };

  // server/src/routes/sidebar-preferences.ts:33
  const getCompanySidebarPreferencesMe: Handler = async (ctx) => {
    const companyId = ctx.param("companyId") ?? "";
    assertCompanyAccess(ctx, companyId);
    const userId = requireBoardUserIdCtx(ctx);
    return Response.json(await svc.getProjectOrder(companyId, userId));
  };

  // server/src/routes/sidebar-preferences.ts:41
  const putCompanySidebarPreferencesMe: Handler = async (ctx) => {
    const companyId = ctx.param("companyId") ?? "";
    assertCompanyAccess(ctx, companyId);
    const userId = requireBoardUserIdCtx(ctx);

    const body = await ctx.json();
    const parsed = upsertSidebarOrderPreferenceSchema.parse(body);
    const result = await svc.upsertProjectOrder(companyId, userId, parsed.orderedIds);

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    await logActivity(db, {
      companyId,
      actorType,
      actorId,
      agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
      runId: ctx.actor?.runId ?? null,
      action: "sidebar_preferences.project_order_updated",
      entityType: "company",
      entityId: companyId,
      details: {
        userId,
        orderedIds: result.orderedIds,
      },
    });
    return Response.json(result);
  };

  return { getSidebarPreferencesMe, putSidebarPreferencesMe, getCompanySidebarPreferencesMe, putCompanySidebarPreferencesMe };
}

export function sidebarPreferenceRoutes(db: Db) {
  const router = Router();
  const {
    getSidebarPreferencesMe,
    putSidebarPreferencesMe,
    getCompanySidebarPreferencesMe,
    putCompanySidebarPreferencesMe,
  } = buildHandlers(db);

  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`sidebarPreference handler unexpectedly accessed storage.${String(prop)}`);
    },
  });
  const deps = { db, storage: storageSentinel };

  router.get("/sidebar-preferences/me", expressHandler(getSidebarPreferencesMe, deps));
  router.put("/sidebar-preferences/me", expressHandler(putSidebarPreferencesMe, deps));
  router.get("/companies/:companyId/sidebar-preferences/me", expressHandler(getCompanySidebarPreferencesMe, deps));
  router.put("/companies/:companyId/sidebar-preferences/me", expressHandler(putCompanySidebarPreferencesMe, deps));

  return router;
}
