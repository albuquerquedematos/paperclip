import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// Import the schema directly from the workspace source. The package.json exports
// map "./*" to "./src/*.ts", so "@paperclipai/db/schema" resolves to
// packages/db/src/schema.ts — but that file does not exist; the entry is
// packages/db/src/schema/index.ts. We use a relative path to be explicit and
// avoid relying on bundler heuristics for directory index resolution.
import * as schema from "../../../db/src/schema/index.js";
import type { Db } from "@paperclipai/db";

/**
 * Minimal interface that matches the Cloudflare Hyperdrive binding shape.
 * The full type is `Hyperdrive` from `@cloudflare/workers-types`, but we
 * declare a local structural equivalent so this file compiles without
 * requiring the workers-types package at import time.
 */
export interface HyperdriveBinding {
  /** The connection string Cloudflare injects — points to the Hyperdrive proxy. */
  connectionString: string;
}

/**
 * Creates a Drizzle `Db` instance backed by Cloudflare Hyperdrive.
 *
 * Hyperdrive terminates the Postgres connection pool near the Worker and
 * forwards queries to the upstream Neon/Postgres database over a long-lived
 * TCP connection. The `postgres-js` driver is compatible with the Workers
 * `nodejs_compat` flag, which provides a polyfilled TCP socket layer.
 *
 * Pool size is capped at 5 — each Worker invocation is short-lived so a
 * large pool wastes Hyperdrive connection slots.
 *
 * @param hyperdrive - The Hyperdrive binding from the Worker `Env`.
 */
export function createHyperdriveDb(hyperdrive: HyperdriveBinding): Db {
  // max: 1 — we create a new pool per request (CF Workers prohibits reusing
  // TCP sockets across requests), so a single connection is all we need.
  // prepare: false disables prepared-statement caching because Hyperdrive
  // routes across multiple upstream connections and cannot share PS state.
  const sql = postgres(hyperdrive.connectionString, {
    max: 1,
    prepare: false,
  });
  // drizzle-orm's postgres-js adapter returns a type that is structurally
  // identical to the `Db` exported from @paperclipai/db. The cast via
  // `unknown` is necessary only because the generic parameters differ at
  // the type level; the runtime shapes are identical.
  return drizzle(sql, { schema }) as unknown as Db;
}
