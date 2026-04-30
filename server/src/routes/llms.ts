import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { AGENT_ICON_NAMES } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { listServerAdapters } from "../adapters/index.js";
import { agentService } from "../services/agents.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler, RequestCtx } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

function hasCreatePermission(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

function textPlain(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function buildHandlers(db: Db) {
  const agentsSvc = agentService(db);

  async function assertCanRead(ctx: RequestCtx) {
    if (ctx.actor?.type === "board") return;
    if (ctx.actor?.type !== "agent" || !ctx.actor.agentId) {
      throw forbidden("Board or permitted agent authentication required");
    }
    const actorAgent = await agentsSvc.getById(ctx.actor.agentId);
    if (!actorAgent || !hasCreatePermission(actorAgent)) {
      throw forbidden("Missing permission to read agent configuration reflection");
    }
  }

  // server/src/routes/llms.ts:28
  const getAgentConfigurationIndex: Handler = async (ctx) => {
    await assertCanRead(ctx);
    const adapters = listServerAdapters().sort((a, b) => a.type.localeCompare(b.type));
    const lines = [
      "# Paperclip Agent Configuration Index",
      "",
      "Installed adapters:",
      ...adapters.map((adapter) => `- ${adapter.type}: /llms/agent-configuration/${adapter.type}.txt`),
      "",
      "Related API endpoints:",
      "- GET /api/companies/:companyId/agent-configurations",
      "- GET /api/agents/:id/configuration",
      "- POST /api/companies/:companyId/agent-hires",
      "",
      "Agent identity references:",
      "- GET /llms/agent-icons.txt",
      "",
      "Notes:",
      "- Sensitive values are redacted in configuration read APIs.",
      "- New hires may be created in pending_approval state depending on company settings.",
      "- Use the paperclip-create-agent skill for end-to-end hiring: adapter reflection, config comparison, instruction source selection, icon choice, desiredSkills, sourceIssueId/sourceIssueIds, and approval follow-up.",
      "- Timer heartbeats are opt-in for new hires. Leave runtimeConfig.heartbeat.enabled false unless the role truly needs scheduled work or the user explicitly asked for it.",
      "",
    ];
    return textPlain(lines.join("\n"));
  };

  // server/src/routes/llms.ts:55
  const getAgentIcons: Handler = async (ctx) => {
    await assertCanRead(ctx);
    const lines = [
      "# Paperclip Agent Icon Names",
      "",
      "Set the `icon` field on hire/create payloads to one of:",
      ...AGENT_ICON_NAMES.map((name) => `- ${name}`),
      "",
      "Example:",
      '{ "name": "SearchOps", "role": "researcher", "icon": "search" }',
      "",
    ];
    return textPlain(lines.join("\n"));
  };

  // server/src/routes/llms.ts:70
  const getAdapterConfiguration: Handler = async (ctx) => {
    await assertCanRead(ctx);
    const adapterType = ctx.param("adapterType") ?? "";
    const adapter = listServerAdapters().find((entry) => entry.type === adapterType);
    if (!adapter) {
      return new Response(`Unknown adapter type: ${adapterType}`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return textPlain(
      adapter.agentConfigurationDoc ??
        `# ${adapterType} agent configuration\n\nNo adapter-specific documentation registered.`,
    );
  };

  return { getAgentConfigurationIndex, getAgentIcons, getAdapterConfiguration };
}

export function llmRoutes(db: Db) {
  const router = Router();
  const { getAgentConfigurationIndex, getAgentIcons, getAdapterConfiguration } = buildHandlers(db);

  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`llm handler unexpectedly accessed storage.${String(prop)}`);
    },
  });
  const deps = { db, storage: storageSentinel };

  router.get("/llms/agent-configuration.txt", expressHandler(getAgentConfigurationIndex, deps));
  router.get("/llms/agent-icons.txt", expressHandler(getAgentIcons, deps));
  router.get("/llms/agent-configuration/:adapterType.txt", expressHandler(getAdapterConfiguration, deps));

  return router;
}
