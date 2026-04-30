/**
 * app.ts
 *
 * Hono application: middleware, setup gate, upload endpoints, and the
 * main `/api/*` catch-all that dispatches to transport-agnostic handlers.
 *
 * Exported as `app` so the thin `api.ts` entry point can call `app.fetch()`.
 */

import { Hono } from "hono";
import { createSetupApp } from "./setup.js";
import { buildRequestResources } from "./route-registry.js";
import { resolveActorFromRequest } from "../auth/resolve-actor.js";
import { registerUploadHandlers } from "./upload-handlers.js";
import { HttpError } from "../../../../server/src/errors.js";
import type { Env } from "./env.js";
import { resolveDeploymentMode } from "./env.js";

export const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Health check — always reachable, no auth, no setup gate
// ---------------------------------------------------------------------------

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    platform: c.env.DEPLOYMENT_PLATFORM ?? "cloudflare",
    mode: c.env.DEPLOYMENT_MODE ?? "authenticated",
    ts: new Date().toISOString(),
  }),
);

// ---------------------------------------------------------------------------
// First-run setup gate
//
// Redirects all non-health, non-setup traffic to /setup until the operator
// completes first-run configuration. Bypassed in `local_trusted` mode.
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  if (c.req.path === "/api/health" || c.req.path.startsWith("/setup")) {
    return next();
  }
  if (c.env.DEPLOYMENT_MODE === "local_trusted") {
    return next();
  }
  const setupCompleted = await c.env.PAPERCLIP_KV.get("SETUP_COMPLETED");
  if (setupCompleted !== "true") {
    return c.redirect("/setup");
  }
  return next();
});

// ---------------------------------------------------------------------------
// Setup sub-app (strips /setup prefix and forwards to the setup Hono app)
// ---------------------------------------------------------------------------

app.all("/setup/*", async (c) => {
  const setupSub = createSetupApp(c.env);
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/setup/, "") || "/";
  return setupSub.fetch(new Request(url.toString(), c.req.raw));
});

app.all("/setup", async (c) => {
  const setupSub = createSetupApp(c.env);
  const url = new URL(c.req.url);
  url.pathname = "/";
  return setupSub.fetch(new Request(url.toString(), c.req.raw));
});

// ---------------------------------------------------------------------------
// R2-native upload endpoints (registered before the /api/* catch-all)
// ---------------------------------------------------------------------------

registerUploadHandlers(app);

// ---------------------------------------------------------------------------
// Main API catch-all
//
// Manual routing: iterate compiled route definitions, match method + path,
// and invoke the transport-agnostic Handler. Using a single wildcard route
// avoids blowing Hono's internal route trie limit (229+ routes).
// ---------------------------------------------------------------------------

app.all("/api/*", async (c) => {
  const { compiled, db, storage } = buildRequestResources(c.env);

  // Normalize trailing slash so /api/companies/ matches /api/companies routes.
  const rawPathname = new URL(c.req.url).pathname;
  const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/$/, "") : rawPathname;
  const method = c.req.method.toUpperCase();

  for (const { route, re, paramNames } of compiled) {
    if (route.method !== method) continue;
    const match = re.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]!] = match[i + 1]!;
    }

    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });

    const ctx: import("../../../../server/src/http/types.js").RequestCtx = {
      method: c.req.method,
      url: new URL(c.req.url),
      headers: new Headers(c.req.raw.headers),
      json<T>(): Promise<T> { return c.req.json<T>(); },
      text(): Promise<string> { return c.req.text(); },
      param(name: string): string | undefined { return params[name]; },
      query(name: string): string | undefined { return c.req.query(name); },
      actor,
      db,
      storage,
    };

    try {
      return await route.handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
          { status: err.status },
        );
      }
      console.error(
        `[CF Worker] Unhandled error in ${route.method} ${route.path}: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    }
  }

  return c.json(
    { error: "This API route is not available in the Cloudflare Workers deployment.", code: "NOT_IMPLEMENTED" },
    501,
  );
});

// ---------------------------------------------------------------------------
// SPA fallback — serves a minimal HTML shell for all non-API paths
// ---------------------------------------------------------------------------

app.all("*", (c) =>
  c.html(
    `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Paperclip</title></head>
<body>
  <p>Loading Paperclip UI... If this persists, the Pages build may not be deployed yet.</p>
</body></html>`,
  ),
);
