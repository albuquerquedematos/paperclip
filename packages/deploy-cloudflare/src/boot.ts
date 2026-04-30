/**
 * boot.ts — Cloudflare deployment boot sequence.
 *
 * Registers all Cloudflare-specific service implementations into the shared
 * provider registries. Called once on first Worker request (or on every cold
 * start — all registrations are idempotent Map.set calls).
 *
 * This is the only file in `packages/deploy-cloudflare/` that touches the
 * server package's registry. Every other file in this package is self-contained.
 *
 * The import of `provider-registry` uses a workspace-relative path. Wrangler
 * (esbuild) resolves it through the workspace symlink at bundle time, so no
 * runtime module resolution occurs.
 *
 * NOTE: `server/src/storage/provider-registry.ts` must be free of Node-only
 * imports (it currently is — it only imports types). If that changes, this
 * import path will need to move to a standalone `@paperclipai/storage-core`
 * package (tracked as an optional follow-up to PR #2).
 */

import { registerStorageProvider } from "../../../server/src/storage/provider-registry.js";
import { R2Provider } from "./storage/r2-provider.js";

/**
 * Environment bindings required at boot time.
 */
export interface BootEnv {
  /** R2 bucket binding — declared as `PAPERCLIP_STORAGE` in wrangler.toml. */
  PAPERCLIP_STORAGE: R2Bucket;
  /**
   * Logical bucket name stored on object metadata (informational).
   * Defaults to `"paperclip-storage"` if absent.
   */
  STORAGE_R2_BUCKET?: string;
  /**
   * Optional key prefix applied to every stored object key.
   * Useful when sharing a single R2 bucket across multiple environments
   * (e.g. `"staging/"` vs `"prod/"`).
   */
  STORAGE_R2_PREFIX?: string;
}

/**
 * Registers the Cloudflare R2 storage provider with the shared provider
 * registry from `server/src/storage/provider-registry.ts`.
 *
 * After registration, calling `createStorageProviderFromConfig` with
 * `config.storageProvider === "r2"` returns an `R2Provider` backed by the
 * `PAPERCLIP_STORAGE` R2 bucket binding.
 *
 * The registry uses a plain `Map`; calling `bootCloudflare` multiple times
 * (e.g. on each warm-start invocation) is safe — subsequent calls overwrite
 * the previous factory with an equivalent one.
 *
 * @param env - The Worker environment bindings injected by the CF runtime.
 */
export function bootCloudflare(env: BootEnv): void {
  const bucketName = env.STORAGE_R2_BUCKET ?? "paperclip-storage";
  const prefix = env.STORAGE_R2_PREFIX ?? "";

  registerStorageProvider("r2", (_config) => {
    return new R2Provider(env.PAPERCLIP_STORAGE, { bucket: bucketName, prefix });
  });
}
