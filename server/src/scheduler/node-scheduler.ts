import { logger } from "../middleware/logger.js";
import type { Scheduler, ScheduledTask } from "./types.js";

export function createNodeScheduler(): Scheduler {
  return {
    every(name: string, intervalMs: number, fn: () => Promise<void>): ScheduledTask {
      const handle = setInterval(() => {
        void fn().catch((err) => {
          logger.error({ err, schedulerTask: name }, "scheduled task failed");
        });
      }, intervalMs);
      return {
        cancel: () => clearInterval(handle),
      };
    },
  };
}
