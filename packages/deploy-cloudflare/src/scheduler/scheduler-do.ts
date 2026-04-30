/**
 * SchedulerDO — Cloudflare Durable Object that owns all cron-style job alarms.
 *
 * Each registered job stores its `name`, `intervalMs`, and `lastFiredAt` in DO
 * persistent storage. A single alarm fires whenever the nearest scheduled job
 * is due, executes that job by posting to the job's registered handler URL,
 * and reschedules the alarm for the next earliest-due job.
 *
 * This replaces the in-process `setInterval` loops in
 * `server/src/index.ts` and `server/src/services/heartbeat.ts`.
 *
 * Usage: get a stub via `env.SCHEDULER_DO.idFromName("global")` — the "global"
 * scheduler is a singleton per deployment. The CF scheduler adapter
 * (`cf-scheduler.ts`) wraps this DO.
 */

interface JobRecord {
  name: string;
  intervalMs: number;
  handlerUrl: string;
  lastFiredAt: number;
  createdAt: number;
}

/** Shape of the body sent to the job's handler URL when a job fires. */
interface JobFiredPayload {
  name: string;
  firedAt: string;
}

export class SchedulerDO implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  // ---------------------------------------------------------------------------
  // Fetch — internal HTTP API for the cf-scheduler adapter
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (`${request.method} ${url.pathname}`) {
      case "POST /register":
        return this.handleRegister(request);
      case "POST /cancel":
        return this.handleCancel(request);
      case "POST /fire":
        return this.handleFire(request);
      case "GET /status":
        return this.handleStatus();
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  // ---------------------------------------------------------------------------
  // Alarm — fires all jobs whose interval has elapsed, then reschedules
  // ---------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const jobs = await this.loadJobs();
    const now = Date.now();

    const fired: string[] = [];
    for (const job of jobs.values()) {
      const nextFireAt = job.lastFiredAt + job.intervalMs;
      if (now >= nextFireAt) {
        await this.fireJob(job, now);
        job.lastFiredAt = now;
        fired.push(job.name);
      }
    }

    // Persist updated lastFiredAt timestamps
    if (fired.length > 0) {
      await this.persistJobs(jobs);
    }

    // Schedule the next alarm for the earliest upcoming job
    await this.scheduleNextAlarm(jobs);
  }

  // ---------------------------------------------------------------------------
  // Route handlers
  // ---------------------------------------------------------------------------

  private async handleRegister(request: Request): Promise<Response> {
    const body = await request.json<{ name: string; intervalMs: number; handlerUrl: string }>();
    if (!body.name || !body.intervalMs || !body.handlerUrl) {
      return Response.json({ error: "name, intervalMs, and handlerUrl are required" }, { status: 400 });
    }

    const jobs = await this.loadJobs();
    const existing = jobs.get(body.name);
    const now = Date.now();

    const record: JobRecord = {
      name: body.name,
      intervalMs: body.intervalMs,
      handlerUrl: body.handlerUrl,
      lastFiredAt: existing?.lastFiredAt ?? now,
      createdAt: existing?.createdAt ?? now,
    };
    jobs.set(body.name, record);

    await this.persistJobs(jobs);
    await this.scheduleNextAlarm(jobs);

    return Response.json({ ok: true, name: body.name, intervalMs: body.intervalMs });
  }

  private async handleCancel(request: Request): Promise<Response> {
    const body = await request.json<{ name: string }>();
    if (!body.name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    const jobs = await this.loadJobs();
    const existed = jobs.delete(body.name);
    await this.persistJobs(jobs);
    await this.scheduleNextAlarm(jobs);

    return Response.json({ ok: true, existed });
  }

  /**
   * Immediately fires a named job — useful for testing and manual triggers.
   */
  private async handleFire(request: Request): Promise<Response> {
    const body = await request.json<{ name: string }>();
    if (!body.name) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }

    const jobs = await this.loadJobs();
    const job = jobs.get(body.name);
    if (!job) {
      return Response.json({ error: `Unknown job: ${body.name}` }, { status: 404 });
    }

    const now = Date.now();
    await this.fireJob(job, now);
    job.lastFiredAt = now;
    await this.persistJobs(jobs);

    return Response.json({ ok: true, name: body.name, firedAt: new Date(now).toISOString() });
  }

  private async handleStatus(): Promise<Response> {
    const jobs = await this.loadJobs();
    const now = Date.now();

    const entries = [...jobs.values()].map((job) => ({
      name: job.name,
      intervalMs: job.intervalMs,
      handlerUrl: job.handlerUrl,
      lastFiredAt: new Date(job.lastFiredAt).toISOString(),
      nextFireAt: new Date(job.lastFiredAt + job.intervalMs).toISOString(),
      overdueMs: Math.max(0, now - (job.lastFiredAt + job.intervalMs)),
    }));

    return Response.json({ jobs: entries });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async loadJobs(): Promise<Map<string, JobRecord>> {
    const stored = await this.state.storage.get<Record<string, JobRecord>>("jobs");
    return new Map(Object.entries(stored ?? {}));
  }

  private async persistJobs(jobs: Map<string, JobRecord>): Promise<void> {
    const obj: Record<string, JobRecord> = {};
    for (const [name, record] of jobs) {
      obj[name] = record;
    }
    await this.state.storage.put("jobs", obj);
  }

  /**
   * Fires a job by POST-ing to its registered `handlerUrl`.
   *
   * If the job URL is unreachable or returns a non-2xx status, the error is
   * logged but does NOT throw — a transient failure should not prevent other
   * jobs from firing or the alarm from rescheduling.
   */
  private async fireJob(job: JobRecord, now: number): Promise<void> {
    const payload: JobFiredPayload = { name: job.name, firedAt: new Date(now).toISOString() };
    try {
      const response = await fetch(job.handlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Paperclip-Scheduler": "1" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        console.warn(
          `[SchedulerDO] Job "${job.name}" handler returned HTTP ${response.status}: ${job.handlerUrl}`,
        );
      }
    } catch (err) {
      console.error(
        `[SchedulerDO] Job "${job.name}" handler threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Sets (or clears) the DO alarm to fire at the time of the earliest pending job.
   */
  private async scheduleNextAlarm(jobs: Map<string, JobRecord>): Promise<void> {
    if (jobs.size === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const job of jobs.values()) {
      const nextFireAt = job.lastFiredAt + job.intervalMs;
      // If the job is already overdue, fire ASAP (500 ms from now to avoid
      // a tight loop if the handler is failing).
      const effectiveNextFireAt = nextFireAt < now ? now + 500 : nextFireAt;
      if (effectiveNextFireAt < earliest) {
        earliest = effectiveNextFireAt;
      }
    }

    await this.state.storage.setAlarm(earliest);
  }
}
