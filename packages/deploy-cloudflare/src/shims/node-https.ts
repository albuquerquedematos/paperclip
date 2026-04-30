// Stub for node:https — not available in CF Workers.
export class Agent {}
export function createServer() { throw new Error("node:https not available in CF Workers"); }
export function request() { throw new Error("node:https not available in CF Workers"); }
export function get() { throw new Error("node:https not available in CF Workers"); }
export default { Agent, createServer, request, get };
