import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";

export interface ActorMembership {
  companyId: string;
  membershipRole: string;
  status: string;
}

export type ActorSource =
  | "local_implicit"
  | "session"
  | "board_key"
  | "agent_jwt"
  | "agent_key"
  | "none";

export interface BoardActor {
  type: "board";
  source: ActorSource;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  isInstanceAdmin: boolean;
  companyIds?: string[];
  memberships?: ActorMembership[];
  keyId?: string;
  runId?: string;
}

export interface AgentActor {
  type: "agent";
  source: ActorSource;
  agentId: string;
  companyId: string;
  keyId?: string;
  runId?: string;
}

/** Full actor — mirrors the shape set by actorMiddleware. null when unauthenticated ("none"). */
export type ActorContext = BoardActor | AgentActor;

/** Minimal normalized request passed to every handler. */
export interface RequestCtx {
  method: string;
  url: URL;
  headers: Headers;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  /** Path param: e.g. ctx.param("companyId") */
  param(name: string): string | undefined;
  /** Query param */
  query(name: string): string | undefined;
  actor: ActorContext | null;
  db: Db;
  storage: StorageService;
}

export type Handler = (ctx: RequestCtx) => Promise<Response>;

export interface RouteDefinition {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Express-style path, e.g. /api/companies/:companyId */
  path: string;
  handler: Handler;
}
