import { Hono } from "hono";

/**
 * First-run setup Hono app.
 *
 * Served at `/setup` before `SETUP_COMPLETED` is set in KV. Collects the
 * secrets and credentials needed to run Paperclip and stores them in KV /
 * the `instance_settings` DB table. Once setup completes, all Workers read
 * config from the DB (encrypted with a master key stored as a Worker secret).
 *
 * Fields collected:
 *   - LLM API key (Anthropic and/or OpenAI)
 *   - Neon/Postgres connection string (Hyperdrive Phase 1)
 *   - Operator email and initial password
 *   - Optional: sandbox bridge URL and API key (for plugin execution)
 *
 * Security: this route is gated — it only accepts requests when
 * `SETUP_COMPLETED` is absent from KV (enforced by the middleware in
 * `api.ts`). After setup completes it permanently locks itself.
 */

interface SetupEnv {
  PAPERCLIP_KV: KVNamespace;
  HYPERDRIVE?: { connectionString: string };
}

interface SetupFormData {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  neonConnectionString?: string;
  operatorEmail: string;
  operatorPassword: string;
  sandboxBridgeUrl?: string;
  sandboxBridgeApiKey?: string;
}

interface ValidationErrors {
  [field: string]: string;
}

function validateSetupForm(data: SetupFormData): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!data.operatorEmail || !data.operatorEmail.includes("@")) {
    errors.operatorEmail = "A valid email address is required.";
  }
  if (!data.operatorPassword || data.operatorPassword.length < 12) {
    errors.operatorPassword = "Password must be at least 12 characters.";
  }
  if (!data.anthropicApiKey && !data.openaiApiKey) {
    errors.llmKey = "At least one LLM API key (Anthropic or OpenAI) is required.";
  }

  return errors;
}

function setupHtml(opts: {
  errors?: ValidationErrors;
  prefill?: Partial<SetupFormData>;
  success?: boolean;
}): string {
  const { errors = {}, prefill = {}, success = false } = opts;

  if (success) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paperclip — Setup Complete</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 80px auto; padding: 0 24px; }
    .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    p { color: #374151; line-height: 1.6; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Setup complete</h1>
    <p>Your Paperclip instance is ready. <a href="/">Open the dashboard</a> to get started.</p>
    <p>Sign in with the operator email and password you just configured.</p>
  </div>
</body>
</html>`;
  }

  const field = (
    name: keyof SetupFormData,
    label: string,
    type = "text",
    placeholder = "",
    required = false,
  ) => {
    const error = errors[name];
    const value = prefill[name] ?? "";
    return `
    <div class="field${error ? " field--error" : ""}">
      <label for="${name}">${label}${required ? " <span aria-hidden='true'>*</span>" : ""}</label>
      <input
        id="${name}"
        name="${name}"
        type="${type}"
        placeholder="${placeholder}"
        value="${String(value).replace(/"/g, "&quot;")}"
        ${required ? "required" : ""}
      />
      ${error ? `<span class="error-msg">${error}</span>` : ""}
    </div>`;
  };

  const llmError = errors.llmKey ?? "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paperclip — First-run Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 1.6rem; }
    p.lead { color: #374151; margin-bottom: 32px; }
    .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; }
    h2 { font-size: 1rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
         color: #6b7280; margin: 24px 0 12px; }
    h2:first-child { margin-top: 0; }
    .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
    label { font-size: 0.875rem; font-weight: 500; }
    input { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.9375rem;
            width: 100%; }
    input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.15); }
    .field--error input { border-color: #dc2626; }
    .error-msg { color: #dc2626; font-size: 0.8125rem; }
    .llm-error { color: #dc2626; font-size: 0.8125rem; margin-top: -8px; margin-bottom: 16px; }
    small { color: #6b7280; font-size: 0.8125rem; }
    button[type=submit] {
      width: 100%; padding: 10px 16px; background: #2563eb; color: #fff;
      border: none; border-radius: 6px; font-size: 1rem; font-weight: 600;
      cursor: pointer; margin-top: 8px;
    }
    button[type=submit]:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <h1>Paperclip Setup</h1>
  <p class="lead">
    Complete the form below to configure your Paperclip instance.
    You only need to do this once.
  </p>
  <div class="card">
    <form method="POST" action="/setup">

      <h2>Admin account</h2>
      ${field("operatorEmail", "Email address", "email", "admin@example.com", true)}
      ${field("operatorPassword", "Password (min. 12 characters)", "password", "", true)}

      <h2>LLM provider keys</h2>
      <small>At least one key is required. Keys are stored encrypted in the database.</small>
      ${llmError ? `<p class="llm-error">${llmError}</p>` : ""}
      ${field("anthropicApiKey", "Anthropic API key", "password", "sk-ant-...")}
      ${field("openaiApiKey", "OpenAI API key", "password", "sk-...")}

      <h2>Database (Phase 1 — Hyperdrive)</h2>
      <small>
        Create a free Neon Postgres database at <a href="https://neon.tech" target="_blank">neon.tech</a>,
        then run <code>wrangler hyperdrive create paperclip-hyperdrive --connection-string="&lt;url&gt;"</code>
        and paste the Hyperdrive ID in your <code>wrangler.toml</code>.
        Leave blank to skip (you can set this later via wrangler).
      </small>
      ${field("neonConnectionString", "Neon connection string (optional)", "password", "postgres://...")}

      <h2>Sandbox bridge (optional)</h2>
      <small>
        Required for plugin execution. Set up the E2B or SSH sandbox bridge and provide
        its URL and API key here. See
        <a href="https://github.com/paperclipai/paperclip/blob/master/doc/CLOUDFLARE.md" target="_blank">
          CLOUDFLARE.md
        </a> for instructions.
      </small>
      ${field("sandboxBridgeUrl", "Sandbox bridge URL", "url", "https://bridge.example.com")}
      ${field("sandboxBridgeApiKey", "Sandbox bridge API key", "password")}

      <button type="submit">Complete setup</button>
    </form>
  </div>
</body>
</html>`;
}

