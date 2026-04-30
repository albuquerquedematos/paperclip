/**
 * R2-backed WorkspaceOperationLogStore for Cloudflare Workers.
 *
 * Design notes mirror those for r2-run-log-store.ts:
 * - R2 objects are immutable; append semantics are emulated by read-modify-PUT.
 * - Key sharding is used when a shard exceeds CHUNK_BYTE_LIMIT bytes.
 *   Shard keys: `workspace-op-logs/<companyId>/<operationId>/chunk-<n>.ndjson`.
 * - All APIs are Web-platform only. No `node:fs`, `node:stream`, or
 *   `node:crypto`.
 * - The `logRef` in WorkspaceOperationLogHandle is the base key prefix
 *   `workspace-op-logs/<companyId>/<operationId>`.
 */

import type {
  WorkspaceOperationLogHandle,
  WorkspaceOperationLogReadOptions,
  WorkspaceOperationLogReadResult,
  WorkspaceOperationLogFinalizeSummary,
  WorkspaceOperationLogStore,
} from "../../../../server/src/services/workspace-operation-log-store.js";

export type {
  WorkspaceOperationLogHandle,
  WorkspaceOperationLogReadOptions,
  WorkspaceOperationLogReadResult,
  WorkspaceOperationLogFinalizeSummary,
  WorkspaceOperationLogStore,
};

/** Maximum bytes buffered in a single R2 object before spilling to a new shard. */
const CHUNK_BYTE_LIMIT = 128 * 1024; // 128 KiB

/** Default read window when no limitBytes is specified. */
const DEFAULT_READ_LIMIT = 256_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Build the key for shard index n under a given base prefix. */
function shardKey(baseKey: string, n: number): string {
  return `${baseKey}/chunk-${n}.ndjson`;
}

/** Parse the shard index from a shard key, or return -1 if not a shard key. */
function parseShardIndex(key: string): number {
  const match = /\/chunk-(\d+)\.ndjson$/.exec(key);
  return match ? parseInt(match[1]!, 10) : -1;
}

/**
 * Discover the highest-indexed shard that exists for the given base key.
 * Returns 0 if only chunk-0 exists, or -1 if no shards exist at all.
 */
async function highestShardIndex(bucket: R2Bucket, baseKey: string, prefix: string): Promise<number> {
  const listed = await bucket.list({ prefix: `${prefix}${baseKey}/` });
  let max = -1;
  for (const obj of listed.objects) {
    const relKey = obj.key.slice(prefix.length);
    const idx = parseShardIndex(relKey);
    if (idx > max) max = idx;
  }
  return max;
}

/** Read the full text content of an R2 object, or return "" if it does not exist. */
async function readObjectText(bucket: R2Bucket, fullKey: string): Promise<string> {
  const obj = await bucket.get(fullKey);
  if (!obj) return "";
  const buf = await obj.arrayBuffer();
  return decoder.decode(buf);
}

/** Compute a SHA-256 hex digest of a UTF-8 string using the Web Crypto API. */
async function sha256Hex(text: string): Promise<string> {
  const buf = encoder.encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface R2WorkspaceOpLogStoreConfig {
  /**
   * Optional key prefix applied to every object key before passing to R2.
   * Example: `"prod/"` makes all keys `"prod/workspace-op-logs/..."`.
   */
  prefix?: string;
}

/**
 * Creates a `WorkspaceOperationLogStore` backed by a Cloudflare R2 bucket.
 *
 * The store type discriminant stored in `WorkspaceOperationLogHandle.store` is
 * `"r2"` so callers that branch on `handle.store` can distinguish this
 * implementation from the Node local-file one.
 */
export function createR2WorkspaceOpLogStore(
  bucket: R2Bucket,
  config?: R2WorkspaceOpLogStoreConfig,
): WorkspaceOperationLogStore {
  const prefix = config?.prefix ?? "";

  function fullKey(objectKey: string): string {
    return prefix ? `${prefix}${objectKey}` : objectKey;
  }

  return {
    async begin(input) {
      const companyId = safeSegment(input.companyId);
      const operationId = safeSegment(input.operationId);
      const baseKey = `workspace-op-logs/${companyId}/${operationId}`;

      // Write an empty chunk-0 to mark the log as started.
      await bucket.put(fullKey(shardKey(baseKey, 0)), new Uint8Array(0), {
        httpMetadata: { contentType: "application/x-ndjson" },
      });

      return { store: "r2" as const, logRef: baseKey };
    },

    async append(handle, event) {
      if (handle.store !== "r2") return;
      const baseKey = handle.logRef;

      const shardIdx = await highestShardIndex(bucket, baseKey, prefix);
      const activeShardIdx = shardIdx < 0 ? 0 : shardIdx;
      const activeKey = fullKey(shardKey(baseKey, activeShardIdx));

      const existing = await readObjectText(bucket, activeKey);

      const line = JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk });
      const newLine = `${line}\n`;
      const newLineBytes = encoder.encode(newLine);

      let writeKey = activeKey;
      let newContent: string;

      if (encoder.encode(existing).byteLength + newLineBytes.byteLength > CHUNK_BYTE_LIMIT) {
        writeKey = fullKey(shardKey(baseKey, activeShardIdx + 1));
        newContent = newLine;
      } else {
        newContent = existing + newLine;
      }

      const encoded = encoder.encode(newContent);
      await bucket.put(writeKey, encoded, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });
    },

    async finalize(handle) {
      if (handle.store !== "r2") {
        return { bytes: 0, compressed: false };
      }
      const baseKey = handle.logRef;

      const shardIdx = await highestShardIndex(bucket, baseKey, prefix);
      if (shardIdx < 0) {
        return { bytes: 0, compressed: false };
      }

      let totalBytes = 0;
      let fullContent = "";

      for (let i = 0; i <= shardIdx; i++) {
        const text = await readObjectText(bucket, fullKey(shardKey(baseKey, i)));
        fullContent += text;
        totalBytes += encoder.encode(text).byteLength;
      }

      const sha256 = await sha256Hex(fullContent);

      return {
        bytes: totalBytes,
        sha256,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "r2") {
        throw new Error("Workspace operation log not found");
      }
      const baseKey = handle.logRef;
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? DEFAULT_READ_LIMIT;

      const shardIdx = await highestShardIndex(bucket, baseKey, prefix);
      if (shardIdx < 0) {
        return { content: "" };
      }

      let fullContent = "";
      for (let i = 0; i <= shardIdx; i++) {
        fullContent += await readObjectText(bucket, fullKey(shardKey(baseKey, i)));
      }

      const allBytes = encoder.encode(fullContent);
      const totalSize = allBytes.byteLength;

      const start = Math.max(0, Math.min(offset, totalSize));
      const end = Math.min(start + limitBytes, totalSize);

      if (start >= end) {
        return { content: "", nextOffset: start < totalSize ? start : undefined };
      }

      const slice = allBytes.slice(start, end);
      const content = decoder.decode(slice);
      const nextOffset = end < totalSize ? end : undefined;

      return { content, nextOffset };
    },
  };
}
