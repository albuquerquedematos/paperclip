import { runChildProcess, runningProcesses } from "./server-utils.js";
import type { CommandExecutor, CommandExecutorInput } from "./executor.js";
import type { RunProcessResult } from "./server-utils.js";

export function createLocalCommandExecutor(): CommandExecutor {
  return {
    async run(input: CommandExecutorInput): Promise<RunProcessResult> {
      return runChildProcess(input.runId, input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec,
        graceSec: input.graceSec,
        onLog: input.onLog,
      });
    },

    async cancel(runId: string): Promise<void> {
      runningProcesses.delete(runId);
    },
  };
}
