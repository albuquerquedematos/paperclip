# Post-Deploy Setup Guide

This guide walks you through everything you need to do after Cloudflare provisions
your Paperclip instance. The process takes about 5–10 minutes.

---

## Step 1 — Deploy to Cloudflare

Click the "Deploy to Cloudflare" button in the README (or run the commands manually):

```bash
# From the repo root
cd packages/deploy-cloudflare
wrangler deploy
```

Cloudflare will provision:
- The main `paperclip-api` Worker
- The R2 bucket `paperclip-storage`
- The KV namespace (you will see the generated ID in the output)
- The Durable Object classes (`TaskDO`, `AgentRunDO`, `SchedulerDO`)
- The Workflow classes (`HeartbeatWorkflow`, `PluginDispatchWorkflow`)
- The Queue `paperclip-jobs`

**Wait for provisioning to complete** — it usually takes under 2 minutes.

---

## Step 2 — Fill in the generated IDs in `wrangler.toml`

After the first deploy, Cloudflare prints the KV namespace ID. Open
`packages/deploy-cloudflare/wrangler.toml` and replace the
`FILL_IN_AFTER_DEPLOY` placeholders:

```toml
[[kv_namespaces]]
binding = "PAPERCLIP_KV"
id = "<paste-kv-namespace-id-here>"
```

Re-deploy after saving:

```bash
wrangler deploy
```

---

## Step 3 — Connect a Postgres database via Hyperdrive

Paperclip Phase 1 uses [Neon Postgres](https://neon.tech) (free tier is sufficient
for small deployments) through Cloudflare Hyperdrive for low-latency queries.

### 3a. Create a Neon database

1. Sign up at <https://neon.tech> (free).
2. Create a new project. Note the **connection string** — it looks like:
   ```
   postgres://neondb_owner:<password>@<host>.neon.tech/neondb?sslmode=require
   ```

### 3b. Create a Hyperdrive configuration

```bash
wrangler hyperdrive create paperclip-hyperdrive \
  --connection-string="postgres://neondb_owner:<password>@<host>.neon.tech/neondb?sslmode=require"
```

The command prints a Hyperdrive ID. Paste it into `wrangler.toml`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<paste-hyperdrive-id-here>"
```

Re-deploy:

```bash
wrangler deploy
```

### 3c. Apply database migrations

Run migrations against Neon directly (Hyperdrive is only for Workers — your
local machine can connect to Neon's direct connection string):

```bash
# From the repo root
DATABASE_URL="postgres://neondb_owner:<password>@<host>.neon.tech/neondb?sslmode=require" \
  node -e "import('@paperclipai/db').then(m => m.applyPendingMigrations(process.env.DATABASE_URL))"
```

---

## Step 4 — Run first-run setup

Open your deployed Worker URL in a browser. If setup is not yet complete you
will be redirected automatically to `/setup`:

```
https://paperclip-api.<your-account>.workers.dev/setup
```

Fill in the form:

| Field | Where to get it |
|---|---|
| **Email address** | Your admin email — you will use this to sign in |
| **Password** | Choose a strong password (min. 12 characters) |
| **Anthropic API key** | <https://console.anthropic.com/settings/keys> |
| **OpenAI API key** | <https://platform.openai.com/api-keys> (optional) |
| **Neon connection string** | From Step 3a above (optional — can skip if using Hyperdrive) |
| **Sandbox bridge URL** | URL of your running E2B/SSH sandbox bridge (optional) |
| **Sandbox bridge API key** | API key for the bridge (optional) |

Click **Complete setup**. You will be redirected to the dashboard.

---

## Step 5 — Access the UI

After setup completes, open:

```
https://paperclip-api.<your-account>.workers.dev
```

Or, if you have deployed the Pages project (linked to the Worker):

```
https://<your-pages-project>.pages.dev
```

Sign in with the email and password you configured in Step 4.

---

## Step 6 — Connect plugin execution (optional)

Paperclip agents run plugins in a sandboxed environment. On Cloudflare, the
recommended approach is the **sandbox bridge** — an existing feature that
routes plugin execution to an E2B sandbox or an SSH-accessible machine.

### Option A: E2B sandbox bridge

1. Get an E2B API key at <https://e2b.dev>.
2. Deploy the sandbox bridge server (see `packages/adapter-utils/README.md`).
3. In the setup form (or via the Settings page), enter the bridge URL and key.

### Option B: Cloudflare Container (experimental)

Cloudflare Containers (beta) can run the plugin sandbox directly on CF
infrastructure. This removes the external bridge dependency but requires
building and publishing a container image.

See `packages/deploy-cloudflare/src/adapter-executor/container.ts` for the
executor implementation and the wrangler.toml comment for the binding
configuration.

---

## Updating secrets later

### Via the Paperclip Settings page

After setup, navigate to **Settings → Instance** in the dashboard to update
LLM keys and bridge credentials without redeployment.

### Via the Wrangler CLI

For Worker-level secrets (e.g. the master encryption key):

```bash
wrangler secret put MASTER_ENCRYPTION_KEY
wrangler secret put SANDBOX_BRIDGE_API_KEY
```

Secrets are available on the next Worker invocation — no redeployment needed.

### Via the Cloudflare dashboard

Navigate to **Workers & Pages → paperclip-api → Settings → Variables** in the
Cloudflare dashboard. Click **Edit variables** to add or update secrets.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Redirected to `/setup` on every request | `SETUP_COMPLETED` is missing from KV. Complete the setup form, or run `wrangler kv:key put --binding=PAPERCLIP_KV SETUP_COMPLETED true`. |
| `502` errors on API routes | Check Worker logs in the Cloudflare dashboard (Workers & Pages → paperclip-api → Logs). |
| DB connection errors | Verify the Hyperdrive ID in `wrangler.toml` matches the output of `wrangler hyperdrive list`. |
| "API route not yet mounted" errors | The HTTP adapter migration (PRs #6–#7) is not yet complete. Follow upstream releases for progress. |
| Setup form shows "Failed to save configuration" | The KV namespace ID in `wrangler.toml` may be wrong. Check it against `wrangler kv:namespace list`. |
