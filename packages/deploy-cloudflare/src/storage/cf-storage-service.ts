/**
 * cf-storage-service.ts — Cloudflare Workers-safe StorageService implementation.
 *
 * Wraps the R2Provider to satisfy the `StorageService` interface from
 * `server/src/storage/types.ts` without importing any Node-only modules.
 *
 * Differences from the Node `createStorageService`:
 * - `putFile` uses the Web Crypto API for SHA-256 hashing instead of
 *   `node:crypto`, and string manipulation instead of `node:path`.
 * - `body` accepts `Uint8Array | ArrayBuffer` (as R2 expects) rather than
 *   `Buffer`. Route handlers that pass a `Buffer` still work because `Buffer`
 *   is a subclass of `Uint8Array` in Node, and Workers polyfill it the same way.
 */

import { R2Provider } from "./r2-provider.js";

// ---------------------------------------------------------------------------
// Helpers (Workers-safe replacements for node:path / node:crypto)
// ---------------------------------------------------------------------------

const MAX_SEGMENT_LENGTH = 120;

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_SEGMENT_LENGTH);
}

function normalizeNamespace(namespace: string): string {
  const parts = namespace
    .split("/")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => sanitizeSegment(entry));
  return parts.length === 0 ? "misc" : parts.join("/");
}

/**
 * Pure string replacement for `path.basename` + `path.extname`.
 * Returns `{ stem, ext }` where ext includes the leading dot (if any).
 */
function splitFilename(filename: string | null): { stem: string; ext: string } {
  if (!filename) return { stem: "file", ext: "" };
  // Strip directory separators
  const base = filename.replace(/^.*[\\/]/, "").trim();
  if (!base) return { stem: "file", ext: "" };
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0) {
    return { stem: sanitizeSegment(base), ext: "" };
  }
  const stemRaw = base.slice(0, dotIdx);
  const extRaw = base.slice(dotIdx); // e.g. ".png"
  const ext = extRaw
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 16);
  return { stem: sanitizeSegment(stemRaw), ext };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildObjectKey(companyId: string, namespace: string, originalFilename: string | null): string {
  const ns = normalizeNamespace(namespace);
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const { stem, ext } = splitFilename(originalFilename);
  const suffix = crypto.randomUUID();
  const filename = `${suffix}-${stem}${ext}`;
  return `${companyId}/${ns}/${year}/${month}/${day}/${filename}`;
}

function ensureCompanyPrefix(companyId: string, objectKey: string): void {
  if (!objectKey.startsWith(`${companyId}/`)) {
    throw Object.assign(new Error("Object does not belong to company"), { status: 403 });
  }
  if (objectKey.includes("..")) {
    throw Object.assign(new Error("Invalid object key"), { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Structural shape of the StorageService (matches `server/src/storage/types.ts`)
 * without importing Node-typed interfaces.
 */
export interface CfStorageService {
  provider: string;
  putFile(input: {
    companyId: string;
    namespace: string;
    originalFilename: string | null;
    contentType: string;
    body: Uint8Array | ArrayBuffer;
  }): Promise<{
    provider: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    originalFilename: string | null;
  }>;
  getObject(companyId: string, objectKey: string): Promise<unknown>;
  headObject(companyId: string, objectKey: string): Promise<unknown>;
  deleteObject(companyId: string, objectKey: string): Promise<void>;
}

/**
 * Create a Workers-safe StorageService backed by an R2Provider.
 */
export function createCfStorageService(provider: R2Provider): CfStorageService {
  return {
    provider: provider.id,

    async putFile(input) {
      const body =
        input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
      if (body.byteLength === 0) {
        throw Object.assign(new Error("File is empty"), { status: 422 });
      }
      const objectKey = buildObjectKey(
        input.companyId,
        input.namespace,
        input.originalFilename,
      );
      const contentType = input.contentType.trim().toLowerCase();
      await provider.putObject({
        objectKey,
        body,
        contentType,
        contentLength: body.byteLength,
      });
      const sha256 = await sha256Hex(body);
      return {
        provider: provider.id,
        objectKey,
        contentType,
        byteSize: body.byteLength,
        sha256,
        originalFilename: input.originalFilename,
      };
    },

    async getObject(companyId: string, objectKey: string) {
      ensureCompanyPrefix(companyId, objectKey);
      return provider.getObject({ objectKey });
    },

    async headObject(companyId: string, objectKey: string) {
      ensureCompanyPrefix(companyId, objectKey);
      return provider.headObject({ objectKey });
    },

    async deleteObject(companyId: string, objectKey: string) {
      ensureCompanyPrefix(companyId, objectKey);
      await provider.deleteObject({ objectKey });
    },
  };
}
