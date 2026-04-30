/**
 * CfCompanySkillsService — Cloudflare Workers implementation of the skill
 * bundle storage layer.
 *
 * Background (from company-skills.ts):
 *   The Node server stores skill files in a local directory tree on the host
 *   filesystem: walkLocalFiles / collectLocalSkillInventory traverse that tree,
 *   readFile reads SKILL.md and supporting files at request time, and
 *   createLocalSkill / updateFile write Markdown to disk.
 *   materializeCatalogSkillFiles / materializeRuntimeSkillFiles copy skill
 *   files into runtime-materialised directories.
 *
 * Workers replacement strategy:
 *   - File content lives in R2, keyed as `skills/{companyId}/{skillId}/{relativePath}`.
 *   - Skill metadata (name, description, version, sourceType, trustLevel, …)
 *     is read from the database via the caller's db handle (D1 or Hyperdrive).
 *   - Local-path skills referencing host directories are not supported in a
 *     stateless Worker deployment; those are delegated to the sidecar via
 *     SidecarClient.getSkillBundle().
 *   - Live validation and skill execution are always delegated to the sidecar.
 *
 * Key data types (from company-skills.ts):
 *   CompanySkillFileDetail  — { path, size, language, content, editable, … }
 *   CompanySkillDetail      — extends CompanySkillListItem with a files array
 *   fileInventory           — JSON column on the DB row listing known paths
 *
 * All code here is Web-API-only — no Node imports.
 */

import type { SidecarClient } from "../sidecar-client.js";

// ---------------------------------------------------------------------------
// R2 key helpers
// ---------------------------------------------------------------------------

function skillPrefix(companyId: string, skillId: string): string {
  return `skills/${companyId}/${skillId}/`;
}

function skillKey(companyId: string, skillId: string, relativePath: string): string {
  return `${skillPrefix(companyId, skillId)}${relativePath}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CfCompanySkillsService {
  constructor(
    private r2: R2Bucket,
    private sidecar: SidecarClient,
  ) {}

  // -------------------------------------------------------------------------
  // Bundle read — assembles { files } from R2 objects
  //
  // Iterates all R2 objects under the skill prefix (mirrors walkLocalFiles) and
  // fetches each body in parallel. Falls back to the sidecar for source types
  // that require the host filesystem (local_path, catalog with live sync).
  // -------------------------------------------------------------------------

  async getSkillBundle(
    companyId: string,
    skillId: string,
  ): Promise<{ files: Record<string, string> }> {
    const prefix = skillPrefix(companyId, skillId);
    const list = await this.r2.list({ prefix });

    if (list.objects.length === 0) {
      // Nothing in R2 — ask the sidecar (covers local_path / catalog sources).
      return this.sidecar.getSkillBundle(companyId, skillId);
    }

    // Fetch all file bodies in parallel to keep latency low.
    const entries = await Promise.all(
      list.objects.map(async (obj) => {
        const result = await this.r2.get(obj.key);
        const content = result ? await result.text() : "";
        const relativePath = obj.key.replace(prefix, "");
        return [relativePath, content] as const;
      }),
    );

    return { files: Object.fromEntries(entries) };
  }

  // -------------------------------------------------------------------------
  // Single file read — mirrors readFile in company-skills.ts
  // -------------------------------------------------------------------------

  async getSkillFile(
    companyId: string,
    skillId: string,
    relativePath: string,
  ): Promise<string | null> {
    const result = await this.r2.get(skillKey(companyId, skillId, relativePath));
    return result ? result.text() : null;
  }

  // -------------------------------------------------------------------------
  // Write — mirrors createLocalSkill / updateFile in company-skills.ts
  // -------------------------------------------------------------------------

  async putSkillFile(
    companyId: string,
    skillId: string,
    relativePath: string,
    content: string,
  ): Promise<void> {
    await this.r2.put(skillKey(companyId, skillId, relativePath), content, {
      httpMetadata: { contentType: "text/plain" },
    });
  }

  // -------------------------------------------------------------------------
  // List — mirrors walkLocalFiles / collectLocalSkillInventory for managed skills
  // -------------------------------------------------------------------------

  async listSkillFiles(companyId: string, skillId: string): Promise<string[]> {
    const prefix = skillPrefix(companyId, skillId);
    const list = await this.r2.list({ prefix });
    return list.objects.map((obj) => obj.key.replace(prefix, ""));
  }

  // -------------------------------------------------------------------------
  // Delete — mirrors the rm calls made during skill deletion in company-skills.ts
  // -------------------------------------------------------------------------

  async deleteSkillBundle(companyId: string, skillId: string): Promise<void> {
    const prefix = skillPrefix(companyId, skillId);
    const list = await this.r2.list({ prefix });

    // Delete objects sequentially to avoid R2 rate limits on large bundles.
    for (const obj of list.objects) {
      await this.r2.delete(obj.key);
    }
  }
}
