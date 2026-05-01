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
import { safeProxyToSidecar } from "../../sidecar-client.js";
import type { Env } from "../env.js";

export function registerPluginUiStaticRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/_plugins/:pluginId/ui/*", async (c) => {
    const url = new URL(c.req.url);
    return safeProxyToSidecar({
      env: c.env,
      path: url.pathname + url.search,
      method: "GET",
      contentType: null,
    });
  });
}
