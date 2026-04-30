/**
 * resolve-actor.ts — Cloudflare Workers port of the Express actorMiddleware.
 *
 * Resolves the authenticated actor from a Web API `Request` object without
 * depending on any Node-only modules (`node:crypto`, Express types, etc.).
 *
 * SHA-256 hashing uses the Web Crypto API (`crypto.subtle`) which is available
 * in both the Workers runtime and modern Node.js (>= 19 with global `crypto`).
 *
 * BetterAuth session lookup is skipped for the Workers deployment — the CF
 * Worker authenticates via Bearer tokens (agent JWTs, agent API keys, and
 * board API keys). UI sessions that rely on HTTP-only cookies must go through
 * BetterAuth's own `/api/auth/*` handler, which is mounted separately.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authUsers, boardApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { ActorContext } from "../../../../server/src/http/types.js";
import { verifyLocalAgentJwt } from "../../../../server/src/agent-auth-jwt.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash a token using the Web Crypto API, returning a lowercase hex string. */
async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the board actor memberships for a given userId.
 * Queries `companyMemberships` and `instanceUserRoles` in parallel.
 */
async function resolveBoardAccess(db: Db, userId: string) {
  const [user, memberships, adminRole] = await Promise.all([
    db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      ),
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
  ]);

  return {
    user,
    companyIds: memberships.map((row) => row.companyId),
    memberships,
    isInstanceAdmin: Boolean(adminRole),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DeploymentMode = "local_trusted" | "authenticated";

/**
 * Resolves the actor from the incoming Web API `Request`.
 *
 * Resolution order:
 * 1. `local_trusted` mode → always returns a local implicit board actor (no DB
 *    queries needed).
 * 2. `Authorization: Bearer <token>` header:
 *    a. Board API key (pcp_board_* tokens stored in `boardApiKeys`).
 *    b. Agent API key (hash stored in `agentApiKeys`).
 *    c. Agent JWT (HMAC-signed token; verified without DB lookup).
 * 3. No Bearer token or unrecognised token → returns `null` (unauthenticated).
 *
 * Note: Cookie-based BetterAuth sessions are not resolved here. The Cloudflare
 * deployment uses the BetterAuth `/api/auth/*` handler separately, and the UI
 * exchanges the session cookie for a Board API key on first visit.
 */
export async function resolveActorFromRequest(
  request: Request,
  db: Db,
  opts: { deploymentMode: DeploymentMode },
): Promise<ActorContext | null> {
  // 1. Local trusted mode — skip all auth checks.
  if (opts.deploymentMode === "local_trusted") {
    return {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      userName: "Local Board",
      userEmail: null,
      isInstanceAdmin: true,
    };
  }

  const runIdHeader = request.headers.get("x-paperclip-run-id") ?? undefined;

  // 2. Bearer token
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = authHeader.slice("bearer ".length).trim();
  if (!token) return null;

  // 2a. Board API key — stored as pcp_board_* with a hash in boardApiKeys table.
  const tokenHash = await hashToken(token);
  const boardKey = await db
    .select()
    .from(boardApiKeys)
    .where(and(eq(boardApiKeys.keyHash, tokenHash), isNull(boardApiKeys.revokedAt)))
    .then((rows) => {
      const now = new Date();
      return rows.find((row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime()) ?? null;
    });

  if (boardKey) {
    const access = await resolveBoardAccess(db, boardKey.userId);
    if (access.user) {
      // Touch lastUsedAt asynchronously — don't block the response.
      void db
        .update(boardApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(boardApiKeys.id, boardKey.id));

      return {
        type: "board",
        source: "board_key",
        userId: boardKey.userId,
        userName: access.user.name ?? null,
        userEmail: access.user.email ?? null,
        companyIds: access.companyIds,
        memberships: access.memberships.map((m) => ({ ...m, membershipRole: m.membershipRole ?? "" })),
        isInstanceAdmin: access.isInstanceAdmin,
        keyId: boardKey.id,
        runId: runIdHeader,
      };
    }
  }

  // 2b. Agent API key — hash stored in agentApiKeys.
  const agentKey = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (agentKey) {
    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentKey.agentId))
      .then((rows) => rows[0] ?? null);

    if (
      agentRecord &&
      agentRecord.status !== "terminated" &&
      agentRecord.status !== "pending_approval"
    ) {
      // Touch lastUsedAt asynchronously.
      void db
        .update(agentApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentApiKeys.id, agentKey.id));

      return {
        type: "agent",
        source: "agent_key",
        agentId: agentKey.agentId,
        companyId: agentKey.companyId,
        keyId: agentKey.id,
        runId: runIdHeader,
      };
    }
    // Key exists but agent is terminated/pending — fall through to return null.
    return null;
  }

  // 2c. Agent JWT — verified with HMAC secret; no DB lookup needed for
  //     the signature, but we validate the agent still exists and is active.
  const claims = verifyLocalAgentJwt(token);
  if (claims) {
    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, claims.sub))
      .then((rows) => rows[0] ?? null);

    if (
      agentRecord &&
      agentRecord.companyId === claims.company_id &&
      agentRecord.status !== "terminated" &&
      agentRecord.status !== "pending_approval"
    ) {
      return {
        type: "agent",
        source: "agent_jwt",
        agentId: claims.sub,
        companyId: claims.company_id,
        runId: runIdHeader ?? claims.run_id ?? undefined,
      };
    }
  }

  // Unrecognised or invalid token.
  return null;
}
