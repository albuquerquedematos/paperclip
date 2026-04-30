import type { RunProcessResult } from "./server-utils.js";

export interface CommandExecutorInput {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface CommandExecutor {
  run(input: CommandExecutorInput): Promise<RunProcessResult>;
  cancel(runId: string): Promise<void>;
}
