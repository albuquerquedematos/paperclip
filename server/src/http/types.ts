import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";

/** Normalized actor from auth middleware — only set when authenticated (not "none"). */
export interface ActorContext {
  type: "board" | "agent";
  userId?: string;
  agentId?: string;
  companyId?: string;
}

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
