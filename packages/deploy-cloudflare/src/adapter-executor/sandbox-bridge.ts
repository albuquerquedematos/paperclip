/**
 * SandboxBridgeExecutor — calls the existing E2B / SSH sandbox bridge HTTP API.
 *
 * The sandbox bridge is a lightweight HTTP server that accepts command
 * execution requests and forwards them to an E2B sandbox or an SSH-accessible
 * machine (see `packages/adapter-utils/src/sandbox-callback-bridge.ts` for
 * the bridge protocol). This executor is the default for Cloudflare
 * deployments because Workers cannot spawn child processes.
 *
 * Configure via env vars (set via `wrangler secret put`):
 *   SANDBOX_BRIDGE_URL     — base URL of the running bridge server
 *   SANDBOX_BRIDGE_API_KEY — optional bearer token
 */

/**
 * Local copy of `CommandExecutorInput` from
 * `packages/adapter-utils/src/executor.ts`. We duplicate it here because
 * Workers cannot import Node-only packages. Keep in sync with the upstream
 * definition.
 *
 * Note: the `onLog` callback is omitted from the over-the-wire shape — logs
 * are returned in the response body instead. The caller of `run()` can still
 * pass an `onLog` function; it will be invoked with the stdout/stderr lines
 * parsed from the response.
 */
export interface CommandExecutorInput {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

/**
 * Local copy of `RunProcessResult` from
 * `packages/adapter-utils/src/server-utils.ts`. Keep in sync.
 */
export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

/** Wire-format body sent to `POST /execute` on the bridge server. */
interface ExecuteRequestBody {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}

export interface SandboxBridgeExecutorConfig {
  /** Base URL of the sandbox bridge HTTP server, e.g. `https://bridge.example.com`. */
  bridgeUrl: string;
  /** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
}

/**
 * Creates an executor that delegates command execution to the sandbox bridge.
 *
 * The bridge server exposes:
 *   POST /execute        — run a command; returns `RunProcessResult`
 *   POST /cancel/:runId  — request cancellation of a running command
 */
export function createSandboxBridgeExecutor(config: SandboxBridgeExecutorConfig) {
  const authHeaders: Record<string, string> = config.apiKey
    ? { Authorization: `Bearer ${config.apiKey}` }
    : {};

  return {
    /**
     * Execute a command on the sandbox bridge and wait for completion.
     *
     * If `input.onLog` is provided, it is called with each line of stdout
     * and stderr after the command completes (not streaming). Real-time
     * streaming would require a chunked response protocol not yet implemented
     * in the bridge — see TODO below.
     */
    async run(input: CommandExecutorInput): Promise<RunProcessResult> {
      const body: ExecuteRequestBody = {
        runId: input.runId,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
      };

      const resp = await fetch(`${config.bridgeUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "(unreadable)");
        throw new Error(`Sandbox bridge /execute returned HTTP ${resp.status}: ${text}`);
      }

      const result = (await resp.json()) as RunProcessResult;

      // If the caller wants log callbacks, replay stdout/stderr lines now.
      // TODO: implement a streaming log protocol in the bridge to avoid
      // buffering the entire output in memory.
      if (input.onLog) {
        if (result.stdout) {
          for (const line of result.stdout.split("\n")) {
            await input.onLog("stdout", line);
          }
        }
        if (result.stderr) {
          for (const line of result.stderr.split("\n")) {
            await input.onLog("stderr", line);
          }
        }
      }

      return result;
    },

    /**
     * Request cancellation of a running command.
     *
     * The bridge server sends SIGTERM (or the configured grace signal) to the
     * target process. This is best-effort — if the bridge is unreachable the
     * timeout on the original `run()` call will eventually terminate it.
     */
    async cancel(runId: string): Promise<void> {
      const resp = await fetch(`${config.bridgeUrl}/cancel/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: authHeaders,
      });

      if (!resp.ok && resp.status !== 404) {
        // 404 = already completed; treat as success. Other errors are warnings.
        const text = await resp.text().catch(() => "(unreadable)");
        console.warn(
          `[SandboxBridgeExecutor] cancel(${runId}) returned HTTP ${resp.status}: ${text}`,
        );
      }
    },
  };
}
