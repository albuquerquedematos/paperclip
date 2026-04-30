import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Handler, RequestCtx } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  createIssueAttachmentMetadataSchema,
  createIssueThreadInteractionSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createChildIssueSchema,
  createIssueSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  rejectIssueThreadInteractionSchema,
  restoreIssueDocumentRevisionSchema,
  respondIssueThreadInteractionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import * as serviceIndex from "../services/index.js";
import {
  accessService,
  agentService,
  companyService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueThreadInteractionService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueReferenceService,
  issueService,
  clampIssueListLimit,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectIssueWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  isInlineAttachmentContentType,
  normalizeIssueAttachmentMaxBytes,
  normalizeContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { feedbackService } from "../services/feedback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;
type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
type ActivityIssueRelationSummary = {
  id: string;
  identifier: string | null;
  title: string;
};
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  reviewRequest: ParsedExecutionState["reviewRequest"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

function summarizeIssueRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string;
}): ActivityIssueRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

function summarizeIssueReferenceActivityDetails(input:
  | {
      addedReferencedIssues: ActivityIssueRelationSummary[];
      removedReferencedIssues: ActivityIssueRelationSummary[];
      currentReferencedIssues: ActivityIssueRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedIssues.length > 0 ? { addedReferencedIssues: input.addedReferencedIssues } : {}),
    ...(input.removedReferencedIssues.length > 0 ? { removedReferencedIssues: input.removedReferencedIssues } : {}),
    ...(input.currentReferencedIssues.length > 0 ? { currentReferencedIssues: input.currentReferencedIssues } : {}),
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

function shouldImplicitlyMoveCommentedIssueToTodo(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  // Only human comments should implicitly reopen finished work.
  // Agent-authored comments remain communicative unless reopen was explicit.
  if (input.actorType !== "user") return false;
  if (!isClosedIssueStatus(input.issueStatus) && input.issueStatus !== "blocked") return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  return true;
}

function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return status === "done" || status === "blocked" || status === "todo" || status === "in_progress";
}

function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: ReturnType<typeof heartbeatService>;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
}) {
  if (
    input.interaction.continuationPolicy !== "wake_assignee"
    && input.interaction.continuationPolicy !== "wake_assignee_on_accept"
  ) return;
  if (
    input.interaction.continuationPolicy === "wake_assignee_on_accept"
    && input.interaction.status !== "accepted"
  ) return;
  if (input.interaction.status === "expired") return;
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status)) return;

  void input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      mutation: "interaction",
    },
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      wakeReason: "issue_commented",
      source: input.source,
    },
  }).catch((err) => logger.warn({
    err,
    issueId: input.issue.id,
    interactionId: input.interaction.id,
    agentId: input.issue.assigneeAgentId,
  }, "failed to wake assignee on issue interaction resolution"));
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

