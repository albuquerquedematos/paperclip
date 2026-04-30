/**
 * R2-backed RunLogStore for Cloudflare Workers.
 *
 * Design notes:
 * - R2 objects are immutable after a PUT. "Append" semantics are implemented
 *   by reading the existing object, concatenating the new line, and re-PUTing.
 *   For very large logs, key sharding is used: each chunk beyond the first
 *   CHUNK_BYTE_LIMIT is written to a new shard key
 *   `runs/<companyId>/<agentId>/<runId>/chunk-<n>.ndjson`.
 * - All APIs are Web-platform only (fetch, TextEncoder/Decoder, SubtleCrypto,
 *   ReadableStream). No `node:fs`, `node:stream`, or `node:crypto`.
 * - The `logRef` stored in RunLogHandle is the base key prefix
 *   `runs/<companyId>/<agentId>/<runId>` so callers treat it as opaque.
 */

import type {
  RunLogHandle,
  RunLogReadOptions,
  RunLogReadResult,
  RunLogFinalizeSummary,
  RunLogStore,
} from "../../../../server/src/services/run-log-store.js";

export type { RunLogHandle, RunLogReadOptions, RunLogReadResult, RunLogFinalizeSummary, RunLogStore };

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

export interface R2RunLogStoreConfig {
  /**
   * Optional key prefix applied to every object key before passing to R2.
   * Example: `"prod/"` makes all keys `"prod/runs/..."`.
   */
  prefix?: string;
}

/**
 * Creates a `RunLogStore` backed by a Cloudflare R2 bucket.
 *
 * The store type discriminant stored in `RunLogHandle.store` is `"r2"` so
 * callers that branch on `handle.store` can distinguish this implementation
 * from the Node local-file one.
 */
export function createR2RunLogStore(bucket: R2Bucket, config?: R2RunLogStoreConfig): RunLogStore {
  const prefix = config?.prefix ?? "";

  function fullKey(objectKey: string): string {
    return prefix ? `${prefix}${objectKey}` : objectKey;
  }

  return {
    async begin(input) {
      const companyId = safeSegment(input.companyId);
      const agentId = safeSegment(input.agentId);
      const runId = safeSegment(input.runId);
      const baseKey = `runs/${companyId}/${agentId}/${runId}`;

      // Write an empty chunk-0 to mark the log as started.
      await bucket.put(fullKey(shardKey(baseKey, 0)), new Uint8Array(0), {
        httpMetadata: { contentType: "application/x-ndjson" },
      });

      // Store the base prefix as the logRef; shard keys are derived from it.
      return { store: "r2" as const, logRef: baseKey };
    },

    async append(handle, event) {
      if (handle.store !== "r2") return 0;
      const baseKey = handle.logRef;

      // Determine which shard to append to.
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
        // Spill to the next shard.
        writeKey = fullKey(shardKey(baseKey, activeShardIdx + 1));
        newContent = newLine;
      } else {
        newContent = existing + newLine;
      }

      const encoded = encoder.encode(newContent);
      await bucket.put(writeKey, encoded, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });

      return newLineBytes.byteLength;
    },

    async finalize(handle) {
      if (handle.store !== "r2") {
        return { bytes: 0, compressed: false };
      }
      const baseKey = handle.logRef;

      // Collect all shards and concatenate to compute total bytes and hash.
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
        throw new Error("Run log not found");
      }
      const baseKey = handle.logRef;
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? DEFAULT_READ_LIMIT;

      // Collect all shards in order to support byte-range reads across shard
      // boundaries. This is acceptable for log sizes that fit comfortably in a
      // Worker's memory budget (128 MiB default).
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
