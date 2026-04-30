/**
 * AgentRunDO — per-agent-run Durable Object.
 *
 * Tracks the lifecycle of a single agent heartbeat run: its status, structured
 * log entries, and the current execution step. Workflow steps (`heartbeat.ts`,
 * `plugin-dispatch.ts`) call this DO via `fetch()` to record progress and
 * retrieve state.
 *
 * Unlike `TaskDO`, AgentRunDO does not manage WebSocket connections — real-time
 * UI updates are broadcast by the parent `TaskDO`. This DO is purely a
 * persistent state store for the duration of one heartbeat execution.
 *
 * One `AgentRunDO` instance exists per heartbeat run. Naming convention:
 * ```ts
 * const id = env.AGENT_RUN_DO.idFromName(runId);
 * ```
 */

export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface AgentRunLogEntry {
  seq: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  ts: string;
  data?: unknown;
}

export interface AgentRunState {
  runId: string;
  agentId: string;
  companyId: string;
  taskId?: string;
  status: AgentRunStatus;
  currentStep?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  logCount: number;
}

/** Request body for POST /state */
type UpdateStateBody = Partial<
  Pick<AgentRunState, "status" | "currentStep" | "startedAt" | "completedAt" | "errorMessage">
>;

export class AgentRunDO implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  // ---------------------------------------------------------------------------
  // Fetch — internal HTTP API called by Workflow steps
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (`${request.method} ${url.pathname}`) {
      case "GET /state":
        return this.handleGetState();
      case "POST /state":
        return this.handleUpdateState(request);
      case "POST /init":
        return this.handleInit(request);
      case "POST /log":
        return this.handleLog(request);
      case "GET /logs":
        return this.handleGetLogs(url);
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  // ---------------------------------------------------------------------------
  // Route handlers
  // ---------------------------------------------------------------------------

  /**
   * Initialise a new run. Idempotent — calling with the same runId twice
   * is safe; subsequent calls are no-ops if the run already exists.
   */
  private async handleInit(request: Request): Promise<Response> {
    const existing = await this.state.storage.get<AgentRunState>("state");
    if (existing) {
      return Response.json({ ok: true, created: false });
    }

    const body = await request.json<Omit<AgentRunState, "logCount">>();
    const runState: AgentRunState = {
      ...body,
      logCount: 0,
      status: body.status ?? "queued",
    };
    await this.state.storage.put("state", runState);
    return Response.json({ ok: true, created: true });
  }

  private async handleGetState(): Promise<Response> {
    const runState = await this.state.storage.get<AgentRunState>("state");
    return Response.json(runState ?? null);
  }

  private async handleUpdateState(request: Request): Promise<Response> {
    const updates = await request.json<UpdateStateBody>();
    const current = await this.state.storage.get<AgentRunState>("state");
    if (!current) {
      return Response.json({ error: "Run not initialised. Call POST /init first." }, { status: 409 });
    }

    const updated: AgentRunState = { ...current, ...updates };

    // Automatically set timestamps when transitioning to terminal states
    if (updates.status === "running" && !updated.startedAt) {
      updated.startedAt = new Date().toISOString();
    }
    if (
      ["succeeded", "failed", "cancelled", "timed_out"].includes(updates.status ?? "") &&
      !updated.completedAt
    ) {
      updated.completedAt = new Date().toISOString();
    }

    await this.state.storage.put("state", updated);
    return Response.json({ ok: true });
  }

  private async handleLog(request: Request): Promise<Response> {
    const body = await request.json<Omit<AgentRunLogEntry, "seq" | "ts">>();
    const current = await this.state.storage.get<AgentRunState>("state");
    if (!current) {
      return Response.json({ error: "Run not initialised." }, { status: 409 });
    }

    const entry: AgentRunLogEntry = {
      seq: current.logCount,
      level: body.level ?? "info",
      message: body.message,
      ts: new Date().toISOString(),
      data: body.data,
    };

    // Log entries are stored as `log:<seq>` keys for cheap sequential reads
    await this.state.storage.put(`log:${entry.seq}`, entry);
    await this.state.storage.put("state", { ...current, logCount: current.logCount + 1 });

    return Response.json({ ok: true, seq: entry.seq });
  }

  private async handleGetLogs(url: URL): Promise<Response> {
    const current = await this.state.storage.get<AgentRunState>("state");
    if (!current) {
      return Response.json({ logs: [] });
    }

    const from = parseInt(url.searchParams.get("from") ?? "0", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);

    // Batch-read log entries
    const keys: string[] = [];
    for (let i = from; i < from + limit && i < current.logCount; i++) {
      keys.push(`log:${i}`);
    }

    if (keys.length === 0) {
      return Response.json({ logs: [], total: current.logCount });
    }

    const entries = await this.state.storage.get<AgentRunLogEntry>(keys);
    const logs = keys
      .map((k) => entries.get(k))
      .filter((e): e is AgentRunLogEntry => e !== undefined);

    return Response.json({ logs, total: current.logCount });
  }
}
