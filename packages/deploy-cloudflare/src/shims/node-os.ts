// Stub for node:os — limited availability in CF Workers.
export const platform = () => "linux";
export const arch = () => "x64";
export const hostname = () => "cf-worker";
export const homedir = () => "/tmp";
export const tmpdir = () => "/tmp";
export const cpus = () => [{ model: "CF Worker", speed: 0 }];
export const totalmem = () => 0;
export const freemem = () => 0;
export const uptime = () => 0;
export const networkInterfaces = () => ({});
export const userInfo = () => ({ username: "worker", uid: 0, gid: 0, shell: null, homedir: "/tmp" });
export const EOL = "\n";
export const type = () => "Linux";
export const release = () => "cf";
export const version = () => "cf";
export default { platform, arch, hostname, homedir, tmpdir, cpus, totalmem, freemem,
  uptime, networkInterfaces, userInfo, EOL, type, release, version };
