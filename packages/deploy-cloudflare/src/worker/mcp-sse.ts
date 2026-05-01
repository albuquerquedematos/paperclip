/**
 * MCP-over-SSE Worker entry point.
 *
 * Exposes the Paperclip MCP server over Server-Sent Events (SSE) so that
 * MCP clients that speak the SSE transport (e.g. Claude Desktop in remote
 * mode, Cursor) can connect to a Cloudflare-deployed instance without
 * needing a locally-running server.
 *
 * Protocol summary (MCP SSE transport):
 *   GET  /mcp         — opens an SSE stream; the server sends JSON-RPC
 *                       notifications and responses as `data:` lines.
 *   POST /mcp/message — client sends JSON-RPC requests here; responses are
 *                       pushed back on the open SSE stream for the session.
 *
 * Session management uses a `sessionId` query parameter. One SSE connection
 * = one MCP session. Sessions are tracked in KV with a short TTL so idle
 * connections do not accumulate entries.
 *
 * TODO: wire up the actual MCP server from `packages/mcp-server/` once the
 * HTTP adapter migration (PR #6/#7) makes it importable in a Worker bundle.
 * For now this implements the SSE framing and message routing layer.
 */

const SSE_KEEPALIVE_INTERVAL_MS = 25_000;
const SESSION_TTL_SECONDS = 3600; // 1 hour

interface McpEnv {
  PAPERCLIP_KV: KVNamespace;
  // TODO: add MCP_SERVER_URL for internal routing once the server is importable
}

/** Encode a Server-Sent Events data frame. */
function sseEvent(eventType: string, data: string, id?: string): string {
  let frame = "";
  if (id) frame += `id: ${id}\n`;
  frame += `event: ${eventType}\n`;
  // Multi-line data: each line gets a `data:` prefix
  for (const line of data.split("\n")) {
    frame += `data: ${line}\n`;
  }
  frame += "\n";
  return frame;
}

export default {
  async fetch(request: Request, env: McpEnv): Promise<Response> {
    const url = new URL(request.url);

    // -----------------------------------------------------------------
    // GET /mcp — open an SSE session
    // -----------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/mcp") {
      const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();

      // Record the session in KV so the POST handler can look it up
      await env.PAPERCLIP_KV.put(
        `mcp:session:${sessionId}`,
        JSON.stringify({ createdAt: new Date().toISOString() }),
        { expirationTtl: SESSION_TTL_SECONDS },
      );

      // Create a TransformStream to drive the SSE response
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      const write = (chunk: string) => writer.write(encoder.encode(chunk));

      // Send the session ID as the first event so the client knows its
      // session and can POST messages to /mcp/message?sessionId=<id>
      void write(sseEvent("session", JSON.stringify({ sessionId })));

      // Keepalive: send a comment every ~25 seconds to prevent the
      // connection from being closed by proxies and load balancers.
      // The Workers runtime suspends execution between requests, so we
      // use a ReadableStream-based keepalive via a background promise.
      //
      // NOTE: Cloudflare Workers have a maximum CPU time per request.
      // Long-lived SSE connections work because the runtime bills only
      // active CPU time. However, connections that survive > 100s of
      // wall-clock time may be subject to the Workers connection timeout.
      // For production use, consider the Durable Objects WebSocket
      // Hibernation API instead of SSE for persistent connections.
      let writerClosed = false;
      const keepaliveInterval = setInterval(() => {
        if (writerClosed) return;
        write(": keepalive\n\n").catch((err) => {
          // Writer was closed (client disconnected) between the check and
          // the write. Stop firing so we don't surface unhandled rejections
          // every interval tick.
          writerClosed = true;
          clearInterval(keepaliveInterval);
          console.debug(
            `[MCP-SSE] keepalive write failed (client likely disconnected): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, SSE_KEEPALIVE_INTERVAL_MS);

      // Clean up the interval when the client disconnects
      request.signal.addEventListener("abort", () => {
        writerClosed = true;
        clearInterval(keepaliveInterval);
        writer.close().catch(() => { /* already closed */ });
        // Remove the session from KV on disconnect
        env.PAPERCLIP_KV.delete(`mcp:session:${sessionId}`).catch(() => { /* best effort */ });
      });

      return new Response(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          // Allow cross-origin access from MCP clients
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // -----------------------------------------------------------------
    // POST /mcp/message — receive a JSON-RPC request from the client
    // -----------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/mcp/message") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return Response.json({ error: "sessionId query parameter is required" }, { status: 400 });
      }

      const sessionData = await env.PAPERCLIP_KV.get(`mcp:session:${sessionId}`);
      if (!sessionData) {
        return Response.json(
          { error: "Session not found or expired. Open a new SSE connection." },
          { status: 404 },
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON in request body" }, { status: 400 });
      }

      // TODO: route the JSON-RPC request to the MCP server implementation
      // once it is importable in a Worker bundle. For now, echo back an
      // "unimplemented" JSON-RPC error response.
      const jsonrpcRequest = body as { jsonrpc?: string; id?: unknown; method?: string };
      const errorResponse = {
        jsonrpc: "2.0",
        id: jsonrpcRequest.id ?? null,
        error: {
          code: -32601,
          message: "MCP server not yet wired up in this Worker build.",
        },
      };

      // In a full implementation, the response would be pushed back on
      // the SSE stream identified by `sessionId`, and this endpoint
      // would return 202 Accepted. For now we return the error inline.
      return Response.json(errorResponse, { status: 200 });
    }

    // -----------------------------------------------------------------
    // OPTIONS /mcp* — CORS preflight
    // -----------------------------------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
