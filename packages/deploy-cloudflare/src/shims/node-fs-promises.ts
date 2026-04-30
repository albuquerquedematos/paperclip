// Stub for node:fs/promises — not available in CF Workers.
const notAvailable = (name: string) => async () => { throw new Error(`node:fs/promises.${name} not available in CF Workers`); };
export const readFile = notAvailable("readFile");
export const writeFile = notAvailable("writeFile");
export const readdir = notAvailable("readdir");
export const mkdir = notAvailable("mkdir");
export const stat = notAvailable("stat");
export const unlink = notAvailable("unlink");
export const access = notAvailable("access");
export const realpath = notAvailable("realpath");
export const rm = notAvailable("rm");
export const rename = notAvailable("rename");
export const copyFile = notAvailable("copyFile");
export const pipeline = notAvailable("pipeline");
export const open = notAvailable("open");
export const lstat = notAvailable("lstat");
export const watch = notAvailable("watch");
export default { readFile, writeFile, readdir, mkdir, stat, lstat, unlink, access, realpath, rm, rename, copyFile, pipeline, open, watch };
