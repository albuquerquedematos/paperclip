/**
 * Cloudflare Scheduler implementation that delegates to `SchedulerDO`.
 *
 * This is a local copy of the `Scheduler` interface that will eventually live
 * in `server/src/scheduler/types.ts` (PR #4 in the implementation plan).
 * We duplicate it here to keep this package self-contained — Workers cannot
 * import Node-only server modules.
 *
 * The `fn` callback passed to `every()` is intentionally ignored on
 * Cloudflare. The DO's `alarm()` handler fires the registered `handlerUrl`
 * instead, so the actual work runs inside the Worker rather than in the
 * calling context. This matches Cloudflare's execution model where there is
 * no persistent "main process" to hold a closure.
 */

export interface ScheduledTask {
  cancel(): void;
}

export interface Scheduler {
  /**
   * Register a recurring job that fires approximately every `intervalMs`
   * milliseconds.
   *
   * @param name       - Stable identifier for the job; used as the storage key
   *                     in SchedulerDO. Must be unique per deployment.
   * @param intervalMs - Target interval in milliseconds.
   * @param fn         - Callback — ignored in the CF implementation.
   *                     On Node, this closure is called by the Node scheduler.
   *                     On CF, the alarm fires the registered `handlerUrl`.
   * @param handlerUrl - HTTP endpoint that SchedulerDO will POST to when the
   *                     alarm fires. Must be reachable from the Worker runtime
   *                     (typically a path on the same Worker, e.g.
   *                     `http://internal/scheduler/heartbeat`).
   */
  every(
    name: string,
    intervalMs: number,
    fn: () => Promise<void>,
    handlerUrl: string,
  ): ScheduledTask;
}

/**
 * Creates a `Scheduler` backed by a `SchedulerDO` Durable Object stub.
 *
 * Obtain the stub with:
 * ```ts
 * const id = env.SCHEDULER_DO.idFromName("global");
 * const stub = env.SCHEDULER_DO.get(id);
 * const scheduler = createCfScheduler(stub);
 * ```
 */
export function createCfScheduler(schedulerDoStub: DurableObjectStub): Scheduler {
  return {
    every(name, intervalMs, _fn, handlerUrl): ScheduledTask {
      // Register the job with SchedulerDO asynchronously. Any registration
      // error is logged but not surfaced to the caller — the DO will retry
      // on the next alarm cycle, and the job will fire once registered.
      void schedulerDoStub
        .fetch("http://internal/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, intervalMs, handlerUrl }),
        })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.text().catch(() => "(unreadable)");
            console.warn(`[CfScheduler] Failed to register job "${name}": HTTP ${res.status}: ${body}`);
          }
        })
        .catch((err) => {
          console.error(
            `[CfScheduler] Error registering job "${name}": ${err instanceof Error ? err.message : String(err)}`,
          );
        });

      return {
        cancel(): void {
          void schedulerDoStub
            .fetch("http://internal/cancel", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            })
            .catch((err) => {
              console.error(
                `[CfScheduler] Error cancelling job "${name}": ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        },
      };
    },
  };
}
