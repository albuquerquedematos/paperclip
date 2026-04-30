import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  heartbeatService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { badRequest } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { Handler } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

export function parseCostDateRange(query: Record<string, unknown>) {
  const fromRaw = query.from as string | undefined;
  const toRaw = query.to as string | undefined;
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
  if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
  return (from || to) ? { from, to } : undefined;
}

export function parseCostLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return 100;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw badRequest("invalid 'limit' value");
  }
  return limit;
}

export function costRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const companies = companyService(db);
  const agents = agentService(db);

  const deps = { db, storage: null as never };

  function ctxQueryRecord(ctx: Parameters<Handler>[0]): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        return ctx.query(String(prop));
      },
    });
  }

  const createCostEvent: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json<Record<string, unknown>>();

    if (ctx.actor?.type === "agent" && ctx.actor.agentId !== body.agentId) {
      return Response.json({ error: "Agent can only report its own costs" }, { status: 403 });
    }

    const event = await costs.createEvent(companyId, {
      ...body,
      occurredAt: new Date(body.occurredAt as string),
    });

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    return Response.json(event, { status: 201 });
  };

  const createFinanceEvent: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    assertBoard(ctx);
    const body = await ctx.json<Record<string, unknown>>();

    const event = await finance.createEvent(companyId, {
      ...body,
      occurredAt: new Date(body.occurredAt as string),
    });

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    return Response.json(event, { status: 201 });
  };

  const getCostsSummary: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const summary = await costs.summary(companyId, range);
    return Response.json(summary);
  };

  const getCostsByAgent: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const rows = await costs.byAgent(companyId, range);
    return Response.json(rows);
  };

  const getCostsByAgentModel: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const rows = await costs.byAgentModel(companyId, range);
    return Response.json(rows);
  };

  const getCostsByProvider: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const rows = await costs.byProvider(companyId, range);
    return Response.json(rows);
  };

  const getCostsByBiller: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const rows = await costs.byBiller(companyId, range);
    return Response.json(rows);
  };

  const getFinanceSummary: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const summary = await finance.summary(companyId, range);
    return Response.json(summary);
  };

  const getFinanceByBiller: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const rows = await finance.byBiller(companyId, range);
    return Response.json(rows);
  };

  const getFinanceByKind: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const rows = await finance.byKind(companyId, range);
    return Response.json(rows);
  };

  const getFinanceEvents: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const limit = parseCostLimit(ctxQueryRecord(ctx));
    const rows = await finance.list(companyId, range, limit);
    return Response.json(rows);
  };

  const getWindowSpend: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const rows = await costs.windowSpend(companyId);
    return Response.json(rows);
  };

  const getQuotaWindows: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    assertBoard(ctx);
    const company = await companies.getById(companyId);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    const results = await fetchAllQuotaWindows();
    return Response.json(results);
  };

  const getBudgetsOverview: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const overview = await budgets.overview(companyId);
    return Response.json(overview);
  };

  const upsertBudgetPolicy: Handler = async (ctx) => {
    assertBoard(ctx);
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json<Record<string, unknown>>();
    const userId = ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board";
    const summary = await budgets.upsertPolicy(companyId, body, userId);
    return Response.json(summary);
  };

  const resolveBudgetIncident: Handler = async (ctx) => {
    assertBoard(ctx);
    const companyId = ctx.param("companyId")!;
    const incidentId = ctx.param("incidentId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json<Record<string, unknown>>();
    const userId = ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board";
    const incident = await budgets.resolveIncident(companyId, incidentId, body, userId);
    return Response.json(incident);
  };

  const getCostsByProject: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const range = parseCostDateRange(ctxQueryRecord(ctx));
    const rows = await costs.byProject(companyId, range);
    return Response.json(rows);
  };

  const updateCompanyBudget: Handler = async (ctx) => {
    assertBoard(ctx);
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json<{ budgetMonthlyCents: number }>();
    const company = await companies.update(companyId, { budgetMonthlyCents: body.budgetMonthlyCents });
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }

    const userId = ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board";
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: body.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "company",
        scopeId: companyId,
        amount: body.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      userId,
    );

    return Response.json(company);
  };

  const updateAgentBudget: Handler = async (ctx) => {
    const agentId = ctx.param("agentId")!;
    const agent = await agents.getById(agentId);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    assertCompanyAccess(ctx, agent.companyId);
    assertBoard(ctx);

    const body = await ctx.json<{ budgetMonthlyCents: number }>();
    const updated = await agents.update(agentId, { budgetMonthlyCents: body.budgetMonthlyCents });
    if (!updated) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    const policyUserId = ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : null;
    await budgets.upsertPolicy(
      updated.companyId,
      {
        scopeType: "agent",
        scopeId: updated.id,
        amount: updated.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      policyUserId,
    );

    return Response.json(updated);
  };

  router.post(
    "/companies/:companyId/cost-events",
    validate(createCostEventSchema),
    expressHandler(createCostEvent, deps),
  );
  router.post(
    "/companies/:companyId/finance-events",
    validate(createFinanceEventSchema),
    expressHandler(createFinanceEvent, deps),
  );
  router.get("/companies/:companyId/costs/summary", expressHandler(getCostsSummary, deps));
  router.get("/companies/:companyId/costs/by-agent", expressHandler(getCostsByAgent, deps));
  router.get("/companies/:companyId/costs/by-agent-model", expressHandler(getCostsByAgentModel, deps));
  router.get("/companies/:companyId/costs/by-provider", expressHandler(getCostsByProvider, deps));
  router.get("/companies/:companyId/costs/by-biller", expressHandler(getCostsByBiller, deps));
  router.get("/companies/:companyId/costs/finance-summary", expressHandler(getFinanceSummary, deps));
  router.get("/companies/:companyId/costs/finance-by-biller", expressHandler(getFinanceByBiller, deps));
  router.get("/companies/:companyId/costs/finance-by-kind", expressHandler(getFinanceByKind, deps));
  router.get("/companies/:companyId/costs/finance-events", expressHandler(getFinanceEvents, deps));
  router.get("/companies/:companyId/costs/window-spend", expressHandler(getWindowSpend, deps));
  router.get("/companies/:companyId/costs/quota-windows", expressHandler(getQuotaWindows, deps));
  router.get("/companies/:companyId/budgets/overview", expressHandler(getBudgetsOverview, deps));
  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    expressHandler(upsertBudgetPolicy, deps),
  );
  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    expressHandler(resolveBudgetIncident, deps),
  );
  router.get("/companies/:companyId/costs/by-project", expressHandler(getCostsByProject, deps));
  router.patch(
    "/companies/:companyId/budgets",
    validate(updateBudgetSchema),
    expressHandler(updateCompanyBudget, deps),
  );
  router.patch(
    "/agents/:agentId/budgets",
    validate(updateBudgetSchema),
    expressHandler(updateAgentBudget, deps),
  );

  return router;
}
