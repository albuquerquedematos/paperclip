import { and, eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issues, projects, projectWorkspaces } from "@paperclipai/db";
import {
  findWorkspaceCommandDefinition,
  matchWorkspaceRuntimeServiceToCommand,
  updateExecutionWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
} from "@paperclipai/shared";
import type { WorkspaceRuntimeDesiredState, WorkspaceRuntimeServiceStateMap } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { executionWorkspaceService, logActivity, workspaceOperationService } from "../services/index.js";
import { mergeExecutionWorkspaceConfig, readExecutionWorkspaceConfig } from "../services/execution-workspaces.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import { readProjectWorkspaceRuntimeConfig } from "../services/project-workspace-runtime-config.js";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  listConfiguredRuntimeServiceEntries,
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectExecutionWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertCanManageExecutionWorkspaceRuntimeServices } from "./workspace-runtime-service-authz.js";
import { appendWithCap } from "../adapters/utils.js";
import { forbidden } from "../errors.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler, RequestCtx } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

const WORKSPACE_CONTROL_OUTPUT_MAX_CHARS = 256 * 1024;

export function executionWorkspaceRoutes(db: Db) {
  const router = Router();
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);

  // Storage is not needed by any execution workspace handler.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`execution-workspace handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  // Helper to derive actor info from RequestCtx
  function ctxActorInfo(ctx: RequestCtx) {
    const actor = ctx.actor;
    if (!actor) throw forbidden("Authentication required");
    if (actor.type === "agent") {
      return {
        actorType: "agent" as const,
        actorId: actor.agentId ?? "unknown-agent",
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
      };
    }
    return {
      actorType: "user" as const,
      actorId: actor.userId ?? "board",
      agentId: null as string | null,
      runId: actor.runId ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const listExecutionWorkspaces: Handler = async (ctx) => {
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    if (!ctx.actor) throw forbidden("Authentication required");
    const filters = {
      projectId: ctx.query("projectId"),
      projectWorkspaceId: ctx.query("projectWorkspaceId"),
      issueId: ctx.query("issueId"),
      status: ctx.query("status"),
      reuseEligible: ctx.query("reuseEligible") === "true",
    };
    const workspaces = ctx.query("summary") === "true"
      ? await svc.listSummaries(companyId, filters)
      : await svc.list(companyId, filters);
    return Response.json(workspaces);
  };

  const getExecutionWorkspace: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const workspace = await svc.getById(id);
    if (!workspace) {
      return Response.json({ error: "Execution workspace not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");
    return Response.json(workspace);
  };

  const getExecutionWorkspaceCloseReadiness: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const workspace = await svc.getById(id);
    if (!workspace) {
      return Response.json({ error: "Execution workspace not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");
    const readiness = await svc.getCloseReadiness(id);
    if (!readiness) {
      return Response.json({ error: "Execution workspace not found" }, { status: 404 });
    }
    return Response.json(readiness);
  };

  const listWorkspaceOperations: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const workspace = await svc.getById(id);
    if (!workspace) {
      return Response.json({ error: "Execution workspace not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");
    const operations = await workspaceOperationsSvc.listForExecutionWorkspace(id);
    return Response.json(operations);
  };

  const handleRuntimeCommand: Handler = async (ctx) => {
    const id = ctx.param("id");
    const action = String(ctx.param("action") ?? "").trim().toLowerCase();
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "run") {
      return Response.json({ error: "Workspace command action not found" }, { status: 404 });
    }

    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Execution workspace not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");

    // assertCanManageExecutionWorkspaceRuntimeServices takes an Express Request
    // and performs DB queries; it is called in the Express middleware layer
    // before this Handler runs (see route wiring below).

    const workspaceCwd = existing.cwd;
    if (!workspaceCwd) {
      return Response.json({ error: "Execution workspace needs a local path before Paperclip can run workspace commands" }, { status: 422 });
    }

    const projectWorkspace = existing.projectWorkspaceId
      ? await db
          .select({
            id: projectWorkspaces.id,
            cwd: projectWorkspaces.cwd,
            repoUrl: projectWorkspaces.repoUrl,
            repoRef: projectWorkspaces.repoRef,
            defaultRef: projectWorkspaces.defaultRef,
            metadata: projectWorkspaces.metadata,
          })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, existing.projectWorkspaceId),
              eq(projectWorkspaces.companyId, existing.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const projectWorkspaceRuntime = readProjectWorkspaceRuntimeConfig(
      (projectWorkspace?.metadata as Record<string, unknown> | null) ?? null,
    )?.workspaceRuntime ?? null;
    const projectPolicy = existing.projectId
      ? await db
          .select({
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, existing.projectId),
              eq(projects.companyId, existing.companyId),
            ),
          )
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;
    const effectiveRuntimeConfig = existing.config?.workspaceRuntime ?? projectWorkspaceRuntime ?? null;
    const body = await ctx.json<{ workspaceCommandId?: string | null; runtimeServiceId?: string | null; serviceIndex?: number | null }>();
    const target = body;
    const configuredServices = effectiveRuntimeConfig
      ? listConfiguredRuntimeServiceEntries({ workspaceRuntime: effectiveRuntimeConfig })
      : [];
    const workspaceCommand = effectiveRuntimeConfig
      ? findWorkspaceCommandDefinition(effectiveRuntimeConfig, target.workspaceCommandId ?? null)
      : null;
    if (target.workspaceCommandId && !workspaceCommand) {
      return Response.json({ error: "Workspace command not found for this execution workspace" }, { status: 404 });
    }
    if (target.runtimeServiceId && !(existing.runtimeServices ?? []).some((service) => service.id === target.runtimeServiceId)) {
      return Response.json({ error: "Runtime service not found for this execution workspace" }, { status: 404 });
    }
    const matchedRuntimeService =
      workspaceCommand?.kind === "service" && !target.runtimeServiceId
        ? matchWorkspaceRuntimeServiceToCommand(workspaceCommand, existing.runtimeServices ?? [])
        : null;
    const selectedRuntimeServiceId = target.runtimeServiceId ?? matchedRuntimeService?.id ?? null;
    const selectedServiceIndex =
      workspaceCommand?.kind === "service"
        ? workspaceCommand.serviceIndex
        : target.serviceIndex ?? null;
    if (
      selectedServiceIndex !== undefined
      && selectedServiceIndex !== null
      && (selectedServiceIndex < 0 || selectedServiceIndex >= configuredServices.length)
    ) {
      return Response.json({ error: "Selected runtime service is not defined in this execution workspace runtime config" }, { status: 422 });
    }
    if (workspaceCommand?.kind === "job" && action !== "run") {
      return Response.json({ error: `Workspace job "${workspaceCommand.name}" can only be run` }, { status: 422 });
    }
    if (workspaceCommand?.kind === "service" && action === "run") {
      return Response.json({ error: `Workspace service "${workspaceCommand.name}" should be started or restarted, not run` }, { status: 422 });
    }
    if (action === "run" && !workspaceCommand) {
      return Response.json({ error: "Select a workspace job to run" }, { status: 422 });
    }

    if ((action === "start" || action === "restart") && !effectiveRuntimeConfig) {
      return Response.json({ error: "Execution workspace has no workspace command configuration or inherited project workspace default" }, { status: 422 });
    }

    const actor = ctxActorInfo(ctx);
    const recorder = workspaceOperationsSvc.createRecorder({
      companyId: existing.companyId,
      executionWorkspaceId: existing.id,
    });
    let runtimeServiceCount = existing.runtimeServices?.length ?? 0;
    let stdout = "";
    let stderr = "";

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: workspaceCommand?.command ?? `workspace command ${action}`,
      cwd: existing.cwd,
      metadata: {
        action,
        executionWorkspaceId: existing.id,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
      run: async () => {
        const ensureWorkspaceAvailable = async () =>
          await ensurePersistedExecutionWorkspaceAvailable({
            base: {
              baseCwd: projectWorkspace?.cwd ?? workspaceCwd,
              source: existing.mode === "shared_workspace" ? "project_primary" : "task_session",
              projectId: existing.projectId,
              workspaceId: existing.projectWorkspaceId,
              repoUrl: existing.repoUrl,
              repoRef: existing.baseRef,
            },
            workspace: {
              mode: existing.mode,
              strategyType: existing.strategyType,
              cwd: existing.cwd,
              providerRef: existing.providerRef,
              projectId: existing.projectId,
              projectWorkspaceId: existing.projectWorkspaceId,
              repoUrl: existing.repoUrl,
              baseRef: existing.baseRef,
              branchName: existing.branchName,
              config: {
                ...existing.config,
                provisionCommand:
                  existing.config?.provisionCommand
                  ?? projectPolicy?.workspaceStrategy?.provisionCommand
                  ?? null,
              },
            },
            issue: existing.sourceIssueId
              ? {
                  id: existing.sourceIssueId,
                  identifier: null,
                  title: existing.name,
                }
              : null,
            agent: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: existing.companyId,
            },
            recorder,
          });

        if (action === "run") {
          if (!workspaceCommand || workspaceCommand.kind !== "job") {
            throw new Error("Workspace job selection is required");
          }
          const availableWorkspace = await ensureWorkspaceAvailable();
          if (!availableWorkspace) {
            throw new Error("Execution workspace needs a local path before Paperclip can run workspace commands");
          }
          return await runWorkspaceJobForControl({
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: existing.companyId,
            },
            issue: existing.sourceIssueId
              ? {
                  id: existing.sourceIssueId,
                  identifier: null,
                  title: existing.name,
                }
              : null,
            workspace: availableWorkspace,
            command: workspaceCommand.rawConfig,
            adapterEnv: {},
            recorder,
            metadata: {
              action,
              executionWorkspaceId: existing.id,
              workspaceCommandId: workspaceCommand.id,
            },
          }).then((nestedOperation) => ({
            status: "succeeded" as const,
            exitCode: 0,
            metadata: {
              nestedOperationId: nestedOperation?.id ?? null,
              runtimeServiceCount,
            },
          }));
        }

        const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout = appendWithCap(stdout, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
          else stderr = appendWithCap(stderr, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
        };

        if (action === "stop" || action === "restart") {
          await stopRuntimeServicesForExecutionWorkspace({
            db,
            executionWorkspaceId: existing.id,
            workspaceCwd,
            runtimeServiceId: selectedRuntimeServiceId,
          });
        }

        if (action === "start" || action === "restart") {
          const availableWorkspace = await ensureWorkspaceAvailable();
          if (!availableWorkspace) {
            throw new Error("Execution workspace needs a local path before Paperclip can manage local runtime services");
          }
          const startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: existing.companyId,
            },
            issue: existing.sourceIssueId
              ? {
                  id: existing.sourceIssueId,
                  identifier: null,
                  title: existing.name,
                }
              : null,
            workspace: availableWorkspace,
            executionWorkspaceId: existing.id,
            config: { workspaceRuntime: effectiveRuntimeConfig },
            adapterEnv: {},
            onLog,
            serviceIndex: selectedServiceIndex,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = selectedRuntimeServiceId ? Math.max(0, (existing.runtimeServices?.length ?? 1) - 1) : 0;
        }

        const currentDesiredState: WorkspaceRuntimeDesiredState =
          existing.config?.desiredState
          ?? ((existing.runtimeServices ?? []).some((service) => service.status === "starting" || service.status === "running")
            ? "running"
            : "stopped");
        const nextRuntimeState: {
          desiredState: WorkspaceRuntimeDesiredState;
          serviceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
        } = selectedRuntimeServiceId && (selectedServiceIndex === undefined || selectedServiceIndex === null)
          ? {
              desiredState: currentDesiredState,
              serviceStates: existing.config?.serviceStates ?? null,
            }
          : buildWorkspaceRuntimeDesiredStatePatch({
              config: { workspaceRuntime: effectiveRuntimeConfig },
              currentDesiredState,
              currentServiceStates: existing.config?.serviceStates ?? null,
              action,
              serviceIndex: selectedServiceIndex,
            });
        const metadata = mergeExecutionWorkspaceConfig(existing.metadata as Record<string, unknown> | null, {
          desiredState: nextRuntimeState.desiredState,
          serviceStates: nextRuntimeState.serviceStates,
        });
        await svc.update(existing.id, { metadata });

        return {
          status: "succeeded",
          stdout,
          stderr,
          system:
            action === "stop"
              ? "Stopped execution workspace runtime services.\n"
              : action === "restart"
                ? "Restarted execution workspace runtime services.\n"
                : "Started execution workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
            workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
            runtimeServiceId: selectedRuntimeServiceId,
            serviceIndex: selectedServiceIndex,
          },
        };
      },
    });

    const workspace = await svc.getById(id);
    if (!workspace) {
      return Response.json({ error: "Execution workspace not found" }, { status: 404 });
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `execution_workspace.runtime_${action}`,
      entityType: "execution_workspace",
      entityId: existing.id,
      details: {
        runtimeServiceCount,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
    });

    return Response.json({
      workspace,
      operation,
    });
  };

  const updateExecutionWorkspace: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Execution workspace not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");
    const body = await ctx.json<Record<string, unknown>>();

    if (ctx.actor.type === "agent") {
      const paths = collectExecutionWorkspaceCommandPaths({
        config: body.config,
        metadata: body.metadata,
      });
      if (paths.length > 0) {
        throw forbidden("Agents cannot mutate workspace command configuration");
      }
    }

    const patch: Record<string, unknown> = {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
      ...(body.repoUrl === undefined ? {} : { repoUrl: body.repoUrl }),
      ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
      ...(body.branchName === undefined ? {} : { branchName: body.branchName }),
      ...(body.providerRef === undefined ? {} : { providerRef: body.providerRef }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.cleanupReason === undefined ? {} : { cleanupReason: body.cleanupReason }),
      ...(body.cleanupEligibleAt !== undefined
        ? { cleanupEligibleAt: body.cleanupEligibleAt ? new Date(body.cleanupEligibleAt as string) : null }
        : {}),
    };
    if (body.metadata !== undefined || body.config !== undefined) {
      const requestedMetadata = body.metadata === undefined
        ? (existing.metadata as Record<string, unknown> | null)
        : (body.metadata as Record<string, unknown> | null);
      patch.metadata = body.config === undefined
        ? requestedMetadata
        : mergeExecutionWorkspaceConfig(requestedMetadata, body.config ?? null);
    }
    let workspace = existing;
    let cleanupWarnings: string[] = [];
    const configForCleanup = readExecutionWorkspaceConfig(
      ((patch.metadata as Record<string, unknown> | null | undefined) ?? (existing.metadata as Record<string, unknown> | null)) ?? null,
    );

    if (body.status === "archived" && existing.status !== "archived") {
      const readiness = await svc.getCloseReadiness(existing.id);
      if (!readiness) {
        return Response.json({ error: "Execution workspace not found" }, { status: 404 });
      }

      if (readiness.state === "blocked") {
        return Response.json({
          error: readiness.blockingReasons[0] ?? "Execution workspace cannot be closed right now",
          closeReadiness: readiness,
        }, { status: 409 });
      }

      const closedAt = new Date();
      const archivedWorkspace = await svc.update(existing.id, {
        ...patch,
        status: "archived",
        closedAt,
        cleanupReason: null,
      });
      if (!archivedWorkspace) {
        return Response.json({ error: "Execution workspace not found" }, { status: 404 });
      }
      workspace = archivedWorkspace;

      if (existing.mode === "shared_workspace") {
        await db
          .update(issues)
          .set({
            executionWorkspaceId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.companyId, existing.companyId),
              eq(issues.executionWorkspaceId, existing.id),
            ),
          );
      }

      try {
        await stopRuntimeServicesForExecutionWorkspace({
          db,
          executionWorkspaceId: existing.id,
          workspaceCwd: existing.cwd,
        });
        const projectWorkspace = existing.projectWorkspaceId
          ? await db
              .select({
                cwd: projectWorkspaces.cwd,
                cleanupCommand: projectWorkspaces.cleanupCommand,
              })
              .from(projectWorkspaces)
              .where(
                and(
                  eq(projectWorkspaces.id, existing.projectWorkspaceId),
                  eq(projectWorkspaces.companyId, existing.companyId),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
        const projectPolicy = existing.projectId
          ? await db
              .select({
                executionWorkspacePolicy: projects.executionWorkspacePolicy,
              })
              .from(projects)
              .where(and(eq(projects.id, existing.projectId), eq(projects.companyId, existing.companyId)))
              .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
          : null;
        const cleanupResult = await cleanupExecutionWorkspaceArtifacts({
          workspace: existing,
          projectWorkspace,
          teardownCommand: configForCleanup?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
          cleanupCommand: configForCleanup?.cleanupCommand ?? null,
          recorder: workspaceOperationsSvc.createRecorder({
            companyId: existing.companyId,
            executionWorkspaceId: existing.id,
          }),
        });
        cleanupWarnings = cleanupResult.warnings;
        const cleanupPatch: Record<string, unknown> = {
          closedAt,
          cleanupReason: cleanupWarnings.length > 0 ? cleanupWarnings.join(" | ") : null,
        };
        if (!cleanupResult.cleaned) {
          cleanupPatch.status = "cleanup_failed";
        }
        if (cleanupResult.warnings.length > 0 || !cleanupResult.cleaned) {
          workspace = (await svc.update(existing.id, cleanupPatch)) ?? workspace;
        }
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        workspace =
          (await svc.update(existing.id, {
            status: "cleanup_failed",
            closedAt,
            cleanupReason: failureReason,
          })) ?? workspace;
        return Response.json({
          error: `Failed to archive execution workspace: ${failureReason}`,
        }, { status: 500 });
      }
    } else {
      const updatedWorkspace = await svc.update(existing.id, patch);
      if (!updatedWorkspace) {
        return Response.json({ error: "Execution workspace not found" }, { status: 404 });
      }
      workspace = updatedWorkspace;
    }
    const actor = ctxActorInfo(ctx);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "execution_workspace.updated",
      entityType: "execution_workspace",
      entityId: workspace.id,
      details: {
        changedKeys: Object.keys(body).sort(),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      },
    });
    return Response.json(workspace);
  };

  // ---------------------------------------------------------------------------
  // Wire handlers via expressHandler
  // ---------------------------------------------------------------------------

  const adapterDeps = { db, storage: storageSentinel };

  router.get("/companies/:companyId/execution-workspaces", expressHandler(listExecutionWorkspaces, adapterDeps));
  router.get("/execution-workspaces/:id", expressHandler(getExecutionWorkspace, adapterDeps));
  router.get("/execution-workspaces/:id/close-readiness", expressHandler(getExecutionWorkspaceCloseReadiness, adapterDeps));
  router.get("/execution-workspaces/:id/workspace-operations", expressHandler(listWorkspaceOperations, adapterDeps));

  // Runtime command handlers keep the validate() middleware in the chain.
  // assertCanManageExecutionWorkspaceRuntimeServices takes an Express Request
  // and performs DB queries; it runs in an Express middleware wrapper before
  // the transport-agnostic Handler.
  router.post(
    "/execution-workspaces/:id/runtime-services/:action",
    validate(workspaceRuntimeControlTargetSchema),
    async (req, _res, next) => {
      try {
        const ws = await svc.getById(req.params.id as string);
        await assertCanManageExecutionWorkspaceRuntimeServices(db, req, {
          companyId: ws?.companyId ?? "",
          executionWorkspaceId: req.params.id as string,
          sourceIssueId: ws?.sourceIssueId ?? null,
        });
        next();
      } catch (err) {
        next(err);
      }
    },
    expressHandler(handleRuntimeCommand, adapterDeps),
  );
  router.post(
    "/execution-workspaces/:id/runtime-commands/:action",
    validate(workspaceRuntimeControlTargetSchema),
    async (req, _res, next) => {
      try {
        const ws = await svc.getById(req.params.id as string);
        await assertCanManageExecutionWorkspaceRuntimeServices(db, req, {
          companyId: ws?.companyId ?? "",
          executionWorkspaceId: req.params.id as string,
          sourceIssueId: ws?.sourceIssueId ?? null,
        });
        next();
      } catch (err) {
        next(err);
      }
    },
    expressHandler(handleRuntimeCommand, adapterDeps),
  );

  router.patch(
    "/execution-workspaces/:id",
    validate(updateExecutionWorkspaceSchema),
    expressHandler(updateExecutionWorkspace, adapterDeps),
  );

  return router;
}
