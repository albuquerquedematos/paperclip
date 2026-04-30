import { Hono } from "hono";
import type { Db } from "@paperclipai/db";

/**
 * Local copies of the HTTP handler types from `server/src/http/types.ts`.
 *
 * We duplicate rather than import because the server package uses Node-only
 * modules (`node:stream`, etc.) and cannot be bundled into a Worker. These
 * shapes must remain structurally identical to the upstream definitions.
 * When upstream types change, update these in lock-step.
 *
 * TODO: extract `server/src/http/types.ts` into a separate `@paperclipai/http`
 * package with zero Node dependencies so both the server and CF Worker can
 * import it directly (tracked in PR #6).
 */
export interface ActorContext {
  type: "board" | "agent";
  userId?: string;
  agentId?: string;
  companyId?: string;
}

export interface RequestCtx {
  method: string;
  url: URL;
  headers: Headers;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  param(name: string): string | undefined;
  query(name: string): string | undefined;
  actor: ActorContext | null;
  db: Db;
  storage: StorageServiceLike;
}

export type Handler = (ctx: RequestCtx) => Promise<Response>;

export interface RouteDefinition {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Express/Hono-style path, e.g. `/api/companies/:companyId`. */
  path: string;
  handler: Handler;
}

/**
 * Minimal shape of the storage service dependency.
 * We use a structural alias to avoid importing the server's Node-typed
 * `StorageService` directly.
 */
export interface StorageServiceLike {
  provider: string;
  putFile(input: unknown): Promise<unknown>;
  getObject(companyId: string, objectKey: string): Promise<unknown>;
  headObject(companyId: string, objectKey: string): Promise<unknown>;
  deleteObject(companyId: string, objectKey: string): Promise<void>;
}

export interface MountRoutesOptions {
  db: Db;
  storage: StorageServiceLike;
  /**
   * Optional middleware that populates `ctx.actor` from the request.
   * Called before the route handler for every matched route.
   *
   * Return `null` to treat the request as unauthenticated.
   * Throw or return a `Response` to short-circuit with an error.
   */
  resolveActor?: (request: Request) => Promise<ActorContext | null>;
}

/**
 * Mounts an array of `RouteDefinition` objects onto a Hono app.
 *
 * Each route definition is a transport-agnostic handler (from the
 * `server/src/http/types.ts` seam). This function bridges from the Hono
 * request context to the `RequestCtx` shape those handlers expect.
 *
 * Usage:
 * ```ts
 * import { Hono } from "hono";
 * import { mountRoutes } from "./hono-adapter.js";
 * import { myRoutes } from "../../server/src/routes/my-routes.js";
 *
 * const app = new Hono();
 * mountRoutes(app, myRoutes, { db, storage });
 * ```
 */
export function mountRoutes(
  app: Hono,
  routes: RouteDefinition[],
  options: MountRoutesOptions,
): void {
  const { db, storage, resolveActor } = options;

  for (const route of routes) {
    const method = route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";

    app[method](route.path, async (c) => {
      // Resolve actor from request (auth middleware equivalent)
      const actor = resolveActor ? await resolveActor(c.req.raw) : null;

      const ctx: RequestCtx = {
        method: c.req.method,
        url: new URL(c.req.url),
        headers: new Headers(c.req.raw.headers),

        async json<T>(): Promise<T> {
          return c.req.json<T>();
        },

        async text(): Promise<string> {
          return c.req.text();
        },

        param(name: string): string | undefined {
          return c.req.param(name);
        },

        query(name: string): string | undefined {
          return c.req.query(name);
        },

        actor,
        db,
        storage,
      };

      try {
        return await route.handler(ctx);
      } catch (err) {
        // Unhandled errors become 500s. In production, Cloudflare's Worker
        // error logging captures the stack trace.
        console.error(
          `[HonoAdapter] Unhandled error in ${route.method} ${route.path}: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        );
        return c.json({ error: "Internal Server Error" }, 500);
      }
    });
  }
}
