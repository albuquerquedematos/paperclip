import { forbidden, unauthorized } from "../errors.js";
import type { ActorMembership } from "../http/types.js";

/**
 * Minimal structural interface satisfied by both Express Request (post-actorMiddleware)
 * and RequestCtx, allowing authz helpers to work in both Express handlers and
 * transport-agnostic Handler functions.
 */
export interface AuthzReq {
  actor:
    | {
        type: string;
        source?: string;
        isInstanceAdmin?: boolean;
        companyIds?: string[];
        memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
        userId?: string;
        agentId?: string;
        companyId?: string;
        runId?: string;
      }
    | null
    | undefined;
  method: string;
}

function isAuthenticated(req: AuthzReq): boolean {
  return !!req.actor && req.actor.type !== "none";
}

export function assertAuthenticated(req: AuthzReq): void {
  if (!isAuthenticated(req)) throw unauthorized();
}

export function assertBoard(req: AuthzReq): void {
  if (!req.actor || req.actor.type !== "board") throw forbidden("Board access required");
}

export function hasBoardOrgAccess(req: AuthzReq): boolean {
  if (!req.actor || req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: AuthzReq): void {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) return;
  throw forbidden("Company membership or instance admin access required");
}

export function assertInstanceAdmin(req: AuthzReq): void {
  assertBoard(req);
  if (req.actor?.source === "local_implicit" || req.actor?.isInstanceAdmin) return;
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: AuthzReq, companyId: string): void {
  assertAuthenticated(req);
  if (!req.actor) return;

  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }

  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if ((membership as ActorMembership).membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

export function getActorInfo(req: AuthzReq) {
  assertAuthenticated(req);
  if (!req.actor) throw unauthorized();

  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
