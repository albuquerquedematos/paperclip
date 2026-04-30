import { Router, type Request, type Response as ExpressResponse, type NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  findWorkspaceCommandDefinition,
  isUuidLike,
  matchWorkspaceRuntimeServiceToCommand,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
} from "@paperclipai/shared";
import type { WorkspaceRuntimeDesiredState, WorkspaceRuntimeServiceStateMap } from "@paperclipai/shared";
import { trackProjectCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { projectService, logActivity, workspaceOperationService } from "../services/index.js";
import { conflict, forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  listConfiguredRuntimeServiceEntries,
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForProjectWorkspace,
} from "../services/workspace-runtime.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertCanManageProjectWorkspaceRuntimeServices } from "./workspace-runtime-service-authz.js";
import { getTelemetryClient } from "../telemetry.js";
import { appendWithCap } from "../adapters/utils.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { environmentService } from "../services/environments.js";
import { secretService } from "../services/secrets.js";
import type { Handler, RequestCtx } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

const WORKSPACE_CONTROL_OUTPUT_MAX_CHARS = 256 * 1024;
const SHARED_WORKSPACE_STOP_AND_RESTART_ACTIONS = new Set(["stop", "restart"]);

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const secretsSvc = secretService(db);
  const workspaceOperations = workspaceOperationService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";
  const environmentsSvc = environmentService(db);

  async function assertProjectEnvironmentSelection(companyId: string, environmentId: string | null | undefined) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentsSvc, companyId, environmentId, {
      allowedDrivers: ["local", "ssh", "sandbox"],
    });
  }

  function readProjectPolicyEnvironmentId(policy: unknown): string | null | undefined {
    if (!policy || typeof policy !== "object" || !("environmentId" in policy)) {
      return undefined;
    }
    const environmentId = (policy as { environmentId?: unknown }).environmentId;
    return typeof environmentId === "string" || environmentId === null ? environmentId : undefined;
  }

  async function resolveCompanyIdForProjectReference(ctx: RequestCtx) {
    const companyIdQuery = ctx.query("companyId");
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(ctx, requestedCompanyId);
      return requestedCompanyId;
    }
    if (ctx.actor?.type === "agent" && ctx.actor.companyId) {
      return ctx.actor.companyId;
    }
    return null;
  }

  async function normalizeProjectReference(ctx: RequestCtx, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const companyId = await resolveCompanyIdForProjectReference(ctx);
    if (!companyId) return rawId;
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    return resolved.project?.id ?? rawId;
  }

  router.param("id", async (req: Request, _res: ExpressResponse, next: NextFunction, rawId: string) => {
    try {
      // Build a minimal RequestCtx-compatible object for Express middleware.
      // req.query is an object in Express; wrap it so helpers can call ctx.query(name).
      const minCtx = {
        actor: req.actor ?? null,
        method: req.method,
        query(name: string) {
          const v = req.query[name];
          return typeof v === "string" ? v : undefined;
        },
      } as unknown as RequestCtx;
      req.params.id = await normalizeProjectReference(minCtx, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Storage is not used by project handlers; supply a sentinel to satisfy AdapterDeps.
  const storageSentinel = new Proxy({} as import("../storage/types.js").StorageService, {
    get(_target, prop) {
      throw new Error(`project handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  const listProjects: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const result = await svc.list(companyId);
    return Response.json(result);
  };

  const getProject: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const project = await svc.getById(id);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, project.companyId);
    return Response.json(project);
  };

  const createProject: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    type CreateProjectPayload = Parameters<typeof svc.create>[1] & {
      workspace?: Parameters<typeof svc.createWorkspace>[1];
    };

    const { workspace, ...projectData } = (await ctx.json()) as CreateProjectPayload;
    await assertProjectEnvironmentSelection(
      companyId,
      readProjectPolicyEnvironmentId(projectData.executionWorkspacePolicy),
    );
    assertNoAgentHostWorkspaceCommandMutation(
      ctx,
      [
        ...collectProjectExecutionWorkspaceCommandPaths(projectData.executionWorkspacePolicy),
        ...collectProjectWorkspaceCommandPaths(workspace, "workspace"),
      ],
    );
    if (projectData.env !== undefined) {
      projectData.env = await secretsSvc.normalizeEnvBindingsForPersistence(
        companyId,
        projectData.env,
        { strictMode: strictSecretsMode, fieldPath: "env" },
      );
    }
    const project = await svc.create(companyId, projectData);
    let createdWorkspaceId: string | null = null;
    if (workspace) {
      const createdWorkspace = await svc.createWorkspace(project.id, workspace);
      if (!createdWorkspace) {
        await svc.remove(project.id);
        return Response.json({ error: "Invalid project workspace payload" }, { status: 422 });
      }
      createdWorkspaceId = createdWorkspace.id;
    }
    const hydratedProject = workspace ? await svc.getById(project.id) : project;

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
        workspaceId: createdWorkspaceId,
        envKeys: project.env ? Object.keys(project.env).sort() : [],
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackProjectCreated(telemetryClient);
    }
    return Response.json(hydratedProject ?? project, { status: 201 });
  };

  const updateProject: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    const body = { ...(await ctx.json<Record<string, unknown>>()) };
    assertNoAgentHostWorkspaceCommandMutation(
      ctx,
      collectProjectExecutionWorkspaceCommandPaths(body.executionWorkspacePolicy),
    );
    await assertProjectEnvironmentSelection(
      existing.companyId,
      readProjectPolicyEnvironmentId(body.executionWorkspacePolicy),
    );
    if (typeof body.archivedAt === "string") {
      body.archivedAt = new Date(body.archivedAt);
    }
    if (body.env !== undefined) {
      body.env = await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, body.env, {
        strictMode: strictSecretsMode,
        fieldPath: "env",
      });
    }
    const project = await svc.update(id, body);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: {
        changedKeys: Object.keys(body).sort(),
        envKeys:
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? Object.keys(body.env as Record<string, unknown>).sort()
            : undefined,
      },
    });

    return Response.json(project);
  };

  const listProjectWorkspaces: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    const workspaces = await svc.listWorkspaces(id);
    return Response.json(workspaces);
  };

  const createProjectWorkspace: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await ctx.json()) as any;
    assertNoAgentHostWorkspaceCommandMutation(
      ctx,
      collectProjectWorkspaceCommandPaths(body),
    );
    const workspace = await svc.createWorkspace(id, body);
    if (!workspace) {
      return Response.json({ error: "Invalid project workspace payload" }, { status: 422 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_created",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
        cwd: workspace.cwd,
        isPrimary: workspace.isPrimary,
      },
    });

    return Response.json(workspace, { status: 201 });
  };

  const updateProjectWorkspace: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const workspaceId = ctx.param("workspaceId")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await ctx.json()) as any;
    assertNoAgentHostWorkspaceCommandMutation(
      ctx,
      collectProjectWorkspaceCommandPaths(body),
    );
    const workspaceExists = (await svc.listWorkspaces(id)).some((workspace) => workspace.id === workspaceId);
    if (!workspaceExists) {
      return Response.json({ error: "Project workspace not found" }, { status: 404 });
    }
    const workspace = await svc.updateWorkspace(id, workspaceId, body);
    if (!workspace) {
      return Response.json({ error: "Invalid project workspace payload" }, { status: 422 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_updated",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        changedKeys: Object.keys(body as Record<string, unknown>).sort(),
      },
    });

    return Response.json(workspace);
  };

  const handleProjectWorkspaceRuntimeCommand: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const workspaceId = ctx.param("workspaceId")!;
    const action = String(ctx.param("action") ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "run") {
      return Response.json({ error: "Workspace command action not found" }, { status: 404 });
    }

    const project = await svc.getById(id);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, project.companyId);

    const workspace = project.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) {
      return Response.json({ error: "Project workspace not found" }, { status: 404 });
    }

    const isSharedWorkspace = Boolean(workspace.sharedWorkspaceKey);
    if (
      ctx.actor?.type === "agent"
      && isSharedWorkspace
      && SHARED_WORKSPACE_STOP_AND_RESTART_ACTIONS.has(action)
    ) {
      throw forbidden("Missing permission to manage workspace runtime services");
    }

    await assertCanManageProjectWorkspaceRuntimeServices(db, ctx, {
      companyId: project.companyId,
      projectWorkspaceId: workspace.id,
    });

    const workspaceCwd = workspace.cwd;
    if (!workspaceCwd) {
      return Response.json({ error: "Project workspace needs a local path before Paperclip can run workspace commands" }, { status: 422 });
    }

    const runtimeConfig = workspace.runtimeConfig?.workspaceRuntime ?? null;
    const target = (await ctx.json()) as { workspaceCommandId?: string | null; runtimeServiceId?: string | null; serviceIndex?: number | null };
    const configuredServices = runtimeConfig ? listConfiguredRuntimeServiceEntries({ workspaceRuntime: runtimeConfig }) : [];
    const workspaceCommand = runtimeConfig
      ? findWorkspaceCommandDefinition(runtimeConfig, target.workspaceCommandId ?? null)
      : null;
    if (target.workspaceCommandId && !workspaceCommand) {
      return Response.json({ error: "Workspace command not found for this project workspace" }, { status: 404 });
    }
    if (target.runtimeServiceId && !(workspace.runtimeServices ?? []).some((service) => service.id === target.runtimeServiceId)) {
      return Response.json({ error: "Runtime service not found for this project workspace" }, { status: 404 });
    }
    const matchedRuntimeService =
      workspaceCommand?.kind === "service" && !target.runtimeServiceId
        ? matchWorkspaceRuntimeServiceToCommand(workspaceCommand, workspace.runtimeServices ?? [])
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
      return Response.json({ error: "Selected runtime service is not defined in this project workspace runtime config" }, { status: 422 });
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
    if ((action === "start" || action === "restart") && !runtimeConfig) {
      return Response.json({ error: "Project workspace has no workspace command configuration" }, { status: 422 });
    }

    const actor = getActorInfo(ctx);
    const recorder = workspaceOperations.createRecorder({ companyId: project.companyId });
    let runtimeServiceCount = workspace.runtimeServices?.length ?? 0;
    let stdout = "";
    let stderr = "";

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: workspaceCommand?.command ?? `workspace command ${action}`,
      cwd: workspace.cwd,
      metadata: {
        action,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
      run: async () => {
        if (action === "run") {
          if (!workspaceCommand || workspaceCommand.kind !== "job") {
            throw new Error("Workspace job selection is required");
          }
          return await runWorkspaceJobForControl({
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: project.companyId,
            },
            issue: null,
            workspace: {
              baseCwd: workspaceCwd,
              source: "project_primary",
              projectId: project.id,
              workspaceId: workspace.id,
              repoUrl: workspace.repoUrl,
              repoRef: workspace.repoRef,
              strategy: "project_primary",
              cwd: workspaceCwd,
              branchName: workspace.defaultRef ?? workspace.repoRef ?? null,
              worktreePath: null,
              warnings: [],
              created: false,
            },
            command: workspaceCommand.rawConfig,
            adapterEnv: {},
            recorder,
            metadata: {
              action,
              projectId: project.id,
              projectWorkspaceId: workspace.id,
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
          await stopRuntimeServicesForProjectWorkspace({
            db,
            projectWorkspaceId: workspace.id,
            runtimeServiceId: selectedRuntimeServiceId,
          });
        }

        if (action === "start" || action === "restart") {
          const startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: project.companyId,
            },
            issue: null,
            workspace: {
              baseCwd: workspaceCwd,
              source: "project_primary",
              projectId: project.id,
              workspaceId: workspace.id,
              repoUrl: workspace.repoUrl,
              repoRef: workspace.repoRef,
              strategy: "project_primary",
              cwd: workspaceCwd,
              branchName: workspace.defaultRef ?? workspace.repoRef ?? null,
              worktreePath: null,
              warnings: [],
              created: false,
            },
            config: { workspaceRuntime: runtimeConfig },
            adapterEnv: {},
            onLog,
            serviceIndex: selectedServiceIndex,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = selectedRuntimeServiceId ? Math.max(0, (workspace.runtimeServices?.length ?? 1) - 1) : 0;
        }

        const currentDesiredState: WorkspaceRuntimeDesiredState =
          workspace.runtimeConfig?.desiredState
          ?? ((workspace.runtimeServices ?? []).some((service) => service.status === "starting" || service.status === "running")
            ? "running"
            : "stopped");
        const nextRuntimeState: {
          desiredState: WorkspaceRuntimeDesiredState;
          serviceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
        } = selectedRuntimeServiceId && (selectedServiceIndex === undefined || selectedServiceIndex === null)
          ? {
              desiredState: currentDesiredState,
              serviceStates: workspace.runtimeConfig?.serviceStates ?? null,
            }
          : buildWorkspaceRuntimeDesiredStatePatch({
              config: { workspaceRuntime: runtimeConfig },
              currentDesiredState,
              currentServiceStates: workspace.runtimeConfig?.serviceStates ?? null,
              action,
              serviceIndex: selectedServiceIndex,
            });
        await svc.updateWorkspace(project.id, workspace.id, {
          runtimeConfig: {
            desiredState: nextRuntimeState.desiredState,
            serviceStates: nextRuntimeState.serviceStates,
          },
        });

        return {
          status: "succeeded",
          stdout,
          stderr,
          system:
            action === "stop"
              ? "Stopped project workspace runtime services.\nThis does not pause issue work or held wake scheduling."
              : action === "restart"
                ? "Restarted project workspace runtime services.\nThis does not pause issue work or held wake scheduling."
                : "Started project workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
            workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
            runtimeServiceId: selectedRuntimeServiceId,
            serviceIndex: selectedServiceIndex,
          },
        };
      },
    });

    const updatedWorkspace = (await svc.listWorkspaces(project.id)).find((entry) => entry.id === workspace.id) ?? workspace;

    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: `project.workspace_runtime_${action}`,
      entityType: "project",
      entityId: project.id,
      details: {
        projectWorkspaceId: workspace.id,
        runtimeServiceCount,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
    });

    return Response.json({
      workspace: updatedWorkspace,
      operation,
    });
  };

  const deleteProjectWorkspace: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const workspaceId = ctx.param("workspaceId")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    const workspace = await svc.removeWorkspace(id, workspaceId);
    if (!workspace) {
      return Response.json({ error: "Project workspace not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_deleted",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
      },
    });

    return Response.json(workspace);
  };

  const deleteProject: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, existing.companyId);
    const project = await svc.remove(id);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    return Response.json(project);
  };

  router.get("/companies/:companyId/projects", expressHandler(listProjects, { db, storage: storageSentinel }));
  router.get("/projects/:id", expressHandler(getProject, { db, storage: storageSentinel }));
  router.post("/companies/:companyId/projects", validate(createProjectSchema), expressHandler(createProject, { db, storage: storageSentinel }));
  router.patch("/projects/:id", validate(updateProjectSchema), expressHandler(updateProject, { db, storage: storageSentinel }));
  router.get("/projects/:id/workspaces", expressHandler(listProjectWorkspaces, { db, storage: storageSentinel }));
  router.post("/projects/:id/workspaces", validate(createProjectWorkspaceSchema), expressHandler(createProjectWorkspace, { db, storage: storageSentinel }));
  router.patch(
    "/projects/:id/workspaces/:workspaceId",
    validate(updateProjectWorkspaceSchema),
    expressHandler(updateProjectWorkspace, { db, storage: storageSentinel }),
  );

  router.post("/projects/:id/workspaces/:workspaceId/runtime-services/:action", validate(workspaceRuntimeControlTargetSchema), expressHandler(handleProjectWorkspaceRuntimeCommand, { db, storage: storageSentinel }));
  router.post("/projects/:id/workspaces/:workspaceId/runtime-commands/:action", validate(workspaceRuntimeControlTargetSchema), expressHandler(handleProjectWorkspaceRuntimeCommand, { db, storage: storageSentinel }));

  router.delete("/projects/:id/workspaces/:workspaceId", expressHandler(deleteProjectWorkspace, { db, storage: storageSentinel }));
  router.delete("/projects/:id", expressHandler(deleteProject, { db, storage: storageSentinel }));

  return router;
}
