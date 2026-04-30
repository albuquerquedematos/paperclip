/**
 * CF Workers replacement for server/src/middleware/logger.ts
 *
 * The Node.js logger writes to a local file using pino-pretty + pino transports.
 * In CF Workers, file I/O is unavailable. This shim replaces it with a
 * console-backed logger that has the same export shape.
 */

import pino from "./pino-shim.js";

export const logger = pino({ level: "info" });

// httpLogger is an Express middleware — never used in CF (we use Hono directly).
// Export a no-op so any import of httpLogger doesn't crash at module load.
export const httpLogger = (_req: unknown, _res: unknown, next: () => void) => next?.();
