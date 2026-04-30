import type { Config } from "../config.js";
import type { StorageProvider as StorageProviderImpl } from "./types.js";
import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "./local-disk-provider.js";
import { createS3StorageProvider } from "./s3-provider.js";

type StorageProviderFactory = (config: Config) => StorageProviderImpl;
const externalProviders = new Map<StorageProviderId, StorageProviderFactory>();

export function registerStorageProvider(id: StorageProviderId, factory: StorageProviderFactory): void {
  externalProviders.set(id, factory);
}

export function createStorageProviderFromConfig(config: Config): StorageProviderImpl {
  if (config.storageProvider === "local_disk") {
    return createLocalDiskStorageProvider(config.storageLocalDiskBaseDir);
  }

  if (config.storageProvider === "s3") {
    return createS3StorageProvider({
      bucket: config.storageS3Bucket,
      region: config.storageS3Region,
      endpoint: config.storageS3Endpoint,
      prefix: config.storageS3Prefix,
      forcePathStyle: config.storageS3ForcePathStyle,
    });
  }

  const external = externalProviders.get(config.storageProvider);
  if (external) {
    return external(config);
  }

  throw new Error(`Unknown storage provider: ${config.storageProvider}`);
}
