import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import { trackGoalCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";
import type { Handler } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  const listGoals: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const result = await svc.list(companyId);
    return Response.json(result);
  };

  const getGoal: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const goal = await svc.getById(id);
    if (!goal) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, goal.companyId);
    return Response.json(goal);
  };

  const createGoal: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await ctx.json()) as any;
    const goal = await svc.create(companyId, body);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackGoalCreated(telemetryClient, { goalLevel: goal.level });
    }
    return Response.json(goal, { status: 201 });
  };

  const updateGoal: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await ctx.json()) as any;
    const goal = await svc.update(id, body);
    if (!goal) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: body as Record<string, unknown>,
    });

    return Response.json(goal);
  };

  const deleteGoal: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    const goal = await svc.remove(id);
    if (!goal) {
      return Response.json({ error: "Goal not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    return Response.json(goal);
  };

  // Storage is not used by any goal handler; supply a sentinel to satisfy AdapterDeps.
  const storageSentinel = new Proxy({} as import("../storage/types.js").StorageService, {
    get(_target, prop) {
      throw new Error(`goal handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  router.get("/companies/:companyId/goals", expressHandler(listGoals, { db, storage: storageSentinel }));
  router.get("/goals/:id", expressHandler(getGoal, { db, storage: storageSentinel }));
  router.post("/companies/:companyId/goals", validate(createGoalSchema), expressHandler(createGoal, { db, storage: storageSentinel }));
  router.patch("/goals/:id", validate(updateGoalSchema), expressHandler(updateGoal, { db, storage: storageSentinel }));
  router.delete("/goals/:id", expressHandler(deleteGoal, { db, storage: storageSentinel }));

  return router;
}
