import type { ModuleTarget } from "../types.js";

/** Node core module names (static list — an isomorphic lib can't read `node:module`). */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** Strip a `node:` prefix and any subpath, returning the core module name. */
export function nodeBuiltinName(spec: string): string | undefined {
  const bare = spec.replace(/^node:/, "");
  const root = bare.split("/")[0];
  return NODE_BUILTINS.has(root) ? bare : undefined;
}

export function isNodeBuiltin(spec: string): boolean {
  return nodeBuiltinName(spec) !== undefined;
}

/**
 * Map a Node-builtin specifier under a given target:
 * - `browser` → a `@jspm/core` browser-polyfill package ref (served locally).
 * - `node`    → `{ external }` (leave the `node:`-prefixed specifier in place).
 */
export function resolveNodeBuiltin(
  spec: string,
  target: ModuleTarget,
): { ref: { pkg: string; subpath: string } } | { external: string } | undefined {
  const name = nodeBuiltinName(spec);
  if (name === undefined) return undefined;
  if (target === "node") return { external: `node:${name}` };
  return { ref: { pkg: "@jspm/core", subpath: `nodelibs/browser/${name}` } };
}
