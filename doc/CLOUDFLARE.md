# Cloudflare Deployment Plan

Status: Design contract for an additive Cloudflare deployment target
Date: 2026-04-30
Audience: Engineers implementing or reviewing the Cloudflare deployment path
Related: [DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md), [DATABASE.md](./DATABASE.md), [SPEC-implementation.md](./SPEC-implementation.md)

## 1. Goal

Make Paperclip deployable to a user's Cloudflare account behind a single "Deploy to Cloudflare" button, with these properties:

- **Pay-per-use**: idle cost approximates the Workers Paid base ($5/mo) plus storage.
- **Scales horizontally**: per-task isolation via Durable Objects, no shared in-process state.
- **Additive, not a fork**: lives as a new package (`packages/deploy-cloudflare/`) plus a small set of upstream-mergeable abstraction seams. Operators continue to track upstream Paperclip releases.
- **Same product**: identical UI, identical REST contract, identical agent-facing API. The deployment target is configurable; the product surface is not.

## 2. Non-Goals

- Replacing the Node/embedded-Postgres deployment path. That remains the primary local/self-hosted mode.
- Eliminating Containers/E2B for plugin execution. Cloudflare cannot spawn arbitrary child processes; sandboxed plugin work continues to run in Containers, E2B, or remote SSH (the existing sandbox bridge from [#4801](https://github.com/.../pull/4801)).
- Multi-region / multi-tenant SaaS. Each Cloudflare deployment is one Paperclip instance owned by one operator.

## 3. Architectural Principle: Deployment Platform as an Orthogonal Axis

Paperclip already has two orthogonal config axes (see [DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md)):

- **Auth mode**: `local_trusted | authenticated`
- **Reachability**: `loopback | lan | tailnet | custom`

We add a third:

- **Deployment platform**: `node | cloudflare`

This axis decides which implementations of platform interfaces (DB driver, storage provider, scheduler, adapter executor, HTTP adapter) get wired in at boot. Auth mode and reachability stay unchanged. A Cloudflare deployment is `platform=cloudflare, mode=authenticated, exposure=public` — the auth/exposure semantics are unchanged from the existing `authenticated/public` mode, which is already the canonical internet-facing configuration.

**Why this matters for upstream-mergeability**: every change required for Cloudflare also benefits the existing Node deployment (testability, DI, fewer global singletons). The Cloudflare package only contains *Cloudflare-specific implementations* of those interfaces — never branching logic in shared code.

## 4. Resource Mapping

| Concern | Cloudflare resource | Notes |
|---|---|---|
| UI ([ui/](../ui/)) | **Pages** | Static SPA build, no SSR. Free. |
| API + auth + MCP-over-SSE | **Workers** | One main Worker; route handlers from [server/src/routes/](../server/src/routes/) re-mounted via Hono. |
| Per-task / per-agent state, websockets, watchdogs | **Durable Objects** | One DO class per concern (TaskDO, AgentRunDO, ScheduledJobDO). Hibernation API for sockets. |
| Multi-step agent runs (heartbeat, retries, tool calls) | **Workflows** | Replaces in-process orchestration in [services/heartbeat.ts](../server/src/services/heartbeat.ts). Checkpointed, retry-safe. |
| Relational data | **Phase 1: Hyperdrive → Neon Postgres** / **Phase 2: D1** | See §6. Phase 1 keeps the existing schema unchanged. |
| Artifacts, skill bundles, attachments, DB backups | **R2** | New `R2Provider` implementation of `StorageProvider` ([server/src/storage/types.ts:31-37](../server/src/storage/types.ts#L31-L37)). |
| Sessions, hot config, instance settings cache | **KV** | BetterAuth sessions stay in DB (already portable); KV used for ephemeral hot reads only. |
| Background fanout (cost rollups, activity log flush, plugin job dispatch) | **Queues** | Replaces in-process timers in [server/src/index.ts:672-784](../server/src/index.ts#L672-L784). |
| Plugin / adapter process execution | **Containers** OR existing E2B/SSH sandbox bridge | Workers cannot spawn processes. Default: route to existing sandbox bridge. Containers is opt-in for users who want everything on Cloudflare. |
| Cron-style routines | **Cron Triggers** → enqueue into Queues / fire Workflows | Replaces in-process cron scheduler in [services/cron.ts](../server/src/services/cron.ts). |
| LLM API egress | Worker `fetch()` | No changes; LLM calls were already HTTP. |

## 5. Existing Seams (Confirmed Clean)

These already exist and only need new implementations — **no upstream changes required**:

| Seam | File | What we add |
|---|---|---|
| `StorageProvider` | [server/src/storage/types.ts:31-37](../server/src/storage/types.ts#L31-L37) | `R2Provider` |
| `createApp(db, opts)` | [server/src/app.ts:108](../server/src/app.ts#L108) | Workers entrypoint that mounts the same route modules — see §6.3 for the Express/Hono adapter strategy |
| BetterAuth (DB-resident sessions) | [server/src/auth/better-auth.ts](../server/src/auth/better-auth.ts) | Works as-is on Hyperdrive+Neon |
| MCP server stdio transport | [packages/mcp-server/src/](../packages/mcp-server/src/) | Optional: wrap with SSE transport for hosted MCP. Stdio MCP continues to work locally. |
| Drizzle schema | [packages/db/src/schema/](../packages/db/src/schema/) | Used unchanged in Phase 1 (Hyperdrive+Neon) |

## 6. New Seams Required (Upstream-Mergeable)

These changes land in the main packages, with default Node implementations preserved. Each is independently useful for testability and is structured to be reviewable/mergeable upstream as standalone PRs.

### 6.1 DB Driver Factory

**Today**: [packages/db/src/client.ts:48-50](../packages/db/src/client.ts#L48-L50) hardcodes `postgres-js`.

**Change**:

```ts
// packages/db/src/client.ts
export type Db = ReturnType<typeof drizzlePg>; // unchanged shape
export function createPostgresDb(url: string): Db { /* current body */ }
// Re-export createDb for backwards compat:
export const createDb = createPostgresDb;
```

The Cloudflare package adds (without touching `packages/db`):

```ts
// packages/deploy-cloudflare/src/db/d1.ts  (Phase 2)
import { drizzle } from "drizzle-orm/d1";
export function createD1Db(binding: D1Database): Db { /* ... */ }

// packages/deploy-cloudflare/src/db/hyperdrive.ts  (Phase 1)
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
export function createHyperdriveDb(hyperdrive: Hyperdrive): Db {
  return drizzle(postgres(hyperdrive.connectionString), { schema });
}
```

**Migrations**: [packages/db/src/client.ts:9](../packages/db/src/client.ts#L9) reads migrations from disk. In Workers, migrations run at deploy time via `wrangler d1 migrations apply` (Phase 2) or via Neon/Hyperdrive direct connection during the post-deploy setup step (Phase 1). The disk-reading migration runner stays as-is for Node.

### 6.2 Scheduler Interface

**Today**: in-process `setInterval` loops in [server/src/index.ts:672-784](../server/src/index.ts#L672-L784) and [server/src/services/heartbeat.ts](../server/src/services/heartbeat.ts).

**Change**: extract to an interface in `server/src/scheduler/types.ts`:

```ts
export interface Scheduler {
  every(name: string, intervalMs: number, fn: () => Promise<void>): Disposable;
  at(name: string, when: Date, fn: () => Promise<void>): Disposable;
  cancel(name: string): void;
}
```

Default Node implementation wraps `setInterval`/`setTimeout` (current behavior). Cloudflare implementation lives in the CF package and dispatches to a **`SchedulerDO`** that owns alarms — one DO per scheduled job, hibernates between fires.

Heartbeat, watchdog, budget threshold, DB backup, plugin job sweep all become consumers of this interface. Each becomes individually testable in unit tests with a fake scheduler.

### 6.3 HTTP Runtime Adapter

**Today**: [server/src/app.ts:108](../server/src/app.ts#L108) returns an Express app. Routes live in [server/src/routes/](../server/src/routes/) as Express routers.

**Constraint**: Workers cannot run Express. Hono runs on both Node and Workers.

**Strategy** (lowest-risk, highest-leverage): introduce a transport-agnostic handler shape and adapters for Express (today) and Hono (Workers). Per-route migration is incremental.

```ts
// server/src/http/handler.ts
export type Handler = (ctx: RequestCtx) => Promise<Response>;
export interface RequestCtx {
  method: string;
  url: URL;
  headers: Headers;
  json<T>(): Promise<T>;
  text(): Promise<string>;
  param(name: string): string | undefined;
  query(name: string): string | undefined;
  actor: ActorContext;        // already populated by middleware
  db: Db;
  storage: StorageService;
}

// server/src/http/express-adapter.ts → wraps Handler as Express RequestHandler
// packages/deploy-cloudflare/src/http/hono-adapter.ts → mounts Handler under Hono
```

**Migration**: routes are migrated one-at-a-time. Until a route is migrated, the Workers entrypoint can fall back to invoking the Express handler via a Web-Streams-based shim (slow path, but works). Health, auth, and the agent-facing API endpoints migrate first because they're the hot path.

This is the largest change and the single biggest upstream PR. It is independently valuable: it makes route handlers unit-testable without spinning up Express, and it is the precondition for any non-Express deployment (Bun, Deno, edge runtimes, future workers).

### 6.4 Adapter Executor Interface

**Today**: [server/src/adapters/utils.ts:77-93](../server/src/adapters/utils.ts#L77-L93) wraps `child_process.spawn` directly via `runChildProcess`.

**Change**: extract to an interface:

```ts
// packages/adapter-utils/src/executor.ts
export interface CommandExecutor {
  run(input: {
    runId: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  }): Promise<RunProcessResult>;
  cancel(runId: string): Promise<void>;
}
```

Default implementation = current `child_process.spawn` path. Cloudflare implementations:

- `SandboxBridgeExecutor` — calls the existing E2B/SSH sandbox bridge (preferred default for `platform=cloudflare`).
- `ContainerExecutor` — invokes a Cloudflare Container service binding for users who want everything on Cloudflare.

The choice is config: `cloudflare.adapter_executor = sandbox_bridge | container`.

### 6.5 Object Storage Provider Registration

**Today**: providers register via [server/src/storage/provider-registry.ts](../server/src/storage/provider-registry.ts) for `local_disk` and `s3`.

**Change**: add an extension point so the CF package can register `r2` without touching the registry file (keeps the upstream registry stable):

```ts
// server/src/storage/provider-registry.ts
const externalProviders = new Map<StorageProviderId, StorageProviderFactory>();
export function registerStorageProvider(id: StorageProviderId, factory: StorageProviderFactory) {
  externalProviders.set(id, factory);
}
```

The `StorageProviderId` union in `@paperclipai/shared` adds `"r2"`. CF package registers `R2Provider` at boot.

### 6.6 Filesystem Quarantine

**Today**: server writes to `~/.paperclip/instances/default/` for skill bundles, artifacts, DB backups.

**Change**: every disk write currently in the request path is already (or should be) routed through `StorageService` ([server/src/storage/types.ts](../server/src/storage/types.ts)). Audit and convert any direct `fs.writeFile`/`fs.readFile` in the request path to go through `StorageService`. This is a hygiene fix valuable on Node too. After this change, Workers compatibility is automatic for the request path.

DB backups and migration journal reads remain disk-based but only run in admin/boot paths that don't execute on Workers (boot is `wrangler deploy`-time; backups become R2 dumps via a Worker cron + Workflow).

## 7. Package Layout

```
paperclip/
├── packages/
│   ├── db/                                  # +createPostgresDb (renamed); schema unchanged
│   ├── shared/                              # +"r2" added to StorageProviderId union
│   ├── adapter-utils/                       # +CommandExecutor interface
│   └── deploy-cloudflare/                   # NEW — all CF-specific code
│       ├── package.json
│       ├── wrangler.toml                    # resource bindings (D1/R2/KV/DOs/Queues/Workflows)
│       ├── src/
│       │   ├── worker/
│       │   │   ├── api.ts                   # Hono app: mounts route handlers
│       │   │   ├── mcp-sse.ts               # MCP-over-SSE Worker
│       │   │   └── setup.ts                 # /setup first-run flow (writes secrets)
│       │   ├── db/
│       │   │   ├── hyperdrive.ts            # Phase 1 driver
│       │   │   └── d1.ts                    # Phase 2 driver
│       │   ├── storage/
│       │   │   └── r2-provider.ts           # implements StorageProvider
│       │   ├── scheduler/
│       │   │   ├── scheduler-do.ts          # Durable Object owning alarms
│       │   │   └── cf-scheduler.ts          # Scheduler impl that talks to SchedulerDO
│       │   ├── runtime/
│       │   │   ├── task-do.ts               # per-task DO (state + WS hibernation)
│       │   │   ├── agent-run-do.ts          # per-agent-run DO
│       │   │   └── workflows/
│       │   │       ├── heartbeat.ts         # Cloudflare Workflow
│       │   │       └── plugin-dispatch.ts
│       │   ├── adapter-executor/
│       │   │   ├── sandbox-bridge.ts        # routes to existing E2B/SSH bridge
│       │   │   └── container.ts             # Cloudflare Container binding
│       │   ├── http/
│       │   │   └── hono-adapter.ts          # wraps server Handler as Hono routes
│       │   └── boot.ts                      # wires CF impls into the shared service container
│       └── deploy/
│           ├── deploy-button.md             # README snippet with the URL
│           └── post-deploy-setup.md         # operator instructions
├── ui/                                      # unchanged; deploys to Pages
└── server/                                  # +new seams (DB factory, Scheduler, Handler shape, CommandExecutor)
```

## 8. Two-Phase Rollout

### Phase 1 — Hyperdrive + Neon Postgres ("works in 2 weeks of focused work")

Goal: get a working Cloudflare deployment without touching the schema.

- DB: Hyperdrive in front of Neon Postgres. Drizzle schema unchanged.
- Storage: R2.
- Compute: Workers + DOs + Workflows.
- Plugin execution: existing sandbox bridge (no Containers).
- UI: Pages.

This is the MVP. It validates the entire architecture (HTTP adapter, scheduler, storage, DOs) without taking on the schema port. Idle cost: $5/mo Workers Paid + Neon free tier + R2 (free tier covers small instances).

### Phase 2 — D1 Migration (optional, for pure-Cloudflare)

Goal: eliminate the external Postgres dependency.

- Schema port: `jsonb` → `text` JSON columns; remove any pg-only types/operators (audit needed). Drizzle has a D1 dialect.
- New migration set targeting D1; data migration tool that reads from Postgres and writes to D1.
- Idle cost drops further (no Neon).

Phase 2 is opt-in. Phase 1 deployments keep working. The CF package config selects between `db: hyperdrive | d1`.

## 9. One-Click Install Flow

### 9.1 The Button

`README.md` gets a button that links to:

```
https://deploy.workers.cloudflare.com/?url=https://github.com/<org>/paperclip
```

`wrangler.toml` at `packages/deploy-cloudflare/wrangler.toml` declares all bindings: D1 (or Hyperdrive config placeholder), R2 buckets, KV namespaces, DO classes + migrations, Queues, Workflows, Cron Triggers, Pages project.

Cloudflare provisions every resource declared in `wrangler.toml` in one shot.

### 9.2 First-Run Setup

Cloudflare cannot collect secrets via the deploy flow. After provisioning, the deployed Worker serves `/setup` on first request when no `SETUP_COMPLETED` flag is present in KV. The setup page collects:

- LLM provider keys (Anthropic, OpenAI, etc.)
- (Phase 1 only) Neon connection string — or auto-provision via Neon API if user pastes a Neon API token
- Operator email / initial board user credentials
- Optional: sandbox bridge credentials (E2B API key, or SSH endpoint)

The setup endpoint writes secrets via the Cloudflare API using a scoped API token the user pastes. Token requirements (minimum scopes) are documented in `deploy/post-deploy-setup.md`. Once written, they propagate to all Workers in the project on the next request — no redeploy.

To avoid per-Worker secret duplication, the canonical store is **encrypted config in D1/Postgres** (`instance_settings` table, already exists per [services/instance-settings.ts](../server/src/services/instance-settings.ts) pattern). Worker secrets hold only the master encryption key. All Workers read decrypted config from the DB. Updating a config value is one DB write, no CF API calls.

### 9.3 Post-Setup State

After `/setup` completes, the operator is redirected into the standard authenticated UI. The instance behaves identically to a self-hosted Paperclip in `authenticated/public` mode. All upstream-documented operator workflows ([CLI.md](./CLI.md), [DEVELOPING.md](./DEVELOPING.md), [DEPLOYMENT-MODES.md](./DEPLOYMENT-MODES.md)) apply.

## 10. Pricing Model

Idle (no traffic, no scheduled jobs firing):

| Item | Cost |
|---|---|
| Workers Paid plan | $5/mo flat |
| Pages | $0 |
| D1 storage (Phase 2) | ~$0 for small instance |
| R2 storage | $0.015/GB-mo |
| KV storage | $0 within free tier |
| Neon Postgres (Phase 1, free tier) | $0 |
| **Idle total** | **~$5–6/mo** |

Active usage adds: Worker requests ($0.30/M after included 10M), Worker CPU time, DO duration (per-ms while awake), DO requests, Workflow steps, R2 operations, D1 reads/writes. No request, no cost. WS hibernation API ensures DOs aren't billed for idle sockets.

What kills the pay-per-use story if misused:

- DOs holding non-hibernated WebSockets — fix: always use `WebSocketHibernation` API.
- Workflows with infinite loops or no checkpointing — fix: bound steps and use `step.sleep` for waits.
- Cron triggers firing too often — fix: use Queues + lazy DO wakeup instead of high-frequency cron.

## 11. Observability

- **Logs**: Workers Logs (via Logpush to R2 for retention).
- **Metrics**: Workers Analytics + custom counters via Analytics Engine.
- **Tracing**: existing telemetry shape in [packages/shared/src/telemetry/](../packages/shared/src/telemetry/) maps onto Workers Tail. No new abstraction needed.
- **Alerting**: Cloudflare email alerts on error rate / DO storage thresholds. Optional: forward to user's preferred channel via a Worker.

## 12. Security

- Auth mode is locked to `authenticated/public` for `platform=cloudflare`. `local_trusted` is rejected at boot.
- Secrets at rest: master key in Worker secrets, all other secrets in DB encrypted with that key.
- Inter-Worker auth: service bindings (capability-based, no shared secret). For external service-to-Worker, mTLS via Cloudflare Access in front of the Worker is recommended for non-public endpoints (agent-facing API can be public; admin endpoints behind Access).
- CSRF/CORS: existing middleware in [server/src/middleware/](../server/src/middleware/) ports unchanged via the HTTP adapter.

## 13. Out of Scope (Explicit)

- **Plugin marketplace on Cloudflare**: not yet. Plugin distribution remains as in [SPEC-implementation.md §5.2](./SPEC-implementation.md#52-out-of-scope-v1).
- **Multi-region active-active**: Cloudflare auto-routes Workers; D1/Postgres remains single-region. No cross-region consistency story.
- **Bring-your-own-VPC**: not supported. Hyperdrive can target a private Postgres via Tunnel, but is not in scope for the MVP.
- **Replacing Containers/E2B for plugin execution with pure Workers**: out of scope. Workers cannot spawn processes; plugins that depend on subprocesses always require a sandbox.

## 14. Open Questions

1. **Express → Hono migration scope**: do we migrate all routes in one PR, or one route module at a time with a transitional Express-via-shim path on Workers? Recommend: incremental, hot-path first.
2. **D1 jsonb port**: which queries currently rely on Postgres JSONB operators (`->`, `->>`, `@>`)? Audit needed before committing to Phase 2.
3. **Plugin worker manager** ([services/plugin-worker-manager.ts](../server/src/services/plugin-worker-manager.ts)) abstracts plugin lifecycle. How much of its current shape maps to a Workflow + Container model? Needs its own design pass before Phase 1 declares done.
4. **MCP transport on Cloudflare**: confirm SSE-over-Workers is acceptable to the MCP clients we care about, or whether we need WebSocket transport.
5. **DO-per-task cardinality**: at 10K+ active tasks, do we want one DO per task, or one DO per company sharded? Affects storage layout and cost.

## 15. Implementation Order

The work decomposes into independently-mergeable PRs. Each upstream PR is reviewed and merged on its own merit (improves testability or modularity for the Node deployment too); the CF package PR lands last and only contains additive code.

| # | PR | Target | Scope |
|---|---|---|---|
| 1 | DB factory split | upstream | Rename `createDb` → `createPostgresDb` with backwards-compat alias; export `Db` type. |
| 2 | StorageProvider extension point | upstream | Add `registerStorageProvider`; add `"r2"` to `StorageProviderId`. |
| 3 | Filesystem quarantine | upstream | Audit request path for direct `fs` writes, route through `StorageService`. |
| 4 | Scheduler interface | upstream | Extract `Scheduler` interface; default Node impl wraps current `setInterval` calls. |
| 5 | CommandExecutor interface | upstream | Extract from [adapters/utils.ts](../server/src/adapters/utils.ts); default impl unchanged. |
| 6 | HTTP Handler shape | upstream | Introduce transport-agnostic `Handler` + Express adapter; migrate health/auth routes first. |
| 7 | Continue HTTP migration | upstream | Migrate remaining routes one module at a time. |
| 8 | `packages/deploy-cloudflare` skeleton | additive | Package layout, `wrangler.toml`, Hono adapter, R2 provider, Hyperdrive driver, `/setup` flow. |
| 9 | Durable Objects (Task, AgentRun, Scheduler) | additive | DO classes implementing the Scheduler interface and per-task state. |
| 10 | Workflows for heartbeat/budget | additive | Replace in-process scheduling with Workflows + Cron Triggers. |
| 11 | Adapter executors | additive | `SandboxBridgeExecutor` (default) and `ContainerExecutor`. |
| 12 | Deploy button + setup wizard polish | additive | README button, post-deploy docs, end-to-end install rehearsal. |
| 13 | (Optional) D1 migration | additive | Schema port, data migration tool, dual-driver runtime. |

Each upstream PR (#1–#7) is independently reviewable, has tests, and improves the Node deployment. The Cloudflare package never blocks upstream review.
