import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { inboxDismissals, joinRequests } from "@paperclipai/db";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { collapseDuplicatePendingHumanJoinRequests } from "../lib/join-request-dedupe.js";
import { assertCompanyAccess } from "./authz.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

function buildDismissedAtByKey(
  dismissals: Array<{ itemKey: string; dismissedAt: Date | string }>,
): Map<string, number> {
  return new Map(
    dismissals.map((dismissal) => [dismissal.itemKey, new Date(dismissal.dismissedAt).getTime()]),
  );
}

function buildHandlers(db: Db) {
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const dashboard = dashboardService(db);

  // server/src/routes/sidebar-badges.ts:25
  const getSidebarBadges: Handler = async (ctx) => {
    const companyId = ctx.param("companyId") ?? "";
    assertCompanyAccess(ctx, companyId);

    let canApproveJoins = false;
    if (ctx.actor?.type === "board") {
      if (ctx.actor.source === "local_implicit" || ctx.actor.isInstanceAdmin) {
        canApproveJoins = true;
      } else {
        canApproveJoins = await access.canUser(companyId, ctx.actor.userId, "joins:approve");
      }
    } else if (ctx.actor?.type === "agent" && ctx.actor.agentId) {
      canApproveJoins = await access.hasPermission(companyId, "agent", ctx.actor.agentId, "joins:approve");
    }

    const visibleJoinRequests = canApproveJoins
      ? collapseDuplicatePendingHumanJoinRequests(
        await db
          .select({
            id: joinRequests.id,
            requestType: joinRequests.requestType,
            status: joinRequests.status,
            requestingUserId: joinRequests.requestingUserId,
            requestEmailSnapshot: joinRequests.requestEmailSnapshot,
            updatedAt: joinRequests.updatedAt,
            createdAt: joinRequests.createdAt,
          })
          .from(joinRequests)
          .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
      ).map(({ id, updatedAt, createdAt }) => ({
        id,
        updatedAt,
        createdAt,
      }))
      : [];

    const dismissedAtByKey =
      ctx.actor?.type === "board" && ctx.actor.userId
        ? await db
          .select({ itemKey: inboxDismissals.itemKey, dismissedAt: inboxDismissals.dismissedAt })
          .from(inboxDismissals)
          .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, ctx.actor.userId)))
          .then(buildDismissedAtByKey)
        : new Map<string, number>();

    const badges = await svc.get(companyId, {
      dismissals: dismissedAtByKey,
      joinRequests: visibleJoinRequests,
    });
    const summary = await dashboard.summary(companyId);
    const hasFailedRuns = badges.failedRuns > 0;
    const alertsCount =
      (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
      (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
    badges.inbox = badges.failedRuns + alertsCount + badges.joinRequests + badges.approvals;

    return Response.json(badges);
  };

  return { getSidebarBadges };
}

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const { getSidebarBadges } = buildHandlers(db);

  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`sidebarBadge handler unexpectedly accessed storage.${String(prop)}`);
    },
  });
  const deps = { db, storage: storageSentinel };

  router.get("/companies/:companyId/sidebar-badges", expressHandler(getSidebarBadges, deps));

  return router;
}
