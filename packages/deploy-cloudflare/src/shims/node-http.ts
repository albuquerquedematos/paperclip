// Stub for node:http — not available in CF Workers.
// Code paths that require a real HTTP server are not exercised in the CF Worker
// (e.g. S3 provider is replaced by R2, local-disk provider is unused).

export class IncomingMessage { headers: Record<string, string> = {}; }
export class ServerResponse { statusCode = 200; }
export class Agent {}
export class ClientRequest { on() { return this; } end() { return this; } }
export const STATUS_CODES: Record<number, string> = {};
export const METHODS: string[] = [];
export function createServer() { throw new Error("node:http.createServer not available in CF Workers"); }
export function request() { throw new Error("node:http.request not available in CF Workers"); }
export function get() { throw new Error("node:http.get not available in CF Workers"); }
export default { IncomingMessage, ServerResponse, Agent, ClientRequest, STATUS_CODES, METHODS, createServer, request, get };
