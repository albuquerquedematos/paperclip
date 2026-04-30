/**
 * cf-extra-routes.ts
 *
 * CF-native handlers for API endpoints that use raw Express handlers in the
 * server package (making them invisible to extractRoutesFromRouter) or depend
 * on runtime registries (adapters, plugins) that don't exist in a CF Worker.
 *
 * Registered in app.ts BEFORE the /api/* catch-all so they shadow the 501.
 */

import type { Hono } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  agents,
  authUsers,
  companyMemberships,
  companySkills,
  invites,
  joinRequests,
} from "@paperclipai/db";
import { collapseDuplicatePendingHumanJoinRequests } from "../../../../server/src/lib/join-request-dedupe.js";
import { resolveHumanInviteRole } from "../../../../server/src/services/company-member-roles.js";
import { createHyperdriveDb } from "../db/hyperdrive.js";
import type { Env } from "./env.js";

// ---------------------------------------------------------------------------
// Helpers (inlined from server/src/routes/access.ts — CF-safe subsets)
// ---------------------------------------------------------------------------

function extractInviteMessage(invite: {
  defaultsPayload: unknown;
}): string | null {
  const raw = invite.defaultsPayload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = (raw as Record<string, unknown>).agentMessage;
  if (typeof msg !== "string") return null;
  const trimmed = msg.trim();
  return trimmed.length ? trimmed : null;
}

type SkillSourceBadge = "paperclip" | "skills_sh" | "github" | "url" | "local" | "catalog";

function deriveSkillSource(skill: {
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

export function registerCfExtraRoutes(app: Hono<{ Bindings: Env }>): void {
  // -------------------------------------------------------------------------
  // GET /api/adapters — no adapter registry in CF Workers
  // -------------------------------------------------------------------------
  app.get("/api/adapters", (c) => c.json([]));

  // -------------------------------------------------------------------------
  // GET /api/plugins — no plugin registry in CF Workers
  // GET /api/plugins/ui-contributions — no plugin registry in CF Workers
  // -------------------------------------------------------------------------
  app.get("/api/plugins", (c) => c.json([]));
  app.get("/api/plugins/ui-contributions", (c) => c.json([]));

  // -------------------------------------------------------------------------
  // GET /api/companies/:companyId/skills
  //
  // Mirrors companySkillService.list() but skips ensureSkillInventoryCurrent
  // (which uses node:fs) since CF Workers have no host filesystem.
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/skills", async (c) => {
    const companyId = c.req.param("companyId");
    const db = createHyperdriveDb(c.env.HYPERDRIVE);

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
  // GET /api/companies/:companyId/join-requests
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/join-requests", async (c) => {
    const companyId = c.req.param("companyId");
    const statusFilter = c.req.query("status");
    const requestTypeFilter = c.req.query("requestType");
    const db = createHyperdriveDb(c.env.HYPERDRIVE);

    const allRows = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId))
      .orderBy(desc(joinRequests.createdAt));

    const rows = collapseDuplicatePendingHumanJoinRequests(allRows);

    const inviteIds = [...new Set(rows.map((r) => r.inviteId))];
    const inviteRows = inviteIds.length
      ? await db.select().from(invites).where(inArray(invites.id, inviteIds))
      : [];
    const inviteMap = new Map(inviteRows.map((inv) => [inv.id, inv]));

    const userIds = [
      ...new Set(
        [
          ...rows.map((r) => r.requestingUserId),
          ...rows.map((r) => r.approvedByUserId),
          ...rows.map((r) => r.rejectedByUserId),
          ...inviteRows.map((inv) => inv.invitedByUserId),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const userRows = userIds.length
      ? await db
          .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name, image: authUsers.image })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds))
      : [];
    const userMap = new Map(
      userRows.map((u) => [u.id, { id: u.id, email: u.email ?? null, name: u.name ?? null, image: u.image ?? null }]),
    );

    const toUser = (id: string | null) => (id ? (userMap.get(id) ?? null) : null);

    const filtered = rows
      .map((row) => {
        const { claimSecretHash: _ch, ...safe } = row;
        const inv = inviteMap.get(row.inviteId) ?? null;
        return {
          ...safe,
          requesterUser: toUser(row.requestingUserId),
          approvedByUser: toUser(row.approvedByUserId),
          rejectedByUser: toUser(row.rejectedByUserId),
          invite: inv
            ? {
                id: inv.id,
                inviteType: inv.inviteType,
                allowedJoinTypes: inv.allowedJoinTypes,
                humanRole: resolveHumanInviteRole(inv.defaultsPayload as Record<string, unknown> | null),
                inviteMessage: extractInviteMessage(inv),
                createdAt: inv.createdAt,
                expiresAt: inv.expiresAt,
                revokedAt: inv.revokedAt,
                acceptedAt: inv.acceptedAt,
                invitedByUser: toUser(inv.invitedByUserId),
              }
            : null,
        };
      })
      .filter((row) => {
        if (statusFilter && row.status !== statusFilter) return false;
        if (requestTypeFilter && row.requestType !== requestTypeFilter) return false;
        return true;
      });

    return c.json(filtered);
  });

  // -------------------------------------------------------------------------
  // GET /api/companies/:companyId/user-directory
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/user-directory", async (c) => {
    const companyId = c.req.param("companyId");
    const db = createHyperdriveDb(c.env.HYPERDRIVE);

    const members = await db
      .select({ principalId: companyMemberships.principalId, status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(desc(companyMemberships.updatedAt));

    const userIds = [...new Set(members.map((m) => m.principalId))];
    const userRows = userIds.length
      ? await db
          .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name, image: authUsers.image })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds))
      : [];
    const userMap = new Map(
      userRows.map((u) => [u.id, { id: u.id, email: u.email ?? null, name: u.name ?? null, image: u.image ?? null }]),
    );

    const users = members.map((m) => ({
      principalId: m.principalId,
      status: "active" as const,
      user: userMap.get(m.principalId) ?? null,
    }));

    return c.json({ users });
  });

  // -------------------------------------------------------------------------
  // GET /api/companies/:companyId/events/ws
  //
  // CF-native WebSocket upgrade. Without a Durable Object pub/sub bus, the
  // connection stays open but receives no server-sent events. The frontend
  // treats this as a connected (but silent) event stream, which is better
  // than a hard error.
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/events/ws", (c) => {
    const upgrade = c.req.header("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return c.text("Expected WebSocket upgrade", 426);
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.addEventListener("message", () => { /* no-op: no pub/sub wired yet */ });
    return new Response(null, { status: 101, webSocket: client });
  });
}
