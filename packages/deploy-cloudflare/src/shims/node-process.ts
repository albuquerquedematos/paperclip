// Shim for the "process" module — provides named exports that some packages
// destructure from it (e.g. `import { versions, env } from "process"`).
// CF Workers expose process as a global but its module doesn't have all named exports.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _proc: any = (typeof process !== "undefined") ? process : {};

export const versions: Record<string, string> = _proc.versions ?? { node: "18.0.0" };
export const env: Record<string, string | undefined> = _proc.env ?? {};
export const platform: string = _proc.platform ?? "linux";
export const arch: string = _proc.arch ?? "x64";
export const version: string = _proc.version ?? "v18.0.0";
export const argv: string[] = _proc.argv ?? [];
export const cwd = () => _proc.cwd?.() ?? "/";
export const exit = (code?: number) => _proc.exit?.(code);
const _hrtime = (...args: [bigint?: boolean] | []): [number, number] | bigint => {
  if (args[0] === true) return BigInt(Date.now()) * 1_000_000n;
  const ms = Date.now();
  return [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];
};
(_hrtime as { bigint?: () => bigint }).bigint = () => BigInt(Date.now()) * 1_000_000n;
export const hrtime = _proc.hrtime ?? _hrtime;
export const nextTick = (fn: () => void) => _proc.nextTick ? _proc.nextTick(fn) : Promise.resolve().then(fn);
export const pid: number = _proc.pid ?? 1;

// Re-export the process object as default
export default _proc;
