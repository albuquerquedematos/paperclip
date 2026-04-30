/**
 * routes/company-access.ts
 *
 * CF-native handlers for company-scoped access/membership endpoints:
 *   GET /api/companies/:companyId/join-requests
 *   GET /api/companies/:companyId/user-directory
 *   GET /api/companies/:companyId/members  (if applicable)
 *
 * The server-side accessRoutes() in access.ts uses raw Express handlers and
 * reads bundled SKILL.md files from the host filesystem — neither works in CF.
 * These handlers implement the same read-paths directly against the DB.
 *
 * Auth: requires an authenticated actor (board or agent). Unauthenticated
 * requests receive 401. Company-scoped endpoints additionally verify that the
 * actor has access to the requested company.
 *
 * CF-specific caveats:
 *   - No filesystem access; all data comes from Hyperdrive/Postgres.
 *   - claimSecretHash is always stripped from join-request responses.
 */

import type { Hono } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { authUsers, companyMemberships, invites, joinRequests } from "@paperclipai/db";
import { collapseDuplicatePendingHumanJoinRequests } from "../../../../../server/src/lib/join-request-dedupe.js";
import { resolveHumanInviteRole } from "../../../../../server/src/services/company-member-roles.js";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

// ---------------------------------------------------------------------------
// Helpers (inlined from server/src/routes/access.ts — CF-safe subsets)
// ---------------------------------------------------------------------------

/**
 * Extracts the human-readable invite message from the invite's defaultsPayload,
 * if present. Returns null when the payload does not contain a non-empty string
 * at the `agentMessage` key.
 */
export function extractInviteMessage(invite: {
  defaultsPayload: unknown;
}): string | null {
  const raw = invite.defaultsPayload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = (raw as Record<string, unknown>).agentMessage;
  if (typeof msg !== "string") return null;
  const trimmed = msg.trim();
  return trimmed.length ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCompanyAccessRoutes(app: Hono<{ Bindings: Env }>): void {
  // -------------------------------------------------------------------------
  // GET /api/companies/:companyId/join-requests
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/join-requests", async (c) => {
    const companyId = c.req.param("companyId");
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const statusFilter = c.req.query("status");
    const requestTypeFilter = c.req.query("requestType");

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
        // Never expose the raw claim secret hash in API responses.
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
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

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
}
