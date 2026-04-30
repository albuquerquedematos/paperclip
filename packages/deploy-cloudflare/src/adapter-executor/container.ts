/**
 * ContainerExecutor — delegates command execution to a Cloudflare Container.
 *
 * Cloudflare Containers (beta as of 2025) allow Workers to launch and
 * communicate with Docker-compatible containers via a service binding
 * (`Fetcher`). The container runs the adapter plugin process and exposes
 * the same HTTP API as the sandbox bridge: `POST /execute` and
 * `POST /cancel/:runId`.
 *
 * This executor is opt-in. Set `cloudflare.adapter_executor = "container"`
 * in the deployment config to use it instead of the default sandbox bridge.
 *
 * Container binding declaration in `wrangler.toml` (add when enabling):
 * ```toml
 * [[containers]]
 * binding = "PLUGIN_CONTAINER"
 * image = "ghcr.io/paperclipai/plugin-sandbox:latest"
 * ```
 *
 * The container image must expose `POST /execute` and `POST /cancel/:runId`
 * on port 80 (default for CF container bindings).
 *
 * Reference: https://developers.cloudflare.com/containers/
 */

import type { CommandExecutorInput, RunProcessResult } from "./sandbox-bridge.js";

/**
 * Creates an executor that delegates command execution to a Cloudflare
 * Container service binding.
 *
 * @param containerBinding - The `Fetcher` injected by the Workers runtime
 *   for the container service binding declared in `wrangler.toml`.
 */
export function createContainerExecutor(containerBinding: Fetcher) {
  return {
    /**
     * Execute a command inside the container.
     *
     * The container receives the same wire-format body as the sandbox bridge
     * so both executors are interchangeable from the caller's perspective.
     */
    async run(input: CommandExecutorInput): Promise<RunProcessResult> {
      // `onLog` is stripped from the wire body — same pattern as
      // sandbox-bridge.ts.
      const { onLog, ...wireBody } = input;

      const resp = await containerBinding.fetch("http://container/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wireBody),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "(unreadable)");
        throw new Error(`Container executor /execute returned HTTP ${resp.status}: ${text}`);
      }

      const result = (await resp.json()) as RunProcessResult;

      if (onLog) {
        if (result.stdout) {
          for (const line of result.stdout.split("\n")) {
            await onLog("stdout", line);
          }
        }
        if (result.stderr) {
          for (const line of result.stderr.split("\n")) {
            await onLog("stderr", line);
          }
        }
      }

      return result;
    },

    /**
     * Request cancellation of a running command inside the container.
     */
    async cancel(runId: string): Promise<void> {
      const resp = await containerBinding.fetch(
        `http://container/cancel/${encodeURIComponent(runId)}`,
        { method: "POST" },
      );

      if (!resp.ok && resp.status !== 404) {
        const text = await resp.text().catch(() => "(unreadable)");
        console.warn(
          `[ContainerExecutor] cancel(${runId}) returned HTTP ${resp.status}: ${text}`,
        );
      }
    },
  };
}
