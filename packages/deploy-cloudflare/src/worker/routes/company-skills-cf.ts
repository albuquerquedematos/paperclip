/**
 * routes/company-skills-cf.ts
 *
 * CF-native handlers for /api/companies/:companyId/skills/*.
 *
 * The server-side companySkillService relies on the host filesystem for
 * SKILL.md inventory sync, file reads, and local-path mutations. CF Workers
 * have no filesystem, so we split the work two ways:
 *
 *   1. DB-readable routes (list, detail, update-status) read directly from
 *      Hyperdrive using `deriveSkillSource` for source metadata. These are
 *      always available, with `sourcePath: null` and no inventory refresh.
 *   2. File/install routes (POST/PATCH/DELETE skills, files, install-update)
 *      proxy to the sidecar, which runs the original server handlers with
 *      filesystem access.
 *
 * Auth: every handler resolves an actor; unauthenticated callers get 401.
 */

import type { Context, Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { agents, companySkills } from "@paperclipai/db";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { safeProxyToSidecar } from "../../sidecar-client.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

// ---------------------------------------------------------------------------
// Skill source derivation (inlined from server — CF-safe subset)
// ---------------------------------------------------------------------------

export type SkillSourceBadge = "paperclip" | "skills_sh" | "github" | "url" | "local" | "catalog";

/**
 * Derives display metadata for a skill's source.
 *
 * The `sourcePath` field is always null in CF Workers because local paths
 * are host-side filesystem locations that do not exist in the worker sandbox.
 */
export function deriveSkillSource(skill: {
  sourceType: string;
  sourceLocator: string | null;
  metadata: unknown;
}): {
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: SkillSourceBadge;
  sourcePath: null;
} {
  const meta =
    skill.metadata && typeof skill.metadata === "object" && !Array.isArray(skill.metadata)
      ? (skill.metadata as Record<string, unknown>)
      : {};

  if (meta.sourceKind === "paperclip_bundled") {
    return { editable: false, editableReason: "Bundled Paperclip skills are read-only.", sourceLabel: "Paperclip bundled", sourceBadge: "paperclip", sourcePath: null };
  }
  if (skill.sourceType === "skills_sh") {
    return { editable: false, editableReason: "Skills.sh-managed skills are read-only.", sourceLabel: skill.sourceLocator, sourceBadge: "skills_sh", sourcePath: null };
  }
  if (skill.sourceType === "github") {
    const owner = typeof meta.owner === "string" ? meta.owner : null;
    const repo = typeof meta.repo === "string" ? meta.repo : null;
    return { editable: false, editableReason: "Remote GitHub skills are read-only.", sourceLabel: owner && repo ? `${owner}/${repo}` : skill.sourceLocator, sourceBadge: "github", sourcePath: null };
  }
  if (skill.sourceType === "url") {
    return { editable: false, editableReason: "URL-based skills are read-only.", sourceLabel: skill.sourceLocator, sourceBadge: "url", sourcePath: null };
  }
  if (skill.sourceType === "local_path") {
    return { editable: true, editableReason: null, sourceLabel: skill.sourceLocator, sourceBadge: "local", sourcePath: null };
  }
  return { editable: false, editableReason: "This skill source is read-only.", sourceLabel: skill.sourceLocator, sourceBadge: "catalog", sourcePath: null };
}

// ---------------------------------------------------------------------------
// Sidecar proxy (for filesystem-bound routes)
// ---------------------------------------------------------------------------

/** Forward the current request to the sidecar (with crash protection). */
async function proxyToSidecar(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  return safeProxyToSidecar({
    env: c.env,
    path: url.pathname + url.search,
    method: c.req.method,
    contentType: c.req.header("Content-Type") ?? null,
    body: c.req.raw.body,
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCompanySkillRoutes(app: Hono<{ Bindings: Env }>): void {
  // -------------------------------------------------------------------------
  // GET /api/companies/:companyId/skills
  //
  // Mirrors companySkillService.list() but skips ensureSkillInventoryCurrent
  // (which uses node:fs) since CF Workers have no host filesystem.
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/skills", async (c) => {
    const companyId = c.req.param("companyId");
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const rows = await db
      .select({
        id: companySkills.id,
        companyId: companySkills.companyId,
        key: companySkills.key,
        slug: companySkills.slug,
        name: companySkills.name,
        description: companySkills.description,
        sourceType: companySkills.sourceType,
        sourceLocator: companySkills.sourceLocator,
        sourceRef: companySkills.sourceRef,
        trustLevel: companySkills.trustLevel,
        compatibility: companySkills.compatibility,
        fileInventory: companySkills.fileInventory,
        metadata: companySkills.metadata,
        createdAt: companySkills.createdAt,
        updatedAt: companySkills.updatedAt,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name), asc(companySkills.key));

    // attachedAgentCount: resolveDesiredSkillKeys uses non-exported internals;
    // query agents and do a simple adapterConfig scan instead.
    const agentRows = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const result = rows.map((row) => {
      const source = deriveSkillSource({
        sourceType: row.sourceType,
        sourceLocator: row.sourceLocator ?? null,
        metadata: row.metadata,
      });

      const attachedAgentCount = agentRows.filter((agent) => {
        const cfg = agent.adapterConfig;
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
        const skillsValue = (cfg as Record<string, unknown>).skills;
        if (!Array.isArray(skillsValue)) return false;
        return skillsValue.some(
          (entry) =>
            (typeof entry === "string" && entry === row.key) ||
            (entry && typeof entry === "object" && (entry as Record<string, unknown>).key === row.key),
        );
      }).length;

      return {
        id: row.id,
        companyId: row.companyId,
        key: row.key,
        slug: row.slug,
        name: row.name,
        description: row.description ?? null,
        sourceType: row.sourceType,
        sourceLocator: row.sourceLocator ?? null,
        sourceRef: row.sourceRef ?? null,
        trustLevel: row.trustLevel,
        compatibility: row.compatibility,
        fileInventory: Array.isArray(row.fileInventory) ? row.fileInventory : [],
        metadata: row.metadata ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        attachedAgentCount,
        ...source,
      };
    });

    return c.json(result);
  });

  // -------------------------------------------------------------------------
  // GET /api/companies/:companyId/skills/:skillId — single skill detail
  // (DB-only; mirrors svc.detail() without filesystem inventory sync)
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/skills/:skillId", async (c) => {
    const companyId = c.req.param("companyId");
    const skillId = c.req.param("skillId");
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const row = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, skillId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return c.json({ error: "Skill not found" }, 404);

    const source = deriveSkillSource({
      sourceType: row.sourceType,
      sourceLocator: row.sourceLocator ?? null,
      metadata: row.metadata,
    });

    // usedByAgents: agents whose adapterConfig.skills references this skill.
    // The UI's CompanySkills detail panel reads `detail.usedByAgents.length`
    // and crashes if missing — so we always populate at least an empty array.
    // Mirrors the list-endpoint scan but keeps full agent records (vs. just count).
    const agentRows = await db
      .select({
        id: agents.id,
        name: agents.name,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const usedByAgents = agentRows
      .filter((agent) => {
        const cfg = agent.adapterConfig;
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
        const skillsValue = (cfg as Record<string, unknown>).skills;
        if (!Array.isArray(skillsValue)) return false;
        return skillsValue.some(
          (entry) =>
            (typeof entry === "string" && entry === row.key) ||
            (entry && typeof entry === "object" && (entry as Record<string, unknown>).key === row.key),
        );
      })
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        urlKey: deriveAgentUrlKey(agent.name, agent.id),
        adapterType: agent.adapterType,
        desired: true,
        actualState: null,
      }));

    return c.json({
      id: row.id,
      companyId: row.companyId,
      key: row.key,
      slug: row.slug,
      name: row.name,
      description: row.description ?? null,
      sourceType: row.sourceType,
      sourceLocator: row.sourceLocator ?? null,
      sourceRef: row.sourceRef ?? null,
      trustLevel: row.trustLevel,
      compatibility: row.compatibility,
      fileInventory: Array.isArray(row.fileInventory) ? row.fileInventory : [],
      metadata: row.metadata ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attachedAgentCount: usedByAgents.length,
      usedByAgents,
      ...source,
    });
  });

  // -------------------------------------------------------------------------
  // Filesystem-bound skill routes — proxy to sidecar.
  // The sidecar runs the original server handlers with disk + git access.
  // -------------------------------------------------------------------------
  const proxyHandler = async (c: Context<{ Bindings: Env }>) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    return proxyToSidecar(c);
  };

  app.get("/api/companies/:companyId/skills/:skillId/update-status", proxyHandler);
  app.get("/api/companies/:companyId/skills/:skillId/files", proxyHandler);
  app.post("/api/companies/:companyId/skills", proxyHandler);
  app.patch("/api/companies/:companyId/skills/:skillId/files", proxyHandler);
  app.delete("/api/companies/:companyId/skills/:skillId", proxyHandler);
  app.post("/api/companies/:companyId/skills/:skillId/install-update", proxyHandler);
  // Bulk-import skills from a URL/path/repo — touches fs (clones, reads .md),
  // so always goes to the sidecar.
  app.post("/api/companies/:companyId/skills/import", proxyHandler);
  // Scan repos/projects for skills to import.
  app.post("/api/companies/:companyId/skills/scan-projects", proxyHandler);
}
