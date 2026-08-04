import type { FilesApi } from "@statewalker/webrun-files";
import { relativeUrl } from "../server/specifiers.js";
import type {
  CssTransform,
  EndpointResolver,
  HostRegistry,
  Lockfile,
  ModuleTarget,
  Source,
  Transform,
} from "../types.js";

export type { HostRegistry } from "../types.js";

/** JS/TS module files — the only ones the transform touches. */
const MODULE_EXT = /\.(?:m|c)?[jt]sx?$/;
export const isModuleFile = (path: string): boolean => MODULE_EXT.test(path);
export const isCssFile = (path: string): boolean => /\.css$/.test(path);

/**
 * The URL-naming seam. Two-arg `servedUrl(targetId, importerId)` is computed in
 * urlPath-space (`relativeUrl(urlPath(importerId), urlPath(targetId))`); the policy
 * OWNS only the extension decision (keep-ext vs ext-map `.js`), the `?module`
 * marking for json/css, and the final relativization. The `urlPath`/depsPrefix
 * id-space and the emit paths are core-owned (shared across drivers).
 */
export interface UrlPolicy {
  /** URL spliced into emitted code for an import of `targetId` from `importerId`. */
  servedUrl(targetId: string, importerId: string): string;
  /** Where the emitted artifact for `id` is written / addressed (module, `~deps`
   *  proxy, and globals-proxy ids alike). */
  emittedPath(id: string): string;
}

/**
 * Everything the per-file preprocess core needs, made explicit so both the
 * request-time server and the batch build drive the SAME functions. Holds raw
 * inputs plus derived state (`globals` merged, `resolveEndpoint` defaulted,
 * `registry` explicit — never a `globalThis` mutation).
 */
export interface PreprocessContext {
  /** Raw project sources (`~/…`). Optional — a package-only server has none. */
  files?: FilesApi;
  /** Where emitted artifacts + lock + the `/raw` cache live. */
  cache: FilesApi;
  target: ModuleTarget;
  basePath: string;
  /** Normalized deps prefix (relative to `basePath`); `""` when unset. */
  depsPath: string;
  tRoot: string;
  lock: Lockfile;
  sources: Source[];
  transform: Transform;
  css: CssTransform;
  /** Explicit host registry — replaces the `globalThis[HOST_REGISTRY_KEY]` mutation. */
  registry: HostRegistry;
  /** Free-global allowlist → module expressions (target defaults merged with user). */
  globals: Record<string, string>;
  /** The linker; the core builds the default when not overridden. */
  resolveEndpoint: EndpointResolver;
  /** In-flight dedupe so parallel drivers can't double-load or tear a proxy. */
  inflight: Map<string, Promise<unknown>>;
  policy: UrlPolicy;
}

/** Project ids (`~/…`) are served verbatim; package ids get the `depsPath` prefix.
 *  `urlPath` is the site-relative space that import URLs are made relative in, so
 *  cross-prefix imports resolve correctly. Core-owned (shared across policies). */
export function urlPath(id: string, ctx: PreprocessContext): string {
  return id.startsWith("~/") ? id : ctx.depsPath + id;
}

/** Target-derived injectable free-global allowlist → module expressions. */
export function defaultGlobals(target: ModuleTarget): Record<string, string> {
  return {
    process:
      target === "browser"
        ? `globalThis.process ?? { env: { NODE_ENV: "production" } }`
        : `globalThis.process`,
    Buffer: `globalThis.Buffer`,
    global: `globalThis`,
    globalThis: `globalThis`,
    __dirname: `"/"`,
    __filename: `"/"`,
  };
}

/** Keep-ext policy: reproduces today's server URLs exactly — the source extension
 *  is kept and `?module` is added for json/css. `emittedPath` is `/t/{target}/{id}`.
 *  Built from `ctx` (closes over `ctx.depsPath`/`ctx.tRoot`), NOT an `export const`. */
export function makeKeepExtPolicy(ctx: PreprocessContext): UrlPolicy {
  return {
    servedUrl(targetId, importerId) {
      const url = relativeUrl(urlPath(importerId, ctx), urlPath(targetId, ctx));
      return targetId.endsWith(".json") || targetId.endsWith(".css") ? `${url}?module` : url;
    },
    emittedPath(id) {
      return `${ctx.tRoot}/${id}`;
    },
  };
}
