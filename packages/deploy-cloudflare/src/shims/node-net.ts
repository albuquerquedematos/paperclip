// Stub for node:net — not available in CF Workers.
export class Socket { on() { return this; } connect() { return this; } end() { return this; } }
export class Server { on() { return this; } listen() { return this; } }
export function createServer() { return new Server(); }
export function createConnection() { return new Socket(); }
export function connect() { return new Socket(); }
export default { Socket, Server, createServer, createConnection, connect };
