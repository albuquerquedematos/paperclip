import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { Handler, RequestCtx } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(ctx: RequestCtx, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(ctx, approval.companyId);
    return approval;
  }

  const deps = { db, storage: null as never };

  const listApprovals: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const status = ctx.query("status");
    const result = await svc.list(companyId, status);
    return Response.json(result.map((approval) => redactApprovalPayload(approval)));
  };

  const getApproval: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const approval = await svc.getById(id);
    if (!approval) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, approval.companyId);
    return Response.json(redactApprovalPayload(approval));
  };

  const createApproval: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json<Record<string, unknown>>();
    const rawIssueIds = body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload as Record<string, unknown>,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(ctx);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        (approvalInput.requestedByAgentId as string | null | undefined) ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    return Response.json(redactApprovalPayload(approval), { status: 201 });
  };

  const getApprovalIssues: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const approval = await svc.getById(id);
    if (!approval) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    return Response.json(issues);
  };

  const approveApproval: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    if (!(await requireApprovalAccess(ctx, id))) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    const body = await ctx.json<{ decisionNote?: string | null }>();
    const decidedByUserId = ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board";
    const { approval, applied } = await svc.approve(id, decidedByUserId, body.decisionNote ?? null);

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: decidedByUserId,
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: decidedByUserId,
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: decidedByUserId,
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    return Response.json(redactApprovalPayload(approval));
  };

  const rejectApproval: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    if (!(await requireApprovalAccess(ctx, id))) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    const body = await ctx.json<{ decisionNote?: string | null }>();
    const decidedByUserId = ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, body.decisionNote ?? null);

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: decidedByUserId,
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    return Response.json(redactApprovalPayload(approval));
  };

  const requestRevision: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    if (!(await requireApprovalAccess(ctx, id))) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    const body = await ctx.json<{ decisionNote?: string | null }>();
    const decidedByUserId = ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board";
    const approval = await svc.requestRevision(id, decidedByUserId, body.decisionNote ?? null);

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: decidedByUserId,
      action: "approval.revision_requested",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });

    return Response.json(redactApprovalPayload(approval));
  };

  const resubmitApproval: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);

    if (ctx.actor?.type === "agent" && ctx.actor.agentId !== existing.requestedByAgentId) {
      return Response.json({ error: "Only requesting agent can resubmit this approval" }, { status: 403 });
    }

    const body = await ctx.json<{ payload?: Record<string, unknown> }>();
    const normalizedPayload = body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            body.payload,
            { strictMode: strictSecretsMode },
          )
        : body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    return Response.json(redactApprovalPayload(approval));
  };

  const listApprovalComments: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const approval = await svc.getById(id);
    if (!approval) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, approval.companyId);
    const comments = await svc.listComments(id);
    return Response.json(comments);
  };

  const addApprovalComment: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const approval = await svc.getById(id);
    if (!approval) {
      return Response.json({ error: "Approval not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, approval.companyId);
    const body = await ctx.json<{ body: string }>();
    const actor = getActorInfo(ctx);
    const comment = await svc.addComment(id, body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    return Response.json(comment, { status: 201 });
  };

  router.get("/companies/:companyId/approvals", expressHandler(listApprovals, deps));
  router.get("/approvals/:id", expressHandler(getApproval, deps));
  router.post(
    "/companies/:companyId/approvals",
    validate(createApprovalSchema),
    expressHandler(createApproval, deps),
  );
  router.get("/approvals/:id/issues", expressHandler(getApprovalIssues, deps));
  router.post(
    "/approvals/:id/approve",
    validate(resolveApprovalSchema),
    expressHandler(approveApproval, deps),
  );
  router.post(
    "/approvals/:id/reject",
    validate(resolveApprovalSchema),
    expressHandler(rejectApproval, deps),
  );
  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    expressHandler(requestRevision, deps),
  );
  router.post(
    "/approvals/:id/resubmit",
    validate(resubmitApprovalSchema),
    expressHandler(resubmitApproval, deps),
  );
  router.get("/approvals/:id/comments", expressHandler(listApprovalComments, deps));
  router.post(
    "/approvals/:id/comments",
    validate(addApprovalCommentSchema),
    expressHandler(addApprovalComment, deps),
  );

  return router;
}
