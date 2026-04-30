// Stub for node:http2 — not available in CF Workers.
const notAvailable = (name: string) => () => { throw new Error(`node:http2.${name} not available in CF Workers`); };
export class ClientHttp2Session { on() { return this; } request() { return {}; } destroy() {} }
export const connect = notAvailable("connect");
export const createServer = notAvailable("createServer");
export const createSecureServer = notAvailable("createSecureServer");
export const constants = {};
export default { ClientHttp2Session, connect, createServer, createSecureServer, constants };
