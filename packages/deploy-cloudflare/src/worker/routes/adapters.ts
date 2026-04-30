/**
 * routes/adapters.ts
 *
 * CF-native handler for GET /api/adapters.
 *
 * The server-side adapterRoutes() reads plugin manifests from disk and
 * maintains an in-process registry — neither is available in a CF Worker.
 * This handler reads the built-in adapter registry (always available) and
 * the disabled-adapter set from the DB-backed adapter-plugin-store shim.
 *
 * Auth: requires an authenticated actor (board or agent). Unauthenticated
 * requests receive 401.
 */

import type { Hono } from "hono";
import { listServerAdapters, isOverridePaused } from "../../../../../server/src/adapters/registry.js";
import { BUILTIN_ADAPTER_TYPES } from "../../../../../server/src/adapters/builtin-adapter-types.js";
import { getDisabledAdapterTypes } from "../../../../../server/src/services/adapter-plugin-store.js";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

export function registerAdapterRoutes(app: Hono<{ Bindings: Env }>): void {
  // -------------------------------------------------------------------------
  // GET /api/adapters — built-in adapters from registry (external adapters
  // require FS-backed plugin store not available in CF; built-ins always load)
  // -------------------------------------------------------------------------
  app.get("/api/adapters", async (c) => {
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const adapters = listServerAdapters();
    const disabledSet = new Set(getDisabledAdapterTypes());
    const result = adapters
      .map((adapter) => ({
        type: adapter.type,
        label: adapter.type,
        source: "builtin" as const,
        modelsCount: (adapter.models ?? []).length,
        loaded: true,
        disabled: disabledSet.has(adapter.type),
        capabilities: {
          supportsInstructionsBundle: adapter.supportsInstructionsBundle ?? false,
          supportsSkills: Boolean(adapter.listSkills || adapter.syncSkills),
          supportsLocalAgentJwt: adapter.supportsLocalAgentJwt ?? false,
          requiresMaterializedRuntimeSkills: adapter.requiresMaterializedRuntimeSkills ?? false,
        },
        overridePaused: BUILTIN_ADAPTER_TYPES.has(adapter.type)
          ? isOverridePaused(adapter.type)
          : undefined,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
    return c.json(result);
  });
}
