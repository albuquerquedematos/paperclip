/**
 * cf-express-shim.ts
 *
 * Zero-dependency replacement for `express` used in the Cloudflare Worker build.
 *
 * The server route factories call `Router()` and register routes with
 * router.get/post/patch/delete/put/use(). The Cloudflare adapter then walks
 * router.stack via express-router-bridge to extract the transport-agnostic
 * Handler functions (tagged with __handler by expressHandler).
 *
 * This shim replicates only the Express Router stack format that
 * express-router-bridge.ts expects:
 *   - Concrete routes: layer.route = { path, methods, stack: [{ handle }] }
 *   - Nested routers: layer.name = "router", layer.handle = nestedRouter,
 *                     layer.regexp = (Express-style prefix regexp)
 *
 * No Node.js built-ins are used — safe for the CF Workers runtime.
 */

type MiddlewareFn = ((...args: unknown[]) => unknown) & { __handler?: unknown };

interface RouteLayer {
  route: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: MiddlewareFn }>;
  };
}

interface RouterMountLayer {
  name: "router";
  handle: CfRouter;
  regexp: RegExp;
  keys: unknown[];
}

type StackLayer = RouteLayer | RouterMountLayer;

export interface CfRouter {
  stack: StackLayer[];
  get(path: string, ...fns: MiddlewareFn[]): this;
  post(path: string, ...fns: MiddlewareFn[]): this;
  patch(path: string, ...fns: MiddlewareFn[]): this;
  put(path: string, ...fns: MiddlewareFn[]): this;
  delete(path: string, ...fns: MiddlewareFn[]): this;
  use(prefix: string | CfRouter, ...rest: CfRouter[]): this;
  param(name: string, fn: MiddlewareFn): this;
}

function buildRouteLayer(method: string, path: string, fns: MiddlewareFn[]): RouteLayer {
  return {
    route: {
      path,
      methods: { [method]: true },
      stack: fns.map((handle) => ({ handle })),
    },
  };
}

function prefixToRegexp(prefix: string): RegExp {
  // Mirror the regexp format Express produces for app.use('/prefix', router):
  //   /^\\/prefix\/?(?=\/|$)/i
  // express-router-bridge.ts reverses this via extractPathFromLayerRegexp.
  const escaped = prefix.replace(/\//g, "\\/");
  return new RegExp(`^\${escaped}\\/?(?=\\/|$)`, "i");
}

function createRouter(): CfRouter {
  const router: CfRouter = {
    stack: [],
    get(path, ...fns) { this.stack.push(buildRouteLayer("get", path, fns)); return this; },
    post(path, ...fns) { this.stack.push(buildRouteLayer("post", path, fns)); return this; },
    patch(path, ...fns) { this.stack.push(buildRouteLayer("patch", path, fns)); return this; },
    put(path, ...fns) { this.stack.push(buildRouteLayer("put", path, fns)); return this; },
    delete(path, ...fns) { this.stack.push(buildRouteLayer("delete", path, fns)); return this; },
    // param() is used for Express parameter pre-processing.
    // In CF Workers we only walk the stack statically, so this is a no-op.
    param(_name: string, _fn: MiddlewareFn) { return this; },
    use(prefix, ...rest) {
      if (typeof prefix === "string") {
        for (const nested of rest) {
          router.stack.push({
            name: "router",
            handle: nested,
            regexp: prefixToRegexp(prefix),
            keys: [],
          });
        }
      } else {
        // router.use(nestedRouter) — no prefix
        router.stack.push({
          name: "router",
          handle: prefix,
          regexp: prefixToRegexp(""),
          keys: [],
        });
      }
      return this;
    },
  };
  return router;
}

// Default export matches express's export shape as used in the route files:
//   import { Router } from "express"
export const Router = createRouter;

// Type-only re-exports so TypeScript is satisfied when route files do
//   import type { Request, Response, NextFunction } from "express"
// (type-only imports are erased at compile time, so no stubs needed)
export type Request = Record<string, unknown>;
export type Response = Record<string, unknown>;
export type NextFunction = () => void;
export type RequestHandler = MiddlewareFn;