function buildExecutionStageWakeup(input: {
  issueId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
}) {
  const { issueId, previousState, nextState, interruptedRunId } = input;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent" ? (nextState.currentParticipant.agentId ?? null) : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(previousState?.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: reason,
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent" ? (nextState.returnAssignee.agentId ?? null) : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(previousState?.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    pluginWorkerManager?: PluginWorkerManager;
  } = {},
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const feedback = feedbackService(db);
  const companiesSvc = companyService(db);
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceServiceDirect(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const issueReferencesSvc = issueReferenceService(db);
  const routinesSvc = routineService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const issueTreeControlFactory = Object.prototype.hasOwnProperty.call(
    serviceIndex,
    "issueTreeControlService",
  )
    ? serviceIndex.issueTreeControlService
    : undefined;
  const treeControlSvc = issueTreeControlFactory?.(db) ?? {
    getActivePauseHoldGate: async () => null,
  };
  const feedbackExportService = opts?.feedbackExportService;
  const environmentsSvc = environmentService(db);
  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  async function assertIssueEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(
      environmentsSvc,
      companyId,
      environmentId,
      { allowedDrivers: ["local", "ssh", "sandbox"] },
    );
  }

  async function logExpiredRequestConfirmations(input: {
    issue: { id: string; companyId: string; identifier?: string | null };
    interactions: Array<{ id: string; kind: string; status: string; result?: unknown }>;
    actor: ReturnType<typeof getActorInfo>;
    source: string;
  }) {
    for (const interaction of input.interactions) {
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.thread_interaction_expired",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          identifier: input.issue.identifier ?? null,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          source: input.source,
          result: interaction.result ?? null,
        },
      });
    }
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response, fileSizeLimit: number) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: fileSizeLimit, files: 1 },
    });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(ctx: RequestCtx, companyId: string) {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board") return;
    if (ctx.actor?.type !== "agent" || !ctx.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    const actorAgent = await agentsSvc.getById(ctx.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Forbidden");
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return;
    throw forbidden("Missing permission to link approvals");
  }

  function actorCanAccessCompany(ctx: RequestCtx, companyId: string) {
    if (!ctx.actor) return false;
    if (ctx.actor.type === "agent") return ctx.actor.companyId === companyId;
    if (ctx.actor.source === "local_implicit" || ctx.actor.isInstanceAdmin) return true;
    return (ctx.actor.companyIds ?? []).includes(companyId);
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(ctx: RequestCtx, companyId: string) {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board") {
      if (ctx.actor.source === "local_implicit" || ctx.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, ctx.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (ctx.actor?.type === "agent") {
      if (!ctx.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(companyId, "agent", ctx.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(ctx.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  /** Throws unauthorized if agent has no runId; returns null for non-agent actors. */
  function requireAgentRunId(ctx: RequestCtx): string | null {
    if (ctx.actor?.type !== "agent") return null;
    const runId = ctx.actor.runId?.trim();
    if (runId) return runId;
    throw unauthorized("Agent run id required");
  }

  async function hasActiveCheckoutManagementOverride(
    actorAgentId: string,
    companyId: string,
    assigneeAgentId: string,
  ) {
    const allowedByGrant = await access.hasPermission(
      companyId,
      "agent",
      actorAgentId,
      "tasks:manage_active_checkouts",
    );
    if (allowedByGrant) return true;

    const companyAgents = await agentsSvc.list(companyId);
    const agentsById = new Map(companyAgents.map((agent) => [agent.id, agent]));
    const actorAgent = agentsById.get(actorAgentId);
    if (!actorAgent) return false;
    if (canCreateAgentsLegacy(actorAgent)) return true;

    // Reporting-chain managers may intervene in an agent's active checkout
    // without taking the task over. Peers must own the checkout/run first.
    let cursor: string | null = assigneeAgentId;
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      const assignee = agentsById.get(cursor);
      if (!assignee) return false;
      if (assignee.reportsTo === actorAgentId) return true;
      cursor = assignee.reportsTo;
    }

    return false;
  }

  async function assertAgentIssueMutationAllowed(
    ctx: RequestCtx,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (ctx.actor?.type !== "agent") return;
    const actorAgentId = ctx.actor.agentId;
    if (!actorAgentId) throw forbidden("Agent authentication required");
    if (issue.assigneeAgentId === null) return;
    if (issue.assigneeAgentId !== actorAgentId) {
      if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
        return;
      }
      if (issue.status === "in_progress") {
        throw new HttpError(409, "Issue is checked out by another agent", {
          issueId: issue.id,
          assigneeAgentId: issue.assigneeAgentId,
          actorAgentId,
        });
      }
      throw new HttpError(403, "Agent cannot mutate another agent's issue", {
        issueId: issue.id,
        assigneeAgentId: issue.assigneeAgentId,
        actorAgentId,
        status: issue.status,
        securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
      });
    }
    if (issue.status !== "in_progress") return;
    const runId = requireAgentRunId(ctx);
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId!);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(ctx);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
  }

  async function assertExplicitResumeIntentAllowed(
    ctx: RequestCtx,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (issue.status === "cancelled") {
      throw new HttpError(409, "Cancelled issues must be restored through the dedicated restore flow", {
        issueId: issue.id,
        status: issue.status,
      });
    }

    if (!isExplicitResumeCapableStatus(issue.status)) {
      throw new HttpError(409, "Issue is not resumable through comment follow-up intent", {
        issueId: issue.id,
        status: issue.status,
      });
    }

    const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issue.companyId, issue.id);
    if (activePauseHold) {
      throw new HttpError(409, "Issue follow-up blocked by active subtree pause hold", {
        issueId: issue.id,
        holdId: activePauseHold.holdId,
        rootIssueId: activePauseHold.rootIssueId,
        mode: activePauseHold.mode,
      });
    }

    if (issue.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id);
      if (readiness.unresolvedBlockerCount > 0) {
        throw new HttpError(409, "Issue follow-up blocked by unresolved blockers", {
          issueId: issue.id,
          unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
        });
      }
    }

    if (ctx.actor?.type !== "agent") return;

    const actorAgentId = ctx.actor.agentId;
    if (!actorAgentId) throw forbidden("Agent authentication required");
    if (!issue.assigneeAgentId) {
      throw new HttpError(409, "Issue follow-up requires an assigned agent", {
        issueId: issue.id,
        actorAgentId,
      });
    }
    if (issue.assigneeAgentId === actorAgentId) return;
    if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
      return;
    }

    throw new HttpError(403, "Agent cannot request follow-up for another agent's issue", {
      issueId: issue.id,
      assigneeAgentId: issue.assigneeAgentId,
      actorAgentId,
    });
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function normalizeIssueAssigneeAgentReference(
    companyId: string,
    rawAssigneeAgentId: string | null | undefined,
  ) {
    if (rawAssigneeAgentId === undefined || rawAssigneeAgentId === null) {
      return rawAssigneeAgentId;
    }

    const raw = rawAssigneeAgentId.trim();
    if (raw.length === 0) {
      return rawAssigneeAgentId;
    }

    const resolved = await agentsSvc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }
  function toValidTimestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function isQueuedIssueCommentForActiveRun(params: {
    comment: {
      authorAgentId?: string | null;
      createdAt?: Date | string | null;
    };
    activeRun: {
      agentId?: string | null;
      startedAt?: Date | string | null;
      createdAt?: Date | string | null;
    };
  }) {
    const activeRunStartedAtMs =
      toValidTimestamp(params.activeRun.startedAt) ?? toValidTimestamp(params.activeRun.createdAt);
    const commentCreatedAtMs = toValidTimestamp(params.comment.createdAt);

    if (activeRunStartedAtMs === null || commentCreatedAtMs === null) return false;
    if (params.comment.authorAgentId && params.comment.authorAgentId === params.activeRun.agentId) return false;
    return commentCreatedAtMs >= activeRunStartedAtMs;
  }
  async function getClosedIssueExecutionWorkspace(issue: { executionWorkspaceId?: string | null }) {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  function closedIssueExecutionWorkspaceResponse(
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ): Response {
    return Response.json(
      { error: getClosedIsolatedExecutionWorkspaceMessage(workspace), executionWorkspace: workspace },
      { status: 409 },
    );
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  const deps = { db, storage };

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  const listIssues: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const assigneeUserFilterRaw = ctx.query("assigneeUserId");
    const touchedByUserFilterRaw = ctx.query("touchedByUserId");
    const inboxArchivedByUserFilterRaw = ctx.query("inboxArchivedByUserId");
    const unreadForUserFilterRaw = ctx.query("unreadForUserId");
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && ctx.actor?.type === "board"
        ? ctx.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && ctx.actor?.type === "board"
        ? ctx.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && ctx.actor?.type === "board"
        ? ctx.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && ctx.actor?.type === "board"
        ? ctx.actor.userId
        : unreadForUserFilterRaw;
    const rawLimit = ctx.query("limit");
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : null;
    const limit = parsedLimit === null ? ISSUE_LIST_DEFAULT_LIMIT : clampIssueListLimit(parsedLimit);
    const rawOffset = ctx.query("offset");
    const parsedOffset = rawOffset !== undefined && /^\d+$/.test(rawOffset)
      ? Number.parseInt(rawOffset, 10)
      : null;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || ctx.actor?.type !== "board")) {
      return Response.json({ error: "assigneeUserId=me requires board authentication" }, { status: 403 });
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || ctx.actor?.type !== "board")) {
      return Response.json({ error: "touchedByUserId=me requires board authentication" }, { status: 403 });
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || ctx.actor?.type !== "board")) {
      return Response.json({ error: "inboxArchivedByUserId=me requires board authentication" }, { status: 403 });
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || ctx.actor?.type !== "board")) {
      return Response.json({ error: "unreadForUserId=me requires board authentication" }, { status: 403 });
    }
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      return Response.json({ error: `limit must be a positive integer up to ${ISSUE_LIST_MAX_LIMIT}` }, { status: 400 });
    }
    if (rawOffset !== undefined && (parsedOffset === null || !Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      return Response.json({ error: "offset must be a non-negative integer" }, { status: 400 });
    }
    const offset = parsedOffset ?? 0;

    const result = await svc.list(companyId, {
      status: ctx.query("status"),
      assigneeAgentId: ctx.query("assigneeAgentId"),
      participantAgentId: ctx.query("participantAgentId"),
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: ctx.query("projectId"),
      workspaceId: ctx.query("workspaceId"),
      executionWorkspaceId: ctx.query("executionWorkspaceId"),
      parentId: ctx.query("parentId"),
      descendantOf: ctx.query("descendantOf"),
      labelId: ctx.query("labelId"),
      originKind: ctx.query("originKind"),
      originId: ctx.query("originId"),
      includeRoutineExecutions:
        ctx.query("includeRoutineExecutions") === "true" || ctx.query("includeRoutineExecutions") === "1",
      excludeRoutineExecutions:
        ctx.query("excludeRoutineExecutions") === "true" || ctx.query("excludeRoutineExecutions") === "1",
      includeBlockedBy: ctx.query("includeBlockedBy") === "true" || ctx.query("includeBlockedBy") === "1",
      q: ctx.query("q"),
      limit,
      offset,
    });
    return Response.json(result);
  };

  const listLabels: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const result = await svc.listLabels(companyId);
    return Response.json(result);
  };

  const createLabel: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json();
    const label = await svc.createLabel(companyId, body);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    return Response.json(label, { status: 201 });
  };

  const deleteLabel: Handler = async (ctx) => {
    const labelId = ctx.param("labelId")!;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      return Response.json({ error: "Label not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      return Response.json({ error: "Label not found" }, { status: 404 });
    }
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    return Response.json(removed);
  };

  router.get("/companies/:companyId/issues", expressHandler(listIssues, deps));
  router.get("/companies/:companyId/labels", expressHandler(listLabels, deps));
  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), expressHandler(createLabel, deps));
  router.delete("/labels/:labelId", expressHandler(deleteLabel, deps));

  const getHeartbeatContext: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);

    const wakeCommentIdRaw = ctx.query("wakeCommentId");
    const wakeCommentId = wakeCommentIdRaw && wakeCommentIdRaw.trim().length > 0 ? wakeCommentIdRaw.trim() : null;

    const currentExecutionWorkspacePromise = issue.executionWorkspaceId
      ? executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : Promise.resolve(null);
    const [
      { project, goal },
      ancestors,
      commentCursor,
      wakeComment,
      relations,
      blockerAttention,
      productivityReview,
      attachments,
      continuationSummary,
      currentExecutionWorkspace,
    ] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
      svc.getRelationSummaries(issue.id),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
      svc.listAttachments(issue.id),
      documentsSvc.getIssueDocumentByKey(issue.id, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
      currentExecutionWorkspacePromise,
    ]);

    return Response.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        ...(blockerAttention ? { blockerAttention } : {}),
        productivityReview,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        blockedBy: relations.blockedBy,
        blocks: relations.blocks,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        originKind: issue.originKind,
        originId: issue.originId,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? { id: project.id, name: project.name, status: project.status, targetDate: project.targetDate }
        : null,
      goal: goal
        ? { id: goal.id, title: goal.title, status: goal.status, level: goal.level, parentId: goal.parentId }
        : null,
      commentCursor,
      wakeComment: wakeComment && wakeComment.issueId === issue.id ? wakeComment : null,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        contentType: a.contentType,
        byteSize: a.byteSize,
        contentPath: withContentPath(a).contentPath,
        createdAt: a.createdAt,
      })),
      continuationSummary: continuationSummary
        ? {
            key: continuationSummary.key,
            title: continuationSummary.title,
            body: continuationSummary.body,
            latestRevisionId: continuationSummary.latestRevisionId,
            latestRevisionNumber: continuationSummary.latestRevisionNumber,
            updatedAt: continuationSummary.updatedAt,
          }
        : null,
      currentExecutionWorkspace,
    });
  };

  const getIssue: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      productivityReview,
      referenceSummary,
    ] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id, { includeCommentBodies: false }),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
      issueReferencesSvc.listIssueReferenceSummary(issue.id),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    return Response.json({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      productivityReview,
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  };

  const getIssueWorkProducts: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    return Response.json(workProducts);
  };

  const listIssueDocuments: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id, {
      includeSystem: ctx.query("includeSystem") === "true",
    });
    return Response.json(docs);
  };

  const getIssueDocument: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(ctx.param("key") ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      return Response.json({ error: "Invalid document key", details: keyParsed.error.issues }, { status: 400 });
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });
    return Response.json(doc);
  };

  router.get("/issues/:id/heartbeat-context", expressHandler(getHeartbeatContext, deps));
  router.get("/issues/:id", expressHandler(getIssue, deps));
  router.get("/issues/:id/work-products", expressHandler(getIssueWorkProducts, deps));
  router.get("/issues/:id/documents", expressHandler(listIssueDocuments, deps));
  router.get("/issues/:id/documents/:key", expressHandler(getIssueDocument, deps));

  const upsertIssueDocument: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    await assertAgentIssueMutationAllowed(ctx, issue);
    const keyParsed = issueDocumentKeySchema.safeParse(String(ctx.param("key") ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      return Response.json({ error: "Invalid document key", details: keyParsed.error.issues }, { status: 400 });
    }
    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: (body.title as string | null) ?? null,
      format: body.format as string,
      body: body.body as string,
      changeSummary: (body.changeSummary as string | null) ?? null,
      baseRevisionId: (body.baseRevisionId as string | null) ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;
    await issueReferencesSvc.syncDocument(doc.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    if (!result.created) {
      const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
        issue,
        { id: doc.id, key: doc.key, latestRevisionId: doc.latestRevisionId, latestRevisionNumber: doc.latestRevisionNumber },
        { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
      );
      await logExpiredRequestConfirmations({ issue, interactions: expiredInteractions, actor, source: "issue.document_updated" });
    }
    return Response.json(doc, { status: result.created ? 201 : 200 });
  };

  const listDocumentRevisions: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(ctx.param("key") ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      return Response.json({ error: "Invalid document key", details: keyParsed.error.issues }, { status: 400 });
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    return Response.json(revisions);
  };

  const restoreDocumentRevision: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const revisionId = ctx.param("revisionId")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    await assertAgentIssueMutationAllowed(ctx, issue);
    const keyParsed = issueDocumentKeySchema.safeParse(String(ctx.param("key") ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      return Response.json({ error: "Invalid document key", details: keyParsed.error.issues }, { status: 400 });
    }
    const actor = getActorInfo(ctx);
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const result = await documentsSvc.restoreIssueDocumentRevision({
      issueId: issue.id,
      key: keyParsed.data,
      revisionId,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await issueReferencesSvc.syncDocument(result.document.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_restored",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: result.document.key,
        documentId: result.document.id,
        title: result.document.title,
        format: result.document.format,
        revisionNumber: result.document.latestRevisionNumber,
        restoredFromRevisionId: result.restoredFromRevisionId,
        restoredFromRevisionNumber: result.restoredFromRevisionNumber,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
      issue,
      { id: result.document.id, key: result.document.key, latestRevisionId: result.document.latestRevisionId, latestRevisionNumber: result.document.latestRevisionNumber },
      { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
    );
    await logExpiredRequestConfirmations({ issue, interactions: expiredInteractions, actor, source: "issue.document_restored" });
    return Response.json(result.document);
  };

  const deleteIssueDocument: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") {
      return Response.json({ error: "Board authentication required" }, { status: 403 });
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(ctx.param("key") ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      return Response.json({ error: "Invalid document key", details: keyParsed.error.issues }, { status: 400 });
    }
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) return Response.json({ error: "Document not found" }, { status: 404 });
    await issueReferencesSvc.deleteDocumentSource(removed.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
      issue,
      { id: removed.id, key: removed.key, latestRevisionId: null, latestRevisionNumber: null },
      { agentId: actor.agentId, userId: actor.actorType === "user" ? actor.actorId : null },
    );
    await logExpiredRequestConfirmations({ issue, interactions: expiredInteractions, actor, source: "issue.document_deleted" });
    return Response.json({ ok: true });
  };

  const createWorkProduct: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    await assertAgentIssueMutationAllowed(ctx, issue);
    const body = await ctx.json<Record<string, unknown>>();
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...body,
      projectId: (body.projectId as string | null | undefined) ?? issue.projectId ?? null,
    });
    if (!product) return Response.json({ error: "Invalid work product payload" }, { status: 422 });
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    return Response.json(product, { status: 201 });
  };

  const updateWorkProduct: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await workProductsSvc.getById(id);
    if (!existing) return Response.json({ error: "Work product not found" }, { status: 404 });
    assertCompanyAccess(ctx, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    await assertAgentIssueMutationAllowed(ctx, issue);
    const body = await ctx.json<Record<string, unknown>>();
    const product = await workProductsSvc.update(id, body);
    if (!product) return Response.json({ error: "Work product not found" }, { status: 404 });
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(body).sort() },
    });
    return Response.json(product);
  };

  const deleteWorkProduct: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await workProductsSvc.getById(id);
    if (!existing) return Response.json({ error: "Work product not found" }, { status: 404 });
    assertCompanyAccess(ctx, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    await assertAgentIssueMutationAllowed(ctx, issue);
    const removed = await workProductsSvc.remove(id);
    if (!removed) return Response.json({ error: "Work product not found" }, { status: 404 });
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    return Response.json(removed);
  };

  const markIssueRead: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") return Response.json({ error: "Board authentication required" }, { status: 403 });
    if (!ctx.actor.userId) return Response.json({ error: "Board user context required" }, { status: 403 });
    const userId = ctx.actor.userId;
    const readState = await svc.markRead(issue.companyId, issue.id, userId, new Date());
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId, lastReadAt: readState.lastReadAt },
    });
    return Response.json(readState);
  };

  const markIssueUnread: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") return Response.json({ error: "Board authentication required" }, { status: 403 });
    if (!ctx.actor.userId) return Response.json({ error: "Board user context required" }, { status: 403 });
    const userId = ctx.actor.userId;
    const removed = await svc.markUnread(issue.companyId, issue.id, userId);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId },
    });
    return Response.json({ id: issue.id, removed });
  };

  const archiveInbox: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") return Response.json({ error: "Board authentication required" }, { status: 403 });
    if (!ctx.actor.userId) return Response.json({ error: "Board user context required" }, { status: 403 });
    const userId = ctx.actor.userId;
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, userId, new Date());
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId, archivedAt: archiveState.archivedAt },
    });
    return Response.json(archiveState);
  };

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), expressHandler(upsertIssueDocument, deps));
  router.get("/issues/:id/documents/:key/revisions", expressHandler(listDocumentRevisions, deps));
  router.post("/issues/:id/documents/:key/revisions/:revisionId/restore", validate(restoreIssueDocumentRevisionSchema), expressHandler(restoreDocumentRevision, deps));
  router.delete("/issues/:id/documents/:key", expressHandler(deleteIssueDocument, deps));
  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), expressHandler(createWorkProduct, deps));
  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), expressHandler(updateWorkProduct, deps));
  router.delete("/work-products/:id", expressHandler(deleteWorkProduct, deps));
  router.post("/issues/:id/read", expressHandler(markIssueRead, deps));
  router.delete("/issues/:id/read", expressHandler(markIssueUnread, deps));
  router.post("/issues/:id/inbox-archive", expressHandler(archiveInbox, deps));

  const unarchiveInbox: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") return Response.json({ error: "Board authentication required" }, { status: 403 });
    if (!ctx.actor.userId) return Response.json({ error: "Board user context required" }, { status: 403 });
    const userId = ctx.actor.userId;
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, userId);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId },
    });
    return Response.json(removed ?? { ok: true });
  };

  const listIssueApprovals: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
    return Response.json(approvals);
  };

  const linkIssueApproval: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    await assertAgentIssueMutationAllowed(ctx, issue);
    await assertCanManageIssueApprovalLinks(ctx, issue.companyId);
    const body = await ctx.json<{ approvalId: string }>();
    const actor = getActorInfo(ctx);
    await issueApprovalsSvc.link(issue.id, body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: body.approvalId },
    });
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
    return Response.json(approvals, { status: 201 });
  };

  const unlinkIssueApproval: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const approvalId = ctx.param("approvalId")!;
    const issue = await svc.getById(id);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    await assertAgentIssueMutationAllowed(ctx, issue);
    await assertCanManageIssueApprovalLinks(ctx, issue.companyId);
    await issueApprovalsSvc.unlink(issue.id, approvalId);
    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });
    return Response.json({ ok: true });
  };

  router.delete("/issues/:id/inbox-archive", expressHandler(unarchiveInbox, deps));
  router.get("/issues/:id/approvals", expressHandler(listIssueApprovals, deps));
  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), expressHandler(linkIssueApproval, deps));
  router.delete("/issues/:id/approvals/:approvalId", expressHandler(unlinkIssueApproval, deps));

  const createIssue: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const body = await ctx.json<Record<string, unknown>>();
    assertNoAgentHostWorkspaceCommandMutation(ctx, collectIssueWorkspaceCommandPaths(body));
    if (body.assigneeAgentId || body.assigneeUserId) {
      await assertCanAssignTasks(ctx, companyId);
    }
    await assertIssueEnvironmentSelection(companyId, (body.executionWorkspaceSettings as Record<string, unknown> | undefined)?.environmentId as string | undefined);

    const actor = getActorInfo(ctx);
    const executionPolicy = normalizeIssueExecutionPolicy(body.executionPolicy);
    const issue = await svc.create(companyId, {
      ...body,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await issueReferencesSvc.syncIssue(issue.id);
    const referenceSummary = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      issueReferencesSvc.emptySummary(),
      referenceSummary,
    );

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        ...(Array.isArray(body.blockedByIssueIds) ? { blockedByIssueIds: body.blockedByIssueIds } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    return Response.json({
      ...issue,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
    }, { status: 201 });
  };

  router.post("/companies/:companyId/issues", validate(createIssueSchema), expressHandler(createIssue, deps));

  const createChildIssue: Handler = async (ctx) => {
    const parentId = ctx.param("id")!;
    const parent = await svc.getById(parentId);
    if (!parent) {
      return Response.json({ error: "Parent issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, parent.companyId);
    const body = await ctx.json<Record<string, unknown>>();
    assertNoAgentHostWorkspaceCommandMutation(ctx, collectIssueWorkspaceCommandPaths(body));
    if (body.assigneeAgentId || body.assigneeUserId) {
      await assertCanAssignTasks(ctx, parent.companyId);
    }
    await assertIssueEnvironmentSelection(parent.companyId, (body.executionWorkspaceSettings as Record<string, unknown> | undefined)?.environmentId as string | undefined);

    const actor = getActorInfo(ctx);
    const executionPolicy = normalizeIssueExecutionPolicy(body.executionPolicy);
    const { issue, parentBlockerAdded } = await svc.createChild(parent.id, {
      ...body,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.child_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        parentId: parent.id,
        identifier: issue.identifier,
        title: issue.title,
        inheritedExecutionWorkspaceFromIssueId: parent.id,
        ...(Array.isArray(body.blockedByIssueIds) ? { blockedByIssueIds: body.blockedByIssueIds } : {}),
        ...(parentBlockerAdded ? { parentBlockerAdded: true } : {}),
      },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.child_create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    return Response.json(issue, { status: 201 });
  };

  router.post("/issues/:id/children", validate(createChildIssueSchema), expressHandler(createChildIssue, deps));

  const updateIssue: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    const body = await ctx.json<Record<string, unknown>>();
    assertNoAgentHostWorkspaceCommandMutation(ctx, collectIssueWorkspaceCommandPaths(body));
    await assertAgentIssueMutationAllowed(ctx, existing);

    const actor = getActorInfo(ctx);
    const isClosed = isClosedIssueStatus(existing.status);
    const isBlocked = existing.status === "blocked";
    const normalizedAssigneeAgentId = await normalizeIssueAssigneeAgentReference(
      existing.companyId,
      body.assigneeAgentId as string | null | undefined,
    );
    const titleOrDescriptionChanged = body.title !== undefined || body.description !== undefined;
    const existingRelations =
      Array.isArray(body.blockedByIssueIds)
        ? await svc.getRelationSummaries(existing.id)
        : null;
    const {
      comment: commentBody,
      reviewRequest,
      reopen: reopenRequested,
      resume: resumeRequested,
      interrupt: interruptRequested,
      hiddenAt: hiddenAtRaw,
      ...updateFields
    } = body;
    const shouldCancelActiveRunForCancelledStatus =
      existing.status !== "cancelled" && updateFields.status === "cancelled";
    if (resumeRequested === true && !commentBody) {
      return Response.json({ error: "Follow-up intent requires a comment" }, { status: 400 });
    }
    if (resumeRequested === true) {
      await assertExplicitResumeIntentAllowed(ctx, existing);
    }
    if (resumeRequested !== true && reopenRequested === true && ctx.actor?.type === "agent") {
      await assertExplicitResumeIntentAllowed(ctx, existing);
    }
    await assertIssueEnvironmentSelection(existing.companyId, (updateFields.executionWorkspaceSettings as Record<string, unknown> | undefined)?.environmentId as string | undefined);
    const requestedAssigneeAgentId =
      normalizedAssigneeAgentId === undefined ? existing.assigneeAgentId : normalizedAssigneeAgentId;
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const effectiveMoveToTodoRequested =
      explicitMoveToTodoRequested ||
      (!!commentBody &&
        shouldImplicitlyMoveCommentedIssueToTodo({
          issueStatus: existing.status,
          assigneeAgentId: requestedAssigneeAgentId,
          actorType: actor.actorType,
          actorId: actor.actorId,
        }));
    const updateReferenceSummaryBefore = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(existing.id)
      : null;
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(existing.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      return Response.json({ error: "Issue follow-up blocked by unresolved blockers" }, { status: 409 });
    }
    let interruptedRunId: string | null = null;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(existing);
    const isAgentWorkUpdate =
      ctx.actor?.type === "agent" && (Object.keys(updateFields).length > 0 || reviewRequest !== undefined);

    if (closedExecutionWorkspace && (commentBody || isAgentWorkUpdate)) {
      return closedIssueExecutionWorkspaceResponse(closedExecutionWorkspace);
    }

    if (interruptRequested) {
      if (!commentBody) {
        return Response.json({ error: "Interrupt is only supported when posting a comment" }, { status: 400 });
      }
      if (ctx.actor?.type !== "board") {
        return Response.json({ error: "Only board users can interrupt active runs from issue comments" }, { status: 403 });
      }

      const runToInterrupt = await resolveActiveIssueRun(existing);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: existing.id },
          });
        }
      }
    }

    const runToCancelForCancelledStatus = shouldCancelActiveRunForCancelledStatus
      ? await resolveActiveIssueRun(existing)
      : null;

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw as string) : null;
    }
    if (
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
      updateFields.status === undefined
    ) {
      updateFields.status = "todo";
    }
    if (body.executionPolicy !== undefined) {
      updateFields.executionPolicy = normalizeIssueExecutionPolicy(body.executionPolicy);
    }
    const previousExecutionPolicy = normalizeIssueExecutionPolicy(existing.executionPolicy ?? null);
    const nextExecutionPolicy =
      updateFields.executionPolicy !== undefined
        ? (updateFields.executionPolicy as NormalizedExecutionPolicy | null)
        : previousExecutionPolicy;
    if (normalizedAssigneeAgentId !== undefined) {
      updateFields.assigneeAgentId = normalizedAssigneeAgentId;
    }

    const transition = applyIssueExecutionPolicyTransition({
      issue: existing,
      policy: nextExecutionPolicy,
      requestedStatus: typeof updateFields.status === "string" ? updateFields.status : undefined,
      requestedAssigneePatch: {
        assigneeAgentId: normalizedAssigneeAgentId,
        assigneeUserId:
          body.assigneeUserId === undefined ? undefined : (body.assigneeUserId as string | null),
      },
      actor: {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
      commentBody,
      reviewRequest: reviewRequest === undefined ? undefined : reviewRequest,
    });
    const decisionId = transition.decision ? randomUUID() : null;
    if (decisionId) {
      const nextExecutionState = transition.patch.executionState;
      if (!nextExecutionState || typeof nextExecutionState !== "object") {
        throw new Error("Execution policy decision patch is missing executionState");
      }
      transition.patch.executionState = {
        ...nextExecutionState,
        lastDecisionId: decisionId,
      };
    }
    Object.assign(updateFields, transition.patch);
    if (reviewRequest !== undefined && transition.patch.executionState === undefined) {
      const existingExecutionState = parseIssueExecutionState(existing.executionState);
      if (!existingExecutionState || existingExecutionState.status !== "pending") {
        if (reviewRequest !== null) {
          return Response.json({ error: "reviewRequest requires an active review or approval stage" }, { status: 422 });
        }
      } else {
        updateFields.executionState = {
          ...existingExecutionState,
          reviewRequest,
        };
      }
    }

    const nextAssigneeAgentId =
      updateFields.assigneeAgentId === undefined ? existing.assigneeAgentId : (updateFields.assigneeAgentId as string | null);
    const nextAssigneeUserId =
      updateFields.assigneeUserId === undefined ? existing.assigneeUserId : (updateFields.assigneeUserId as string | null);
    const assigneeWillChange =
      nextAssigneeAgentId !== existing.assigneeAgentId || nextAssigneeUserId !== existing.assigneeUserId;
    const isAgentReturningIssueToCreator =
      ctx.actor?.type === "agent" &&
      !!(ctx.actor.agentId) &&
      existing.assigneeAgentId === ctx.actor.agentId &&
      nextAssigneeAgentId === null &&
      typeof nextAssigneeUserId === "string" &&
      !!existing.createdByUserId &&
      nextAssigneeUserId === existing.createdByUserId;

    if (assigneeWillChange && !transition.workflowControlledAssignment) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(ctx, existing.companyId);
      }
    }

    let issue;
    try {
      if (transition.decision && decisionId) {
        const decision = transition.decision;
        issue = await db.transaction(async (tx) => {
          const updated = await svc.update(
            id,
            {
              ...updateFields,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
            },
            tx,
          );
          if (!updated) return null;

          await tx.insert(issueExecutionDecisions).values({
            id: decisionId,
            companyId: updated.companyId,
            issueId: updated.id,
            stageId: decision.stageId,
            stageType: decision.stageType,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            outcome: decision.outcome,
            body: decision.body,
            createdByRunId: actor.runId ?? null,
          });

          return updated;
        });
      } else {
        issue = await svc.update(id, {
          ...updateFields,
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            companyId: existing.companyId,
            assigneePatch: {
              assigneeAgentId: normalizedAssigneeAgentId === undefined ? "__omitted__" : normalizedAssigneeAgentId,
              assigneeUserId:
                body.assigneeUserId === undefined ? "__omitted__" : body.assigneeUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }

    let cancelledStatusRunId: string | null = null;
    if (runToCancelForCancelledStatus) {
      try {
        const cancelled = await heartbeat.cancelRun(runToCancelForCancelledStatus.id);
        if (cancelled) {
          cancelledStatusRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_status_cancelled", issueId: existing.id },
          });
        }
      } catch (err) {
        logger.warn({ err, issueId: existing.id, runId: runToCancelForCancelledStatus.id }, "failed to cancel run for cancelled issue");
        await logActivity(db, {
          companyId: existing.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "heartbeat.cancel_failed",
          entityType: "heartbeat_run",
          entityId: runToCancelForCancelledStatus.id,
          details: { source: "issue_status_cancelled", issueId: existing.id },
        });
      }
    }

    if (titleOrDescriptionChanged) {
      await issueReferencesSvc.syncIssue(issue.id);
    }
    const updateReferenceSummaryAfter = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(issue.id)
      : null;
    const updateReferenceDiff = updateReferenceSummaryBefore && updateReferenceSummaryAfter
      ? issueReferencesSvc.diffIssueReferenceSummary(updateReferenceSummaryBefore, updateReferenceSummaryAfter)
      : null;
    let issueResponse: typeof issue & {
      blockedBy?: unknown;
      blocks?: unknown;
      relatedWork?: Awaited<ReturnType<typeof issueReferencesSvc.listIssueReferenceSummary>>;
      referencedIssueIdentifiers?: string[];
    } = issue;
    let updatedRelations: Awaited<ReturnType<typeof svc.getRelationSummaries>> | null = null;
    if (issue && Array.isArray(body.blockedByIssueIds)) {
      updatedRelations = await svc.getRelationSummaries(issue.id);
      issueResponse = {
        ...issue,
        blockedBy: updatedRelations.blockedBy,
        blocks: updatedRelations.blocks,
      };
    }
    await routinesSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    // Build activity details with previous values for changed fields
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(updateFields)) {
      if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
        previous[key] = (existing as Record<string, unknown>)[key];
      }
    }
    if (Array.isArray(body.blockedByIssueIds)) {
      previous.blockedByIssueIds = existingRelations?.blockedBy.map((relation) => relation.id) ?? [];
    }

    const hasFieldChanges = Object.keys(previous).length > 0;
    const reopened =
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
      previous.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        ...updateFields,
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...(cancelledStatusRunId ? { cancelledStatusRunId } : {}),
        _previous: hasFieldChanges ? previous : undefined,
        ...summarizeIssueReferenceActivityDetails(
          updateReferenceDiff
            ? {
                addedReferencedIssues: updateReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
                removedReferencedIssues: updateReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
                currentReferencedIssues: updateReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
              }
            : null,
        ),
      },
    });

    if (Array.isArray(body.blockedByIssueIds)) {
      const previousBlockedByIds = new Set((existingRelations?.blockedBy ?? []).map((relation) => relation.id));
      const nextBlockedByIds = new Set(body.blockedByIssueIds as string[]);
      const addedBlockedByIssueIds = [...nextBlockedByIds].filter((candidate) => !previousBlockedByIds.has(candidate));
      const removedBlockedByIssueIds = [...previousBlockedByIds].filter((candidate) => !nextBlockedByIds.has(candidate));
      const nextBlockedByRelations = updatedRelations?.blockedBy ?? [];
      const previousBlockedByRelations = existingRelations?.blockedBy ?? [];
      if (addedBlockedByIssueIds.length > 0 || removedBlockedByIssueIds.length > 0) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.blockers_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            blockedByIssueIds: body.blockedByIssueIds,
            addedBlockedByIssueIds,
            removedBlockedByIssueIds,
            blockedByIssues: nextBlockedByRelations.map(summarizeIssueRelationForActivity),
            addedBlockedByIssues: nextBlockedByRelations
              .filter((relation) => addedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
            removedBlockedByIssues: previousBlockedByRelations
              .filter((relation) => removedBlockedByIssueIds.includes(relation.id))
              .map(summarizeIssueRelationForActivity),
          },
        });
      }
    }

    const reviewerChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "review");
    if (reviewerChanges.addedParticipants.length > 0 || reviewerChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.reviewers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: reviewerChanges.participants,
          addedParticipants: reviewerChanges.addedParticipants,
          removedParticipants: reviewerChanges.removedParticipants,
        },
      });
    }

    const approverChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "approval");
    if (approverChanges.addedParticipants.length > 0 || approverChanges.removedParticipants.length > 0) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.approvers_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          participants: approverChanges.participants,
          addedParticipants: approverChanges.addedParticipants,
          removedParticipants: approverChanges.removedParticipants,
        },
      });
    }

    if (issue.status === "done" && existing.status !== "done") {
      const tc = getTelemetryClient();
      if (tc && actor.agentId) {
        const actorAgent = await agentsSvc.getById(actor.agentId);
        if (actorAgent) {
          const model = typeof actorAgent.adapterConfig?.model === "string" ? actorAgent.adapterConfig.model : undefined;
          trackAgentTaskCompleted(tc, {
            agentRole: actorAgent.role,
            agentId: actorAgent.id,
            adapterType: actorAgent.adapterType,
            model,
          });
        }
      }
    }

    let comment = null;
    if (commentBody) {
      const commentReferenceSummaryBefore = updateReferenceSummaryAfter
        ?? await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      comment = await svc.addComment(id, commentBody as string, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      });
      await issueReferencesSvc.syncComment(comment.id);
      const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
        commentReferenceSummaryBefore,
        commentReferenceSummaryAfter,
      );
      issueResponse = {
        ...issueResponse,
        relatedWork: commentReferenceSummaryAfter,
        referencedIssueIdentifiers: commentReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
        issue,
        comment,
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.comment",
      });

    } else if (updateReferenceSummaryAfter) {
      issueResponse = {
        ...issueResponse,
        relatedWork: updateReferenceSummaryAfter,
        referencedIssueIdentifiers: updateReferenceSummaryAfter.outbound.map(
          (item) => item.issue.identifier ?? item.issue.id,
        ),
      };
    }

    const assigneeChanged =
      issue.assigneeAgentId !== existing.assigneeAgentId || issue.assigneeUserId !== existing.assigneeUserId;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      body.status !== undefined;
    const statusChangedFromBlockedToTodo =
      existing.status === "blocked" &&
      issue.status === "todo" &&
      (body.status !== undefined || reopened);
    const statusChangedFromClosedToTodo =
      isClosedIssueStatus(existing.status) &&
      issue.status === "todo" &&
      body.status !== undefined;
    const previousExecutionState = parseIssueExecutionState(existing.executionState);
    const nextExecutionState = parseIssueExecutionState(issue.executionState);
    const executionStageWakeup = buildExecutionStageWakeup({
      issueId: issue.id,
      previousState: previousExecutionState,
      nextState: nextExecutionState,
      interruptedRunId,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : issue.id;
        wakeups.set(`${agentId}:${wakeIssueId}`, { agentId, wakeup });
      };

      if (executionStageWakeup) {
        addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup);
      } else if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        addWakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            ...(comment ? { commentId: comment.id } : {}),
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            ...(comment
              ? {
                  taskId: issue.id,
                  commentId: comment.id,
                  wakeCommentId: comment.id,
                }
              : {}),
            source: "issue.update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (
        !assigneeChanged &&
        (statusChangedFromBacklog || statusChangedFromBlockedToTodo || statusChangedFromClosedToTodo) &&
        issue.assigneeAgentId
      ) {
        addWakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        const assigneeId = issue.assigneeAgentId;
        const actorIsAgent = actor.actorType === "agent";
        const selfComment = actorIsAgent && actor.actorId === assigneeId;
        const skipAssigneeCommentWake = selfComment || isClosed;

        if (assigneeId && !assigneeChanged && (reopened || !skipAssigneeCommentWake)) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: reopened ? "issue_reopened_via_comment" : "issue_commented",
            payload: {
              issueId: id,
              commentId: comment.id,
              mutation: "comment",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: reopened ? "issue.comment.reopen" : "issue.comment",
              wakeReason: reopened ? "issue_reopened_via_comment" : "issue_commented",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }

        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody as string);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      const becameDone = existing.status !== "done" && issue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(issue.id);
        for (const dependent of dependents) {
          addWakeup(dependent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_blockers_resolved",
            payload: {
              issueId: dependent.id,
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: dependent.id,
              taskId: dependent.id,
              wakeReason: "issue_blockers_resolved",
              source: "issue.blockers_resolved",
              resolvedBlockerIssueId: issue.id,
              blockerIssueIds: dependent.blockerIssueIds,
            },
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
      if (becameTerminal && issue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(issue.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_children_completed",
            payload: {
              issueId: parent.id,
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              wakeReason: "issue_children_completed",
              source: "issue.children_completed",
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    return Response.json({ ...issueResponse, comment });
  };

  router.patch("/issues/:id", validate(updateIssueRouteSchema), expressHandler(updateIssue, deps));

  const deleteIssue: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    await assertAgentIssueMutationAllowed(ctx, existing);
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    return Response.json(issue);
  };

  const checkoutIssue: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        return Response.json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        }, { status: 409 });
      }
    }

    const body = await ctx.json<Record<string, unknown>>();
    if (ctx.actor?.type === "agent" && ctx.actor.agentId !== body.agentId) {
      return Response.json({ error: "Agent can only checkout as itself" }, { status: 403 });
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      return closedIssueExecutionWorkspaceResponse(closedExecutionWorkspace);
    }

    const checkoutRunId = requireAgentRunId(ctx);
    const updated = await svc.checkout(issue.id, body.agentId as string, body.expectedStatuses as string[] | undefined, checkoutRunId);
    const actor = getActorInfo(ctx);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: ctx.actor?.type ?? "board",
        actorAgentId: ctx.actor?.type === "agent" ? ctx.actor.agentId ?? null : null,
        checkoutAgentId: body.agentId as string,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(body.agentId as string, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    return Response.json(updated);
  };

  const releaseIssue: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    await assertAgentIssueMutationAllowed(ctx, existing);
    const actorRunId = requireAgentRunId(ctx);

    const released = await svc.release(
      existing.id,
      ctx.actor?.type === "agent" ? ctx.actor.agentId ?? undefined : undefined,
      actorRunId,
    );
    if (!released) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    return Response.json(released);
  };

  const adminForceRelease: Handler = async (ctx) => {
    if (ctx.actor?.type !== "board") {
      return Response.json({ error: "Board access required" }, { status: 403 });
    }
    if (!ctx.actor.userId) {
      throw forbidden("Board user context required");
    }

    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);

    const clearAssignee = ctx.query("clearAssignee") === "true";
    const result = await svc.adminForceRelease(existing.id, { clearAssignee });
    if (!result) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: result.issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.admin_force_release",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        issueId: result.issue.id,
        actorUserId: ctx.actor.userId,
        prevCheckoutRunId: result.previous.checkoutRunId,
        prevExecutionRunId: result.previous.executionRunId,
        clearAssignee,
      },
    });

    return Response.json(result);
  };

  router.delete("/issues/:id", expressHandler(deleteIssue, deps));
  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), expressHandler(checkoutIssue, deps));
  router.post("/issues/:id/release", expressHandler(releaseIssue, deps));
  router.post("/issues/:id/admin/force-release", expressHandler(adminForceRelease, deps));

  const listIssueComments: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const afterRaw = ctx.query("after");
    const afterCommentIdRaw = ctx.query("afterCommentId");
    const afterCommentId =
      typeof afterRaw === "string" && afterRaw.trim().length > 0
        ? afterRaw.trim()
        : typeof afterCommentIdRaw === "string" && afterCommentIdRaw.trim().length > 0
          ? afterCommentIdRaw.trim()
          : null;
    const orderRaw = ctx.query("order");
    const order =
      typeof orderRaw === "string" && orderRaw.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRawStr = ctx.query("limit");
    const limitRaw =
      typeof limitRawStr === "string" && limitRawStr.trim().length > 0
        ? Number(limitRawStr)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(issue.id, {
      afterCommentId,
      order,
      limit,
    });
    return Response.json(comments);
  };

  const listIssueInteractions: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const interactions = await issueThreadInteractionService(db).listForIssue(issue.id);
    return Response.json(interactions);
  };

  const createInteraction: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const body = await ctx.json<Record<string, unknown>>();
    if (ctx.actor?.type === "agent") {
      await assertAgentIssueMutationAllowed(ctx, issue);
    } else {
      assertBoard(ctx);
    }

    const actor = getActorInfo(ctx);
    const agentSourceRunId = ctx.actor?.type === "agent" ? requireAgentRunId(ctx) : null;

    const interaction = await issueThreadInteractionService(db).create(issue, {
      ...body,
      sourceRunId: ctx.actor?.type === "agent" ? agentSourceRunId : body.sourceRunId ?? null,
    }, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
      },
    });

    return Response.json(interaction, { status: 201 });
  };

  const acceptInteraction: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const interactionId = ctx.param("interactionId")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    assertBoard(ctx);

    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const { interaction, createdIssues, continuationIssue } = await issueThreadInteractionService(db).acceptInteraction(issue, interactionId, body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    const continuationWakeIssue = continuationIssue ?? issue;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: interaction.status === "expired"
        ? "issue.thread_interaction_expired"
        : "issue.thread_interaction_accepted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        createdTaskCount:
          interaction.kind === "suggest_tasks"
            ? (interaction.result?.createdTasks?.length ?? 0)
            : 0,
        skippedTaskCount:
          interaction.kind === "suggest_tasks"
            ? (interaction.result?.skippedClientKeys?.length ?? 0)
            : 0,
      },
    });

    if (continuationIssue) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier: issue.identifier,
          status: continuationIssue.status,
          assigneeAgentId: continuationIssue.assigneeAgentId ?? null,
          assigneeUserId: continuationIssue.assigneeUserId ?? null,
          source: "request_confirmation_accept",
          interactionId: interaction.id,
          _previous: {
            status: issue.status,
            assigneeAgentId: issue.assigneeAgentId ?? null,
            assigneeUserId: issue.assigneeUserId ?? null,
          },
        },
      });
    }

    for (const createdIssue of createdIssues) {
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue: createdIssue,
        reason: "issue_assigned",
        mutation: "interaction_accept",
        contextSource: "issue.interaction.accept",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }

    queueResolvedInteractionContinuationWakeup({
      heartbeat,
      issue: continuationWakeIssue,
      interaction,
      actor,
      source: "issue.interaction.accept",
    });

    return Response.json(interaction);
  };

  const rejectInteraction: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const interactionId = ctx.param("interactionId")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    assertBoard(ctx);

    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const interaction = await issueThreadInteractionService(db).rejectInteraction(issue, interactionId, body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: interaction.status === "expired"
        ? "issue.thread_interaction_expired"
        : "issue.thread_interaction_rejected",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        rejectionReason:
          interaction.kind === "suggest_tasks"
            ? (interaction.result?.rejectionReason ?? null)
            : interaction.kind === "request_confirmation"
              ? (interaction.result?.reason ?? null)
            : null,
      },
    });

    queueResolvedInteractionContinuationWakeup({
      heartbeat,
      issue,
      interaction,
      actor,
      source: "issue.interaction.reject",
    });

    return Response.json(interaction);
  };

  const respondInteraction: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const interactionId = ctx.param("interactionId")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    assertBoard(ctx);

    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const interaction = await issueThreadInteractionService(db).answerQuestions(issue, interactionId, body, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.thread_interaction_answered",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        answeredQuestionCount:
          interaction.kind === "ask_user_questions"
            ? (interaction.result?.answers?.length ?? 0)
            : 0,
      },
    });

    queueResolvedInteractionContinuationWakeup({
      heartbeat,
      issue,
      interaction,
      actor,
      source: "issue.interaction.respond",
    });

    return Response.json(interaction);
  };

  router.get("/issues/:id/comments", expressHandler(listIssueComments, deps));
  router.get("/issues/:id/interactions", expressHandler(listIssueInteractions, deps));
  router.post("/issues/:id/interactions", validate(createIssueThreadInteractionSchema), expressHandler(createInteraction, deps));
  router.post("/issues/:id/interactions/:interactionId/accept", validate(acceptIssueThreadInteractionSchema), expressHandler(acceptInteraction, deps));
  router.post("/issues/:id/interactions/:interactionId/reject", validate(rejectIssueThreadInteractionSchema), expressHandler(rejectInteraction, deps));
  router.post("/issues/:id/interactions/:interactionId/respond", validate(respondIssueThreadInteractionSchema), expressHandler(respondInteraction, deps));

  const getIssueComment: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const commentId = ctx.param("commentId")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      return Response.json({ error: "Comment not found" }, { status: 404 });
    }
    return Response.json(comment);
  };

  const deleteIssueComment: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const commentId = ctx.param("commentId")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    await assertAgentIssueMutationAllowed(ctx, issue);

    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      return Response.json({ error: "Comment not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    const actorOwnsComment =
      actor.actorType === "agent"
        ? comment.authorAgentId === actor.agentId
        : comment.authorUserId === actor.actorId;
    if (!actorOwnsComment) {
      return Response.json({ error: "Only the comment author can cancel queued comments" }, { status: 403 });
    }

    const activeRun = await resolveActiveIssueRun(issue);
    if (!activeRun) {
      return Response.json({ error: "Queued comment can no longer be canceled" }, { status: 409 });
    }

    if (!isQueuedIssueCommentForActiveRun({ comment, activeRun })) {
      return Response.json({ error: "Only queued comments can be canceled" }, { status: 409 });
    }

    const removed = await svc.removeComment(commentId);
    if (!removed) {
      return Response.json({ error: "Comment not found" }, { status: 404 });
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_cancelled",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: removed.id,
        bodySnippet: removed.body.slice(0, 120),
        identifier: issue.identifier,
        issueTitle: issue.title,
        source: "queue_cancel",
        queueTargetRunId: activeRun.id,
      },
    });

    return Response.json(removed);
  };

  const getFeedbackVotes: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") {
      return Response.json({ error: "Only board users can view feedback votes" }, { status: 403 });
    }

    const votes = await feedback.listIssueVotesForUser(issue.id, ctx.actor.userId ?? "local-board");
    return Response.json(votes);
  };

  const getFeedbackTraces: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") {
      return Response.json({ error: "Only board users can view feedback traces" }, { status: 403 });
    }

    const targetTypeRaw = ctx.query("targetType");
    const voteRaw = ctx.query("vote");
    const statusRaw = ctx.query("status");
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(ctx.query("from"), "from"),
      to: parseDateQuery(ctx.query("to"), "to"),
      sharedOnly: parseBooleanQuery(ctx.query("sharedOnly")),
      includePayload: parseBooleanQuery(ctx.query("includePayload")),
    });
    return Response.json(traces);
  };

  const getFeedbackTrace: Handler = async (ctx) => {
    const traceId = ctx.param("traceId")!;
    if (ctx.actor?.type !== "board") {
      return Response.json({ error: "Only board users can view feedback traces" }, { status: 403 });
    }
    const includePayloadRaw = ctx.query("includePayload");
    const includePayload = parseBooleanQuery(includePayloadRaw) || includePayloadRaw === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(ctx, trace.companyId)) {
      return Response.json({ error: "Feedback trace not found" }, { status: 404 });
    }
    return Response.json(trace);
  };

  const getFeedbackTraceBundle: Handler = async (ctx) => {
    const traceId = ctx.param("traceId")!;
    if (ctx.actor?.type !== "board") {
      return Response.json({ error: "Only board users can view feedback trace bundles" }, { status: 403 });
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(ctx, bundle.companyId)) {
      return Response.json({ error: "Feedback trace not found" }, { status: 404 });
    }
    return Response.json(bundle);
  };

  const addIssueComment: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    await assertAgentIssueMutationAllowed(ctx, issue);
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      return closedIssueExecutionWorkspaceResponse(closedExecutionWorkspace);
    }

    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const reopenRequested = body.reopen === true;
    const resumeRequested = body.resume === true;
    const interruptRequested = body.interrupt === true;
    if (resumeRequested === true) {
      await assertExplicitResumeIntentAllowed(ctx, issue);
    }
    if (resumeRequested !== true && reopenRequested === true && ctx.actor?.type === "agent") {
      await assertExplicitResumeIntentAllowed(ctx, issue);
    }
    const isClosed = isClosedIssueStatus(issue.status);
    const isBlocked = issue.status === "blocked";
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const effectiveMoveToTodoRequested =
      explicitMoveToTodoRequested ||
      shouldImplicitlyMoveCommentedIssueToTodo({
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(issue.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      return Response.json({ error: "Issue follow-up blocked by unresolved blockers" }, { status: 409 });
    }
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;
    const commentReferenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);

    if (effectiveMoveToTodoRequested && (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers))) {
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        return Response.json({ error: "Issue not found" }, { status: 404 });
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (ctx.actor?.type !== "board") {
        return Response.json({ error: "Only board users can interrupt active runs from issue comments" }, { status: 403 });
      }

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, body.body as string, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
      runId: actor.runId,
    });
    await issueReferencesSvc.syncComment(comment.id);
    const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(currentIssue.id);
    const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      commentReferenceSummaryBefore,
      commentReferenceSummaryAfter,
    );

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
      currentIssue,
      comment,
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      issue: currentIssue,
      interactions: expiredInteractions,
      actor,
      source: "issue.comment",
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipWake = selfComment || isClosed;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(issue.companyId, body.body as string);
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        wakeups.set(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    return Response.json(comment, { status: 201 });
  };

  const saveFeedbackVote: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const issue = await svc.getById(id);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    if (ctx.actor?.type !== "board") {
      return Response.json({ error: "Only board users can vote on AI feedback" }, { status: 403 });
    }

    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const result = await feedback.saveIssueVote({
      issueId: issue.id,
      targetType: body.targetType as string,
      targetId: body.targetId as string,
      vote: body.vote as string,
      reason: body.reason as string | undefined,
      authorUserId: ctx.actor.userId ?? "local-board",
      allowSharing: body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    return Response.json(result.vote, { status: 201 });
  };

  const listAttachments: Handler = async (ctx) => {
    const issueId = ctx.param("id")!;
    const issue = await svc.getById(issueId);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, issue.companyId);
    const attachments = await svc.listAttachments(issue.id);
    return Response.json(attachments.map(withContentPath));
  };

  router.get("/issues/:id/comments/:commentId", expressHandler(getIssueComment, deps));
  router.delete("/issues/:id/comments/:commentId", expressHandler(deleteIssueComment, deps));
  router.get("/issues/:id/feedback-votes", expressHandler(getFeedbackVotes, deps));
  router.get("/issues/:id/feedback-traces", expressHandler(getFeedbackTraces, deps));
  router.get("/feedback-traces/:traceId", expressHandler(getFeedbackTrace, deps));
  router.get("/feedback-traces/:traceId/bundle", expressHandler(getFeedbackTraceBundle, deps));
  router.post("/issues/:id/comments", validate(addIssueCommentSchema), expressHandler(addIssueComment, deps));
  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), expressHandler(saveFeedbackVote, deps));
  router.get("/issues/:id/attachments", expressHandler(listAttachments, deps));

  // TODO(cloudflare): use R2 multipart upload — kept as Express handler because it uses multer
  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    // assertAgentIssueMutationAllowed takes RequestCtx (throw-based); bridge from Express req
    await assertAgentIssueMutationAllowed({ actor: req.actor ?? null } as unknown as RequestCtx, issue);

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);

    try {
      await runSingleFileUpload(req, res, attachmentMaxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${attachmentMaxBytes} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeContentType(file.mimetype);
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  // TODO(cloudflare): stream via R2 Response — kept as Express handler because it pipes a stream to res
  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const responseContentType = normalizeContentType(attachment.contentType || object.contentType);
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  const deleteAttachment: Handler = async (ctx) => {
    const attachmentId = ctx.param("attachmentId")!;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      return Response.json({ error: "Attachment not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, attachment.companyId);
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      return Response.json({ error: "Issue not found" }, { status: 404 });
    }
    await assertAgentIssueMutationAllowed(ctx, issue);

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      return Response.json({ error: "Attachment not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    return Response.json({ ok: true });
  };

  router.delete("/attachments/:attachmentId", expressHandler(deleteAttachment, deps));

  return router;
}
