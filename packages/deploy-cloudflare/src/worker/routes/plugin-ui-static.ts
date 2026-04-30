/**
 * routes/plugin-ui-static.ts
 *
 * CF-native handler for GET /_plugins/:pluginId/ui/*filePath.
 *
 * The server-side handler reads UI bundle files from the plugin's local
 * package directory (plugin.packagePath/dist/ui/...), which CF Workers cannot
 * do. We proxy the request to the sidecar — it has filesystem access and runs
 * the same handler. Without this, the request would fall through to the SPA
 * fallback and return ui/dist/index.html (HTML) for what the UI loads as JS,
 * silently breaking plugin UI loading.
 *
 * No auth here: matches the server's behaviour, which serves bundle assets
 * publicly so the UI can fetch them via cache-busting URLs.
 */

import type { Hono } from "hono";
import type { Env } from "../env.js";

export function registerPluginUiStaticRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/_plugins/:pluginId/ui/*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname + url.search;

    if (c.env.SIDECAR_SERVICE) {
      const stub = c.env.SIDECAR_SERVICE.get(c.env.SIDECAR_SERVICE.idFromName("sidecar"));
      return stub.fetch(`http://sidecar${path}`, { method: "GET" });
    }
    const baseUrl = c.env.SIDECAR_URL;
    if (!baseUrl) {
      return c.json(
        { error: "Plugin UI assets unavailable: configure SIDECAR_URL or SIDECAR_SERVICE" },
        503,
      );
    }
    const headers = new Headers();
    if (c.env.SIDECAR_API_KEY) headers.set("Authorization", `Bearer ${c.env.SIDECAR_API_KEY}`);
    try {
      return await fetch(`${baseUrl}${path}`, { method: "GET", headers });
    } catch {
      return c.json({ error: "Sidecar unreachable" }, 503);
    }
  });
}
