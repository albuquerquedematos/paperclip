import { Hono } from "hono";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../../../../server/src/errors.js";
import { extractRoutesFromRouter } from "./express-router-bridge.js";

/**
 * Re-export the full ActorContext types from the server package.
 *
 * We import directly rather than duplicating because these types are pure
 * TypeScript interfaces with zero runtime code — Wrangler/esbuild strips them
 * at bundle time. If the server package ever gains Node-specific runtime
 * imports at the type-import level, move these to a shared `@paperclipai/http`
 * package (tracked as follow-up to PR #6).
 */
export type {
  ActorContext,
  ActorMembership,
  ActorSource,
  BoardActor,
  AgentActor,
  RequestCtx,
  Handler,
  RouteDefinition,
} from "../../../../server/src/http/types.js";

import type {
  ActorContext,
  Handler,
  RequestCtx,
  RouteDefinition,
} from "../../../../server/src/http/types.js";

/**
 * Minimal structural alias for the storage service dependency.
 * Avoids importing the Node-typed `StorageService` directly from the server
 * package while remaining structurally compatible at runtime.
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
 * Maps an `HttpError` (from `server/src/errors.ts`) to the appropriate HTTP
 * response. All other thrown values become 500 Internal Server Error.
 */
function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json(
      { error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      { status: err.status },
    );
  }
  console.error(
    `[HonoAdapter] Unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  return Response.json({ error: "Internal Server Error" }, { status: 500 });
}

/**
 * Mounts an array of `RouteDefinition` objects onto a Hono app.
 *
 * Each route definition is a transport-agnostic handler (from the
 * `server/src/http/types.ts` seam). This function bridges from the Hono
 * request context to the `RequestCtx` shape those handlers expect.
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
        storage: storage as import("../../../../server/src/storage/types.js").StorageService,
      };

      try {
        return await route.handler(ctx);
      } catch (err) {
        return errorResponse(err);
      }
    });
  }
}

/**
 * Walks an Express Router's `.stack`, extracts all tagged route definitions
 * (those whose innermost handler carries `__handler` set by `expressHandler`),
 * and mounts them on the Hono app via `mountRoutes`.
 *
 * @param app      - The Hono application instance.
 * @param router   - An Express `Router` instance (opaque `unknown` to avoid
 *                   importing Express types into this Workers-safe file).
 * @param prefix   - Optional path prefix to prepend to every extracted route.
 *                   Use `"/companies"` for the company router, `""` for all
 *                   others (matches the `api.use("/companies", ...)` pattern
 *                   in `server/src/app.ts`).
 * @param options  - Same options passed to `mountRoutes`.
 */
export function mountExpressRouter(
  app: Hono,
  router: unknown,
  prefix: string,
  options: MountRoutesOptions,
): void {
  const routes = extractRoutesFromRouter(router, prefix);
  mountRoutes(app, routes, options);
}
