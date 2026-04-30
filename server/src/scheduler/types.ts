export interface ScheduledTask {
  cancel(): void;
}

export interface Scheduler {
  every(name: string, intervalMs: number, fn: () => Promise<void>): ScheduledTask;
}
