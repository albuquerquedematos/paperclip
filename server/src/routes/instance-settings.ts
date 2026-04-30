import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  issueGraphLivenessAutoRecoveryRequestSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "@paperclipai/shared";
import { assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";
import { heartbeatService, instanceSettingsService, logActivity } from "../services/index.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

function buildHandlers(db: Db) {
  const svc = instanceSettingsService(db);
  const heartbeat = heartbeatService(db);

  // server/src/routes/instance-settings.ts:28
  const getGeneralSettings: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    return Response.json(await svc.getGeneral());
  };

  // server/src/routes/instance-settings.ts:35
  const patchGeneralSettings: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const body = await ctx.json();
    const patch = patchInstanceGeneralSettingsSchema.parse(body);
    const updated = await svc.updateGeneral(patch);

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    const companyIds = await svc.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType,
          actorId,
          agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
          runId: ctx.actor?.runId ?? null,
          action: "instance.settings.general_updated",
          entityType: "instance_settings",
          entityId: updated.id,
          details: {
            general: updated.general,
            changedKeys: Object.keys(patch).sort(),
          },
        }),
      ),
    );
    return Response.json(updated.general);
  };

  // server/src/routes/instance-settings.ts:65
  const getExperimentalSettings: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    return Response.json(await svc.getExperimental());
  };

  // server/src/routes/instance-settings.ts:72
  const patchExperimentalSettings: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const body = await ctx.json();
    const patch = patchInstanceExperimentalSettingsSchema.parse(body);
    const updated = await svc.updateExperimental(patch);

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    const companyIds = await svc.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType,
          actorId,
          agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
          runId: ctx.actor?.runId ?? null,
          action: "instance.settings.experimental_updated",
          entityType: "instance_settings",
          entityId: updated.id,
          details: {
            experimental: updated.experimental,
            changedKeys: Object.keys(patch).sort(),
          },
        }),
      ),
    );
    return Response.json(updated.experimental);
  };

  // server/src/routes/instance-settings.ts:103
  const previewIssueGraphLivenessAutoRecovery: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const body = await ctx.json();
    const parsed = issueGraphLivenessAutoRecoveryRequestSchema.parse(body);
    return Response.json(await heartbeat.buildIssueGraphLivenessAutoRecoveryPreview({
      lookbackHours: parsed.lookbackHours,
    }));
  };

  // server/src/routes/instance-settings.ts:113
  const runIssueGraphLivenessAutoRecovery: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const body = await ctx.json();
    const parsed = issueGraphLivenessAutoRecoveryRequestSchema.parse(body);

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    const result = await heartbeat.reconcileIssueGraphLiveness({
      runId: null,
      force: true,
      lookbackHours: parsed.lookbackHours,
    });
    const companyIds = await svc.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType,
          actorId,
          agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
          runId: ctx.actor?.runId ?? null,
          action: "instance.settings.issue_graph_liveness_auto_recovery_run",
          entityType: "instance_settings",
          entityId: "default",
          details: {
            lookbackHours: result.lookbackHours,
            escalationsCreated: result.escalationsCreated,
            existingEscalations: result.existingEscalations,
            skippedOutsideLookback: result.skippedOutsideLookback,
            escalationIssueIds: result.escalationIssueIds,
          },
        }),
      ),
    );
    return Response.json(result);
  };

  return {
    getGeneralSettings,
    patchGeneralSettings,
    getExperimentalSettings,
    patchExperimentalSettings,
    previewIssueGraphLivenessAutoRecovery,
    runIssueGraphLivenessAutoRecovery,
  };
}

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const {
    getGeneralSettings,
    patchGeneralSettings,
    getExperimentalSettings,
    patchExperimentalSettings,
    previewIssueGraphLivenessAutoRecovery,
    runIssueGraphLivenessAutoRecovery,
  } = buildHandlers(db);

  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`instanceSettings handler unexpectedly accessed storage.${String(prop)}`);
    },
  });
  const deps = { db, storage: storageSentinel };

  router.get("/instance/settings/general", expressHandler(getGeneralSettings, deps));
  router.patch("/instance/settings/general", expressHandler(patchGeneralSettings, deps));
  router.get("/instance/settings/experimental", expressHandler(getExperimentalSettings, deps));
  router.patch("/instance/settings/experimental", expressHandler(patchExperimentalSettings, deps));
  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
    expressHandler(previewIssueGraphLivenessAutoRecovery, deps),
  );
  router.post(
    "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
    expressHandler(runIssueGraphLivenessAutoRecovery, deps),
  );

  return router;
}
