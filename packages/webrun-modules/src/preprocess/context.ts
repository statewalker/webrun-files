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

/** Fine-grained input classification driving the transform registry. `css` and
 *  `tailwind-css` share the coarse `css` bucket (see `coarseBucket`); a registry
 *  that registers only `css` handles both via fallback. */
export type InputType = "module" | "css" | "tailwind-css";

/** One registered transform: what it consumes (`inType`), what it emits
 *  (`outType`), and the per-file `run` (loads/resolves/transforms/caches). */
export interface RegisteredTransform {
  inType: InputType;
  outType: "js" | "css";
  run(
    id: string,
    source: string,
    ctx: PreprocessContext,
  ): Promise<{ code: string; emittedId: string }>;
}

/** Registry of transforms keyed by `InputType`. `get` throws on a missing key;
 *  `register` is last-wins. */
export interface TransformRegistry {
  has(t: InputType): boolean;
  get(t: InputType): RegisteredTransform;
  register(t: RegisteredTransform): void;
}

/** Classify a raw file by id + content. CSS content is sniffed for Tailwind
 *  directives (`@tailwind`, or `@import "tailwindcss"`) → `tailwind-css`; plain
 *  CSS → `css`; everything else → `module`. */
export function detectInputType(id: string, source: string): InputType {
  if (isCssFile(id)) {
    return /^\s*@tailwind\b/m.test(source) || /^\s*@import\s+["']tailwindcss["']/m.test(source)
      ? "tailwind-css"
      : "css";
  }
  return "module";
}

/** The coarse fallback bucket for an `InputType`: `tailwind-css` degrades to
 *  `css`; every other type is its own bucket. */
export function coarseBucket(t: InputType): InputType {
  return t === "tailwind-css" ? "css" : t;
}

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
  /** Input-type → transform registry consulted by `preprocessModule`. Drivers
   *  attach the default (`newDefaultTransformRegistry()`); an unregistered
   *  fine-grained type falls back to its `coarseBucket`. */
  transforms?: TransformRegistry;
  /**
   * OPT-IN incremental gate. When set, `walkFrom` consults it for each reachable
   * module/CSS id BEFORE transforming: returning `true` means the emitted artifact
   * for `id` is already current, so its transform + emit are skipped (its closure is
   * still traversed). Absent (the request-time server) ⇒ every id is transformed,
   * byte-identical to the pre-gate behaviour. The batch build supplies a
   * content-hash hook so shared/interior nodes aren't re-transformed once per path.
   */
  skipTransform?(id: string, source: string): Promise<boolean>;
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
