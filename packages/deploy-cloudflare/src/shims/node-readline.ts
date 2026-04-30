// Stub for node:readline — not available in CF Workers.
export function createInterface() { throw new Error("node:readline not available in CF Workers"); }
export function question() { throw new Error("node:readline not available in CF Workers"); }
export default { createInterface, question };
