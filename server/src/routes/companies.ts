import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  companyPortabilityService,
  companyService,
  feedbackService,
  logActivity,
} from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import type { BoardActor, Handler, RequestCtx } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

export function companyRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const feedback = feedbackService(db);

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return parsed;
  }

  function assertImportTargetAccess(
    ctx: RequestCtx,
    target: { mode: "new_company" } | { mode: "existing_company"; companyId: string },
  ) {
    if (target.mode === "new_company") {
      assertInstanceAdmin(ctx);
      return;
    }
    assertCompanyAccess(ctx, target.companyId);
  }

  async function assertCanUpdateBranding(ctx: RequestCtx, companyId: string) {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board") return;
    if (!ctx.actor?.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(ctx.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update company branding");
    }
  }

  async function assertCanManagePortability(ctx: RequestCtx, companyId: string, capability: "imports" | "exports") {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board") return;
    if (!ctx.actor?.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(ctx.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage company ${capability}`);
    }
  }

  // Storage sentinel used for handlers that do not touch storage.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`company handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  const listCompanies: Handler = async (ctx) => {
    assertBoard(ctx);
    const boardActor = ctx.actor as BoardActor;
    const result = await svc.list();
    if (boardActor.source === "local_implicit" || boardActor.isInstanceAdmin) {
      return Response.json(result);
    }
    const allowed = new Set(boardActor.companyIds ?? []);
    return Response.json(result.filter((company) => allowed.has(company.id)));
  };

  const getCompanyStats: Handler = async (ctx) => {
    assertBoard(ctx);
    const boardActor = ctx.actor as BoardActor;
    const allowed = boardActor.source === "local_implicit" || boardActor.isInstanceAdmin
      ? null
      : new Set(boardActor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      return Response.json(stats);
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    return Response.json(filtered);
  };

  const missingCompanyIdError: Handler = async (_ctx) => {
    return Response.json(
      { error: "Missing companyId in path. Use /api/companies/{companyId}/issues." },
      { status: 400 },
    );
  };

  const getCompany: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (ctx.actor?.type !== "agent") {
      assertBoard(ctx);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    return Response.json(company);
  };

  const listFeedbackTraces: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    assertBoard(ctx);

    const targetTypeRaw = ctx.query("targetType");
    const voteRaw = ctx.query("vote");
    const statusRaw = ctx.query("status");
    const issueIdRaw = ctx.query("issueId");
    const issueId = issueIdRaw && issueIdRaw.trim().length > 0 ? issueIdRaw : undefined;
    const projectIdRaw = ctx.query("projectId");
    const projectId = projectIdRaw && projectIdRaw.trim().length > 0 ? projectIdRaw : undefined;
    const fromRaw = ctx.query("from");
    const toRaw = ctx.query("to");
    const sharedOnlyRaw = ctx.query("sharedOnly");
    const includePayloadRaw = ctx.query("includePayload");

    const traces = await feedback.listFeedbackTraces({
      companyId,
      issueId,
      projectId,
      targetType: targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined,
      vote: voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined,
      status: statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined,
      from: parseDateQuery(fromRaw, "from"),
      to: parseDateQuery(toRaw, "to"),
      sharedOnly: parseBooleanQuery(sharedOnlyRaw),
      includePayload: parseBooleanQuery(includePayloadRaw),
    });
    return Response.json(traces);
  };

  const exportCompany: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanManagePortability(ctx, companyId, "exports");
    const body = await ctx.json();
    const result = await portability.exportBundle(companyId, body);
    return Response.json(result);
  };

  const previewImport: Handler = async (ctx) => {
    assertBoard(ctx);
    const body = await ctx.json<{ target: Parameters<typeof assertImportTargetAccess>[1] }>();
    assertImportTargetAccess(ctx, body.target);
    const preview = await portability.previewImport(body);
    return Response.json(preview);
  };

  const importBundle: Handler = async (ctx) => {
    assertBoard(ctx);
    const body = await ctx.json<{ target: Parameters<typeof assertImportTargetAccess>[1]; include?: unknown }>();
    assertImportTargetAccess(ctx, body.target);
    const actor = getActorInfo(ctx);
    const result = await portability.importBundle(body, ctx.actor?.type === "board" ? ctx.actor.userId : null);
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    return Response.json(result);
  };

  const previewExportByCompany: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanManagePortability(ctx, companyId, "exports");
    const body = await ctx.json();
    const preview = await portability.previewExport(companyId, body);
    return Response.json(preview);
  };

  const exportByCompany: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanManagePortability(ctx, companyId, "exports");
    const body = await ctx.json();
    const result = await portability.exportBundle(companyId, body);
    return Response.json(result);
  };

  const previewImportByCompany: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanManagePortability(ctx, companyId, "imports");
    const body = await ctx.json<{ target: { mode: string; companyId?: string }; collisionStrategy?: string }>();
    if (body.target.mode === "existing_company" && body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    return Response.json(preview);
  };

  const applyImportByCompany: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanManagePortability(ctx, companyId, "imports");
    const body = await ctx.json<{ target: { mode: string; companyId?: string }; collisionStrategy?: string; include?: unknown }>();
    if (body.target.mode === "existing_company" && body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(ctx);
    const result = await portability.importBundle(body, ctx.actor?.type === "board" ? ctx.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    return Response.json(result);
  };

  const createCompany: Handler = async (ctx) => {
    assertBoard(ctx);
    const boardActor = ctx.actor as BoardActor;
    if (!(boardActor.source === "local_implicit" || boardActor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const body = await ctx.json();
    const company = await svc.create(body);
    await access.ensureMembership(company.id, "user", boardActor.userId ?? "local-board", "owner", "active");
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: boardActor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        boardActor.userId ?? "board",
      );
    }
    return Response.json(company, { status: 201 });
  };

  const updateCompany: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);

    const actor = getActorInfo(ctx);
    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    let body: Record<string, unknown>;

    if (ctx.actor?.type === "agent") {
      // Only CEO agents may update company branding fields
      const agentSvc = agentService(db);
      const actorAgent = ctx.actor.agentId ? await agentSvc.getById(ctx.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update company settings");
      }
      if (actorAgent.companyId !== companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      body = updateCompanyBrandingSchema.parse(await ctx.json());
    } else {
      assertBoard(ctx);
      const boardActor = ctx.actor as BoardActor;
      body = updateCompanySchema.parse(await ctx.json());

      if (body.feedbackDataSharingEnabled === true && !existingCompany.feedbackDataSharingEnabled) {
        body = {
          ...body,
          feedbackDataSharingConsentAt: new Date(),
          feedbackDataSharingConsentByUserId: boardActor.userId ?? "local-board",
          feedbackDataSharingTermsVersion:
            typeof body.feedbackDataSharingTermsVersion === "string" && body.feedbackDataSharingTermsVersion.length > 0
              ? body.feedbackDataSharingTermsVersion
              : DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
        };
      }
    }

    const company = await svc.update(companyId, body);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    return Response.json(company);
  };

  const updateCompanyBranding: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanUpdateBranding(ctx, companyId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await ctx.json()) as any;
    const company = await svc.update(companyId, body);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    return Response.json(company);
  };

  const archiveCompany: Handler = async (ctx) => {
    assertBoard(ctx);
    const boardActor = ctx.actor as BoardActor;
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const company = await svc.archive(companyId);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: boardActor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    return Response.json(company);
  };

  const deleteCompany: Handler = async (ctx) => {
    assertBoard(ctx);
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const company = await svc.remove(companyId);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    return Response.json({ ok: true });
  };

  // The storage dep is optional on this route factory; pass it when available,
  // otherwise use a sentinel so expressHandler's AdapterDeps type is satisfied.
  const storageDep = storage ?? storageSentinel;

  router.get("/", expressHandler(listCompanies, { db, storage: storageSentinel }));
  router.get("/stats", expressHandler(getCompanyStats, { db, storage: storageSentinel }));
  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", expressHandler(missingCompanyIdError, { db, storage: storageSentinel }));
  router.get("/:companyId", expressHandler(getCompany, { db, storage: storageSentinel }));
  router.get("/:companyId/feedback-traces", expressHandler(listFeedbackTraces, { db, storage: storageSentinel }));
  router.post("/:companyId/export", validate(companyPortabilityExportSchema), expressHandler(exportCompany, { db, storage: storageDep }));
  router.post("/import/preview", validate(companyPortabilityPreviewSchema), expressHandler(previewImport, { db, storage: storageDep }));
  router.post("/import", validate(companyPortabilityImportSchema), expressHandler(importBundle, { db, storage: storageDep }));
  router.post("/:companyId/exports/preview", validate(companyPortabilityExportSchema), expressHandler(previewExportByCompany, { db, storage: storageDep }));
  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), expressHandler(exportByCompany, { db, storage: storageDep }));
  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), expressHandler(previewImportByCompany, { db, storage: storageDep }));
  router.post("/:companyId/imports/apply", validate(companyPortabilityImportSchema), expressHandler(applyImportByCompany, { db, storage: storageDep }));
  router.post("/", validate(createCompanySchema), expressHandler(createCompany, { db, storage: storageSentinel }));
  router.patch("/:companyId", expressHandler(updateCompany, { db, storage: storageSentinel }));
  router.patch("/:companyId/branding", validate(updateCompanyBrandingSchema), expressHandler(updateCompanyBranding, { db, storage: storageSentinel }));
  router.post("/:companyId/archive", expressHandler(archiveCompany, { db, storage: storageSentinel }));
  router.delete("/:companyId", expressHandler(deleteCompany, { db, storage: storageSentinel }));

  return router;
}
