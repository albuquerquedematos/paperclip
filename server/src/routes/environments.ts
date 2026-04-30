import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  AGENT_ADAPTER_TYPES,
  createEnvironmentSchema,
  getEnvironmentCapabilities,
  probeEnvironmentConfigSchema,
  updateEnvironmentSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  issueService,
  logActivity,
  projectService,
} from "../services/index.js";
import {
  normalizeEnvironmentConfigForPersistence,
  normalizeEnvironmentConfigForProbe,
  parseEnvironmentDriverConfig,
  readSshEnvironmentPrivateKeySecretId,
  type ParsedEnvironmentConfig,
} from "../services/environment-config.js";
import { probeEnvironment } from "../services/environment-probe.js";
import { secretService } from "../services/secrets.js";
import { listReadyPluginEnvironmentDrivers } from "../services/plugin-environment-driver.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler, RequestCtx } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

export function environmentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = environmentService(db);
  const executionWorkspaces = executionWorkspaceService(db);
  const issues = issueService(db);
  const projects = projectService(db);
  const secrets = secretService(db);

  // Storage is not needed by any environment handler; supply a sentinel that
  // throws if accidentally accessed, keeping the adapter type contract honest.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`environment handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  function parseObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  // ---------------------------------------------------------------------------
  // Internal authz helpers operating on RequestCtx (not Express Request)
  // ---------------------------------------------------------------------------

  async function assertCanMutateEnvironments(ctx: RequestCtx, companyId: string) {
    // ctx.actor is null when type was "none"; express-adapter normalises that.
    if (!ctx.actor) throw forbidden("Authentication required");
    const actor = ctx.actor;

    if (actor.type === "board") {
      const allowed = await access.canUser(companyId, actor.userId ?? "", "environments:manage");
      if (!allowed) {
        throw forbidden("Missing permission: environments:manage");
      }
      return;
    }

    if (!actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "environments:manage");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: environments:manage");
  }

  async function actorCanReadEnvironmentConfigurations(ctx: RequestCtx, companyId: string) {
    if (!ctx.actor) return false;
    const actor = ctx.actor;

    if (actor.type === "board") {
      return access.canUser(companyId, actor.userId ?? "", "environments:manage");
    }

    if (!actor.agentId) return false;
    const actorAgent = await agents.getById(actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "environments:manage");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  function redactEnvironmentForRestrictedView<T extends {
    config: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
  }>(environment: T): T & { configRedacted: true; metadataRedacted: true } {
    return {
      ...environment,
      config: {},
      metadata: null,
      configRedacted: true,
      metadataRedacted: true,
    };
  }

  function summarizeEnvironmentUpdate(
    patch: Record<string, unknown>,
    environment: {
      name: string;
      driver: string;
      status: string;
    },
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      changedFields: Object.keys(patch).sort(),
    };

    if (patch.name !== undefined) details.name = environment.name;
    if (patch.driver !== undefined) details.driver = environment.driver;
    if (patch.status !== undefined) details.status = environment.status;
    if (patch.description !== undefined) details.descriptionChanged = true;
    if (patch.config !== undefined) {
      details.configChanged = true;
      details.configTopLevelKeyCount =
        patch.config && typeof patch.config === "object" && !Array.isArray(patch.config)
          ? Object.keys(patch.config as Record<string, unknown>).length
          : 0;
    }
    if (patch.metadata !== undefined) {
      details.metadataChanged = true;
      details.metadataTopLevelKeyCount =
        patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)
          ? Object.keys(patch.metadata as Record<string, unknown>).length
          : 0;
    }

    return details;
  }

  // Helper to derive actorInfo-equivalent from RequestCtx
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

  const listEnvironments: Handler = async (ctx) => {
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    if (!ctx.actor) throw forbidden("Authentication required");
    const rows = await svc.list(companyId, {
      status: ctx.query("status"),
      driver: ctx.query("driver"),
    });
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(ctx, companyId);
    if (canReadConfigs) {
      return Response.json(rows);
    }
    return Response.json(rows.map((environment) => redactEnvironmentForRestrictedView(environment)));
  };

  const getEnvironmentCapabilitiesHandler: Handler = async (ctx) => {
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    if (!ctx.actor) throw forbidden("Authentication required");
    const pluginDrivers = await listReadyPluginEnvironmentDrivers({
      db,
      workerManager: options.pluginWorkerManager,
    });
    return Response.json(getEnvironmentCapabilities(
      AGENT_ADAPTER_TYPES,
      {
        sandboxProviders: Object.fromEntries(pluginDrivers.map((driver) => [
          driver.driverKey,
          {
            status: "supported" as const,
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: driver.displayName,
            description: driver.description,
            source: "plugin" as const,
            pluginKey: driver.pluginKey,
            pluginId: driver.pluginId,
            configSchema: driver.configSchema,
          },
        ])),
      },
    ));
  };

  const createEnvironment: Handler = async (ctx) => {
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    await assertCanMutateEnvironments(ctx, companyId);
    const actor = ctxActorInfo(ctx);
    const body = await ctx.json<Record<string, unknown>>();
    const input = {
      ...body,
      config: await normalizeEnvironmentConfigForPersistence({
        db,
        companyId,
        environmentName: body.name as string,
        driver: body.driver as string,
        config: body.config,
        actor: {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        pluginWorkerManager: options.pluginWorkerManager,
      }),
    };
    const environment = await svc.create(companyId, input);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.created",
      entityType: "environment",
      entityId: environment.id,
      details: {
        name: environment.name,
        driver: environment.driver,
        status: environment.status,
      },
    });
    return Response.json(environment, { status: 201 });
  };

  const getEnvironment: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const environment = await svc.getById(id);
    if (!environment) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(ctx, environment.companyId);
    if (canReadConfigs) {
      return Response.json(environment);
    }
    return Response.json(redactEnvironmentForRestrictedView(environment));
  };

  const listEnvironmentLeases: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const environment = await svc.getById(id);
    if (!environment) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(ctx, environment.companyId);
    if (!canReadConfigs) {
      throw forbidden("Missing permission: environments:manage");
    }
    const leases = await svc.listLeases(environment.id, {
      status: ctx.query("status"),
    });
    return Response.json(leases);
  };

  const getEnvironmentLease: Handler = async (ctx) => {
    const leaseId = ctx.param("leaseId");
    if (!leaseId) return Response.json({ error: "Missing leaseId" }, { status: 400 });
    const lease = await svc.getLeaseById(leaseId);
    if (!lease) {
      return Response.json({ error: "Environment lease not found" }, { status: 404 });
    }
    if (!ctx.actor) throw forbidden("Authentication required");
    const canReadConfigs = await actorCanReadEnvironmentConfigurations(ctx, lease.companyId);
    if (!canReadConfigs) {
      throw forbidden("Missing permission: environments:manage");
    }
    return Response.json(lease);
  };

  const updateEnvironment: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }
    await assertCanMutateEnvironments(ctx, existing.companyId);
    const actor = ctxActorInfo(ctx);
    const body = await ctx.json<Record<string, unknown>>();
    const nextDriver = (body.driver as string | undefined) ?? existing.driver;
    const nextName = (body.name as string | undefined) ?? existing.name;
    const configSource =
      body.config !== undefined
        ? body.driver !== undefined && body.driver !== existing.driver
          ? body.config
          : {
              ...parseObject(existing.config),
              ...parseObject(body.config),
            }
        : body.driver !== undefined && body.driver !== existing.driver
          ? {}
          : existing.config;
    const patch = {
      ...body,
      ...(body.config !== undefined || body.driver !== undefined
        ? {
            config: await normalizeEnvironmentConfigForPersistence({
              db,
              companyId: existing.companyId,
              environmentName: nextName,
              driver: nextDriver,
              config: configSource,
              actor: {
                agentId: actor.agentId,
                userId: actor.actorType === "user" ? actor.actorId : null,
              },
              pluginWorkerManager: options.pluginWorkerManager,
            }),
          }
        : {}),
    };
    const environment = await svc.update(existing.id, patch);
    if (!environment) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }
    await logActivity(db, {
      companyId: environment.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.updated",
      entityType: "environment",
      entityId: environment.id,
      details: summarizeEnvironmentUpdate(patch as Record<string, unknown>, environment),
    });
    return Response.json(environment);
  };

  const deleteEnvironment: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }
    await assertCanMutateEnvironments(ctx, existing.companyId);
    await Promise.all([
      executionWorkspaces.clearEnvironmentSelection(existing.companyId, existing.id),
      issues.clearExecutionWorkspaceEnvironmentSelection(existing.companyId, existing.id),
      projects.clearExecutionWorkspaceEnvironmentSelection(existing.companyId, existing.id),
    ]);
    const removed = await svc.remove(existing.id);
    if (!removed) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }
    const secretId = readSshEnvironmentPrivateKeySecretId(existing);
    if (secretId) {
      await secrets.remove(secretId);
    }
    const actor = ctxActorInfo(ctx);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.deleted",
      entityType: "environment",
      entityId: removed.id,
      details: {
        name: removed.name,
        driver: removed.driver,
        status: removed.status,
      },
    });
    return Response.json(removed);
  };

  const probeEnvironmentHandler: Handler = async (ctx) => {
    const id = ctx.param("id");
    if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
    const environment = await svc.getById(id);
    if (!environment) {
      return Response.json({ error: "Environment not found" }, { status: 404 });
    }
    await assertCanMutateEnvironments(ctx, environment.companyId);
    const actor = ctxActorInfo(ctx);
    const probe = await probeEnvironment(db, environment, {
      pluginWorkerManager: options.pluginWorkerManager,
    });
    await logActivity(db, {
      companyId: environment.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.probed",
      entityType: "environment",
      entityId: environment.id,
      details: {
        driver: environment.driver,
        ok: probe.ok,
        summary: probe.summary,
      },
    });
    return Response.json(probe);
  };

  const probeEnvironmentConfig: Handler = async (ctx) => {
    const companyId = ctx.param("companyId");
    if (!companyId) return Response.json({ error: "Missing companyId" }, { status: 400 });
    await assertCanMutateEnvironments(ctx, companyId);
    const actor = ctxActorInfo(ctx);
    const body = await ctx.json<Record<string, unknown>>();
    const normalizedConfig = await normalizeEnvironmentConfigForProbe({
      db,
      driver: body.driver as string,
      config: body.config,
      pluginWorkerManager: options.pluginWorkerManager,
    });
    const environment = {
      id: "unsaved",
      companyId,
      name: (typeof body.name === "string" ? body.name.trim() : "") || "Unsaved environment",
      description: (body.description as string | undefined) ?? null,
      driver: body.driver as string,
      status: "active" as const,
      config: normalizedConfig,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const probe = await probeEnvironment(db, environment, {
      pluginWorkerManager: options.pluginWorkerManager,
      resolvedConfig: {
        driver: body.driver as string,
        config: normalizedConfig,
      } as ParsedEnvironmentConfig,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "environment.probed_unsaved",
      entityType: "environment",
      entityId: "unsaved",
      details: {
        driver: environment.driver,
        ok: probe.ok,
        summary: probe.summary,
        configTopLevelKeyCount: Object.keys(environment.config).length,
      },
    });
    return Response.json(probe);
  };

  // ---------------------------------------------------------------------------
  // Wire handlers via expressHandler
  // ---------------------------------------------------------------------------

  const adapterDeps = { db, storage: storageSentinel };

  router.get("/companies/:companyId/environments", expressHandler(listEnvironments, adapterDeps));
  router.get("/companies/:companyId/environments/capabilities", expressHandler(getEnvironmentCapabilitiesHandler, adapterDeps));
  router.post("/companies/:companyId/environments", validate(createEnvironmentSchema), expressHandler(createEnvironment, adapterDeps));
  router.get("/environments/:id", expressHandler(getEnvironment, adapterDeps));
  router.get("/environments/:id/leases", expressHandler(listEnvironmentLeases, adapterDeps));
  router.get("/environment-leases/:leaseId", expressHandler(getEnvironmentLease, adapterDeps));
  router.patch("/environments/:id", validate(updateEnvironmentSchema), expressHandler(updateEnvironment, adapterDeps));
  router.delete("/environments/:id", expressHandler(deleteEnvironment, adapterDeps));
  router.post("/environments/:id/probe", expressHandler(probeEnvironmentHandler, adapterDeps));
  router.post(
    "/companies/:companyId/environments/probe-config",
    validate(probeEnvironmentConfigSchema),
    expressHandler(probeEnvironmentConfig, adapterDeps),
  );

  return router;
}
