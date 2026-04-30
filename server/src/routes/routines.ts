import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createRoutineSchema,
  createRoutineTriggerSchema,
  rotateRoutineTriggerSecretSchema,
  runRoutineSchema,
  updateRoutineSchema,
  updateRoutineTriggerSchema,
} from "@paperclipai/shared";
import { trackRoutineCreated } from "@paperclipai/shared/telemetry";
import { accessService, logActivity, routineService } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler, RequestCtx } from "../http/types.js";
import type { StorageService } from "../storage/types.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function buildHandlers(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const svc = routineService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const access = accessService(db);

  async function assertBoardCanAssignTasks(ctx: RequestCtx, companyId: string) {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type !== "board") return;
    if (ctx.actor.source === "local_implicit" || ctx.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, ctx.actor.userId, "tasks:assign");
    if (!allowed) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  function assertCanManageCompanyRoutine(ctx: RequestCtx, companyId: string, assigneeAgentId?: string | null) {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board") return;
    if (ctx.actor?.type !== "agent" || !ctx.actor.agentId) throw forbidden("Agent authentication required");
    if (assigneeAgentId !== ctx.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
  }

  async function assertCanManageExistingRoutine(ctx: RequestCtx, routineId: string) {
    const routine = await svc.get(routineId);
    if (!routine) return null;
    assertCompanyAccess(ctx, routine.companyId);
    if (ctx.actor?.type === "board") return routine;
    if (ctx.actor?.type !== "agent" || !ctx.actor.agentId) throw forbidden("Agent authentication required");
    if (routine.assigneeAgentId !== ctx.actor.agentId) {
      throw forbidden("Agents can only manage routines assigned to themselves");
    }
    return routine;
  }

  // server/src/routes/routines.ts:60
  const listRoutines: Handler = async (ctx) => {
    const companyId = ctx.param("companyId") ?? "";
    assertCompanyAccess(ctx, companyId);
    const result = await svc.list(companyId);
    return Response.json(result);
  };

  // server/src/routes/routines.ts:67
  const createRoutine: Handler = async (ctx) => {
    const companyId = ctx.param("companyId") ?? "";
    const body = await ctx.json();
    const parsed = createRoutineSchema.parse(body);
    await assertBoardCanAssignTasks(ctx, companyId);
    assertCanManageCompanyRoutine(ctx, companyId, parsed.assigneeAgentId);
    const created = await svc.create(companyId, parsed, {
      agentId: ctx.actor?.type === "agent" ? (ctx.actor.agentId ?? null) : null,
      userId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : null,
    });

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
      action: "routine.created",
      entityType: "routine",
      entityId: created.id,
      details: { title: created.title, assigneeAgentId: created.assigneeAgentId },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackRoutineCreated(telemetryClient);
    }
    return Response.json(created, { status: 201 });
  };

  // server/src/routes/routines.ts:94
  const getRoutine: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const detail = await svc.getDetail(id);
    if (!detail) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, detail.companyId);
    return Response.json(detail);
  };

  // server/src/routes/routines.ts:104
  const patchRoutine: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const routine = await assertCanManageExistingRoutine(ctx, id);
    if (!routine) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    const body = await ctx.json();
    const parsed = updateRoutineSchema.parse(body);
    const assigneeWillChange =
      parsed.assigneeAgentId !== undefined &&
      parsed.assigneeAgentId !== routine.assigneeAgentId;
    if (assigneeWillChange) {
      await assertBoardCanAssignTasks(ctx, routine.companyId);
    }
    const statusWillActivate =
      parsed.status !== undefined &&
      parsed.status === "active" &&
      routine.status !== "active";
    if (statusWillActivate) {
      await assertBoardCanAssignTasks(ctx, routine.companyId);
    }
    if (
      ctx.actor?.type === "agent" &&
      parsed.assigneeAgentId !== undefined &&
      parsed.assigneeAgentId !== ctx.actor.agentId
    ) {
      throw forbidden("Agents can only assign routines to themselves");
    }
    const updated = await svc.update(routine.id, parsed, {
      agentId: ctx.actor?.type === "agent" ? (ctx.actor.agentId ?? null) : null,
      userId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : null,
    });

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    await logActivity(db, {
      companyId: routine.companyId,
      actorType,
      actorId,
      agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
      runId: ctx.actor?.runId ?? null,
      action: "routine.updated",
      entityType: "routine",
      entityId: routine.id,
      details: { title: updated?.title ?? routine.title },
    });
    return Response.json(updated);
  };

  // server/src/routes/routines.ts:149
  const listRoutineRuns: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const routine = await svc.get(id);
    if (!routine) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, routine.companyId);
    const limitStr = ctx.query("limit");
    const limit = Number(limitStr ?? 50);
    const result = await svc.listRuns(routine.id, Number.isFinite(limit) ? limit : 50);
    return Response.json(result);
  };

  // server/src/routes/routines.ts:161
  const createRoutineTrigger: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const routine = await assertCanManageExistingRoutine(ctx, id);
    if (!routine) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    await assertBoardCanAssignTasks(ctx, routine.companyId);
    const body = await ctx.json();
    const parsed = createRoutineTriggerSchema.parse(body);
    const created = await svc.createTrigger(routine.id, parsed, {
      agentId: ctx.actor?.type === "agent" ? (ctx.actor.agentId ?? null) : null,
      userId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : null,
    });

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    await logActivity(db, {
      companyId: routine.companyId,
      actorType,
      actorId,
      agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
      runId: ctx.actor?.runId ?? null,
      action: "routine.trigger_created",
      entityType: "routine_trigger",
      entityId: created.trigger.id,
      details: { routineId: routine.id, kind: created.trigger.kind },
    });
    return Response.json(created, { status: 201 });
  };

  // server/src/routes/routines.ts:187
  const patchRoutineTrigger: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const trigger = await svc.getTrigger(id);
    if (!trigger) {
      return Response.json({ error: "Routine trigger not found" }, { status: 404 });
    }
    const routine = await assertCanManageExistingRoutine(ctx, trigger.routineId);
    if (!routine) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    await assertBoardCanAssignTasks(ctx, routine.companyId);
    const body = await ctx.json();
    const parsed = updateRoutineTriggerSchema.parse(body);
    const updated = await svc.updateTrigger(trigger.id, parsed, {
      agentId: ctx.actor?.type === "agent" ? (ctx.actor.agentId ?? null) : null,
      userId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : null,
    });

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    await logActivity(db, {
      companyId: routine.companyId,
      actorType,
      actorId,
      agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
      runId: ctx.actor?.runId ?? null,
      action: "routine.trigger_updated",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: { routineId: routine.id, kind: updated?.kind ?? trigger.kind },
    });
    return Response.json(updated);
  };

  // server/src/routes/routines.ts:218
  const deleteRoutineTrigger: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const trigger = await svc.getTrigger(id);
    if (!trigger) {
      return Response.json({ error: "Routine trigger not found" }, { status: 404 });
    }
    const routine = await assertCanManageExistingRoutine(ctx, trigger.routineId);
    if (!routine) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    await svc.deleteTrigger(trigger.id);

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    await logActivity(db, {
      companyId: routine.companyId,
      actorType,
      actorId,
      agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
      runId: ctx.actor?.runId ?? null,
      action: "routine.trigger_deleted",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: { routineId: routine.id, kind: trigger.kind },
    });
    return new Response(null, { status: 204 });
  };

  // server/src/routes/routines.ts:245
  const rotateRoutineTriggerSecret: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const trigger = await svc.getTrigger(id);
    if (!trigger) {
      return Response.json({ error: "Routine trigger not found" }, { status: 404 });
    }
    const routine = await assertCanManageExistingRoutine(ctx, trigger.routineId);
    if (!routine) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    const body = await ctx.json();
    rotateRoutineTriggerSecretSchema.parse(body);
    const rotated = await svc.rotateTriggerSecret(trigger.id, {
      agentId: ctx.actor?.type === "agent" ? (ctx.actor.agentId ?? null) : null,
      userId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : null,
    });

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    await logActivity(db, {
      companyId: routine.companyId,
      actorType,
      actorId,
      agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
      runId: ctx.actor?.runId ?? null,
      action: "routine.trigger_secret_rotated",
      entityType: "routine_trigger",
      entityId: trigger.id,
      details: { routineId: routine.id },
    });
    return Response.json(rotated);
  };

  // server/src/routes/routines.ts:279
  const runRoutine: Handler = async (ctx) => {
    const id = ctx.param("id") ?? "";
    const routine = await assertCanManageExistingRoutine(ctx, id);
    if (!routine) {
      return Response.json({ error: "Routine not found" }, { status: 404 });
    }
    await assertBoardCanAssignTasks(ctx, routine.companyId);
    const body = await ctx.json();
    const parsed = runRoutineSchema.parse(body);
    const run = await svc.runRoutine(routine.id, parsed, {
      agentId: ctx.actor?.type === "agent" ? (ctx.actor.agentId ?? null) : null,
      userId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? null) : null,
    });

    const actorType = ctx.actor!.type === "agent" ? "agent" as const : "user" as const;
    const actorId = ctx.actor!.type === "agent"
      ? (ctx.actor!.agentId ?? "unknown-agent")
      : (ctx.actor!.userId ?? "board");
    await logActivity(db, {
      companyId: routine.companyId,
      actorType,
      actorId,
      agentId: ctx.actor!.type === "agent" ? (ctx.actor!.agentId ?? null) : null,
      runId: ctx.actor?.runId ?? null,
      action: "routine.run_triggered",
      entityType: "routine_run",
      entityId: run.id,
      details: { routineId: routine.id, source: run.source, status: run.status },
    });
    return Response.json(run, { status: 202 });
  };

  // server/src/routes/routines.ts:305
  // TODO(cloudflare): verify auth flow in Workers — rawBody is not available
  // on RequestCtx; the signature verification that depends on rawBody will need
  // a separate body-buffering approach in the Workers runtime.
  const firePublicTrigger: Handler = async (ctx) => {
    const publicId = ctx.param("publicId") ?? "";
    const result = await svc.firePublicTrigger(publicId, {
      authorizationHeader: ctx.headers.get("authorization"),
      signatureHeader: ctx.headers.get("x-paperclip-signature"),
      hubSignatureHeader: ctx.headers.get("x-hub-signature-256"),
      timestampHeader: ctx.headers.get("x-paperclip-timestamp"),
      idempotencyKey: ctx.headers.get("idempotency-key"),
      // rawBody is not available on RequestCtx in the transport-agnostic shape.
      // Workers callers must buffer the raw body separately before verification.
      // TODO(cloudflare): surface rawBody on RequestCtx for signature verification.
      rawBody: null,
      payload: await ctx.json<Record<string, unknown> | null>().then((v) =>
        typeof v === "object" && v !== null ? v as Record<string, unknown> : null,
      ),
    });
    return Response.json(result, { status: 202 });
  };

  return {
    listRoutines,
    createRoutine,
    getRoutine,
    patchRoutine,
    listRoutineRuns,
    createRoutineTrigger,
    patchRoutineTrigger,
    deleteRoutineTrigger,
    rotateRoutineTriggerSecret,
    runRoutine,
    firePublicTrigger,
  };
}

