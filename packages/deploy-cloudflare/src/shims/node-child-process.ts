// Stub for node:child_process — not available in CF Workers.
const notAvailable = (name: string) => () => { throw new Error(`node:child_process.${name} not available in CF Workers`); };
export const spawn = notAvailable("spawn");
export const exec = notAvailable("exec");
export const execFile = notAvailable("execFile");
export const execFileSync = notAvailable("execFileSync");
export const execSync = notAvailable("execSync");
export const spawnSync = notAvailable("spawnSync");
export const fork = notAvailable("fork");
export default { spawn, exec, execFile, execFileSync, execSync, spawnSync, fork };
