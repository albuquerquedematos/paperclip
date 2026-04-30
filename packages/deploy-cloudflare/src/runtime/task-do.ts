/**
 * TaskDO — per-task Durable Object.
 *
 * Responsibilities:
 *   - Persists task state (status, current step, metadata) in DO storage.
 *   - Manages WebSocket connections from the UI using the Hibernation API,
 *     so idle sockets are not billed while no messages are in flight.
 *   - Broadcasts state updates to all connected clients.
 *
 * One `TaskDO` instance exists per task. Get the stub with:
 * ```ts
 * const id = env.TASK_DO.idFromName(taskId);
 * const stub = env.TASK_DO.get(id);
 * ```
 *
 * Hibernation API: Cloudflare suspends the DO between requests and message
 * deliveries. The DO is re-instantiated transparently; WebSocket objects are
 * restored by the runtime and passed to `webSocketMessage` / `webSocketClose`.
 */

/** Serializable task state shape — extend as the domain evolves. */
export interface TaskState {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  currentStep?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

/** Message sent over WebSocket when task state changes. */
interface StateUpdatedMessage {
  type: "state_updated";
  data: TaskState;
}

/** Message sent over WebSocket when a log line arrives from the executor. */
interface LogLineMessage {
  type: "log_line";
  stream: "stdout" | "stderr";
  line: string;
  ts: string;
}

/** Incoming message from the UI client — e.g. cancellation request. */
interface ClientMessage {
  type: "cancel" | "ping";
  requestId?: string;
}

export class TaskDO implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  // ---------------------------------------------------------------------------
  // Fetch — handles HTTP requests routed to this DO
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade — Hibernation API
    if (url.pathname === "/ws") {
      return this.handleWebSocketUpgrade();
    }

    // Read current task state
    if (request.method === "GET" && url.pathname === "/state") {
      const taskState = await this.state.storage.get<TaskState>("taskState");
      return Response.json(taskState ?? null);
    }

    // Write task state (called by Workflow steps or agent-run APIs)
    if (request.method === "POST" && url.pathname === "/state") {
      const body = await request.json<TaskState>();
      await this.state.storage.put("taskState", body);
      this.broadcast<StateUpdatedMessage>({ type: "state_updated", data: body });
      return Response.json({ ok: true });
    }

    // Append a log line and broadcast to connected clients
    if (request.method === "POST" && url.pathname === "/log") {
      const body = await request.json<{ stream: "stdout" | "stderr"; line: string }>();
      const msg: LogLineMessage = {
        type: "log_line",
        stream: body.stream,
        line: body.line,
        ts: new Date().toISOString(),
      };
      this.broadcast(msg);
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // WebSocket Hibernation API callbacks
  // ---------------------------------------------------------------------------

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON message" }));
      return;
    }

    if (parsed.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", requestId: parsed.requestId }));
      return;
    }

    if (parsed.type === "cancel") {
      // TODO: propagate cancellation to the running Workflow or executor
      // by calling the internal cancellation API endpoint.
      ws.send(JSON.stringify({ type: "cancel_ack", requestId: parsed.requestId }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", error: `Unknown message type: ${parsed.type}` }));
  }

  webSocketClose(_ws: WebSocket, code: number, reason: string): void {
    // The Hibernation API handles cleanup automatically. Log for observability.
    console.debug(`[TaskDO] WebSocket closed — code=${code} reason=${reason}`);
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    console.warn(
      `[TaskDO] WebSocket error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    // pair[1] is the server side; pair[0] is returned to the client.
    // acceptWebSocket registers pair[1] with the Hibernation API so the
    // DO can be suspended between message deliveries without losing the socket.
    this.state.acceptWebSocket(pair[1]);

    // Send current state to the newly connected client immediately
    void this.state.storage.get<TaskState>("taskState").then((taskState) => {
      if (taskState) {
        pair[1].send(JSON.stringify({ type: "state_updated", data: taskState }));
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: pair[0],
    });
  }

  private broadcast<T>(message: T): void {
    const serialized = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(serialized);
      } catch (err) {
        // A closed-but-not-yet-cleaned-up socket may throw — ignore.
        console.debug(
          `[TaskDO] Broadcast send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
