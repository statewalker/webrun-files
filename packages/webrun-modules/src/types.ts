import type { FilesApi } from "@statewalker/webrun-files";

/**
 * Public contract for `@statewalker/webrun-modules`. Types only — the resolver
 * core, the default npm `Source`, and the transforms are implemented separately.
 * Contract source: notes/2026/2026-07/2026-07-23/grill-module-webrun-modules.md
 */

/** The build target — selects `exports` conditions and is part of the cache key. */
export type ModuleTarget = "browser" | "node";

/**
 * A reference to resolve: either an npm package (with optional pinned version and
 * subpath) or a URL (a local project script served by this server, or an already
 * resolved local URL).
 */
export type ModuleRef = { pkg: string; version?: string; subpath?: string } | { url: string };

/** The result of resolving a `ModuleRef`: a directly `import`-able local URL. */
export interface ResolvedModule {
  /** Importable URL — `/{name}@{version}/{subpath}` for a package, carries `basePath`. */
  url: string;
  target: ModuleTarget;
}

/**
 * The version-dedupe map produced by `prime` and reusable as a pin input. One
 * artifact, two roles: a partial lockfile pins only the names it lists; `prime`
 * writes the complete one back to the cache.
 */
export type Lockfile = Record<string, string /* resolved version */>;

/** A parsed `package.json` (only the fields resolution reads). */
export interface PackageManifest {
  name: string;
  version: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  imports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** A package acquired by a `Source`: its untarred files plus parsed manifest. */
export interface LoadedPackage {
  name: string;
  version: string;
  /** The untarred package tree — every file individually addressable. */
  files: FilesApi;
  manifest: PackageManifest;
}

/**
 * Pluggable acquisition seam. The default impl fetches an npm registry tarball and
 * untars it in memory; JSR and direct-URL are alternative impls.
 */
export interface Source {
  /** Whether this source handles the given reference (npm | jsr | url). */
  matches(ref: ModuleRef): boolean;
  /** Resolve a concrete version, fetch bytes, untar, parse the manifest. */
  load(ref: ModuleRef): Promise<LoadedPackage>;
}

/** The source-file kinds the transform distinguishes. */
export type SourceFormat = "esm" | "cjs" | "ts" | "tsx";

export interface SourceFile {
  path: string;
  source: string;
  format: SourceFormat;
}

/** One specifier's imported bindings (which forms are used). */
export interface ModuleImport {
  /** named imports, e.g. { useState } → ["useState"] */
  names: string[];
  /** `import * as X` present */
  hasNamespace: boolean;
  /** `import X` (default) present */
  hasDefault: boolean;
}

/**
 * Static-analysis result for one module. Free globals are modeled as imports
 * from the reserved `""` (host/globalThis) pseudo-module.
 */
export interface ModuleDescriptor {
  /** specifier → imported bindings; key "" holds detected free-global names. */
  imports: Record<string, ModuleImport>;
  /** the module's own exported names (default counted as "default"). */
  exports: string[];
}

/**
 * Pluggable per-file transform seam. Turns one raw file into browser-runnable ESM,
 * passing every discovered specifier through `rewrite` (which returns the
 * same-origin, prefix-portable relative URL to emit).
 */
export interface Transform {
  transform(file: SourceFile, rewrite: (specifier: string) => string): Promise<string>;
}

export interface ModuleServerOptions {
  /** Injected cache — NodeFilesApi / browser-OPFS / MemFilesApi. Never node:fs. */
  cache: FilesApi;
  /** Optional: local project files served under their own paths (authored scripts). */
  project?: FilesApi;
  /** Acquisition sources; defaults to `[npmRegistrySource()]`. */
  sources?: Source[];
  /** Per-file transform; defaults to the sucrase-based ESM + CJS-interop transform. */
  transform?: Transform;
  /** Selects `exports` conditions and cache key. Defaults to `"browser"`. */
  target?: ModuleTarget;
  /** Optional lockfile input for reproducible resolution; also written by `prime`. */
  lock?: Lockfile;
  /** Mount prefix, e.g. `"/deps/v1/"`. Defaults to `"/"`. */
  basePath?: string;
  /** Prefix (relative to `basePath`) for external package URLs, isolating npm
   *  deps under e.g. `"deps/"` while authored project files stay at `~/`.
   *  Defaults to `""` — packages served alongside project files. */
  depsPath?: string;
}

export interface ModuleServer {
  /** Resolve a single reference to an importable local URL (resolve-on-miss). */
  resolve(ref: ModuleRef, importer?: string): Promise<ResolvedModule>;
  /** Walk the entry's whole graph, warm the cache, write `lock`. */
  prime(entry: ModuleRef): Promise<ResolvedModule>;
  /** Prime an entry and return every reachable module URL (the exact set of
   *  scripts required to run it, `basePath`-prefixed, sorted). */
  listResources(entry: ModuleRef): Promise<string[]>;
  /** List every file of a package (raw, package-relative paths), loading it if
   *  needed — the full package contents, not just the reachable subset. */
  listPackageFiles(ref: ModuleRef): Promise<string[]>;
  /** Standard Web handler; serves the cache and matches under `basePath`. */
  fetch(request: Request): Promise<Response>;
  /** The resolved graph — also the persisted lockfile. */
  readonly lock: Lockfile;
}

/** Host-populated registry of live module instances bound via the `host` endpoint. */
export interface HostRegistry {
  set(name: string, instance: unknown): void;
  get(name: string): unknown;
  has(name: string): boolean;
}

/** Thrown when a package / version / subpath cannot be resolved. */
export class ModuleResolveError extends Error {
  constructor(
    readonly ref: ModuleRef,
    readonly reason: string,
  ) {
    super(`Cannot resolve ${JSON.stringify(ref)}: ${reason}`);
    this.name = "ModuleResolveError";
  }
}

/** Thrown when a file cannot be transformed to runnable ESM. */
export class ModuleTransformError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Cannot transform ${path}: ${reason}`);
    this.name = "ModuleTransformError";
  }
}
