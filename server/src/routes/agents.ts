import { Router, type Request, type Response as ExpressResponse, type NextFunction } from "express";
import type { Handler, RequestCtx } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, companies, heartbeatRuns, issues as issuesTable } from "@paperclipai/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  agentSkillSyncSchema,
  agentMineInboxQuerySchema,
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  isUuidLike,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  type AgentSkillSnapshot,
  type InstanceSchedulerHeartbeatAgent,
  upsertAgentInstructionsFileSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
  supportedEnvironmentDriversForAdapter,
} from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  agentInstructionsService,
  accessService,
  approvalService,
  companySkillService,
  budgetService,
  heartbeatService,
  ISSUE_LIST_DEFAULT_LIMIT,
  issueApprovalService,
  issueService,
  logActivity,
  syncInstructionsBundleConfigFromFilePath,
  workspaceOperationService,
} from "../services/index.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import { secretService } from "../services/secrets.js";
import {
  detectAdapterModel,
  findActiveServerAdapter,
  findServerAdapter,
  listAdapterModels,
  refreshAdapterModels,
  requireServerAdapter,
} from "../adapters/index.js";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, type OrgChartStyle, ORG_CHART_STYLES } from "./org-chart-svg.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { runClaudeLogin } from "@paperclipai/adapter-claude-local/server";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
} from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { ensureOpenCodeModelConfiguredAndAvailable } from "@paperclipai/adapter-opencode-local/server";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { getTelemetryClient } from "../telemetry.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { recoveryService } from "../services/recovery/service.js";

const RUN_LOG_DEFAULT_LIMIT_BYTES = 256_000;
const RUN_LOG_MAX_LIMIT_BYTES = 1024 * 1024;

function readRunLogLimitBytes(value: unknown) {
  const parsed = Number(value ?? RUN_LOG_DEFAULT_LIMIT_BYTES);
  if (!Number.isFinite(parsed)) return RUN_LOG_DEFAULT_LIMIT_BYTES;
  return Math.max(1, Math.min(RUN_LOG_MAX_LIMIT_BYTES, Math.trunc(parsed)));
}

function readLiveRunsQueryInt(value: unknown, max: number, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(parsed)));
}

