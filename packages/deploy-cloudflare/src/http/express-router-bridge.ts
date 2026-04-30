/**
 * express-router-bridge.ts
 *
 * Walks an Express Router's internal `.stack` to extract route definitions that
 * carry a `__handler` tag (set by the tagged `expressHandler` wrapper in
 * `server/src/http/express-adapter.ts`). The extracted definitions are the
 * transport-agnostic `Handler` functions that can be mounted directly on the
 * Hono app without pulling in any Node-specific Express machinery.
 *
 * This file is Workers-safe: it imports only type-level dependencies from the
 * server package and performs no Node-only I/O at runtime. The Express Router
 * object is passed in as an opaque `unknown` and interrogated structurally.
 */

import type { Handler, RouteDefinition } from "../../../../server/src/http/types.js";

/** A function that may carry the `__handler` tag set by `expressHandler`. */
type TaggedFn = ((...args: unknown[]) => unknown) & { __handler?: Handler };

/**
 * Shape of a single layer inside an Express Router's internal `.stack` array.
 * These are not publicly typed by Express, so we define a local structural
 * interface that matches what Express 4.x and 5.x actually produce at runtime.
 */
interface RouterLayer {
  /** Present when this layer is a concrete route (app.get / app.post / etc.). */
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: TaggedFn }>;
  };
  /** "router" when this layer wraps a nested Router (app.use('/prefix', router)). */
  name?: string;
  /** The nested Router object when name === "router". */
  handle?: { stack?: RouterLayer[] };
  /** The compiled regexp Express stores for the mount prefix. */
  regexp?: RegExp;
  /** Named capture groups extracted from the regexp. */
  keys?: Array<{ name: string }>;
}

/**
 * Reverse-engineers the mount prefix Express stored as a regexp back into a
 * plain path string.
 *
 * Express generates regexps like:
 *   `/^\/companies\/?(?=\/|$)/i`
 * from a prefix like `/companies`. We extract the literal path segment from
 * the known pattern so we can rebuild full route paths for nested routers.
 *
 * Returns an empty string when the layer has no extractable prefix (e.g. the
 * root-mounted catch-all).
 */
function extractPathFromLayerRegexp(layer: RouterLayer): string {
  if (!layer.regexp) return "";
  const src = layer.regexp.source;
  // Pattern produced by Express for a simple path prefix like "/companies":
  //   ^\\/companies\\/?(?=\\/|$)
  const m = src.match(/^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)/);
  if (m) return "/" + m[1].replace(/\\\//g, "/");
  return "";
}

/**
 * Recursively walks an Express Router's `.stack` and returns all
 * `RouteDefinition` objects whose innermost handler carries a `__handler` tag.
 *
 * @param routerObj - The Express `Router` instance (typed as `unknown` to avoid
 *   importing Express at the call site, which would pull in Node-only types).
 * @param prefix - The path prefix accumulated from outer `app.use()` calls.
 */
export function extractRoutesFromRouter(
  routerObj: unknown,
  prefix = "",
): RouteDefinition[] {
  const router = routerObj as { stack?: RouterLayer[] };
  const defs: RouteDefinition[] = [];

  for (const layer of router.stack ?? []) {
    if (layer.route) {
      // This layer is a concrete route (GET /foo, POST /bar, etc.)
      const rawPath = prefix + layer.route.path;
      // Normalize: strip trailing slash except for a bare "/"
      const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (!enabled) continue;
        for (const rl of layer.route.stack) {
          if (rl.handle.__handler) {
            defs.push({
              method: method.toUpperCase() as RouteDefinition["method"],
              path,
              handler: rl.handle.__handler,
            });
            break; // Only take the first tagged handler per method
          }
        }
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      // This layer is a nested Router mounted via app.use('/prefix', router)
      const nested = extractPathFromLayerRegexp(layer);
      defs.push(...extractRoutesFromRouter(layer.handle, prefix + nested));
    }
  }

  return defs;
}
