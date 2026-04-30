/**
 * @fileoverview Adapter management REST API routes
 *
 * This module provides Express routes for managing external adapter plugins:
 * - Listing all registered adapters (built-in + external)
 * - Installing external adapters from npm packages or local paths
 * - Unregistering external adapters
 *
 * Read-only routes require board org access. Mutating adapter management
 * routes require instance-admin access because they can install, reload, or
 * toggle server-side adapter code for the whole Paperclip instance.
 *
 * @module server/routes/adapters
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import {
  listServerAdapters,
  findServerAdapter,
  findActiveServerAdapter,
  listEnabledServerAdapters,
  registerServerAdapter,
  resolveExternalAdapterRegistration,
  unregisterServerAdapter,
  isOverridePaused,
  setOverridePaused,
} from "../adapters/registry.js";
import {
  listAdapterPlugins,
  addAdapterPlugin,
  removeAdapterPlugin,
  getAdapterPluginByType,
  getAdapterPluginsDir,
  getDisabledAdapterTypes,
  setAdapterDisabled,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import type { ServerAdapterModule, AdapterConfigSchema } from "../adapters/types.js";
import { loadExternalAdapterPackage, getUiParserSource, getOrExtractUiParserSource, reloadExternalAdapter } from "../adapters/plugin-loader.js";
import { logger } from "../middleware/logger.js";
import { assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface AdapterInstallRequest {
  /** npm package name (e.g., "droid-paperclip-adapter") or local path */
  packageName: string;
  /** True if packageName is a local filesystem path */
  isLocalPath?: boolean;
  /** Target version for npm packages (optional, defaults to latest) */
  version?: string;
}

interface AdapterCapabilities {
  supportsInstructionsBundle: boolean;
  supportsSkills: boolean;
  supportsLocalAgentJwt: boolean;
  requiresMaterializedRuntimeSkills: boolean;
}

interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  capabilities: AdapterCapabilities;
  /** True when an external plugin has replaced a built-in adapter of the same type. */
  overriddenBuiltin?: boolean;
  /** True when the external override for a builtin type is currently paused. */
  overridePaused?: boolean;
  version?: string;
  packageName?: string;
  isLocalPath?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the adapter package directory (same rules as plugin-loader).
 */
