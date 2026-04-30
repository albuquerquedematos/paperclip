import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";

/**
 * Local copies of the StorageProvider interface types from
 * `server/src/storage/types.ts`. We duplicate only the shapes needed here
 * because importing Node-typed server modules into a Worker bundle would pull
 * in `node:stream` and other Node-only dependencies.
 *
 * Keep these in sync with `server/src/storage/types.ts`.
 */
export interface PutObjectInput {
  objectKey: string;
  body: Uint8Array | ArrayBuffer;
  contentType: string;
  contentLength: number;
}

export interface GetObjectInput {
  objectKey: string;
}

export interface GetObjectResult {
  /** ReadableStream — Workers environment returns Web Streams, not Node Readable. */
  stream: ReadableStream;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface HeadObjectResult {
  exists: boolean;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface StorageProvider {
  id: StorageProviderId;
  putObject(input: PutObjectInput): Promise<void>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  headObject(input: GetObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: GetObjectInput): Promise<void>;
}

export interface R2ProviderConfig {
  /** Logical bucket name — recorded on stored objects for observability. */
  bucket: string;
  /**
   * Optional key prefix applied to every object key before passing to R2.
   * Useful when sharing a single R2 bucket across multiple environments.
   * Example: `"prod/"` → all keys become `"prod/<objectKey>"`.
   */
  prefix: string;
}

/**
 * `StorageProvider` implementation backed by Cloudflare R2.
 *
 * R2 is S3-compatible at the conceptual level but exposes a native binding
 * API (`R2Bucket`) in Workers rather than the AWS SDK. This provider wraps
 * that binding to satisfy the `StorageProvider` contract used throughout the
 * server package.
 *
 * The `stream` field in `GetObjectResult` is a `ReadableStream` (Web Streams
 * API) rather than a Node `Readable`. Callers in the Workers environment
 * should consume it directly. If a Node `Readable` is needed (e.g. in a
 * test shim), wrap it: `Readable.fromWeb(result.stream)`.
 */
export class R2Provider implements StorageProvider {
  readonly id: StorageProviderId = "r2";

  private readonly bucket: R2Bucket;
  private readonly prefix: string;

  constructor(bucket: R2Bucket, config: R2ProviderConfig) {
    this.bucket = bucket;
    this.prefix = config.prefix;
  }

  private key(objectKey: string): string {
    return this.prefix ? `${this.prefix}${objectKey}` : objectKey;
  }

  async putObject(input: PutObjectInput): Promise<void> {
    await this.bucket.put(this.key(input.objectKey), input.body, {
      httpMetadata: { contentType: input.contentType },
    });
  }

  async getObject(input: GetObjectInput): Promise<GetObjectResult> {
    const obj = await this.bucket.get(this.key(input.objectKey));
    if (!obj) {
      throw new Error(`R2: object not found: ${input.objectKey}`);
    }
    return {
      // R2ObjectBody.body is a ReadableStream<Uint8Array> — cast to the
      // opaque ReadableStream type our interface declares.
      stream: obj.body as unknown as ReadableStream,
      contentType: obj.httpMetadata?.contentType,
      contentLength: obj.size,
      etag: obj.etag,
      lastModified: obj.uploaded,
    };
  }

  async headObject(input: GetObjectInput): Promise<HeadObjectResult> {
    const obj = await this.bucket.head(this.key(input.objectKey));
    if (!obj) {
      return { exists: false };
    }
    return {
      exists: true,
      contentType: obj.httpMetadata?.contentType,
      contentLength: obj.size,
      etag: obj.etag,
      lastModified: obj.uploaded,
    };
  }

  async deleteObject(input: GetObjectInput): Promise<void> {
    await this.bucket.delete(this.key(input.objectKey));
  }
}