export function routineRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const {
    listRoutines,
    createRoutine,
    getRoutine,
    patchRoutine,
    listRoutineRuns,
    createRoutineTrigger,
    patchRoutineTrigger,
    deleteRoutineTrigger,
    rotateRoutineTriggerSecret,
    runRoutine,
    firePublicTrigger,
  } = buildHandlers(db, options);

  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`routine handler unexpectedly accessed storage.${String(prop)}`);
    },
  });
  const deps = { db, storage: storageSentinel };

  router.get("/companies/:companyId/routines", expressHandler(listRoutines, deps));
  router.post("/companies/:companyId/routines", expressHandler(createRoutine, deps));
  router.get("/routines/:id", expressHandler(getRoutine, deps));
  router.patch("/routines/:id", expressHandler(patchRoutine, deps));
  router.get("/routines/:id/runs", expressHandler(listRoutineRuns, deps));
  router.post("/routines/:id/triggers", expressHandler(createRoutineTrigger, deps));
  router.patch("/routine-triggers/:id", expressHandler(patchRoutineTrigger, deps));
  router.delete("/routine-triggers/:id", expressHandler(deleteRoutineTrigger, deps));
  router.post("/routine-triggers/:id/rotate-secret", expressHandler(rotateRoutineTriggerSecret, deps));
  router.post("/routines/:id/run", expressHandler(runRoutine, deps));
  router.post("/routine-triggers/public/:publicId/fire", expressHandler(firePublicTrigger, deps));

  return router;
}