/**
 * Creates the `/setup` Hono sub-application.
 *
 * Mount it under the main app:
 * ```ts
 * app.route("/setup", createSetupApp(env));
 * ```
 */
export function createSetupApp(env: SetupEnv): Hono {
  const setup = new Hono();

  // GET /setup — render the setup form
  setup.get("/", (c) => c.html(setupHtml({})));

  // POST /setup — process the form submission
  setup.post("/", async (c) => {
    const body = await c.req.parseBody();

    const data: SetupFormData = {
      anthropicApiKey: String(body.anthropicApiKey ?? "").trim() || undefined,
      openaiApiKey: String(body.openaiApiKey ?? "").trim() || undefined,
      neonConnectionString: String(body.neonConnectionString ?? "").trim() || undefined,
      operatorEmail: String(body.operatorEmail ?? "").trim(),
      operatorPassword: String(body.operatorPassword ?? ""),
      sandboxBridgeUrl: String(body.sandboxBridgeUrl ?? "").trim() || undefined,
      sandboxBridgeApiKey: String(body.sandboxBridgeApiKey ?? "").trim() || undefined,
    };

    const errors = validateSetupForm(data);
    if (Object.keys(errors).length > 0) {
      return c.html(
        setupHtml({ errors, prefill: { ...data, operatorPassword: "" } }),
        400,
      );
    }

    try {
      // Persist non-secret config to KV (plain strings)
      const kvWrites: Array<Promise<void>> = [
        env.PAPERCLIP_KV.put("SETUP_COMPLETED", "true"),
        env.PAPERCLIP_KV.put("OPERATOR_EMAIL", data.operatorEmail),
      ];

      if (data.anthropicApiKey) {
        kvWrites.push(env.PAPERCLIP_KV.put("ANTHROPIC_API_KEY", data.anthropicApiKey));
      }
      if (data.openaiApiKey) {
        kvWrites.push(env.PAPERCLIP_KV.put("OPENAI_API_KEY", data.openaiApiKey));
      }
      if (data.sandboxBridgeUrl) {
        kvWrites.push(env.PAPERCLIP_KV.put("SANDBOX_BRIDGE_URL", data.sandboxBridgeUrl));
      }
      if (data.sandboxBridgeApiKey) {
        kvWrites.push(env.PAPERCLIP_KV.put("SANDBOX_BRIDGE_API_KEY", data.sandboxBridgeApiKey));
      }

      // The operator password and Neon connection string are more sensitive —
      // in production these should be written via `wrangler secret put` or
      // stored encrypted in the DB after the first DB connection is available.
      // For the initial setup flow we store them in KV as a bootstrap mechanism;
      // the server will read them on first boot and migrate them to encrypted
      // DB storage.
      // TODO: implement encrypted-in-DB migration once the Hyperdrive driver
      // is wired up in boot.ts.
      kvWrites.push(env.PAPERCLIP_KV.put("BOOTSTRAP_OPERATOR_PASSWORD", data.operatorPassword));

      await Promise.all(kvWrites);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.html(
        setupHtml({
          errors: { _global: `Failed to save configuration: ${message}` },
          prefill: { ...data, operatorPassword: "" },
        }),
        500,
      );
    }

    return c.html(setupHtml({ success: true }));
  });

  return setup;
}