export function agentRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  // Legacy hardcoded maps — used as fallback when adapter module does not
  // declare capability flags explicitly.
  const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
    claude_local: "instructionsFilePath",
    codex_local: "instructionsFilePath",
    droid_local: "instructionsFilePath",
    gemini_local: "instructionsFilePath",
    hermes_local: "instructionsFilePath",
    opencode_local: "instructionsFilePath",
    cursor: "instructionsFilePath",
    pi_local: "instructionsFilePath",
  };
  const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));

  /** Check if an adapter supports the managed instructions bundle. */
  function adapterSupportsInstructionsBundle(adapterType: string): boolean {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
    return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
  }

  /** Resolve the adapter config key for the instructions file path. */
  function resolveInstructionsPathKey(adapterType: string): string | null {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.instructionsPathKey) return adapter.instructionsPathKey;
    if (adapter?.supportsInstructionsBundle === true) return "instructionsFilePath";
    if (adapter?.supportsInstructionsBundle === false) return null;
    return DEFAULT_INSTRUCTIONS_PATH_KEYS[adapterType] ?? null;
  }
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);
  const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
  ] as const;

  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);
  const approvalsSvc = approvalService(db);
  const budgets = budgetService(db);
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const instructions = agentInstructionsService();
  const companySkills = companySkillService(db);
  const workspaceOperations = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function assertAgentEnvironmentSelection(
    companyId: string,
    adapterType: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentService(db), companyId, environmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(adapterType),
    });
  }

  /**
   * Resolve the execution target the adapter should run its test probes against.
   *
   * - No environmentId / local environment → returns a local target so the
   *   adapter probes the Paperclip host (legacy behavior).
   * - SSH environment → builds an SSH execution target from the environment
   *   config so the adapter probes the remote box. No lease is required:
   *   the SSH spec is fully derived from the saved environment config.
   * - Sandbox / plugin environments → currently fall back to local probing
   *   with a warning check, since lifting a temporary sandbox lease for an
   *   ad-hoc test invocation is out of scope for this iteration.
   */
  async function resolveAdapterTestExecutionContext(input: {
    companyId: string;
    adapterType: string;
    environmentId: string | null;
  }): Promise<{
    executionTarget: AdapterExecutionTarget | null;
    environmentName: string | null;
    fallbackChecks: AdapterEnvironmentCheck[];
  }> {
    if (!input.environmentId) {
      return { executionTarget: null, environmentName: null, fallbackChecks: [] };
    }

    const environment = await environmentsSvc.getById(input.environmentId);
    if (!environment || environment.companyId !== input.companyId) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [
          {
            code: "environment_not_found",
            level: "warn",
            message: "Selected environment was not found. Falling back to a local probe.",
          },
        ],
      };
    }

    if (environment.driver === "local") {
      return { executionTarget: null, environmentName: environment.name, fallbackChecks: [] };
    }

    if (environment.driver === "ssh") {
      try {
        const target = await resolveEnvironmentExecutionTarget({
          db,
          companyId: input.companyId,
          adapterType: input.adapterType,
          environment: {
            id: environment.id,
            driver: environment.driver,
            config: environment.config ?? null,
          },
          leaseMetadata: null,
        });
        if (target) {
          return { executionTarget: target, environmentName: environment.name, fallbackChecks: [] };
        }
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_unavailable",
              level: "warn",
              message:
                `Could not resolve an execution target for environment "${environment.name}". Falling back to a local probe.`,
            },
          ],
        };
      } catch (err) {
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_failed",
              level: "warn",
              message:
                `Could not connect to environment "${environment.name}" to run the test. Falling back to a local probe.`,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
    }

    // sandbox / plugin / other drivers: not yet supported for ad-hoc adapter tests.
    return {
      executionTarget: null,
      environmentName: environment.name,
      fallbackChecks: [
        {
          code: "environment_driver_not_supported_for_test",
          level: "warn",
          message:
            `Adapter testing inside ${environment.driver} environments is not yet supported. Falling back to a local probe; results may not reflect runs in "${environment.name}".`,
          hint: "Run a real heartbeat in the environment to verify end-to-end behavior.",
        },
      ],
    };
  }

  async function getCurrentUserRedactionOptions() {
    return {
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    };
  }

  function canCreateAgents(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id)
      : [];
    const hasExplicitTaskAssignGrant = grants.some((grant) => grant.permissionKey === "tasks:assign");

    if (agent.role === "ceo") {
      return {
        canAssignTasks: true,
        taskAssignSource: "ceo_role" as const,
        membership,
        grants,
      };
    }

    if (canCreateAgents(agent)) {
      return {
        canAssignTasks: true,
        taskAssignSource: "agent_creator" as const,
        membership,
        grants,
      };
    }

    if (hasExplicitTaskAssignGrant) {
      return {
        canAssignTasks: true,
        taskAssignSource: "explicit_grant" as const,
        membership,
        grants,
      };
    }

    return {
      canAssignTasks: false,
      taskAssignSource: "none" as const,
      membership,
      grants,
    };
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    options?: { restricted?: boolean },
  ) {
    const [chainOfCommand, accessState] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
    ]);

    return {
      ...(options?.restricted ? redactForRestrictedAgentView(agent) : agent),
      chainOfCommand,
      access: accessState,
    };
  }

  async function applyDefaultAgentTaskAssignGrant(
    companyId: string,
    agentId: string,
    grantedByUserId: string | null,
  ) {
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      grantedByUserId,
    );
  }

  async function assertCanCreateAgentsForCompany(ctx: RequestCtx, companyId: string) {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board") {
      if (ctx.actor.source === "local_implicit" || ctx.actor.isInstanceAdmin) return null;
      const allowed = await access.canUser(companyId, ctx.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return null;
    }
    if (!ctx.actor?.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(ctx.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (!allowedByGrant && !canCreateAgents(actorAgent)) {
      throw forbidden("Missing permission: can create agents");
    }
    return actorAgent;
  }

  async function assertBoardCanManageAgentsForCompany(ctx: RequestCtx, companyId: string) {
    assertBoard(ctx);
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board" && (ctx.actor.source === "local_implicit" || ctx.actor.isInstanceAdmin)) return;
    if (ctx.actor?.type === "board") {
      const allowed = await access.canUser(companyId, ctx.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
    }
  }

  async function assertCanReadConfigurations(ctx: RequestCtx, companyId: string) {
    return assertCanCreateAgentsForCompany(ctx, companyId);
  }

  /** Returns the agent or null (caller must return 404 when null). */
  async function getAccessibleAgent(ctx: RequestCtx, id: string) {
    const agent = await svc.getById(id);
    if (!agent) return null;
    assertCompanyAccess(ctx, agent.companyId);
    if (ctx.actor?.type === "board") {
      await assertBoardCanManageAgentsForCompany(ctx, agent.companyId);
    }
    return agent;
  }

  async function actorCanReadConfigurationsForCompany(ctx: RequestCtx, companyId: string) {
    assertCompanyAccess(ctx, companyId);
    if (ctx.actor?.type === "board") {
      if (ctx.actor.source === "local_implicit" || ctx.actor.isInstanceAdmin) return true;
      return access.canUser(companyId, ctx.actor.userId, "agents:create");
    }
    if (!ctx.actor?.agentId) return false;
    const actorAgent = await svc.getById(ctx.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) return false;
    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  async function buildSkippedWakeupResponse(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    payload: Record<string, unknown> | null | undefined,
  ) {
    const issueId = typeof payload?.issueId === "string" && payload.issueId.trim() ? payload.issueId : null;
    if (!issueId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId: null,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const issue = await db
      .select({
        id: issuesTable.id,
        executionRunId: issuesTable.executionRunId,
      })
      .from(issuesTable)
      .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, agent.companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issue?.executionRunId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionRun = await heartbeat.getRun(issue.executionRunId);
    if (!executionRun || (executionRun.status !== "queued" && executionRun.status !== "running")) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: issue.executionRunId,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionAgent = await svc.getById(executionRun.agentId);
    const executionAgentName = executionAgent?.name ?? null;

    return {
      status: "skipped" as const,
      reason: "issue_execution_deferred",
      message: executionAgentName
        ? `Wakeup was deferred because this issue is already being executed by ${executionAgentName}.`
        : "Wakeup was deferred because this issue already has an active execution run.",
      issueId,
      executionRunId: executionRun.id,
      executionAgentId: executionRun.agentId,
      executionAgentName,
    };
  }

  async function assertCanUpdateAgent(ctx: RequestCtx, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(ctx, targetAgent.companyId);
    if (ctx.actor?.type === "board") {
      await assertBoardCanManageAgentsForCompany(ctx, targetAgent.companyId);
      return;
    }
    if (!ctx.actor?.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(ctx.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    if (actorAgent.id === targetAgent.id) return;
    if (actorAgent.role === "ceo") return;
    const allowedByGrant = await access.hasPermission(
      targetAgent.companyId,
      "agent",
      actorAgent.id,
      "agents:create",
    );
    if (allowedByGrant || canCreateAgents(actorAgent)) return;
    throw forbidden("Only CEO or agent creators can modify other agents");
  }

  async function assertCanReadAgent(ctx: RequestCtx, targetAgent: { companyId: string }) {
    assertCompanyAccess(ctx, targetAgent.companyId);
    if (ctx.actor?.type === "board") {
      await assertCanReadConfigurations(ctx, targetAgent.companyId);
      return;
    }
    if (!ctx.actor?.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(ctx.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }

  function assertKnownAdapterType(type: string | null | undefined): string {
    const adapterType = typeof type === "string" ? type.trim() : "";
    if (!adapterType) {
      throw unprocessable("Adapter type is required");
    }
    if (!findServerAdapter(adapterType)) {
      throw unprocessable(`Unknown adapter type: ${adapterType}`);
    }
    return adapterType;
  }

  async function assertAgentDefaultEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
    options?: { allowedDrivers?: string[]; allowedSandboxProviders?: string[] },
  ) {
    if (environmentId === undefined || environmentId === null) return;
    const environment = await environmentsSvc.getById(environmentId);
    if (!environment || environment.companyId !== companyId) {
      throw unprocessable("Selected environment must belong to the same company");
    }
    if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
      throw unprocessable(`Environment driver "${environment.driver}" is not allowed here`);
    }
    if (environment.driver === "sandbox" && options?.allowedSandboxProviders) {
      const config = environment.config && typeof environment.config === "object"
        ? environment.config as Record<string, unknown>
        : {};
      const provider = typeof config.provider === "string" ? config.provider : "";
      if (provider === "fake") {
        throw unprocessable(
          `Selected sandbox provider "${provider}" is not supported for agent defaults yet`,
        );
      }
      if (options.allowedSandboxProviders.length > 0 && !options.allowedSandboxProviders.includes(provider)) {
        throw unprocessable(
          `Selected sandbox provider "${provider || "unknown"}" is not supported for agent defaults yet`,
        );
      }
    }
  }

  function hasOwn(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
  }

  function allowedEnvironmentDriversForAgent(adapterType: string): string[] {
    return supportedEnvironmentDriversForAdapter(adapterType);
  }

  function allowedSandboxProvidersForAgent(adapterType: string): string[] | undefined {
    return supportedEnvironmentDriversForAdapter(adapterType).includes("sandbox") ? [] : [];
  }

  async function resolveCompanyIdForAgentReference(ctx: RequestCtx): Promise<string | null> {
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

  async function normalizeAgentReference(ctx: RequestCtx, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const companyId = await resolveCompanyIdForAgentReference(ctx);
    if (!companyId) {
      // No company context to scope the lookup. Leave the raw value in place
      // so handlers can resolve it via svc.getById (which scans by URL key
      // and lets the route handler enforce assertCompanyAccess afterwards).
      return raw;
    }

    const resolved = await svc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      // Don't throw here either — return raw and let the handler decide.
      // svc.getById is the single source of truth for resolution + 404 behavior.
      return raw;
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function preserveInstructionsBundleConfig(
    existingAdapterConfig: Record<string, unknown>,
    nextAdapterConfig: Record<string, unknown>,
  ) {
    const nextKeys = new Set(Object.keys(nextAdapterConfig));
    if (KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => nextKeys.has(key))) {
      return nextAdapterConfig;
    }

    const merged = { ...nextAdapterConfig };
    for (const key of KNOWN_INSTRUCTIONS_BUNDLE_KEYS) {
      if (merged[key] === undefined && existingAdapterConfig[key] !== undefined) {
        merged[key] = existingAdapterConfig[key];
      }
    }
    return merged;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
    return null;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? false,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function normalizeNewAgentRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> {
    const parsedRuntimeConfig = asRecord(runtimeConfig);
    const normalizedRuntimeConfig = parsedRuntimeConfig ? { ...parsedRuntimeConfig } : {};
    const parsedHeartbeat = asRecord(normalizedRuntimeConfig.heartbeat);
    const heartbeat = parsedHeartbeat ? { ...parsedHeartbeat } : {};

    if (parseBooleanLike(heartbeat.enabled) == null) {
      heartbeat.enabled = false;
    }
    if (parseNumberLike(heartbeat.maxConcurrentRuns) == null) {
      heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
    }

    normalizedRuntimeConfig.heartbeat = heartbeat;
    return normalizedRuntimeConfig;
  }

  function generateEd25519PrivateKeyPem(): string {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  function ensureGatewayDeviceKey(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "openclaw_gateway") return adapterConfig;
    const disableDeviceAuth = parseBooleanLike(adapterConfig.disableDeviceAuth) === true;
    if (disableDeviceAuth) return adapterConfig;
    if (asNonEmptyString(adapterConfig.devicePrivateKeyPem)) return adapterConfig;
    return { ...adapterConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
  }

  function applyCreateDefaultsByAdapterType(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...adapterConfig };
    if (adapterType === "codex_local") {
      if (!asNonEmptyString(next.model)) {
        next.model = DEFAULT_CODEX_LOCAL_MODEL;
      }
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "gemini_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_GEMINI_LOCAL_MODEL;
      return ensureGatewayDeviceKey(adapterType, next);
    }
    // OpenCode requires explicit model selection — no default
    if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return ensureGatewayDeviceKey(adapterType, next);
  }

  async function assertAdapterConfigConstraints(
    companyId: string,
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    if (adapterType !== "opencode_local") return;
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(companyId, adapterConfig);
    const runtimeEnv = asRecord(runtimeConfig.env) ?? {};
    try {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model: runtimeConfig.model,
        command: runtimeConfig.command,
        cwd: runtimeConfig.cwd,
        env: runtimeEnv,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
    }
  }

  function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(adapterConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    companyId: string;
    name: string;
    role: string;
    adapterType: string;
    adapterConfig: unknown;
  }>(
    agent: T,
    input?: { files: Record<string, string>; entryFile?: string },
  ): Promise<T> {
    if (!adapterSupportsInstructionsBundle(agent.adapterType)) {
      return agent;
    }

    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(adapterConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(adapterConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(adapterConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(adapterConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(adapterConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      const nextAdapterConfig = { ...adapterConfig };
      const hadLegacyPrompt =
        Object.prototype.hasOwnProperty.call(nextAdapterConfig, "promptTemplate")
        || Object.prototype.hasOwnProperty.call(nextAdapterConfig, "bootstrapPromptTemplate");
      delete nextAdapterConfig.promptTemplate;
      delete nextAdapterConfig.bootstrapPromptTemplate;
      if (!hadLegacyPrompt) return agent;

      const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
      return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
    }

    const files = input?.files
      ?? await loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(agent.role));
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      { entryFile: input?.entryFile ?? "AGENTS.md", replaceExisting: false },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;
    delete nextAdapterConfig.bootstrapPromptTemplate;

    const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig });
    return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
  }

  function assertNoNewAgentLegacyPromptTemplate(adapterType: string, adapterConfig: Record<string, unknown>) {
    if (!adapterSupportsInstructionsBundle(adapterType)) return;
    if (
      Object.prototype.hasOwnProperty.call(adapterConfig, "promptTemplate")
      || Object.prototype.hasOwnProperty.call(adapterConfig, "bootstrapPromptTemplate")
    ) {
      throw unprocessable(
        "New agents must use instructionsBundle/AGENTS.md instead of adapterConfig.promptTemplate or bootstrapPromptTemplate",
      );
    }
  }

  async function assertCanManageInstructionsPath(ctx: RequestCtx, targetAgent: { id: string; companyId: string }) {
    assertCompanyAccess(ctx, targetAgent.companyId);
    if (ctx.actor?.type !== "board") {
      throw forbidden(
        "Only board-authenticated callers can manage instructions path or bundle configuration",
      );
    }
    await assertBoardCanManageAgentsForCompany(ctx, targetAgent.companyId);
  }

  function assertNoAgentInstructionsConfigMutation(
    ctx: RequestCtx,
    adapterConfig: Record<string, unknown> | null | undefined,
  ) {
    if (ctx.actor?.type !== "agent" || !adapterConfig) return;
    const changedSensitiveKeys = KNOWN_INSTRUCTIONS_BUNDLE_KEYS.filter((key) => adapterConfig[key] !== undefined);
    if (changedSensitiveKeys.length === 0) return;
    throw forbidden(
      `Agent-authenticated callers cannot modify instructions path or bundle configuration (${changedSensitiveKeys.join(", ")})`,
    );
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const adapterConfigPatch = asRecord(patch.adapterConfig);
    if (adapterConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }

  function buildUnsupportedSkillSnapshot(
    adapterType: string,
    desiredSkills: string[] = [],
  ): AgentSkillSnapshot {
    return {
      adapterType,
      supported: false,
      mode: "unsupported",
      desiredSkills,
      entries: [],
      warnings: ["This adapter does not implement skill sync yet."],
    };
  }

  // Legacy hardcoded set — used as fallback when adapter module does not
  // declare requiresMaterializedRuntimeSkills explicitly.
  const LEGACY_MATERIALIZED_SKILLS_SET = new Set([
    "cursor",
    "gemini_local",
    "opencode_local",
    "pi_local",
  ]);

  function shouldMaterializeRuntimeSkillsForAdapter(adapterType: string) {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.requiresMaterializedRuntimeSkills !== undefined) {
      return adapter.requiresMaterializedRuntimeSkills;
    }
    return LEGACY_MATERIALIZED_SKILLS_SET.has(adapterType);
  }

  async function buildRuntimeSkillConfig(
    companyId: string,
    adapterType: string,
    config: Record<string, unknown>,
  ) {
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    return {
      ...config,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
  }

  async function resolveDesiredSkillAssignment(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ) {
    if (!requestedDesiredSkills) {
      return {
        adapterConfig,
        desiredSkills: null as string[] | null,
        runtimeSkillEntries: null as Awaited<ReturnType<typeof companySkills.listRuntimeSkillEntries>> | null,
      };
    }

    const resolvedRequestedSkills = await companySkills.resolveRequestedSkillKeys(
      companyId,
      requestedDesiredSkills,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
    });
    const requiredSkills = runtimeSkillEntries
      .filter((entry) => entry.required)
      .map((entry) => entry.key);
    const desiredSkills = Array.from(new Set([...requiredSkills, ...resolvedRequestedSkills]));

    return {
      adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desiredSkills),
      desiredSkills,
      runtimeSkillEntries,
    };
  }

  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      adapterType: agent.adapterType,
      adapterConfig: redactEventPayload(agent.adapterConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...record,
      adapterConfig: redactEventPayload(
        typeof record.adapterConfig === "object" && record.adapterConfig !== null
          ? (record.adapterConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
      afterConfig: redactRevisionSnapshot(revision.afterConfig),
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      role: String(node.role),
      status: String(node.status),
      reports,
    };
  }

  // Storage is not used by agent handlers; supply a sentinel to satisfy AdapterDeps.
  const storageSentinel = new Proxy({} as import("../storage/types.js").StorageService, {
    get(_target, prop) {
      throw new Error(`agent handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  router.param("id", async (req: Request, _res: ExpressResponse, next: NextFunction, rawId: string) => {
    try {
      // Build a minimal RequestCtx wrapper. The Express req exposes `query`
      // as an object; RequestCtx expects `query(name)` as a function. Casting
      // req directly threw `ctx.query is not a function` whenever a non-UUID
      // :id (e.g. "ceo") forced normalizeAgentReference to read companyId
      // from the query string. Mirrors the wrapper in routes/projects.ts.
      const minCtx = {
        actor: (req as Request & { actor?: unknown }).actor ?? null,
        method: req.method,
        query(name: string) {
          const v = req.query[name];
          return typeof v === "string" ? v : undefined;
        },
      } as unknown as RequestCtx;
      req.params.id = await normalizeAgentReference(minCtx, String(rawId));
      next();
    } catch (err) {
      next(err);
    }
  });

  const listAdapterModelsHandler: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const type = assertKnownAdapterType(ctx.param("type"));
    const refreshRaw = ctx.query("refresh");
    const refresh = typeof refreshRaw === "string"
      ? ["1", "true", "yes"].includes(refreshRaw.toLowerCase())
      : false;
    const models = refresh
      ? await refreshAdapterModels(type)
      : await listAdapterModels(type);
    return Response.json(models);
  };

  const detectAdapterModelHandler: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const type = assertKnownAdapterType(ctx.param("type"));
    const detected = await detectAdapterModel(type);
    return Response.json(detected);
  };

  router.get("/companies/:companyId/adapters/:type/models", expressHandler(listAdapterModelsHandler, { db, storage: storageSentinel }));
  router.get("/companies/:companyId/adapters/:type/detect-model", expressHandler(detectAdapterModelHandler, { db, storage: storageSentinel }));

  const testAdapterEnvironmentHandler: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    const type = assertKnownAdapterType(ctx.param("type"));
    await assertCanReadConfigurations(ctx, companyId);

    const adapter = requireServerAdapter(type);

    const body = await ctx.json<{ adapterConfig?: Record<string, unknown>; environmentId?: string }>();
    const inputAdapterConfig = (body?.adapterConfig ?? {}) as Record<string, unknown>;
    const requestedEnvironmentId =
      typeof body?.environmentId === "string" && body.environmentId.trim().length > 0
        ? body.environmentId
        : null;
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      inputAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      companyId,
      normalizedAdapterConfig,
    );

    const { executionTarget, environmentName, fallbackChecks } =
      await resolveAdapterTestExecutionContext({
        companyId,
        adapterType: type,
        environmentId: requestedEnvironmentId,
      });

    const result = await adapter.testEnvironment({
      companyId,
      adapterType: type,
      config: runtimeAdapterConfig,
      executionTarget,
      environmentName,
    });

    if (fallbackChecks.length > 0) {
      const checks = [...fallbackChecks, ...result.checks];
      const status: typeof result.status = checks.some((c) => c.level === "error")
        ? "fail"
        : checks.some((c) => c.level === "warn")
          ? "warn"
          : result.status;
      return Response.json({ ...result, checks, status });
    }

    return Response.json(result);
  };

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    expressHandler(testAdapterEnvironmentHandler, { db, storage: storageSentinel }),
  );

  const listAgentSkills: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertCanReadConfigurations(ctx, agent.companyId);

    const adapter = findActiveServerAdapter(agent.adapterType);
    if (!adapter?.listSkills) {
      const preference = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      );
      const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId, {
        materializeMissing: false,
      });
      const requiredSkills = runtimeSkillEntries.filter((entry) => entry.required).map((entry) => entry.key);
      return Response.json(buildUnsupportedSkillSnapshot(agent.adapterType, Array.from(new Set([...requiredSkills, ...preference.desiredSkills]))));
    }

    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      agent.adapterConfig,
    );
    const runtimeSkillConfig = await buildRuntimeSkillConfig(
      agent.companyId,
      agent.adapterType,
      runtimeConfig,
    );
    const snapshot = await adapter.listSkills({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      config: runtimeSkillConfig,
    });
    return Response.json(snapshot);
  };

  const syncAgentSkills: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertCanUpdateAgent(ctx, agent);

    const body = await ctx.json<{ desiredSkills: string[] }>();
    const requestedSkills = Array.from(
      new Set(
        body.desiredSkills
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
    const {
      adapterConfig: nextAdapterConfig,
      desiredSkills,
      runtimeSkillEntries,
    } = await resolveDesiredSkillAssignment(
      agent.companyId,
      agent.adapterType,
      agent.adapterConfig as Record<string, unknown>,
      requestedSkills,
    );
    if (!desiredSkills || !runtimeSkillEntries) {
      throw unprocessable("Skill sync requires desiredSkills.");
    }
    const actor = getActorInfo(ctx);
    const updated = await svc.update(agent.id, {
      adapterConfig: nextAdapterConfig,
    }, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "skill-sync",
      },
    });
    if (!updated) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const adapter = findActiveServerAdapter(updated.adapterType);
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      updated.companyId,
      updated.adapterConfig,
    );
    const runtimeSkillConfig = {
      ...runtimeConfig,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
    const snapshot = adapter?.syncSkills
      ? await adapter.syncSkills({
          agentId: updated.id,
          companyId: updated.companyId,
          adapterType: updated.adapterType,
          config: runtimeSkillConfig,
        }, desiredSkills)
      : adapter?.listSkills
        ? await adapter.listSkills({
            agentId: updated.id,
            companyId: updated.companyId,
            adapterType: updated.adapterType,
            config: runtimeSkillConfig,
          })
        : buildUnsupportedSkillSnapshot(updated.adapterType, desiredSkills);

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent.skills_synced",
      entityType: "agent",
      entityId: updated.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        adapterType: updated.adapterType,
        desiredSkills,
        mode: snapshot.mode,
        supported: snapshot.supported,
        entryCount: snapshot.entries.length,
        warningCount: snapshot.warnings.length,
      },
    });

    return Response.json(snapshot);
  };

  router.get("/agents/:id/skills", expressHandler(listAgentSkills, { db, storage: storageSentinel }));
  router.post(
    "/agents/:id/skills/sync",
    validate(agentSkillSyncSchema),
    expressHandler(syncAgentSkills, { db, storage: storageSentinel }),
  );

  const listCompanyAgents: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    // The url.searchParams approach is used since ctx.query() only surfaces the first value.
    // Check for any unexpected query params by inspecting the URL.
    const searchParams = ctx.url.searchParams;
    const unsupportedQueryParams = Array.from(searchParams.keys()).sort();
    if (unsupportedQueryParams.length > 0) {
      return Response.json(
        { error: `Unsupported query parameter${unsupportedQueryParams.length === 1 ? "" : "s"}: ${unsupportedQueryParams.join(", ")}` },
        { status: 400 },
      );
    }
    const result = await svc.list(companyId);
    const canReadConfigs = await actorCanReadConfigurationsForCompany(ctx, companyId);
    if (canReadConfigs) {
      return Response.json(result);
    }
    return Response.json(result.map((agent) => redactForRestrictedAgentView(agent)));
  };

  const listSchedulerHeartbeats: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);

    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        companyName: companies.name,
        companyIssuePrefix: companies.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          companyId: row.companyId,
          companyName: row.companyName,
          companyIssuePrefix: row.companyIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          adapterType: row.adapterType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    return Response.json(items);
  };

  const getCompanyOrg: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    return Response.json(leanTree);
  };

  const getCompanyOrgSvg: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const styleRaw = ctx.query("style");
    const style = (ORG_CHART_STYLES.includes(styleRaw as OrgChartStyle) ? styleRaw : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    return new Response(svg, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" },
    });
  };

  const getCompanyOrgPng: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const styleRaw = ctx.query("style");
    const style = (ORG_CHART_STYLES.includes(styleRaw as OrgChartStyle) ? styleRaw : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    return new Response(png as unknown as BodyInit, {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-cache" },
    });
  };

  const listAgentConfigurations: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanReadConfigurations(ctx, companyId);
    const rows = await svc.list(companyId);
    return Response.json(rows.map((row) => redactAgentConfiguration(row)));
  };

  const getAgentMe: Handler = async (ctx) => {
    if (ctx.actor?.type !== "agent" || !ctx.actor.agentId) {
      return Response.json({ error: "Agent authentication required" }, { status: 401 });
    }
    const agent = await svc.getById(ctx.actor.agentId);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    return Response.json(await buildAgentDetail(agent));
  };

  router.get("/companies/:companyId/agents", expressHandler(listCompanyAgents, { db, storage: storageSentinel }));
  router.get("/instance/scheduler-heartbeats", expressHandler(listSchedulerHeartbeats, { db, storage: storageSentinel }));
  router.get("/companies/:companyId/org", expressHandler(getCompanyOrg, { db, storage: storageSentinel }));
  router.get("/companies/:companyId/org.svg", expressHandler(getCompanyOrgSvg, { db, storage: storageSentinel }));
  router.get("/companies/:companyId/org.png", expressHandler(getCompanyOrgPng, { db, storage: storageSentinel }));
  router.get("/companies/:companyId/agent-configurations", expressHandler(listAgentConfigurations, { db, storage: storageSentinel }));
  router.get("/agents/me", expressHandler(getAgentMe, { db, storage: storageSentinel }));

  const getAgentMeInboxLite: Handler = async (ctx) => {
    if (ctx.actor?.type !== "agent" || !ctx.actor.agentId || !ctx.actor.companyId) {
      return Response.json({ error: "Agent authentication required" }, { status: 401 });
    }

    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(ctx.actor.companyId, {
      assigneeAgentId: ctx.actor.agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });
    const dependencyReadiness = await issuesSvc.listDependencyReadiness(
      ctx.actor.companyId,
      rows.map((issue) => issue.id),
    );

    return Response.json(
      rows.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        updatedAt: issue.updatedAt,
        activeRun: issue.activeRun,
        dependencyReady: dependencyReadiness.get(issue.id)?.isDependencyReady ?? true,
        unresolvedBlockerCount: dependencyReadiness.get(issue.id)?.unresolvedBlockerCount ?? 0,
        unresolvedBlockerIssueIds: dependencyReadiness.get(issue.id)?.unresolvedBlockerIssueIds ?? [],
      })),
    );
  };

  const getAgentMeInboxMine: Handler = async (ctx) => {
    if (ctx.actor?.type !== "agent" || !ctx.actor.agentId || !ctx.actor.companyId) {
      return Response.json({ error: "Agent authentication required" }, { status: 401 });
    }

    const query = agentMineInboxQuerySchema.parse(Object.fromEntries(ctx.url.searchParams));
    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(ctx.actor.companyId, {
      touchedByUserId: query.userId,
      inboxArchivedByUserId: query.userId,
      status: query.status,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });

    return Response.json(rows);
  };

  const getAgent: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    assertCompanyAccess(ctx, agent.companyId);
    const isSelf = ctx.actor?.type === "agent" && ctx.actor.agentId === id;
    const canReadSensitiveDetail = isSelf
      ? true
      : await actorCanReadConfigurationsForCompany(ctx, agent.companyId);
    if (!canReadSensitiveDetail) {
      return Response.json(await buildAgentDetail(agent, { restricted: true }));
    }
    return Response.json(await buildAgentDetail(agent));
  };

  const getAgentConfiguration: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertCanReadConfigurations(ctx, agent.companyId);
    return Response.json(redactAgentConfiguration(agent));
  };

  const listAgentConfigRevisions: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertCanReadConfigurations(ctx, agent.companyId);
    const revisions = await svc.listConfigRevisions(agent.id);
    return Response.json(revisions.map((revision) => redactConfigRevision(revision)));
  };

  const getAgentConfigRevision: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const revisionId = ctx.param("revisionId")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertCanReadConfigurations(ctx, agent.companyId);
    const revision = await svc.getConfigRevision(agent.id, revisionId);
    if (!revision) {
      return Response.json({ error: "Revision not found" }, { status: 404 });
    }
    return Response.json(redactConfigRevision(revision));
  };

  const rollbackAgentConfigRevision: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const revisionId = ctx.param("revisionId")!;
    const existing = await svc.getById(id);
    if (!existing) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertCanUpdateAgent(ctx, existing);

    const actor = getActorInfo(ctx);
    const updated = await svc.rollbackConfigRevision(existing.id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      return Response.json({ error: "Revision not found" }, { status: 404 });
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    return Response.json(updated);
  };

  const getAgentRuntimeState: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertBoardCanManageAgentsForCompany(ctx, agent.companyId);
    assertCompanyAccess(ctx, agent.companyId);
    const state = await heartbeat.getRuntimeState(agent.id);
    return Response.json(state);
  };

  const listAgentTaskSessions: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertBoardCanManageAgentsForCompany(ctx, agent.companyId);
    assertCompanyAccess(ctx, agent.companyId);
    const sessions = await heartbeat.listTaskSessions(agent.id);
    return Response.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  };

  const resetAgentRuntimeSession: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    await assertBoardCanManageAgentsForCompany(ctx, agent.companyId);
    assertCompanyAccess(ctx, agent.companyId);

    const body = await ctx.json<{ taskKey?: string }>();
    const taskKey =
      typeof body.taskKey === "string" && body.taskKey.trim().length > 0
        ? body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(agent.id, { taskKey });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: agent.id,
      details: { taskKey: taskKey ?? null },
    });

    return Response.json(state);
  };

  router.get("/agents/me/inbox-lite", expressHandler(getAgentMeInboxLite, { db, storage: storageSentinel }));
  router.get("/agents/me/inbox/mine", expressHandler(getAgentMeInboxMine, { db, storage: storageSentinel }));
  router.get("/agents/:id", expressHandler(getAgent, { db, storage: storageSentinel }));
  router.get("/agents/:id/configuration", expressHandler(getAgentConfiguration, { db, storage: storageSentinel }));
  router.get("/agents/:id/config-revisions", expressHandler(listAgentConfigRevisions, { db, storage: storageSentinel }));
  router.get("/agents/:id/config-revisions/:revisionId", expressHandler(getAgentConfigRevision, { db, storage: storageSentinel }));
  router.post("/agents/:id/config-revisions/:revisionId/rollback", expressHandler(rollbackAgentConfigRevision, { db, storage: storageSentinel }));
  router.get("/agents/:id/runtime-state", expressHandler(getAgentRuntimeState, { db, storage: storageSentinel }));
  router.get("/agents/:id/task-sessions", expressHandler(listAgentTaskSessions, { db, storage: storageSentinel }));
  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), expressHandler(resetAgentRuntimeSession, { db, storage: storageSentinel }));

  const createAgentHire: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanCreateAgentsForCompany(ctx, companyId);
    const reqBody = await ctx.json<Record<string, unknown>>();
    const sourceIssueIds = parseSourceIssueIds(reqBody as { sourceIssueId?: string | null; sourceIssueIds?: string[] });
    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      sourceIssueId: _sourceIssueId,
      sourceIssueIds: _sourceIssueIds,
      ...hireInput
    } = reqBody as Record<string, unknown> & { desiredSkills?: string[]; instructionsBundle?: { files: Record<string, string>; entryFile?: string }; sourceIssueId?: string | null; sourceIssueIds?: string[] };
    hireInput.adapterType = assertKnownAdapterType(hireInput.adapterType as string | null | undefined);
    assertNoNewAgentLegacyPromptTemplate(
      hireInput.adapterType as string,
      (hireInput.adapterConfig ?? {}) as Record<string, unknown>,
    );
    assertNoAgentHostWorkspaceCommandMutation(
      ctx,
      collectAgentAdapterWorkspaceCommandPaths(hireInput.adapterConfig),
    );
    assertNoAgentInstructionsConfigMutation(
      ctx,
      (hireInput.adapterConfig ?? {}) as Record<string, unknown>,
    );
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      hireInput.adapterType as string,
      ((hireInput.adapterConfig ?? {}) as Record<string, unknown>),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      hireInput.adapterType as string,
      requestedAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      desiredSkillAssignment.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await assertAdapterConfigConstraints(
      companyId,
      hireInput.adapterType as string,
      normalizedAdapterConfig,
    );
    const normalizedHireInput = {
      ...hireInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizeNewAgentRuntimeConfig(hireInput.runtimeConfig),
    };

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const createdAgent = await svc.create(companyId, {
      ...normalizedHireInput,
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle);

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(ctx);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (agent.adapterConfig ?? normalizedHireInput.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          desiredSkills: desiredSkillAssignment.desiredSkills,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
            desiredSkills: desiredSkillAssignment.desiredSkills,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      actor.actorType === "user" ? actor.actorId : null,
    );

    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }

    return Response.json({ agent, approval }, { status: 201 });
  };

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), expressHandler(createAgentHire, { db, storage: storageSentinel }));

  const createAgent: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    await assertCanCreateAgentsForCompany(ctx, companyId);

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }
    if (company.requireBoardApprovalForNewAgents) {
      throw conflict(
        "Direct agent creation requires board approval. Use POST /api/companies/:companyId/agent-hires to create a pending hire approval.",
      );
    }

    const body = await ctx.json<Record<string, unknown>>();
    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      ...createInput
    } = body as Record<string, unknown> & { desiredSkills?: string[]; instructionsBundle?: unknown };
    (createInput as Record<string, unknown>).adapterType = assertKnownAdapterType((createInput as Record<string, unknown>).adapterType as string | null | undefined);
    assertNoNewAgentLegacyPromptTemplate(
      (createInput as Record<string, unknown>).adapterType as string,
      ((createInput as Record<string, unknown>).adapterConfig ?? {}) as Record<string, unknown>,
    );
    assertNoAgentHostWorkspaceCommandMutation(
      ctx,
      collectAgentAdapterWorkspaceCommandPaths((createInput as Record<string, unknown>).adapterConfig),
    );
    assertNoAgentInstructionsConfigMutation(
      ctx,
      ((createInput as Record<string, unknown>).adapterConfig ?? {}) as Record<string, unknown>,
    );
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      (createInput as Record<string, unknown>).adapterType as string,
      (((createInput as Record<string, unknown>).adapterConfig ?? {}) as Record<string, unknown>),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      (createInput as Record<string, unknown>).adapterType as string,
      requestedAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      companyId,
      desiredSkillAssignment.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await assertAdapterConfigConstraints(
      companyId,
      (createInput as Record<string, unknown>).adapterType as string,
      normalizedAdapterConfig,
    );
    await assertAgentEnvironmentSelection(companyId, (createInput as Record<string, unknown>).adapterType as string, (createInput as Record<string, unknown>).defaultEnvironmentId as string | null | undefined);
    await assertAgentDefaultEnvironmentSelection(companyId, (createInput as Record<string, unknown>).defaultEnvironmentId as string | null | undefined, {
      allowedDrivers: allowedEnvironmentDriversForAgent((createInput as Record<string, unknown>).adapterType as string),
      allowedSandboxProviders: allowedSandboxProvidersForAgent((createInput as Record<string, unknown>).adapterType as string),
    });

    const createdAgent = await svc.create(companyId, {
      ...(createInput as Record<string, unknown>),
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizeNewAgentRuntimeConfig((createInput as Record<string, unknown>).runtimeConfig),
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    } as Parameters<typeof svc.create>[1]);
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle as { files: Record<string, string>; entryFile?: string } | undefined);

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      ctx.actor?.type === "board" ? (ctx.actor.userId ?? null) : null,
    );

    if (agent.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: agent.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
    }

    return Response.json(agent, { status: 201 });
  };

  router.post("/companies/:companyId/agents", validate(createAgentSchema), expressHandler(createAgent, { db, storage: storageSentinel }));

  const updateAgentPermissions: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    assertCompanyAccess(ctx, existing.companyId);

    if (ctx.actor?.type === "agent") {
      const actorAgent = ctx.actor.agentId ? await svc.getById(ctx.actor.agentId) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      if (actorAgent.role !== "ceo") {
        return Response.json({ error: "Only CEO can manage permissions" }, { status: 403 });
      }
    } else {
      await assertBoardCanManageAgentsForCompany(ctx, existing.companyId);
    }

    const body = await ctx.json<Record<string, unknown>>();
    const agent = await svc.updatePermissions(id, body);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    const effectiveCanAssignTasks =
      agent.role === "ceo" || Boolean(agent.permissions?.canCreateAgents) || body.canAssignTasks;
    await access.ensureMembership(agent.companyId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      agent.companyId,
      "agent",
      agent.id,
      "tasks:assign",
      Boolean(effectiveCanAssignTasks),
      ctx.actor?.type === "board" ? (ctx.actor.userId ?? null) : null,
    );

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        canCreateAgents: agent.permissions?.canCreateAgents ?? false,
        canAssignTasks: Boolean(effectiveCanAssignTasks),
      },
    });

    return Response.json(await buildAgentDetail(agent));
  };

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), expressHandler(updateAgentPermissions, { db, storage: storageSentinel }));

  const updateAgentInstructionsPath: Handler = async (ctx) => {
    if (ctx.actor?.type !== "board") {
      throw forbidden("Only board-authenticated callers can manage instructions path or bundle configuration");
    }

    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });

    await assertCanManageInstructionsPath(ctx, existing);

    const body = await ctx.json<Record<string, unknown>>();
    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(body.adapterConfigKey);
    const defaultKey = resolveInstructionsPathKey(existing.adapterType);
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      return Response.json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      }, { status: 422 });
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      nextAdapterConfig[adapterConfigKey] = resolveInstructionsFilePath(body.path as string, existingAdapterConfig);
    }

    const syncedAdapterConfig = syncInstructionsBundleConfigFromFilePath(existing, nextAdapterConfig);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      syncedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const actor = getActorInfo(ctx);
    const agent = await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        adapterConfigKey,
        path: pathValue,
        cleared: body.path === null,
      },
    });

    return Response.json({
      agentId: agent.id,
      adapterType: agent.adapterType,
      adapterConfigKey,
      path: pathValue,
    });
  };

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), expressHandler(updateAgentInstructionsPath, { db, storage: storageSentinel }));

  const getAgentInstructionsBundle: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    await assertCanReadAgent(ctx, existing);
    return Response.json(await instructions.getBundle(existing));
  };

  const updateAgentInstructionsBundle: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    await assertCanManageInstructionsPath(ctx, existing);

    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const { bundle, adapterConfig } = await instructions.updateBundle(existing, body);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      existing.id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: body.clearLegacyPromptTemplate === true,
      },
    });

    return Response.json(bundle);
  };

  const getAgentInstructionsBundleFile: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    await assertCanReadAgent(ctx, existing);

    const relativePath = ctx.query("path") ?? "";
    if (!relativePath.trim()) {
      return Response.json({ error: "Query parameter 'path' is required" }, { status: 422 });
    }

    return Response.json(await instructions.readFile(existing, relativePath));
  };

  const upsertAgentInstructionsBundleFile: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    await assertCanManageInstructionsPath(ctx, existing);

    const body = await ctx.json<Record<string, unknown>>();
    const actor = getActorInfo(ctx);
    const result = await instructions.writeFile(existing, body.path as string, body.content as string, {
      clearLegacyPromptTemplate: body.clearLegacyPromptTemplate as boolean | undefined,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      existing.id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: body.clearLegacyPromptTemplate === true,
      },
    });

    return Response.json(result.file);
  };

  const deleteAgentInstructionsBundleFile: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    await assertCanManageInstructionsPath(ctx, existing);

    const relativePath = ctx.query("path") ?? "";
    if (!relativePath.trim()) {
      return Response.json({ error: "Query parameter 'path' is required" }, { status: 422 });
    }

    const actor = getActorInfo(ctx);
    const result = await instructions.deleteFile(existing, relativePath);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: { path: relativePath },
    });

    return Response.json(result.bundle);
  };

  router.get("/agents/:id/instructions-bundle", expressHandler(getAgentInstructionsBundle, { db, storage: storageSentinel }));
  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), expressHandler(updateAgentInstructionsBundle, { db, storage: storageSentinel }));
  router.get("/agents/:id/instructions-bundle/file", expressHandler(getAgentInstructionsBundleFile, { db, storage: storageSentinel }));
  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), expressHandler(upsertAgentInstructionsBundleFile, { db, storage: storageSentinel }));
  router.delete("/agents/:id/instructions-bundle/file", expressHandler(deleteAgentInstructionsBundleFile, { db, storage: storageSentinel }));

  const updateAgent: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const existing = await svc.getById(id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    await assertCanUpdateAgent(ctx, existing);

    const body = await ctx.json<Record<string, unknown>>();
    if (hasOwn(body as object, "permissions")) {
      return Response.json({ error: "Use /api/agents/:id/permissions for permission changes" }, { status: 422 });
    }

    const patchData = { ...body };
    const replaceAdapterConfig = patchData.replaceAdapterConfig === true;
    delete patchData.replaceAdapterConfig;
    if (hasOwn(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        return Response.json({ error: "adapterConfig must be an object" }, { status: 422 });
      }
      assertNoAgentInstructionsConfigMutation(ctx, adapterConfig);
      assertNoAgentHostWorkspaceCommandMutation(
        ctx,
        collectAgentAdapterWorkspaceCommandPaths(adapterConfig),
      );
      const changingInstructionsConfig = Object.keys(adapterConfig).some((key) =>
        KNOWN_INSTRUCTIONS_BUNDLE_KEYS.includes(key as (typeof KNOWN_INSTRUCTIONS_BUNDLE_KEYS)[number]),
      );
      if (changingInstructionsConfig) {
        await assertCanManageInstructionsPath(ctx, existing);
      }
      patchData.adapterConfig = adapterConfig;
    }

    const requestedAdapterType = hasOwn(patchData, "adapterType")
      ? assertKnownAdapterType(patchData.adapterType as string | null | undefined)
      : existing.adapterType;
    const touchesAdapterConfiguration =
      hasOwn(patchData, "adapterType") ||
      hasOwn(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
      const changingAdapterType =
        typeof patchData.adapterType === "string" && patchData.adapterType !== existing.adapterType;
      const requestedAdapterConfig = hasOwn(patchData, "adapterConfig")
        ? (asRecord(patchData.adapterConfig) ?? {})
        : null;
      if (
        requestedAdapterConfig
        && replaceAdapterConfig
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) =>
          existingAdapterConfig[key] !== undefined && requestedAdapterConfig[key] === undefined,
        )
      ) {
        await assertCanManageInstructionsPath(ctx, existing);
      }
      let rawEffectiveAdapterConfig = requestedAdapterConfig ?? existingAdapterConfig;
      if (requestedAdapterConfig && !changingAdapterType && !replaceAdapterConfig) {
        rawEffectiveAdapterConfig = { ...existingAdapterConfig, ...requestedAdapterConfig };
      }
      if (changingAdapterType) {
        // Preserve adapter-agnostic keys (env, cwd, etc.) from the existing config
        // when the adapter type changes. Without this, a PATCH that includes
        // adapterConfig but omits these keys would silently drop them.
        const ADAPTER_AGNOSTIC_KEYS = [
          "env", "cwd", "timeoutSec", "graceSec",
          "promptTemplate", "bootstrapPromptTemplate",
        ] as const;
        for (const key of ADAPTER_AGNOSTIC_KEYS) {
          if (rawEffectiveAdapterConfig[key] === undefined && existingAdapterConfig[key] !== undefined) {
            rawEffectiveAdapterConfig = { ...rawEffectiveAdapterConfig, [key]: existingAdapterConfig[key] };
          }
        }
        rawEffectiveAdapterConfig = preserveInstructionsBundleConfig(
          existingAdapterConfig,
          rawEffectiveAdapterConfig,
        );
      }
      const effectiveAdapterConfig = applyCreateDefaultsByAdapterType(
        requestedAdapterType,
        rawEffectiveAdapterConfig,
      );
      const normalizedEffectiveAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.companyId,
        effectiveAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      patchData.adapterConfig = syncInstructionsBundleConfigFromFilePath(existing, normalizedEffectiveAdapterConfig);
    }
    if (touchesAdapterConfiguration && requestedAdapterType === "opencode_local") {
      const effectiveAdapterConfig = asRecord(patchData.adapterConfig) ?? {};
      await assertAdapterConfigConstraints(
        existing.companyId,
        requestedAdapterType,
        effectiveAdapterConfig,
      );
    }
    if (touchesAdapterConfiguration || Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")) {
      await assertAgentDefaultEnvironmentSelection(
        existing.companyId,
        Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")
          ? (typeof patchData.defaultEnvironmentId === "string" ? patchData.defaultEnvironmentId : null)
          : existing.defaultEnvironmentId,
        {
          allowedDrivers: allowedEnvironmentDriversForAgent(requestedAdapterType),
          allowedSandboxProviders: allowedSandboxProvidersForAgent(requestedAdapterType),
        },
      );
    }

    const actor = getActorInfo(ctx);
    const agent = await svc.update(existing.id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
    });
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });

    return Response.json(agent);
  };

  router.patch("/agents/:id", validate(updateAgentSchema), expressHandler(updateAgent, { db, storage: storageSentinel }));

  const pauseAgent: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    if (!(await getAccessibleAgent(ctx, id))) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    const agent = await svc.pause(id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    return Response.json(agent);
  };

  const resumeAgent: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    if (!(await getAccessibleAgent(ctx, id))) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    const agent = await svc.resume(id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    return Response.json(agent);
  };

  const approveAgent: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const existing = await getAccessibleAgent(ctx, id);
    if (!existing) return Response.json({ error: "Agent not found" }, { status: 404 });
    if (existing.status !== "pending_approval") {
      return Response.json({ error: "Only pending approval agents can be approved" }, { status: 409 });
    }
    const approval = await svc.activatePendingApproval(id);
    if (!approval) return Response.json({ error: "Agent not found" }, { status: 404 });
    if (!approval.activated) {
      return Response.json({ error: "Only pending approval agents can be approved" }, { status: 409 });
    }
    const { agent } = approval;

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.approved",
      entityType: "agent",
      entityId: agent.id,
      details: { source: "agent_detail" },
    });

    return Response.json(agent);
  };

  const terminateAgent: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    if (!(await getAccessibleAgent(ctx, id))) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    const agent = await svc.terminate(id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
    });

    return Response.json(agent);
  };

  router.post("/agents/:id/pause", expressHandler(pauseAgent, { db, storage: storageSentinel }));
  router.post("/agents/:id/resume", expressHandler(resumeAgent, { db, storage: storageSentinel }));
  router.post("/agents/:id/approve", expressHandler(approveAgent, { db, storage: storageSentinel }));
  router.post("/agents/:id/terminate", expressHandler(terminateAgent, { db, storage: storageSentinel }));

  const deleteAgent: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    if (!(await getAccessibleAgent(ctx, id))) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }
    const agent = await svc.remove(id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });

    return Response.json({ ok: true });
  };

  router.delete("/agents/:id", expressHandler(deleteAgent, { db, storage: storageSentinel }));

  const listAgentKeys: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const agent = await getAccessibleAgent(ctx, id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
    const keys = await svc.listKeys(agent.id);
    return Response.json(keys);
  };

  const createAgentKey: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const agent = await getAccessibleAgent(ctx, id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
    const body = await ctx.json<Record<string, unknown>>();
    const key = await svc.createApiKey(agent.id, body.name as string);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.key_created",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    return Response.json(key, { status: 201 });
  };

  const revokeAgentKey: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const keyId = ctx.param("keyId")!;
    const agent = await getAccessibleAgent(ctx, id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });

    const key = await svc.getKeyById(keyId);
    if (!key || key.agentId !== agent.id) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }

    const revoked = await svc.revokeKey(agent.id, keyId);
    if (!revoked) return Response.json({ error: "Key not found" }, { status: 404 });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    return Response.json({ ok: true });
  };

  router.get("/agents/:id/keys", expressHandler(listAgentKeys, { db, storage: storageSentinel }));
  router.post("/agents/:id/keys", validate(createAgentKeySchema), expressHandler(createAgentKey, { db, storage: storageSentinel }));
  router.delete("/agents/:id/keys/:keyId", expressHandler(revokeAgentKey, { db, storage: storageSentinel }));

  const wakeupAgent: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
    assertCompanyAccess(ctx, agent.companyId);

    if (ctx.actor?.type === "agent") {
      if (ctx.actor.agentId !== agent.id) {
        return Response.json({ error: "Agent can only invoke itself" }, { status: 403 });
      }
    } else {
      await assertBoardCanManageAgentsForCompany(ctx, agent.companyId);
    }

    const body = await ctx.json<Record<string, unknown>>();
    const run = await heartbeat.wakeup(agent.id, {
      source: body.source as "timer" | "assignment" | "on_demand" | "automation",
      triggerDetail: ((body.triggerDetail as string | undefined) ?? "manual") as "system" | "manual" | "ping" | "callback",
      reason: (body.reason as string | null) ?? null,
      payload: (body.payload as Record<string, unknown> | null) ?? null,
      idempotencyKey: (body.idempotencyKey as string | null) ?? null,
      requestedByActorType: ctx.actor?.type === "agent" ? "agent" : "user",
      requestedByActorId: ctx.actor?.type === "agent" ? ctx.actor.agentId ?? null : (ctx.actor?.userId ?? null),
      contextSnapshot: {
        triggeredBy: ctx.actor?.type ?? "none",
        actorId: ctx.actor?.type === "agent" ? ctx.actor.agentId : ctx.actor?.userId,
        forceFreshSession: body.forceFreshSession === true,
      },
    });

    if (!run) {
      return Response.json(await buildSkippedWakeupResponse(agent, (body.payload as Record<string, unknown> | null) ?? null), { status: 202 });
    }

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    return Response.json(run, { status: 202 });
  };

  const invokeHeartbeat: Handler = async (ctx) => {
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
    assertCompanyAccess(ctx, agent.companyId);

    if (ctx.actor?.type === "agent") {
      if (ctx.actor.agentId !== id) {
        return Response.json({ error: "Agent can only invoke itself" }, { status: 403 });
      }
    } else {
      await assertBoardCanManageAgentsForCompany(ctx, agent.companyId);
    }

    const run = await heartbeat.invoke(
      id,
      "on_demand",
      {
        triggeredBy: ctx.actor?.type ?? "none",
        actorId: ctx.actor?.type === "agent" ? ctx.actor.agentId : ctx.actor?.userId,
      },
      "manual",
      {
        actorType: ctx.actor?.type === "agent" ? "agent" : "user",
        actorId: ctx.actor?.type === "agent" ? ctx.actor.agentId ?? null : (ctx.actor?.userId ?? null),
      },
    );

    if (!run) return Response.json({ status: "skipped" }, { status: 202 });

    const actor = getActorInfo(ctx);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    return Response.json(run, { status: 202 });
  };

  const claudeLogin: Handler = async (ctx) => {
    assertBoard(ctx);
    const id = ctx.param("id")!;
    const agent = await svc.getById(id);
    if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
    await assertBoardCanManageAgentsForCompany(ctx, agent.companyId);
    assertCompanyAccess(ctx, agent.companyId);
    if (agent.adapterType !== "claude_local") {
      return Response.json({ error: "Login is only supported for claude_local agents" }, { status: 400 });
    }

    const config = asRecord(agent.adapterConfig) ?? {};
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(agent.companyId, config);
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      config: runtimeConfig,
    });

    return Response.json(result);
  };

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), expressHandler(wakeupAgent, { db, storage: storageSentinel }));
  router.post("/agents/:id/heartbeat/invoke", expressHandler(invokeHeartbeat, { db, storage: storageSentinel }));
  router.post("/agents/:id/claude-login", expressHandler(claudeLogin, { db, storage: storageSentinel }));

  const listHeartbeatRuns: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);
    const agentId = ctx.query("agentId");
    const limitParam = ctx.query("limit");
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    const runs = await heartbeat.list(companyId, agentId, limit);
    return Response.json(runs);
  };

  router.get("/companies/:companyId/heartbeat-runs", expressHandler(listHeartbeatRuns, { db, storage: storageSentinel }));

  const listLiveRuns: Handler = async (ctx) => {
    const companyId = ctx.param("companyId")!;
    assertCompanyAccess(ctx, companyId);

    const minCount = readLiveRunsQueryInt(ctx.query("minCount"), 50);
    const limit = readLiveRunsQueryInt(ctx.query("limit"), 50);

    const columns = {
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      adapterType: agentsTable.adapterType,
      logBytes: heartbeatRuns.logBytes,
      livenessState: heartbeatRuns.livenessState,
      livenessReason: heartbeatRuns.livenessReason,
      continuationAttempt: heartbeatRuns.continuationAttempt,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      nextAction: heartbeatRuns.nextAction,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastOutputSeq: heartbeatRuns.lastOutputSeq,
      lastOutputStream: heartbeatRuns.lastOutputStream,
      lastOutputBytes: heartbeatRuns.lastOutputBytes,
      processStartedAt: heartbeatRuns.processStartedAt,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRunsQuery = db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const liveRuns = limit > 0 ? await liveRunsQuery.limit(limit) : await liveRunsQuery;
    const targetRunCount = limit > 0 ? Math.min(minCount, limit) : minCount;

    if (targetRunCount > 0 && liveRuns.length < targetRunCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(targetRunCount - liveRuns.length);

      const rows = [...liveRuns, ...recentRuns];
      return Response.json(await Promise.all(rows.map(async (run) => ({
        ...run,
        outputSilence: await heartbeat.buildRunOutputSilence(run),
      }))));
    }

    return Response.json(await Promise.all(liveRuns.map(async (run) => ({
      ...run,
      outputSilence: await heartbeat.buildRunOutputSilence(run),
    }))));
  };

  const getHeartbeatRun: Handler = async (ctx) => {
    const runId = ctx.param("runId")!;
    const run = await heartbeat.getRun(runId);
    if (!run) return Response.json({ error: "Heartbeat run not found" }, { status: 404 });
    assertCompanyAccess(ctx, run.companyId);
    const retryExhaustedReason = await heartbeat.getRetryExhaustedReason(runId);
    return Response.json(
      redactCurrentUserValue(
        { ...run, retryExhaustedReason, outputSilence: await heartbeat.buildRunOutputSilence(run) },
        await getCurrentUserRedactionOptions(),
      ),
    );
  };

  const cancelHeartbeatRun: Handler = async (ctx) => {
    assertBoard(ctx);
    const runId = ctx.param("runId")!;
    const existing = await heartbeat.getRun(runId);
    if (existing) {
      assertCompanyAccess(ctx, existing.companyId);
    }
    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: ctx.actor?.type === "board" ? (ctx.actor.userId ?? "board") : "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    return Response.json(run);
  };

  router.get("/companies/:companyId/live-runs", expressHandler(listLiveRuns, { db, storage: storageSentinel }));
  router.get("/heartbeat-runs/:runId", expressHandler(getHeartbeatRun, { db, storage: storageSentinel }));
  router.post("/heartbeat-runs/:runId/cancel", expressHandler(cancelHeartbeatRun, { db, storage: storageSentinel }));

  const recordWatchdogDecision: Handler = async (ctx) => {
    const runId = ctx.param("runId")!;
    const existing = await heartbeat.getRun(runId);
    if (!existing) return Response.json({ error: "Heartbeat run not found" }, { status: 404 });
    assertCompanyAccess(ctx, existing.companyId);
    const body = await ctx.json<Record<string, unknown>>();
    const decision = typeof body?.decision === "string" ? body.decision : "";
    if (!["snooze", "continue", "dismissed_false_positive"].includes(decision)) {
      return Response.json({ error: "Unsupported watchdog decision" }, { status: 400 });
    }
    const evaluationIssueId = typeof body?.evaluationIssueId === "string" ? body.evaluationIssueId : null;
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 4000) : null;
    const snoozedUntil = decision === "snooze" ? new Date(String(body?.snoozedUntil ?? "")) : null;
    if (decision === "snooze" && (!snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= new Date())) {
      return Response.json({ error: "snoozedUntil must be a future ISO datetime" }, { status: 400 });
    }
    const row = await recovery.recordWatchdogDecision({
      runId: existing.id,
      actor: ctx.actor ?? { type: "none" as const },
      decision: decision as "snooze" | "continue" | "dismissed_false_positive",
      evaluationIssueId,
      reason,
      snoozedUntil,
      createdByRunId: ctx.actor?.runId ?? null,
    });
    return Response.json(row);
  };

  const listHeartbeatRunEvents: Handler = async (ctx) => {
    const runId = ctx.param("runId")!;
    const run = await heartbeat.getRun(runId);
    if (!run) return Response.json({ error: "Heartbeat run not found" }, { status: 404 });
    assertCompanyAccess(ctx, run.companyId);
    const afterSeq = Number(ctx.query("afterSeq") ?? 0);
    const limit = Number(ctx.query("limit") ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const redactedEvents = events.map((event) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }, currentUserRedactionOptions),
    );
    return Response.json(redactedEvents);
  };

  const getHeartbeatRunLog: Handler = async (ctx) => {
    const runId = ctx.param("runId")!;
    const run = await heartbeat.getRunLogAccess(runId);
    if (!run) return Response.json({ error: "Heartbeat run not found" }, { status: 404 });
    assertCompanyAccess(ctx, run.companyId);
    const offset = Number(ctx.query("offset") ?? 0);
    const limitBytes = readRunLogLimitBytes(ctx.query("limitBytes"));
    const result = await heartbeat.readLog(run, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes,
    });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" } });
  };

  const listHeartbeatRunWorkspaceOperations: Handler = async (ctx) => {
    const runId = ctx.param("runId")!;
    const run = await heartbeat.getRun(runId);
    if (!run) return Response.json({ error: "Heartbeat run not found" }, { status: 404 });
    assertCompanyAccess(ctx, run.companyId);
    const context = asRecord(run.contextSnapshot);
    const executionWorkspaceId = asNonEmptyString(context?.executionWorkspaceId);
    const operations = await workspaceOperations.listForRun(runId, executionWorkspaceId);
    return Response.json(redactCurrentUserValue(operations, await getCurrentUserRedactionOptions()));
  };

  const getWorkspaceOperationLog: Handler = async (ctx) => {
    const operationId = ctx.param("operationId")!;
    const operation = await workspaceOperations.getById(operationId);
    if (!operation) return Response.json({ error: "Workspace operation not found" }, { status: 404 });
    assertCompanyAccess(ctx, operation.companyId);
    const offset = Number(ctx.query("offset") ?? 0);
    const limitBytes = readRunLogLimitBytes(ctx.query("limitBytes"));
    const result = await workspaceOperations.readLog(operationId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes,
    });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store" } });
  };

  const listIssueLiveRuns: Handler = async (ctx) => {
    const rawId = ctx.param("issueId")!;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
        logBytes: heartbeatRuns.logBytes,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
        nextAction: heartbeatRuns.nextAction,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        lastOutputSeq: heartbeatRuns.lastOutputSeq,
        lastOutputStream: heartbeatRuns.lastOutputStream,
        lastOutputBytes: heartbeatRuns.lastOutputBytes,
        processStartedAt: heartbeatRuns.processStartedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));
    return Response.json(await Promise.all(liveRuns.map(async (run) => ({
      ...run,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    }))));
  };

  const getIssueActiveRun: Handler = async (ctx) => {
    const rawId = ctx.param("issueId")!;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) return Response.json({ error: "Issue not found" }, { status: 404 });
    assertCompanyAccess(ctx, issue.companyId);
    let run = issue.executionRunId ? await heartbeat.getRunIssueSummary(issue.executionRunId) : null;
    if (
      run &&
      (
        (run.status !== "queued" && run.status !== "running") ||
        run.issueId !== issue.id
      )
    ) {
      run = null;
    }
    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunIssueSummaryForAgent(issue.assigneeAgentId);
      const candidateIssueId = asNonEmptyString(candidateRun?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) return Response.json(null);
    const agent = await svc.getById(run.agentId);
    if (!agent) return Response.json(null);
    return Response.json({
      ...run,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    });
  };

  router.post("/heartbeat-runs/:runId/watchdog-decisions", expressHandler(recordWatchdogDecision, { db, storage: storageSentinel }));
  router.get("/heartbeat-runs/:runId/events", expressHandler(listHeartbeatRunEvents, { db, storage: storageSentinel }));
  router.get("/heartbeat-runs/:runId/log", expressHandler(getHeartbeatRunLog, { db, storage: storageSentinel }));
  router.get("/heartbeat-runs/:runId/workspace-operations", expressHandler(listHeartbeatRunWorkspaceOperations, { db, storage: storageSentinel }));
  router.get("/workspace-operations/:operationId/log", expressHandler(getWorkspaceOperationLog, { db, storage: storageSentinel }));
  router.get("/issues/:issueId/live-runs", expressHandler(listIssueLiveRuns, { db, storage: storageSentinel }));
  router.get("/issues/:issueId/active-run", expressHandler(getIssueActiveRun, { db, storage: storageSentinel }));

  return router;
}
