import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Builds the health-check {@link Handler} closed over the optional db and
 * deployment options. Using a factory lets us avoid threading `db` through
 * the adapter deps when it is genuinely optional for this endpoint.
 */
function buildHealthHandler(
  db: Db | undefined,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  },
): Handler {
  return async (ctx) => {
    // ctx.actor is null when unauthenticated; map back to the legacy shape.
    const actorType = ctx.actor?.type ?? null;
    const exposeFullDetails = shouldExposeFullHealthDetails(actorType, opts.deploymentMode);
    const exposeDevServerDetails =
      exposeFullDetails ||
      hasDevServerStatusToken(ctx.headers.get("x-paperclip-dev-server-status-token") ?? undefined);

    if (!db) {
      return Response.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      return Response.json(
        {
          status: "unhealthy",
          version: serverVersion,
          error: "database_unreachable",
        },
        { status: 503 },
      );
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (
      exposeDevServerDetails &&
      persistedDevServerStatus &&
      typeof (db as { select?: unknown }).select === "function"
    ) {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    if (!exposeFullDetails) {
      return Response.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(devServer ? { devServer } : {}),
      });
    }

    return Response.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  };
}

/**
 * Returns an Express Router for the health endpoint.
 *
 * The public signature is intentionally identical to the previous version so
 * that the existing mount in app.ts (`api.use("/health", healthRoutes(...))`)
 * continues to work without any changes.
 */
export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const handler = buildHealthHandler(db, opts);

  // expressHandler requires a StorageService in deps, but the health endpoint
  // never touches storage. We supply a sentinel that throws if accidentally
  // called, keeping the type contract honest without introducing a real dep.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`health handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  // db is optional for health but expressHandler's AdapterDeps types it as Db.
  // When db is undefined the handler returns early before touching ctx.db, so
  // we supply a sentinel here too rather than widen the adapter's types.
  const dbSentinel = new Proxy({} as Db, {
    get(_target, prop) {
      throw new Error(`health handler unexpectedly accessed db.${String(prop)}`);
    },
  });

  const router = Router();
  router.get(
    "/",
    expressHandler(handler, {
      db: db ?? dbSentinel,
      storage: storageSentinel,
    }),
  );
  return router;
}
