/**
 * routes/events.ts
 *
 * CF-native handler for GET /api/companies/:companyId/events/ws.
 *
 * The server-side WebSocket event bus relies on an in-process pub/sub
 * mechanism that does not exist in a CF Worker. This handler accepts the
 * WebSocket upgrade so the frontend does not receive a hard error, but the
 * connection stays silent (no server-sent events) until a Durable Object
 * pub/sub bus is wired up.
 *
 * Auth: the WebSocket protocol does not support request headers once the
 * upgrade completes, so auth is checked before the upgrade response is sent.
 * Unauthenticated requests receive 401 (plain HTTP, before the upgrade).
 *
 * CF-specific caveats:
 *   - WebSocketPair is a CF Workers global; not available in Node.js.
 *   - The connection is accepted but sends no events (stub behaviour).
 *   - TODO: Wire up a Durable Object pub/sub bus for real-time events.
 */

import type { Hono } from "hono";
import { createHyperdriveDb } from "../../db/hyperdrive.js";
import { resolveActorFromRequest } from "../../auth/resolve-actor.js";
import { resolveDeploymentMode } from "../env.js";
import type { Env } from "../env.js";

export function registerEventRoutes(app: Hono<{ Bindings: Env }>): void {
  // -------------------------------------------------------------------------
  // GET /api/companies/:companyId/events/ws
  //
  // CF-native WebSocket upgrade. Without a Durable Object pub/sub bus, the
  // connection stays open but receives no server-sent events. The frontend
  // treats this as a connected (but silent) event stream, which is better
  // than a hard error.
  // -------------------------------------------------------------------------
  app.get("/api/companies/:companyId/events/ws", async (c) => {
    const upgrade = c.req.header("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return c.text("Expected WebSocket upgrade", 426);
    }

    // Authenticate before accepting the upgrade. Once the 101 is sent the
    // response is committed, so we must reject unauthenticated callers here.
    const db = createHyperdriveDb(c.env.HYPERDRIVE);
    const actor = await resolveActorFromRequest(c.req.raw, db, {
      deploymentMode: resolveDeploymentMode(c.env),
    });
    if (!actor) return new Response("Unauthorized", { status: 401 });

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    server.addEventListener("message", () => { /* no-op: no pub/sub bus wired yet */ });
    server.addEventListener("close", () => { /* expected: client disconnected */ });
    server.addEventListener("error", (ev) => {
      console.error("[EventsWS] WebSocket error:", ev);
    });
    return new Response(null, { status: 101, webSocket: client });
  });
}
