// Stub for node:tls — not available in CF Workers.
export class TLSSocket { on() { return this; } }
export class Server { on() { return this; } listen() { return this; } }
export function createServer() { return new Server(); }
export function connect() { return new TLSSocket(); }
export default { TLSSocket, Server, createServer, connect };
