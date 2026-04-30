/**
 * Custom esbuild bundler for the Cloudflare Worker.
 *
 * Wrangler's built-in esbuild cannot mark specific packages as external or
 * alias individual modules, so we pre-bundle the worker here and point wrangler
 * to the output with --no-bundle.
 *
 * Two categories of problematic packages:
 *
 * 1. Available in CF Workers via nodejs_compat → mark as `external` so the CF
 *    runtime resolves them (node:crypto, node:stream, node:path, etc.)
 *
 * 2. NOT available in CF Workers (node:http, node:net, node:tls, node:fs, etc.)
 *    → alias to lightweight stubs bundled into the output. If the CF runtime tried
 *    to resolve these as externals it would crash on startup.
 *
 * Other stubs:
 *   - express → cf-express-shim (zero-dep Router that Express-router-bridge can walk)
 *   - embedded-postgres / @embedded-postgres/* → external (never called in CF)
 *   - jsdom → external (SVG sanitize path throws at runtime; acceptable for CF)
 */

import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIMS = path.join(__dirname, "src/shims");

// Node.js built-ins CF Workers DOES provide via nodejs_compat.
// Mark external → CF runtime resolves them at runtime.
const CF_PROVIDED_BUILTINS = [
  "node:assert", "node:async_hooks", "node:buffer", "node:crypto",
  "node:diagnostics_channel", "node:events", "node:module",
  "node:path", "node:perf_hooks", "node:process", "node:querystring",
  "node:stream", "node:stream/consumers", "node:stream/promises",
  "node:stream/web", "node:string_decoder", "node:timers",
  "node:timers/promises", "node:url", "node:util", "node:util/types",
  "node:worker_threads", "node:zlib",
  // Without "node:" prefix (legacy imports resolved by CF runtime too)
  "assert", "async_hooks", "buffer", "crypto", "diagnostics_channel",
  "events", "module", "path", "perf_hooks", "querystring",
  "stream", "string_decoder", "timers", "url", "util", "worker_threads", "zlib",
  // node:sqlite (Node 22.5+) — only referenced in try/catch inside undici@7;
  // the CF runtime will reject it but that code path is never reached.
  "node:sqlite",
  // Node-only packages not available in CF — never called in CF code paths
  "embedded-postgres",
  "@embedded-postgres/*",
  "jsdom",
];