function resolveAdapterPackageDir(record: AdapterPluginRecord): string {
  return record.localPath
    ? path.resolve(record.localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

/**
 * Read `version` from the adapter's package.json on disk.
 * This is the source of truth for what is actually installed (npm or local path).
 *
 * TODO(cloudflare): readAdapterPackageVersionFromDisk uses fs.readFileSync to
 * read package.json from a locally installed npm package directory. The entire
 * concept of locally installed adapter packages assumes a persistent filesystem
 * and a Node-compatible module loader. For Workers compatibility the installed
 * version should be persisted to the database at install time and read from
 * there instead of from disk at request time.
 */
function readAdapterPackageVersionFromDisk(record: AdapterPluginRecord): string | undefined {
  try {
    const pkgDir = resolveAdapterPackageDir(record);
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8");
    const v = JSON.parse(raw).version;
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

function buildAdapterCapabilities(adapter: ServerAdapterModule): AdapterCapabilities {
  return {
    supportsInstructionsBundle: adapter.supportsInstructionsBundle ?? false,
    supportsSkills: Boolean(adapter.listSkills || adapter.syncSkills),
    supportsLocalAgentJwt: adapter.supportsLocalAgentJwt ?? false,
    requiresMaterializedRuntimeSkills: adapter.requiresMaterializedRuntimeSkills ?? false,
  };
}

function buildAdapterInfo(adapter: ServerAdapterModule, externalRecord: AdapterPluginRecord | undefined, disabledSet: Set<string>): AdapterInfo {
  const fromDisk = externalRecord ? readAdapterPackageVersionFromDisk(externalRecord) : undefined;
  return {
    type: adapter.type,
    label: adapter.type, // ServerAdapterModule doesn't have a separate "label" field; type serves as label
    source: externalRecord ? "external" : "builtin",
    modelsCount: (adapter.models ?? []).length,
    loaded: true, // If it's in the registry, it's loaded
    disabled: disabledSet.has(adapter.type),
    capabilities: buildAdapterCapabilities(adapter),
    overriddenBuiltin: externalRecord ? BUILTIN_ADAPTER_TYPES.has(adapter.type) : undefined,
    overridePaused: BUILTIN_ADAPTER_TYPES.has(adapter.type) ? isOverridePaused(adapter.type) : undefined,
    // Prefer on-disk package.json so the UI reflects bumps without relying on store-only fields.
    version: fromDisk ?? externalRecord?.version,
    packageName: externalRecord?.packageName,
    isLocalPath: externalRecord?.localPath ? true : undefined,
  };
}

/**
 * Normalize a local path that may be a Windows path into a WSL-compatible path.
 *
 * - Windows paths (e.g., "C:\\Users\\...") are converted via `wslpath -u`.
 * - Paths already starting with `/mnt/` or `/` are returned as-is.
 */
async function normalizeLocalPath(rawPath: string): Promise<string> {
  // Already a POSIX path (WSL or native Linux)
  if (rawPath.startsWith("/")) {
    return rawPath;
  }

  // Windows path detection: C:\ or C:/ pattern
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
    try {
      const { stdout } = await execFileAsync("wslpath", ["-u", rawPath]);
      return stdout.trim();
    } catch (err) {
      logger.warn({ err, rawPath }, "wslpath conversion failed; using path as-is");
      return rawPath;
    }
  }

  return rawPath;
}

/**
 * Register an external adapter module into the server registry via the
 * hot-install path, resolving `sessionManagement` identically to how the
 * init-time IIFE does. Module-provided `sessionManagement` is honored first,
 * with fallback to the host registry by type for builtin-type overrides.
 *
 * Keeps the hot-install and init-time paths at parity so an adapter installed
 * via `POST /api/adapters/install` has the same shape in the registry as the
 * same adapter loaded on the next server restart.
 */
function registerWithSessionManagement(adapter: ServerAdapterModule): void {
  registerServerAdapter(resolveExternalAdapterRegistration(adapter));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function adapterRoutes() {
  const router = Router();

  // Storage is not used by any adapter handler.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`adapter handler unexpectedly accessed storage.${String(prop)}`);
    },
  });

  // A placeholder Db sentinel — adapter routes do not touch the database.
  // expressHandler requires a Db in deps; supply a proxy that throws on access.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbSentinel = new Proxy({} as any, {
    get(_target, prop) {
      throw new Error(`adapter handler unexpectedly accessed db.${String(prop)}`);
    },
  });

  const adapterDeps = { db: dbSentinel, storage: storageSentinel };

  // ---------------------------------------------------------------------------
  // Authz helpers — assertBoardOrgAccess and assertInstanceAdmin from authz.ts
  // accept RequestCtx directly (both satisfy the AuthzReq structural interface).
  // ---------------------------------------------------------------------------

  // config schema cache shared across the router's lifetime
  const configSchemaCache = new Map<string, {
    adapter: ServerAdapterModule;
    schema: AdapterConfigSchema;
    fetchedAt: number;
  }>();
  const CONFIG_SCHEMA_TTL_MS = 30_000;

  /**
   * GET /api/adapters
   *
   * List all registered adapters (built-in + external).
   * Each entry includes whether the adapter is built-in or external,
   * its model count, and load status.
   */
  const listAdapters: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);

    const registeredAdapters = listServerAdapters();
    const externalRecords = new Map(
      listAdapterPlugins().map((r) => [r.type, r]),
    );
    const disabledSet = new Set(getDisabledAdapterTypes());

    const result: AdapterInfo[] = registeredAdapters.map((adapter) =>
      buildAdapterInfo(adapter, externalRecords.get(adapter.type), disabledSet),
    ).sort((a, b) => a.type.localeCompare(b.type));

    return Response.json(result);
  };

  /**
   * POST /api/adapters/install
   *
   * Install an external adapter from an npm package or local path.
   *
   * Request body:
   * - packageName: string (required) — npm package name or local path
   * - isLocalPath?: boolean (default false)
   * - version?: string — target version for npm packages
   */
  const installAdapter: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const body = await ctx.json<AdapterInstallRequest>();
    const { packageName, isLocalPath = false, version } = body;

    if (!packageName || typeof packageName !== "string") {
      return Response.json({ error: "packageName is required and must be a string." }, { status: 400 });
    }

    // Strip version suffix if the UI sends "pkg@1.2.3" instead of separating it
    let canonicalName = packageName;
    let explicitVersion = version;
    const versionSuffix = packageName.match(/@(\d+\.\d+\.\d+.*)$/);
    if (versionSuffix) {
      const lastAtIndex = packageName.lastIndexOf("@");
      if (lastAtIndex > 0 && !explicitVersion) {
        canonicalName = packageName.slice(0, lastAtIndex);
        explicitVersion = versionSuffix[1];
      }
    }

    try {
      let installedVersion: string | undefined;
      let moduleLocalPath: string | undefined;

      if (!isLocalPath) {
        const pluginsDir = getAdapterPluginsDir();
        const spec = explicitVersion ? `${canonicalName}@${explicitVersion}` : canonicalName;

        logger.info({ spec, pluginsDir }, "Installing adapter package via npm");

        await execFileAsync("npm", ["install", "--no-save", spec], {
          cwd: pluginsDir,
          timeout: 120_000,
        });

        // TODO(cloudflare): reading package.json from the npm install directory
        // uses node:fs/promises at request time. For Workers compatibility the
        // installed version should be persisted to the DB by the install job and
        // read from there rather than from the local filesystem.
        try {
          const pkgJsonPath = path.join(pluginsDir, "node_modules", canonicalName, "package.json");
          const pkgContent = await import("node:fs/promises");
          const pkgRaw = await pkgContent.readFile(pkgJsonPath, "utf-8");
          const pkg = JSON.parse(pkgRaw);
          const v = pkg.version;
          installedVersion =
            typeof v === "string" && v.trim().length > 0 ? v.trim() : explicitVersion;
        } catch {
          installedVersion = explicitVersion;
        }
      } else {
        moduleLocalPath = path.resolve(await normalizeLocalPath(packageName));
        // TODO(cloudflare): reading package.json from a local-path adapter
        // directory uses node:fs/promises at request time. For Workers
        // compatibility the version should be captured during the install step
        // and stored in the database rather than read from disk at request time.
        try {
          const pkgRaw = await readFile(path.join(moduleLocalPath, "package.json"), "utf-8");
          const v = JSON.parse(pkgRaw).version;
          if (typeof v === "string" && v.trim().length > 0) {
            installedVersion = v.trim();
          }
        } catch {
          // leave installedVersion undefined if package.json is missing
        }
      }

      const adapterModule = await loadExternalAdapterPackage(canonicalName, moduleLocalPath);

      if (BUILTIN_ADAPTER_TYPES.has(adapterModule.type)) {
        return Response.json({
          error: `Adapter type "${adapterModule.type}" is a built-in adapter and cannot be overwritten.`,
        }, { status: 409 });
      }

      const existing = findServerAdapter(adapterModule.type);
      const isReinstall = existing !== null;
      if (existing) {
        unregisterServerAdapter(adapterModule.type);
        logger.info({ type: adapterModule.type }, "Unregistered existing adapter for replacement");
      }

      registerWithSessionManagement(adapterModule);

      const record: AdapterPluginRecord = {
        packageName: canonicalName,
        localPath: moduleLocalPath,
        version: installedVersion ?? explicitVersion,
        type: adapterModule.type,
        installedAt: new Date().toISOString(),
      };
      addAdapterPlugin(record);

      logger.info(
        { type: adapterModule.type, packageName: canonicalName },
        "External adapter installed and registered",
      );

      return Response.json({
        type: adapterModule.type,
        packageName: canonicalName,
        version: installedVersion ?? explicitVersion,
        installedAt: record.installedAt,
        requiresRestart: isReinstall,
      }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, packageName }, "Failed to install external adapter");

      if (message.includes("npm") || message.includes("ERR!")) {
        return Response.json({ error: `npm install failed: ${message}` }, { status: 500 });
      }
      return Response.json({ error: `Failed to install adapter: ${message}` }, { status: 500 });
    }
  };

  /**
   * PATCH /api/adapters/:type
   *
   * Enable or disable an adapter.
   *
   * Request body: { "disabled": boolean }
   */
  const patchAdapter: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const adapterType = ctx.param("type");
    if (!adapterType) return Response.json({ error: "Adapter type is required." }, { status: 400 });
    const body = await ctx.json<{ disabled?: boolean }>();
    const { disabled } = body;

    if (typeof disabled !== "boolean") {
      return Response.json({ error: "Request body must include { \"disabled\": true|false }." }, { status: 400 });
    }

    const existing = findServerAdapter(adapterType);
    if (!existing) {
      return Response.json({ error: `Adapter "${adapterType}" is not registered.` }, { status: 404 });
    }

    const changed = setAdapterDisabled(adapterType, disabled);

    if (changed) {
      logger.info({ type: adapterType, disabled }, "Adapter enabled/disabled");
    }

    return Response.json({ type: adapterType, disabled, changed });
  };

  /**
   * PATCH /api/adapters/:type/override
   *
   * Pause or resume an external adapter's override of a builtin type.
   */
  const patchAdapterOverride: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const adapterType = ctx.param("type");
    if (!adapterType) return Response.json({ error: "Adapter type is required." }, { status: 400 });
    const body = await ctx.json<{ paused?: boolean }>();
    const { paused } = body;

    if (typeof paused !== "boolean") {
      return Response.json({ error: "\"paused\" (boolean) is required in request body." }, { status: 400 });
    }

    if (!BUILTIN_ADAPTER_TYPES.has(adapterType)) {
      return Response.json({ error: `Type "${adapterType}" is not a builtin adapter.` }, { status: 400 });
    }

    const changed = setOverridePaused(adapterType, paused);

    logger.info({ type: adapterType, paused, changed }, "Adapter override toggle");

    return Response.json({ type: adapterType, paused, changed });
  };

  /**
   * DELETE /api/adapters/:type
   *
   * Unregister an external adapter. Built-in adapters cannot be removed.
   */
  const deleteAdapter: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const adapterType = ctx.param("type");

    if (!adapterType) {
      return Response.json({ error: "Adapter type is required." }, { status: 400 });
    }

    if (BUILTIN_ADAPTER_TYPES.has(adapterType)) {
      return Response.json({
        error: `Cannot remove built-in adapter "${adapterType}".`,
      }, { status: 403 });
    }

    const existing = findServerAdapter(adapterType);
    if (!existing) {
      return Response.json({
        error: `Adapter "${adapterType}" is not registered.`,
      }, { status: 404 });
    }

    const externalRecord = getAdapterPluginByType(adapterType);
    if (!externalRecord) {
      return Response.json({
        error: `Adapter "${adapterType}" is not an externally installed adapter.`,
      }, { status: 404 });
    }

    if (externalRecord.packageName && !externalRecord.localPath) {
      try {
        const pluginsDir = getAdapterPluginsDir();
        await execFileAsync("npm", ["uninstall", externalRecord.packageName], {
          cwd: pluginsDir,
          timeout: 60_000,
        });
        logger.info(
          { type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall completed for external adapter",
        );
      } catch (err) {
        logger.warn(
          { err, type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall failed for external adapter; continuing with unregister",
        );
      }
    }

    unregisterServerAdapter(adapterType);
    removeAdapterPlugin(adapterType);

    logger.info({ type: adapterType }, "External adapter unregistered and removed");

    return Response.json({ type: adapterType, removed: true });
  };

  /**
   * POST /api/adapters/:type/reload
   *
   * Reload an external adapter at runtime.
   */
  const reloadAdapter: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const type = ctx.param("type");
    if (!type) return Response.json({ error: "Adapter type is required." }, { status: 400 });

    if (BUILTIN_ADAPTER_TYPES.has(type) && !getAdapterPluginByType(type)) {
      return Response.json({ error: "Cannot reload built-in adapter." }, { status: 400 });
    }

    try {
      const newModule = await reloadExternalAdapter(type);

      if (!newModule) {
        return Response.json({ error: `Adapter "${type}" is not an externally installed adapter.` }, { status: 404 });
      }

      unregisterServerAdapter(type);
      registerWithSessionManagement(newModule);
      configSchemaCache.delete(type);

      const record = getAdapterPluginByType(type);
      let newVersion: string | undefined;
      if (record) {
        newVersion = readAdapterPackageVersionFromDisk(record);
        if (newVersion) {
          addAdapterPlugin({ ...record, version: newVersion });
        }
      }

      logger.info({ type, version: newVersion }, "External adapter reloaded at runtime");

      return Response.json({ type, version: newVersion, reloaded: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to reload external adapter");
      return Response.json({ error: `Failed to reload adapter: ${message}` }, { status: 500 });
    }
  };

  /**
   * POST /api/adapters/:type/reinstall
   *
   * Reinstall an npm-sourced external adapter.
   */
  const reinstallAdapter: Handler = async (ctx) => {
    assertInstanceAdmin(ctx);
    const type = ctx.param("type");
    if (!type) return Response.json({ error: "Adapter type is required." }, { status: 400 });

    if (BUILTIN_ADAPTER_TYPES.has(type) && !getAdapterPluginByType(type)) {
      return Response.json({ error: "Cannot reinstall built-in adapter." }, { status: 400 });
    }

    const record = getAdapterPluginByType(type);
    if (!record) {
      return Response.json({ error: `Adapter "${type}" is not an externally installed adapter.` }, { status: 404 });
    }

    if (record.localPath) {
      return Response.json({ error: "Local-path adapters cannot be reinstalled. Use Reload instead." }, { status: 400 });
    }

    try {
      const pluginsDir = getAdapterPluginsDir();

      logger.info({ type, packageName: record.packageName }, "Reinstalling adapter package via npm");

      await execFileAsync("npm", ["install", "--no-save", record.packageName], {
        cwd: pluginsDir,
        timeout: 120_000,
      });

      const newModule = await reloadExternalAdapter(type);
      if (!newModule) {
        return Response.json({ error: "npm install succeeded but adapter reload failed." }, { status: 500 });
      }

      unregisterServerAdapter(type);
      registerWithSessionManagement(newModule);
      configSchemaCache.delete(type);

      let newVersion: string | undefined;
      const updatedRecord = getAdapterPluginByType(type);
      if (updatedRecord) {
        newVersion = readAdapterPackageVersionFromDisk(updatedRecord);
        if (newVersion) {
          addAdapterPlugin({ ...updatedRecord, version: newVersion });
        }
      }

      logger.info({ type, version: newVersion }, "Adapter reinstalled from npm");

      return Response.json({ type, version: newVersion, reinstalled: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to reinstall adapter");
      return Response.json({ error: `Reinstall failed: ${message}` }, { status: 500 });
    }
  };

  /**
   * GET /api/adapters/:type/config-schema
   *
   * Serve a declarative config schema for an adapter's UI form fields.
   */
  const getAdapterConfigSchema: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const type = ctx.param("type");
    if (!type) return Response.json({ error: "Adapter type is required." }, { status: 400 });

    const adapter = findActiveServerAdapter(type);
    if (!adapter) {
      return Response.json({ error: `Adapter "${type}" is not registered.` }, { status: 404 });
    }
    if (!adapter.getConfigSchema) {
      return Response.json({ error: `Adapter "${type}" does not provide a config schema.` }, { status: 404 });
    }

    const cached = configSchemaCache.get(type);
    if (cached && cached.adapter === adapter && Date.now() - cached.fetchedAt < CONFIG_SCHEMA_TTL_MS) {
      return Response.json(cached.schema);
    }

    try {
      const schema = await adapter.getConfigSchema();
      configSchemaCache.set(type, { adapter, schema, fetchedAt: Date.now() });
      return Response.json(schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, type }, "Failed to resolve config schema");
      return Response.json({ error: `Failed to resolve config schema: ${message}` }, { status: 500 });
    }
  };

  /**
   * GET /api/adapters/:type/ui-parser.js
   *
   * Serve the self-contained UI parser JS for an adapter type.
   */
  const getAdapterUiParser: Handler = async (ctx) => {
    assertBoardOrgAccess(ctx);
    const type = ctx.param("type");
    if (!type) return Response.json({ error: "Adapter type is required." }, { status: 400 });
    const source = getOrExtractUiParserSource(type);
    if (!source) {
      return Response.json({ error: `No UI parser available for adapter "${type}".` }, { status: 404 });
    }
    return new Response(source, {
      headers: { "Content-Type": "application/javascript" },
    });
  };

  // ---------------------------------------------------------------------------
  // Wire handlers via expressHandler
  // ---------------------------------------------------------------------------

  router.get("/adapters", expressHandler(listAdapters, adapterDeps));
  router.post("/adapters/install", expressHandler(installAdapter, adapterDeps));
  router.patch("/adapters/:type", expressHandler(patchAdapter, adapterDeps));
  router.patch("/adapters/:type/override", expressHandler(patchAdapterOverride, adapterDeps));
  router.delete("/adapters/:type", expressHandler(deleteAdapter, adapterDeps));
  router.post("/adapters/:type/reload", expressHandler(reloadAdapter, adapterDeps));
  router.post("/adapters/:type/reinstall", expressHandler(reinstallAdapter, adapterDeps));
  router.get("/adapters/:type/config-schema", expressHandler(getAdapterConfigSchema, adapterDeps));
  router.get("/adapters/:type/ui-parser.js", expressHandler(getAdapterUiParser, adapterDeps));

  return router;
}
