/**
 * adapter-executor/anthropic-api.ts — SCAFFOLD
 *
 * Worker-direct Anthropic API adapter executor. This is the framework for
 * running an agent loop entirely inside the CF Worker (no sidecar required
 * for the LLM call itself), using `fetch()` against api.anthropic.com.
 *
 * Status: scaffolded only. The function below validates the API key and
 * shows the call shape, but the full agent loop, tool dispatch, and
 * conversation persistence are NOT YET IMPLEMENTED.
 *
 * Why a separate adapter:
 *   The existing `claude` adapter spawns the `claude` CLI as a child process.
 *   That gives you the full CLI feature set (Edit/Write/Bash/Glob/Grep tools,
 *   skill loading, hooks, MCP, etc.) at the cost of needing a host with a
 *   filesystem and child_process. CF Workers cannot do either, so Option A
 *   (proxy to sidecar) is the production path today.
 *
 *   This module is Option B: a CF-safe adapter that calls the Anthropic API
 *   directly. It will never have feature parity with the CLI — too many of
 *   the CLI's tools assume a filesystem. But it can support a useful subset
 *   for chat-style agents and read-only repo analysis.
 *
 * What still needs to be built (in priority order):
 *   1. Agent loop: read agent config + last message → call /v1/messages →
 *      handle tool_use blocks → loop until stop. ~150 lines.
 *   2. Tool registry: replace CLI tools with CF-safe equivalents:
 *        - file_read/file_write   → R2 (PAPERCLIP_STORAGE binding)
 *        - bash                   → proxy to PluginContainer DO
 *        - glob/grep              → R2 list + fetch
 *        - web_fetch              → fetch() (already CF-native)
 *      ~300 lines plus per-tool handlers.
 *   3. Conversation state: persist turns to AgentRunDO so the workflow can
 *      checkpoint and resume. ~50 lines.
 *   4. Cost/token accounting: forward usage to the existing cost-rollup
 *      pipeline. ~30 lines.
 *   5. Skill loading: fetch skill bundles from R2 and inject into the
 *      system prompt. ~80 lines.
 *   6. Hook into HeartbeatWorkflow: when an agent's adapterType is
 *      "claude-api", route to this executor instead of the sidecar.
 *
 * Total scope: ~600–800 lines + tests + integration. Realistic build time
 * is days, not hours. Track in CLOUDFLARE.md §6.4 (Adapter Executor Interface).
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-4-7";

export interface AnthropicAdapterInput {
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
}

export interface AnthropicAdapterOutput {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Single Anthropic /v1/messages call. No tool dispatch, no agent loop, no
 * conversation persistence — those are the missing pieces above. Useful as
 * the leaf primitive once the loop is built.
 */
export async function callAnthropic(input: AnthropicAdapterInput): Promise<AnthropicAdapterOutput> {
  if (!input.apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }
  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model ?? DEFAULT_MODEL,
      max_tokens: input.maxTokens ?? 4096,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages: input.messages,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`Anthropic API ${resp.status}: ${text}`);
  }
  const data = await resp.json() as {
    content: Array<{ type: string; text?: string }>;
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
  };
  const text = data.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("");
  return {
    text,
    stopReason: data.stop_reason,
    usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
  };
}
