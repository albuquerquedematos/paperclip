// CF Workers replacement for server/src/version.ts
// createRequire("../package.json") doesn't work in CF Workers (no FS).
export const serverVersion = "0.0.0";
