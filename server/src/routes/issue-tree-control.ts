import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createIssueTreeHoldSchema,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { heartbeatService, issueService, issueTreeControlService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import type { Handler } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

const TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS = 1_000;

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRunCancellationTasks(tasks: Promise<void>[]) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.all(tasks),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, TREE_RUN_CANCELLATION_RESPONSE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function issueTreeControlRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const treeControlSvc = issueTreeControlService(db);
  const heartbeat = heartbeatService(db);

  const deps = { db, storage: null as never };

  const previewTreeControl: Handler = async (ctx) => {
    assertBoard(ctx);
    const rootIssueId = ctx.param("id")!;
    const root = await issuesSvc.getById(rootIssueId);
    if (!root) {
      return Response.json({ error: "Root issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, root.companyId);
    const body = await ctx.json();
    const preview = await treeControlSvc.preview(root.companyId, root.id, body);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: root.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.tree_control_previewed",
      entityType: "issue",
      entityId: root.id,
      details: {
        mode: preview.mode,
        totals: preview.totals,
        warningCodes: preview.warnings.map((warning: { code: string }) => warning.code),
      },
    });

    return Response.json(preview);
  };

  const createTreeHold: Handler = async (ctx) => {
    assertBoard(ctx);
    const rootIssueId = ctx.param("id")!;
    const root = await issuesSvc.getById(rootIssueId);
    if (!root) {
      return Response.json({ error: "Root issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, root.companyId);
    const body = await ctx.json<Record<string, unknown>>();

    const actor = getActorInfo(ctx);
    const actorInput = {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
    };
    let result = await treeControlSvc.createHold(root.companyId, root.id, {
      ...body,
      actor: actorInput,
    });
    await logActivity(db, {
      companyId: root.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.tree_hold_created",
      entityType: "issue",
      entityId: root.id,
      details: {
        holdId: result.hold.id,
        mode: result.hold.mode,
        reason: result.hold.reason,
        totals: result.preview.totals,
        warningCodes: result.preview.warnings.map((warning: { code: string }) => warning.code),
      },
    });

    const runCancellationTasks: Promise<void>[] = [];
    if (result.hold.mode === "pause" || result.hold.mode === "cancel") {
      const interruptedRunIds = [...new Set(result.preview.activeRuns.map((run: { id: string }) => run.id))];
      for (const heartbeatRunId of interruptedRunIds) {
        const cancellationTask = (async () => {
          try {
            await heartbeat.cancelRun(heartbeatRunId);
            await logActivity(db, {
              companyId: root.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.tree_hold_run_interrupted",
              entityType: "heartbeat_run",
              entityId: heartbeatRunId,
              details: {
                holdId: result.hold.id,
                rootIssueId: root.id,
                reason: result.hold.mode === "pause" ? "active_subtree_pause_hold" : "subtree_cancel_operation",
              },
            });
          } catch (error) {
            await Promise.resolve(logActivity(db, {
              companyId: root.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.tree_hold_run_interrupt_failed",
              entityType: "heartbeat_run",
              entityId: heartbeatRunId,
              details: {
                holdId: result.hold.id,
                rootIssueId: root.id,
                reason: result.hold.mode === "pause" ? "active_subtree_pause_hold" : "subtree_cancel_operation",
                error: errorToMessage(error),
              },
            })).catch(() => null);
          }
        })();
        runCancellationTasks.push(cancellationTask);
      }

      const cancelledWakeups = await treeControlSvc.cancelUnclaimedWakeupsForTree(
        root.companyId,
        root.id,
        result.hold.mode === "pause"
          ? "Cancelled because an active subtree pause hold was created"
          : "Cancelled because a subtree cancel operation was applied",
      );
      for (const wakeup of cancelledWakeups) {
        await logActivity(db, {
          companyId: root.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.tree_hold_wakeup_deferred",
          entityType: "agent_wakeup_request",
          entityId: wakeup.id,
          details: {
            holdId: result.hold.id,
            rootIssueId: root.id,
            agentId: wakeup.agentId,
            previousReason: wakeup.reason,
          },
        });
      }
    }

    if (result.hold.mode === "cancel") {
      const statusUpdate = await treeControlSvc.cancelIssueStatusesForHold(root.companyId, root.id, result.hold.id);
      await logActivity(db, {
        companyId: root.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.tree_cancel_status_updated",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          cancelledIssueIds: statusUpdate.updatedIssueIds,
          cancelledIssueCount: statusUpdate.updatedIssueIds.length,
        },
      });
    }

    if (runCancellationTasks.length > 0) {
      await waitForRunCancellationTasks(runCancellationTasks);
    }

    if (result.hold.mode === "restore") {
      let statusUpdate;
      try {
        statusUpdate = await treeControlSvc.restoreIssueStatusesForHold(root.companyId, root.id, result.hold.id, {
          reason: result.hold.reason,
          actor: actorInput,
        });
      } catch (error) {
        await treeControlSvc.releaseHold(root.companyId, root.id, result.hold.id, {
          reason: "Restore operation failed before subtree status updates completed",
          metadata: {
            cleanup: "restore_failed_before_apply",
          },
          actor: actorInput,
        }).catch(() => null);
        throw error;
      }
      if (statusUpdate.restoreHold) {
        result = { ...result, hold: statusUpdate.restoreHold };
      }
      await logActivity(db, {
        companyId: root.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.tree_restore_status_updated",
        entityType: "issue",
        entityId: root.id,
        details: {
          holdId: result.hold.id,
          restoredIssueIds: statusUpdate.updatedIssueIds,
          restoredIssueCount: statusUpdate.updatedIssueIds.length,
          releasedCancelHoldIds: statusUpdate.releasedCancelHoldIds,
        },
      });

      const wakeAgents = typeof body.metadata === "object"
        && body.metadata !== null
        && (body.metadata as Record<string, unknown>).wakeAgents === true;
      if (wakeAgents) {
        for (const restoredIssue of statusUpdate.updatedIssues) {
          if (!restoredIssue.assigneeAgentId) continue;
          const wakeRun = await heartbeat
            .wakeup(restoredIssue.assigneeAgentId, {
              source: "assignment",
              triggerDetail: "system",
              reason: "issue_tree_restored",
              payload: {
                issueId: restoredIssue.id,
                rootIssueId: root.id,
                restoreHoldId: result.hold.id,
              },
              requestedByActorType: actor.actorType,
              requestedByActorId: actor.actorId,
              contextSnapshot: {
                issueId: restoredIssue.id,
                taskId: restoredIssue.id,
                wakeReason: "issue_tree_restored",
                source: "issue.tree_restore",
                rootIssueId: root.id,
                restoreHoldId: result.hold.id,
              },
            })
            .catch(() => null);
          if (!wakeRun) continue;
          await logActivity(db, {
            companyId: root.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.tree_restore_wakeup_requested",
            entityType: "heartbeat_run",
            entityId: wakeRun.id,
            details: {
              holdId: result.hold.id,
              rootIssueId: root.id,
              issueId: restoredIssue.id,
              agentId: restoredIssue.assigneeAgentId,
            },
          });
        }
      }
    }

    const status = result.hold.mode === "restore" || result.hold.mode === "resume" ? 200 : 201;
    return Response.json(result, { status });
  };

  const getTreeControlState: Handler = async (ctx) => {
    assertBoard(ctx);
    const issueId = ctx.param("id")!;
    const issue = await issuesSvc.getById(issueId);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    return Response.json({ activePauseHold });
  };

  const listTreeHolds: Handler = async (ctx) => {
    assertBoard(ctx);
    const rootIssueId = ctx.param("id")!;
    const root = await issuesSvc.getById(rootIssueId);
    if (!root) {
      return Response.json({ error: "Root issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, root.companyId);
    const statusParam = ctx.query("status");
    const modeParam = ctx.query("mode");
    const includeMembers = ctx.query("includeMembers") === "true";
    const holds = await treeControlSvc.listHolds(root.companyId, root.id, {
      status: statusParam === "active" || statusParam === "released" ? statusParam : undefined,
      mode:
        modeParam === "pause" || modeParam === "resume" || modeParam === "cancel" || modeParam === "restore"
          ? modeParam
          : undefined,
      includeMembers,
    });
    return Response.json(holds);
  };

  const getTreeHold: Handler = async (ctx) => {
    assertBoard(ctx);
    const rootIssueId = ctx.param("id")!;
    const root = await issuesSvc.getById(rootIssueId);
    if (!root) {
      return Response.json({ error: "Root issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, root.companyId);

    const hold = await treeControlSvc.getHold(root.companyId, ctx.param("holdId")!);
    if (!hold || hold.rootIssueId !== root.id) {
      return Response.json({ error: "Issue tree hold not found" }, { status: 404 });
    }
    return Response.json(hold);
  };

  const releaseTreeHold: Handler = async (ctx) => {
    assertBoard(ctx);
    const rootIssueId = ctx.param("id")!;
    const root = await issuesSvc.getById(rootIssueId);
    if (!root) {
      return Response.json({ error: "Root issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, root.companyId);
    const body = await ctx.json<Record<string, unknown>>();

    const actor = getActorInfo(ctx);
    const hold = await treeControlSvc.releaseHold(root.companyId, root.id, ctx.param("holdId")!, {
      ...body,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
    });
    await logActivity(db, {
      companyId: root.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.tree_hold_released",
      entityType: "issue",
      entityId: root.id,
      details: {
        holdId: hold.id,
        mode: hold.mode,
        reason: hold.releaseReason,
        memberCount: hold.members?.length ?? 0,
      },
    });

    return Response.json(hold);
  };

  router.post(
    "/issues/:id/tree-control/preview",
    validate(previewIssueTreeControlSchema),
    expressHandler(previewTreeControl, deps),
  );
  router.post(
    "/issues/:id/tree-holds",
    validate(createIssueTreeHoldSchema),
    expressHandler(createTreeHold, deps),
  );
  router.get("/issues/:id/tree-control/state", expressHandler(getTreeControlState, deps));
  router.get("/issues/:id/tree-holds", expressHandler(listTreeHolds, deps));
  router.get("/issues/:id/tree-holds/:holdId", expressHandler(getTreeHold, deps));
  router.post(
    "/issues/:id/tree-holds/:holdId/release",
    validate(releaseIssueTreeHoldSchema),
    expressHandler(releaseTreeHold, deps),
  );

  return router;
}
