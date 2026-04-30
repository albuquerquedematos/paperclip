import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { activityService, normalizeActivityLimit } from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";
import { heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import type { Handler } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  const getCompanyActivity: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);

    const filters = {
      companyId,
      agentId: ctx.query("agentId"),
      entityType: ctx.query("entityType"),
      entityId: ctx.query("entityId"),
      limit: normalizeActivityLimit(Number(ctx.query("limit"))),
    };
    const result = await svc.list(filters);
    return Response.json(result);
  };

  const createCompanyActivity: Handler = async (ctx) => {
    assertBoard(ctx);
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json<z.infer<typeof createActivitySchema>>();
    const event = await svc.create({
      companyId,
      ...body,
      details: body.details ? sanitizeRecord(body.details as Record<string, unknown>) : null,
    });
    return Response.json(event, { status: 201 });
  };

  const getIssueActivity: Handler = async (ctx) => {
    const rawId = ctx.param("id")!;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const result = await svc.forIssue(issue.id);
    return Response.json(result);
  };

  const getIssueRuns: Handler = async (ctx) => {
    const rawId = ctx.param("id")!;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, issue.id);
    return Response.json(result);
  };

  const getRunIssues: Handler = async (ctx) => {
    assertAuthenticated(ctx);
    const runId = ctx.param("runId")!;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      return Response.json([]);
    }
    assertCompanyAccess(ctx, run.companyId);
    const result = await svc.issuesForRun(runId);
    return Response.json(result);
  };

  const deps = { db, storage: null as never };

  router.get("/companies/:companyId/activity", expressHandler(getCompanyActivity, deps));
  router.post(
    "/companies/:companyId/activity",
    validate(createActivitySchema),
    expressHandler(createCompanyActivity, deps),
  );
  router.get("/issues/:id/activity", expressHandler(getIssueActivity, deps));
  router.get("/issues/:id/runs", expressHandler(getIssueRuns, deps));
  router.get("/heartbeat-runs/:runId/issues", expressHandler(getRunIssues, deps));

  return router;
}
