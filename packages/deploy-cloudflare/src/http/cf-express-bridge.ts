/**
 * cf-express-bridge.ts
 *
 * Bridges raw Express route handlers (req, res, next) to the transport-agnostic
 * Handler type used by the CF Workers route registry.
 *
 * Route factories in the server package (access.ts, company-skills.ts) use raw
 * Express handlers instead of the expressHandler adapter, making them invisible
 * to extractRoutesFromRouter. This bridge:
 *
 *   1. Walks the Express router stack to find untagged routes.
 *   2. Wraps each raw handler chain as a transport-agnostic Handler.
 *   3. Inside each Handler, builds a minimal mock req/res, runs the Express
 *      middleware chain, and resolves to the captured Web Response.
 *
 * Only the subset of Express req/res API used by the server's route handlers
 * is implemented. Calling unsupported methods throws at runtime with a clear
 * message rather than silently doing nothing.
 */

import { HttpError } from "../../../../server/src/errors.js";
import type { Handler, RequestCtx, RouteDefinition } from "../../../../server/src/http/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RawFn = (...args: unknown[]) => unknown;
type HandlerLayer = { handle: RawFn & { __handler?: Handler } };

interface RouterLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: HandlerLayer[];
  };
  name?: string;
  handle?: { stack?: RouterLayer[] };
  regexp?: RegExp;
}

// ---------------------------------------------------------------------------
// Mock Express req
// ---------------------------------------------------------------------------

/**
 * Minimal Express Request stand-in built from a RequestCtx.
 * Handlers read params/query/body/actor and headers.get().
 */
