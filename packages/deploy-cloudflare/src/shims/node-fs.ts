// Stub for node:fs — not available in CF Workers.
// Must export every named export that bundled packages try to import.

const notAvailable = (name: string) => () => { throw new Error(`node:fs.${name} not available in CF Workers`); };
const notAvailableSync = (name: string) => () => { throw new Error(`node:fs.${name} not available in CF Workers`); };

// Commonly needed constants
export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 512, O_EXCL: 2048,
  O_TRUNC: 1024, O_APPEND: 8, O_SYNC: 128, O_NONBLOCK: 4,
  S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
};

// Sync API stubs
export const readFileSync = notAvailableSync("readFileSync");
export const writeFileSync = notAvailableSync("writeFileSync");
export const appendFileSync = notAvailableSync("appendFileSync");
export const existsSync = () => false;
export const mkdirSync = notAvailableSync("mkdirSync");
export const rmdirSync = notAvailableSync("rmdirSync");
export const rmSync = notAvailableSync("rmSync");
export const readdirSync = notAvailableSync("readdirSync");
export const statSync = notAvailableSync("statSync");
export const lstatSync = notAvailableSync("lstatSync");
export const fstatSync = notAvailableSync("fstatSync");
export const unlinkSync = notAvailableSync("unlinkSync");
export const renameSync = notAvailableSync("renameSync");
export const copyFileSync = notAvailableSync("copyFileSync");
export const chmodSync = notAvailableSync("chmodSync");
export const chownSync = notAvailableSync("chownSync");
export const truncateSync = notAvailableSync("truncateSync");
export const openSync = notAvailableSync("openSync");
export const closeSync = notAvailableSync("closeSync");
export const readSync = notAvailableSync("readSync");
export const writeSync = notAvailableSync("writeSync");
export const realpathSync = Object.assign(notAvailableSync("realpathSync"), { native: notAvailableSync("realpathSync.native") });

// Async callback-style API stubs
export const readFile = notAvailable("readFile");
export const writeFile = notAvailable("writeFile");
export const appendFile = notAvailable("appendFile");
export const readdir = notAvailable("readdir");
export const mkdir = notAvailable("mkdir");
export const rmdir = notAvailable("rmdir");
export const rm = notAvailable("rm");
export const stat = notAvailable("stat");
export const lstat = notAvailable("lstat");
export const fstat = notAvailable("fstat");
export const unlink = notAvailable("unlink");
export const rename = notAvailable("rename");
export const copyFile = notAvailable("copyFile");
export const chmod = notAvailable("chmod");
export const realpath = Object.assign(notAvailable("realpath"), { native: notAvailable("realpath.native") });
export const open = notAvailable("open");
export const close = notAvailable("close");
export const access = notAvailable("access");
export const watch = notAvailable("watch");
export const watchFile = notAvailable("watchFile");

// Stream stubs
export class ReadStream { on() { return this; } pipe() { return this; } }
export class WriteStream { on() { return this; } write() {} end() {} }
export const createReadStream = notAvailable("createReadStream");
export const createWriteStream = notAvailable("createWriteStream");

// promises namespace (re-export from separate stub)
export const promises = {
  readFile: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  writeFile: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  readdir: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  mkdir: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  stat: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  lstat: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  unlink: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  access: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  realpath: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  open: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  copyFile: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  rename: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
  rm: async () => { throw new Error("node:fs/promises not available in CF Workers"); },
};

export default {
  constants, readFileSync, writeFileSync, appendFileSync, existsSync,
  mkdirSync, rmdirSync, rmSync, readdirSync, statSync, lstatSync, fstatSync,
  unlinkSync, renameSync, copyFileSync, chmodSync, chownSync, truncateSync,
  openSync, closeSync, readSync, writeSync, realpathSync,
  readFile, writeFile, appendFile, readdir, mkdir, rmdir, rm,
  stat, lstat, fstat, unlink, rename, copyFile, chmod, realpath,
  open, close, access, watch, watchFile,
  ReadStream, WriteStream, createReadStream, createWriteStream,
  promises,
};