await build({
  entryPoints: [path.join(__dirname, "src/worker/api.ts")],
  bundle: true,
  outfile: path.join(__dirname, "dist/worker.js"),
  format: "esm",
  target: "es2022",
  platform: "node",
  conditions: ["workerd", "worker", "browser", "module"],
  mainFields: ["module", "main"],
  external: [
    "cloudflare:*",
    ...CF_PROVIDED_BUILTINS,
  ],
  alias: {
    // Express replacement: zero-dep CF-safe Router shim
    "express": path.join(__dirname, "src/http/cf-express-shim.ts"),

    // Node.js APIs NOT available in CF Workers — stub them so the bundle
    // doesn't fail to load (code that calls these throws at runtime, which
    // is acceptable since these paths are not exercised in CF).
    "node:http":          path.join(SHIMS, "node-http.ts"),
    "http":               path.join(SHIMS, "node-http.ts"),
    "node:https":         path.join(SHIMS, "node-https.ts"),
    "https":              path.join(SHIMS, "node-https.ts"),
    "node:net":           path.join(SHIMS, "node-net.ts"),
    "net":                path.join(SHIMS, "node-net.ts"),
    "node:tls":           path.join(SHIMS, "node-tls.ts"),
    "tls":                path.join(SHIMS, "node-tls.ts"),
    "node:fs":            path.join(SHIMS, "node-fs.ts"),
    "fs":                 path.join(SHIMS, "node-fs.ts"),
    "node:fs/promises":   path.join(SHIMS, "node-fs-promises.ts"),
    "fs/promises":        path.join(SHIMS, "node-fs-promises.ts"),
    "node:http2":         path.join(SHIMS, "node-http2.ts"),
    "http2":              path.join(SHIMS, "node-http2.ts"),
    "node:child_process": path.join(SHIMS, "node-child-process.ts"),
    "child_process":      path.join(SHIMS, "node-child-process.ts"),
    "node:readline":      path.join(SHIMS, "node-readline.ts"),
    "readline":           path.join(SHIMS, "node-readline.ts"),
    // process module: CF Workers has 'process' as a global but its module export
    // doesn't have named exports like 'versions'; provide a shim that does.
    "process":            path.join(SHIMS, "node-process.ts"),
    "node:process":       path.join(SHIMS, "node-process.ts"),
    // pino: Node.js-specific CJS logger; replace with a CF-safe console-backed shim.
    "pino":               path.join(SHIMS, "pino-shim.ts"),
    // pino-http: Express HTTP logger middleware using pino internals; not used in CF.
    "pino-http":          path.join(SHIMS, "pino-shim.ts"),
    // dotenv: CJS module that does require("path"/"crypto") at init — not needed in CF.
    "dotenv":             path.join(SHIMS, "dotenv-shim.ts"),
    // multer: CJS file-upload middleware; pulls in mime-types → require("path").
    // CF Workers handles uploads via Request.formData(); shim provides the API shape.
    "multer":             path.join(SHIMS, "multer-shim.ts"),
    "node:os":            path.join(SHIMS, "node-os.ts"),
    "os":                 path.join(SHIMS, "node-os.ts"),
    "node:dns":           path.join(SHIMS, "node-dns.ts"),
    "dns":                path.join(SHIMS, "node-dns.ts"),
    "node:dns/promises":  path.join(SHIMS, "node-dns.ts"),
    "dns/promises":       path.join(SHIMS, "node-dns.ts"),
  },
  plugins: [
    // esbuild alias only supports bare module names; use a plugin to intercept
    // specific server source files that require CF-safe shims. We match by path
    // suffix so relative and package-alias imports are both caught.
    {
      name: "server-file-shims",
      setup(build) {
        const SERVER_SRC = path.resolve(__dirname, "../../server/src");
        const intercepts = [
          { serverRelPath: "middleware/logger", shimFile: "server-logger-shim.ts", filter: /logger/ },
          { serverRelPath: "version",           shimFile: "server-version-shim.ts", filter: /version/ },
        ];
        for (const { serverRelPath, shimFile, filter } of intercepts) {
          const targetNoExt = path.join(SERVER_SRC, serverRelPath);
          const shimPath = path.join(SHIMS, shimFile);
          build.onResolve({ filter }, (args) => {
            if (!args.resolveDir) return;
            const absNoExt = path.resolve(args.resolveDir, args.path).replace(/\.[jt]sx?$/, "");
            if (absNoExt === targetNoExt) return { path: shimPath };
          });
        }
      },
    },
  ],
  // Inject a banner that polyfills Node.js globals missing from CF Workers nodejs_compat.
  // Must run before any module initialization (pino uses process.hrtime.bigint at load time).
  banner: {
    js: [
      "// CF Workers polyfills for missing nodejs_compat APIs",
      "if (typeof process !== 'undefined') {",
      "  if (!process.hrtime) {",
      "    process.hrtime = function(time) {",
      "      const ms = Date.now();",
      "      const s = Math.floor(ms / 1000);",
      "      const ns = (ms % 1000) * 1000000;",
      "      if (time) return [s - time[0], ns - time[1]];",
      "      return [s, ns];",
      "    };",
      "    process.hrtime.bigint = function() { return BigInt(Date.now()) * 1000000n; };",
      "  }",
      "  if (!process.cwd) process.cwd = function() { return '/'; };",
      "  if (!process.chdir) process.chdir = function() {};",
      "  if (!process.exit) process.exit = function(code) { throw new Error('process.exit(' + code + ')'); };",
      "}",
    ].join("\n"),
  },
  splitting: false,
  define: {
    "process.env.NODE_ENV": '"production"',
    // db/src/client.ts uses import.meta.url to locate migration files.
    // In CF Workers this code path is never exercised (migrations run externally),
    // but the variable is assigned at module level so we need a valid URL base.
    "import.meta.url": '"file:///worker.js"',
  },
  logLevel: "info",
});

console.log("Worker bundle written to dist/worker.js");
