import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import type { ActorContext, ActorMembership, Handler, RequestCtx } from "./types.js";

export interface AdapterDeps {
  db: Db;
  storage: StorageService;
}

/**
 * Wraps a transport-agnostic {@link Handler} as an Express {@link RequestHandler}.
 *
 * Bridging notes:
 * - `req.body` is already parsed by express.json(); json() returns it directly
 *   so the raw body is never re-parsed.
 * - Path params come from `req.params`, query params from `req.query`.
 * - `req.actor.type === "none"` is normalised to `null` so handlers can do a
 *   simple null-check rather than inspecting the string.
 * - The Web API `Response` returned by the handler is forwarded to Express `res`
 *   by copying status, headers, and body.
 */
export function expressHandler(handler: Handler, deps: AdapterDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      // Build the base URL from the incoming request. Express provides
      // req.hostname and req.originalUrl which together give us a fully-formed
      // URL object without needing the raw Host header gymnastics.
      const protocol = (req as { protocol?: string }).protocol ?? "http";
      const baseUrl = `${protocol}://${req.hostname}`;
      const url = new URL(req.originalUrl, baseUrl);

      // Translate the Express actor to ActorContext | null. "none" → null.
      const expressActor = req.actor;
      let actor: ActorContext | null = null;
      if (expressActor?.type === "board") {
        actor = {
          type: "board",
          source: expressActor.source as ActorContext["source"],
          userId: expressActor.userId ?? "unknown",
          userName: (expressActor as { userName?: string | null }).userName ?? null,
          userEmail: (expressActor as { userEmail?: string | null }).userEmail ?? null,
          isInstanceAdmin: Boolean((expressActor as { isInstanceAdmin?: boolean }).isInstanceAdmin),
          companyIds: (expressActor as { companyIds?: string[] }).companyIds,
          memberships: (expressActor as { memberships?: ActorMembership[] }).memberships,
          keyId: (expressActor as { keyId?: string }).keyId,
          runId: expressActor.runId,
        };
      } else if (expressActor?.type === "agent") {
        actor = {
          type: "agent",
          source: expressActor.source as ActorContext["source"],
          agentId: expressActor.agentId ?? "unknown",
          companyId: expressActor.companyId ?? "",
          keyId: (expressActor as { keyId?: string }).keyId,
          runId: expressActor.runId,
        };
      }

      // Build the Web-API-compatible Headers object from Express's incoming
      // headers map. Express lowercases all header names, so this is safe.
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(name, v);
        } else {
          // value is string here; cast required because Object.entries loses
          // the discriminated IncomingHttpHeaders union.
          headers.set(name, value as string);
        }
      }

      const ctx: RequestCtx = {
        method: req.method,
        url,
        headers,

        // Body is already parsed by express.json() — just return the cached
        // object rather than re-serialising/re-parsing it.
        json<T = unknown>(): Promise<T> {
          return Promise.resolve(req.body as T);
        },
        text(): Promise<string> {
          if (typeof req.body === "string") return Promise.resolve(req.body);
          return Promise.resolve(JSON.stringify(req.body));
        },

        param(name: string): string | undefined {
          const value = req.params[name];
          return value === undefined ? undefined : String(value);
        },
        query(name: string): string | undefined {
          const value = req.query[name];
          if (value === undefined) return undefined;
          // Express query values can be string | ParsedQs | string[] | ParsedQs[]
          // We only surface the first scalar string.
          if (typeof value === "string") return value;
          if (Array.isArray(value)) {
            const first = value[0];
            return typeof first === "string" ? first : undefined;
          }
          return undefined;
        },

        actor,
        db: deps.db,
        storage: deps.storage,
      };

      const response = await handler(ctx);

      res.status(response.status);

      // Forward response headers (skip ones Express manages itself).
      response.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (lower === "transfer-encoding" || lower === "content-length") return;
        res.setHeader(name, value);
      });

      const body = await response.text();
      res.send(body);
    } catch (err) {
      next(err);
    }
  };
}
