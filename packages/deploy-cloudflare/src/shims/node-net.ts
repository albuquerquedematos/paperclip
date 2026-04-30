// Stub for node:net — not available in CF Workers.
export class Socket { on() { return this; } connect() { return this; } end() { return this; } }
export class Server { on() { return this; } listen() { return this; } }
export function createServer() { return new Server(); }
export function createConnection() { return new Socket(); }
export function connect() { return new Socket(); }

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[\da-f:]+$/i;
export function isIP(input: string): 0 | 4 | 6 {
  if (IPV4_RE.test(input)) return 4;
  if (IPV6_RE.test(input) && input.includes(":")) return 6;
  return 0;
}
export function isIPv4(input: string): boolean { return isIP(input) === 4; }
export function isIPv6(input: string): boolean { return isIP(input) === 6; }

export default { Socket, Server, createServer, createConnection, connect, isIP, isIPv4, isIPv6 };
