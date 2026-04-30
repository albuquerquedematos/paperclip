/**
 * routes/company-skills-cf.ts
 *
 * CF-native handler for GET /api/companies/:companyId/skills.
 *
 * The server-side companySkillService.list() calls ensureSkillInventoryCurrent()
 * which reads SKILL.md files from the host filesystem — this is not available
 * in a CF Worker. This handler mirrors the DB query portion of that service,
 * returning the same shape but skipping filesystem-based inventory sync.
 *
 * Auth: requires an authenticated actor (board or agent). Unauthenticated
 * requests receive 401.
 *
 * CF-specific caveats:
 *   - No filesystem access; skill inventory is not refreshed in CF.
 *   - sourcePath is always null (local paths are host-only).
 *   - attachedAgentCount is computed via a direct adapterConfig scan rather
 *     than resolveDesiredSkillKeys (which uses non-exported internals).
 */

import type { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { agents, companySkills } from "@paperclipai/db";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
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
}
