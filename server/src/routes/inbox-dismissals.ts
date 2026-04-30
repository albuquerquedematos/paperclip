import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { inboxDismissalService, logActivity } from "../services/index.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

const inboxDismissalSchema = z.object({
  itemKey: z.string().trim().min(1).regex(/^(approval|join|run):.+$/, "Unsupported inbox item key"),
});

function buildHandlers(db: Db) {
  const svc = inboxDismissalService(db);

  // server/src/routes/inbox-dismissals.ts:16
  const getInboxDismissals: Handler = async (ctx) => {
    const companyId = ctx.param("companyId") ?? "";
    assertCompanyAccess(ctx, companyId);
    assertBoard(ctx);
    const dismissals = await svc.list(companyId, (ctx.actor as { userId: string }).userId);
    return Response.json(dismissals);
  };

  // server/src/routes/inbox-dismissals.ts:31
  const postInboxDismissal: Handler = async (ctx) => {
    const companyId = ctx.param("companyId") ?? "";
    assertCompanyAccess(ctx, companyId);
    assertBoard(ctx);
    const boardActor = ctx.actor as { type: "board"; userId: string; runId?: string };

    const body = await ctx.json();
    const parsed = inboxDismissalSchema.parse(body);

    const dismissal = await svc.dismiss(companyId, boardActor.userId, parsed.itemKey, new Date());

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: boardActor.userId,
      agentId: null,
      runId: ctx.actor?.runId ?? null,
      action: "inbox.dismissed",
      entityType: "company",
      entityId: companyId,
      details: {
        userId: boardActor.userId,
        itemKey: dismissal.itemKey,
        dismissedAt: dismissal.dismissedAt,
      },
    });

    return Response.json(dismissal, { status: 201 });
  };

  return { getInboxDismissals, postInboxDismissal };
}

export function inboxDismissalRoutes(db: Db) {
  const router = Router();
  const { getInboxDismissals, postInboxDismissal } = buildHandlers(db);

  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`inboxDismissal handler unexpectedly accessed storage.${String(prop)}`);
    },
  });
  const deps = { db, storage: storageSentinel };

  router.get("/companies/:companyId/inbox-dismissals", expressHandler(getInboxDismissals, deps));
  router.post("/companies/:companyId/inbox-dismissals", expressHandler(postInboxDismissal, deps));

  return router;
}