function buildMockReq(
  ctx: RequestCtx,
  params: Record<string, string>,
  body: unknown,
): Record<string, unknown> {
  const query: Record<string, string | string[]> = {};
  ctx.url.searchParams.forEach((value, key) => {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  });

  return {
    method: ctx.method,
    path: ctx.url.pathname,
    params,
    query,
    body,                 // validate() middleware may overwrite this
    actor: ctx.actor,
    get: (header: string) => ctx.headers.get(header) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Mock Express res
// ---------------------------------------------------------------------------

interface MockRes {
  _status: number;
  _headers: Headers;
  _settled: boolean;
  _resolve: (r: Response) => void;
  _reject: (e: unknown) => void;
  promise: Promise<Response>;
  status(code: number): this;
  json(data: unknown): this;
  send(data: unknown): this;
  sendStatus(code: number): this;
  set(header: string, value: string): this;
  end(): this;
}

function createMockRes(): MockRes {
  let _resolve!: (r: Response) => void;
  let _rejectInner!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => { _resolve = res; _rejectInner = rej; });

  const res: MockRes = {
    _status: 200,
    _headers: new Headers(),
    _settled: false,
    _resolve,
    _reject(e: unknown) {
      if (!this._settled) { this._settled = true; _rejectInner(e); }
      else console.error("[CF Worker] Handler error after response settled:", e);
    },
    promise,
    status(code) { this._status = code; return this; },
    json(data) {
      if (!this._settled) {
        this._settled = true;
        _resolve(Response.json(data, { status: this._status, headers: this._headers }));
      }
      return this;
    },
    send(data) {
      if (this._settled) return this;
      this._settled = true;
      if (typeof data === "string") {
        _resolve(new Response(data, { status: this._status, headers: this._headers }));
      } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        _resolve(new Response(data as ArrayBuffer, { status: this._status, headers: this._headers }));
      } else if (data == null) {
        _resolve(new Response(null, { status: this._status }));
      } else {
        _resolve(Response.json(data, { status: this._status, headers: this._headers }));
      }
      return this;
    },
    sendStatus(code) {
      if (!this._settled) {
        this._settled = true;
        _resolve(new Response(null, { status: code }));
      }
      return this;
    },
    set(header, value) { this._headers.set(header, value); return this; },
    end() {
      if (!this._settled) {
        this._settled = true;
        _resolve(new Response(null, { status: this._status }));
      }
      return this;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Middleware chain runner
// ---------------------------------------------------------------------------

function runChain(
  req: Record<string, unknown>,
  res: MockRes,
  handlers: HandlerLayer[],
): void {
  let i = 0;
  // next is synchronous: each handler is fired as a fire-and-forget Promise,
  // with errors redirected to res._reject so res.promise always settles.
  //
  // Double-next() guard: a buggy middleware that calls next() more than once
  // would skip handlers or invoke them out of order.  We defend against this
  // by giving each handler invocation its own `used` flag.  The first call
  // to the bound `next` advances the chain; subsequent calls are ignored.
  function advance(err?: unknown): void {
    if (err) {
      res._reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (i >= handlers.length) return;
    const fn = handlers[i++]!.handle;
    // Bind a single-use next for this handler slot.
    let called = false;
    const boundNext = (e?: unknown): void => {
      if (called) return; // ignore double-calls from the same handler
      called = true;
      advance(e);
    };
    Promise.resolve(
      (fn as (req: unknown, res: unknown, next: unknown) => unknown)(req, res, boundNext),
    ).catch((e: unknown) => res._reject(e));
  }
  advance();
}

// ---------------------------------------------------------------------------
// Path-pattern compilation (shared with route-registry.ts)
// ---------------------------------------------------------------------------

/** Converts an Express-style path (with :param segments) to a RegExp + param names. */
export function pathToRegex(path: string): { re: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
  return { re: new RegExp(`^${pattern}$`), paramNames };
}

// ---------------------------------------------------------------------------
// Public API: wrap a raw Express handler stack as a transport-agnostic Handler
// ---------------------------------------------------------------------------

/**
 * Given an Express-style route path and its middleware/handler stack (from
 * walking the router's `.stack`), returns a transport-agnostic Handler that:
 *
 *   - Extracts URL params using the path pattern.
 *   - Pre-parses the JSON request body.
 *   - Runs the Express middleware chain with a minimal mock req/res.
 *   - Converts HttpErrors to JSON error responses.
 */
export function bridgeExpressHandlers(
  path: string,
  handlers: HandlerLayer[],
): Handler {
  const { re, paramNames } = pathToRegex(path);

  return async (ctx: RequestCtx): Promise<Response> => {
    // Extract URL path params
    const match = ctx.url.pathname.match(re);
    const params: Record<string, string> = {};
    if (match) {
      paramNames.forEach((name, i) => { params[name] = match[i + 1] ?? ""; });
    }

    // Pre-parse body (body-parser equivalent; validate() middleware re-validates)
    let body: unknown = undefined;
    if (!["GET", "HEAD", "DELETE"].includes(ctx.method.toUpperCase())) {
      const ct = ctx.headers.get("content-type") ?? "";
      if (ct.includes("application/json") || ct === "") {
        try { body = await ctx.json<unknown>(); } catch { body = undefined; }
      }
    }

    const req = buildMockReq(ctx, params, body);
    const res = createMockRes();

    // runChain fires the handler chain; errors (including from async handlers
    // invoked via synchronous next() calls) are redirected to res._reject so
    // res.promise always settles — either with the response or an error.
    runChain(req, res, handlers);

    try {
      return await res.promise;
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
          { status: err.status },
        );
      }
      console.error(
        "[CF Bridge] Unhandled error:",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// Router walker: extract all routes including untagged ones
// ---------------------------------------------------------------------------

function extractPathFromLayerRegexp(layer: RouterLayer): string {
  if (!layer.regexp) return "";
  const src = layer.regexp.source;
  const m = src.match(/^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)/);
  if (m) return "/" + m[1].replace(/\\\//g, "/");
  return "";
}

/**
 * Walks an Express Router's stack and returns RouteDefinitions for both:
 *   - Tagged routes (expressHandler-wrapped, with __handler) — used as-is.
 *   - Untagged routes (raw Express handlers) — wrapped via bridgeExpressHandlers.
 *
 * Use in place of extractRoutesFromRouter when the router contains raw handlers.
 */
export function extractAllRoutesFromRouter(
  routerObj: unknown,
  prefix = "",
): RouteDefinition[] {
  const router = routerObj as { stack?: RouterLayer[] };
  const defs: RouteDefinition[] = [];

  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const rawPath = prefix + layer.route.path;
      const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;

      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (!enabled) continue;

        // Prefer tagged handlers (expressHandler-wrapped)
        const tagged = layer.route.stack.find((l) => l.handle.__handler);
        if (tagged?.handle.__handler) {
          defs.push({ method: method.toUpperCase() as RouteDefinition["method"], path, handler: tagged.handle.__handler });
          continue;
        }

        // Fall back to bridging the raw Express handlers
        defs.push({
          method: method.toUpperCase() as RouteDefinition["method"],
          path,
          handler: bridgeExpressHandlers(path, layer.route.stack),
        });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      const nested = extractPathFromRegexp(layer);
      defs.push(...extractAllRoutesFromRouter(layer.handle, prefix + nested));
    }
  }

  return defs;
}

function extractPathFromRegexp(layer: RouterLayer): string {
  return extractPathFromLayerRegexp(layer);
}
