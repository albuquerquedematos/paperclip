# CF Worker smoke tests

A vitest suite that exercises the live Cloudflare Worker (`http://localhost:8787` by default) and asserts no route returns a worker-internal crash (status >= 500).

## Prerequisites

1. `pnpm dev:cf` running (worker + Node sidecar in parallel).
2. `DEPLOYMENT_MODE=local_trusted` set in `packages/deploy-cloudflare/.dev.vars` so requests bypass auth.
3. At least one company in the dev DB (the suite picks the first one).

## Run

```bash
pnpm test:cf-smoke
```

Override the target URL:

```bash
CF_SMOKE_BASE_URL=https://my-paperclip-instance.workers.dev pnpm test:cf-smoke
```

## What it covers

- **Health + adapter/plugin meta routes** — quick liveness check.
- **Company-scoped reads** — every `GET /api/companies/:id/*` the UI calls.
- **Issue-scoped reads (regression guard)** — every `GET /api/issues/:id/*`,
  hit twice when possible: once with the UUID, once with the human key (e.g.
  `ALM-1`). Specifically catches the `invalid input syntax for type uuid`
  bug class.
- **Agent-scoped reads** — agent detail, configuration, runtime-state, etc.
- **Plugin-scoped reads** — detail, dashboard, health, config, jobs. Asserts
  these never return 501 (regression guard for the missing-routes bug).
- **`/_plugins/:id/ui/index.js`** — asserts the response is NOT silently HTML
  (regression for the SPA fallback bug that broke plugin UI loading).
- **Issue lifecycle mutation** — creates a synthetic issue, then re-runs the
  comments/attachments reads against the new UUID to prove the mutation flow
  works end-to-end.
- **Project-scoped reads** — basic detail + child-list routes.

## What it does NOT cover

- UI behaviour, race conditions, Workflow execution paths, queue consumer
  paths, cron triggers — these need separate harnesses.
- Authorization/multi-tenancy — runs as `local_trusted` board user.
- Mutation correctness — only checks status codes, not response shapes.
- Deployed-only paths (R2, Hyperdrive, container DOs in production mode) —
  the local fallback serves those, so tests pass on `wrangler dev` but
  the production paths are not exercised.

If the suite passes locally, you have ~80% confidence that the routes you
touched didn't regress on CF. CI integration is a follow-up — the suite
needs a seeded DB + a wrapper that boots `dev:cf` before running.
