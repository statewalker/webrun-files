import { readText } from "@statewalker/webrun-files";
import { globalHostRegistry, HOST_REGISTRY_KEY } from "../deps/host-registry.js";
import {
  defaultGlobals,
  makeKeepExtPolicy,
  type PreprocessContext,
  type UrlPolicy,
  urlPath,
} from "../preprocess/context.js";
import { cssModuleWrapper, preprocessModule, serveJsonModule } from "../preprocess/module.js";
import { newDefaultTransformRegistry } from "../preprocess/registry.js";
import { ensurePackage, makeDefaultEndpointResolver, rawBytes } from "../preprocess/resolve.js";
import { walkFrom } from "../preprocess/walk.js";
import { npmRegistrySource } from "../sources/npm-registry-source.js";
import { newDefaultCssTransform } from "../transform/css/index.js";
import { newDefaultTransform } from "../transform/index.js";
import type {
  CssTransformResult,
  EndpointResolver,
  HostRegistry,
  Lockfile,
  ModuleRef,
  ModuleServer,
  ModuleServerOptions,
  ResolvedModule,
} from "../types.js";
import { ModuleResolveError } from "../types.js";

/** JS/TS module files — the only ones the transform touches. */
const MODULE_EXT = /\.(?:m|c)?[jt]sx?$/;
const isModuleFile = (path: string) => MODULE_EXT.test(path);
const isCssFile = (path: string) => /\.css$/.test(path);

const CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  html: "text/html",
  svg: "image/svg+xml",
  wasm: "application/wasm",
  map: "application/json",
  txt: "text/plain",
};

/** Guess a content-type from a file path (non-module resources). */
function contentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Create a module/dependency server over an injected `FilesApi` cache. */
export function newModuleServer(options: ModuleServerOptions): ModuleServer {
  const cache = options.cache;
  const project = options.project;
  const sources = options.sources ?? [npmRegistrySource()];
  const transformer = options.transform ?? newDefaultTransform();
  const cssTransformer = options.css ?? newDefaultCssTransform();
  const target = options.target ?? "browser";
  const basePath = normalizeBase(options.basePath ?? "/");
  // Optional prefix (relative to `basePath`) for external package URLs, so npm
  // deps can be isolated under e.g. `/deps/` while authored project files stay at
  // `~/`. Default "" ⇒ packages served alongside project files (unchanged).
  const depsPrefix = normalizeDeps(options.depsPath ?? "");
  const lock: Lockfile = { ...(options.lock ?? {}) };
  const tRoot = `/t/${target}`;

  // Provided registry: a live `HostRegistry` BECOMES the realm-global so served
  // proxies + `providedNames` read the same object (late `.set` calls stay
  // visible); a plain Record is copied into the shared global registry. The
  // extracted resolution core reads `ctx.registry` only (never `globalThis`).
  if (options.provided && typeof (options.provided as HostRegistry).get === "function") {
    (globalThis as Record<string, unknown>)[HOST_REGISTRY_KEY] = options.provided;
  }
  const registry = globalHostRegistry();
  if (options.provided && typeof (options.provided as HostRegistry).get !== "function") {
    for (const [k, v] of Object.entries(options.provided as Record<string, unknown>)) {
      registry.set(k, v);
    }
  }

  // The explicit per-file preprocess context: everything the lifted resolution
  // cluster (`src/preprocess/*`) needs, driven here with the keep-ext policy that
  // reproduces today's server URLs exactly. `policy` + `resolveEndpoint` close
  // over `ctx`, so they are wired in immediately after construction.
  const ctx: PreprocessContext = {
    files: project,
    cache,
    target,
    basePath,
    depsPath: depsPrefix,
    tRoot,
    lock,
    sources,
    transform: transformer,
    css: cssTransformer,
    registry,
    globals: { ...defaultGlobals(target), ...(options.globals ?? {}) },
    inflight: new Map(),
    transforms: newDefaultTransformRegistry(),
    policy: undefined as unknown as UrlPolicy,
    resolveEndpoint: undefined as unknown as EndpointResolver,
  };
  ctx.policy = makeKeepExtPolicy(ctx);
  ctx.resolveEndpoint = options.resolveEndpoint ?? makeDefaultEndpointResolver(ctx);

  let ready: Promise<void> | undefined;
  const init = () => {
    ready ??= (async () => {
      if (await cache.exists("/lock.json")) {
        Object.assign(lock, JSON.parse(await readText(cache, "/lock.json")), options.lock ?? {});
      }
    })();
    return ready;
  };

  const urlFor = (id: string) => basePath + urlPath(id, ctx);
  const idFromPath = (pathname: string): string => {
    let p = pathname.startsWith(basePath)
      ? pathname.slice(basePath.length)
      : pathname.replace(/^\//, "");
    if (depsPrefix && p.startsWith(depsPrefix)) p = p.slice(depsPrefix.length);
    return p;
  };

  /** Transform + cache a `.css` file via the shared `preprocessModule` core, then
   *  reconstruct the `CssTransformResult` (its exports come back from the sidecar
   *  the core just wrote) for the callers that need the class map. */
  async function cssTransformAndCache(id: string): Promise<CssTransformResult> {
    const { code } = await preprocessModule(id, ctx);
    const exports = JSON.parse(await readText(cache, `${tRoot}/${id}.exports.json`));
    return { code, exports };
  }

  /** Transform + cache a module (JS/TS/JSX/TSX) via the shared `preprocessModule`
   *  core; returns the emitted ESM body. */
  async function transformAndCache(id: string): Promise<string> {
    return (await preprocessModule(id, ctx)).code;
  }

  /** Serve a file's raw bytes (non-module resources, or `?raw`). */
  async function serveRaw(id: string, asOctet: boolean): Promise<Response> {
    const bytes = await rawBytes(id, ctx);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: { "content-type": asOctet ? "application/octet-stream" : contentType(id) },
    });
  }

  async function resolveEntryId(ref: ModuleRef): Promise<string> {
    if ("url" in ref) {
      if (/^https?:/.test(ref.url)) throw new ModuleResolveError(ref, "absolute URL is not local");
      const p = idFromPath(ref.url);
      return p.startsWith("~/") ? p : `~/${p.replace(/^\//, "")}`;
    }
    return (await ensurePackage(ref, ctx)).id;
  }

  return {
    get lock() {
      return lock;
    },

    async resolve(ref: ModuleRef): Promise<ResolvedModule> {
      await init();
      const id = await resolveEntryId(ref);
      return { url: urlFor(id), target };
    },

    async prime(entry: ModuleRef): Promise<ResolvedModule> {
      await init();
      const rootId = await resolveEntryId(entry);
      await walkFrom(rootId, ctx);
      return { url: urlFor(rootId), target };
    },

    async listResources(entry: ModuleRef): Promise<string[]> {
      await init();
      const rootId = await resolveEntryId(entry);
      const ids = await walkFrom(rootId, ctx);
      return ids.map(urlFor).sort();
    },

    async listPackageFiles(ref: ModuleRef): Promise<string[]> {
      await init();
      if ("url" in ref) throw new ModuleResolveError(ref, "not a package reference");
      const { name, version } = await ensurePackage({ pkg: ref.pkg, version: ref.version }, ctx);
      const key = `${name}@${version}`;
      const files: string[] = [];
      for await (const info of cache.list(`/raw/${key}`, { recursive: true })) {
        if (info.kind === "file") files.push(info.path.replace(`/raw/${key}/`, ""));
      }
      return files.sort();
    },

    async fetch(request: Request): Promise<Response> {
      await init();
      const url = new URL(request.url);
      const id = idFromPath(url.pathname);
      try {
        // `?raw` → octet-stream; `?module` on a `.json` → ESM wrapper; non-module
        // files (json/md/css/…) → raw + guessed type.
        if (url.searchParams.has("raw")) return await serveRaw(id, true);
        if (url.searchParams.has("module") && id.endsWith(".json")) {
          const code = await serveJsonModule(id, ctx);
          if (code === undefined) return new Response(null, { status: 404 });
          return new Response(code, {
            status: 200,
            headers: { "content-type": "text/javascript" },
          });
        }
        if (isCssFile(id)) {
          const cssModules = /\.module\.css$/.test(id);
          if (!url.searchParams.has("module")) {
            const cachedCss = await cache.exists(`${tRoot}/${id}`);
            const code = cachedCss
              ? await readText(cache, `${tRoot}/${id}`)
              : (await cssTransformAndCache(id)).code;
            return new Response(code, { status: 200, headers: { "content-type": "text/css" } });
          }
          const cachedExports = await cache.exists(`${tRoot}/${id}.exports.json`);
          const result = cachedExports
            ? {
                code: await readText(cache, `${tRoot}/${id}`),
                exports: JSON.parse(await readText(cache, `${tRoot}/${id}.exports.json`)),
              }
            : await cssTransformAndCache(id);
          return new Response(cssModuleWrapper(result.code, result.exports, cssModules), {
            status: 200,
            headers: { "content-type": "text/javascript" },
          });
        }
        if (!isModuleFile(id)) return await serveRaw(id, false);
        // module files → transform to ESM. `~deps` proxies are pre-generated into
        // `/t/{target}`; a missing one has no `/raw/` to transform → 404 (never
        // routed through transformAndCache).
        const cached = await cache.exists(`${tRoot}/${id}`);
        if (!cached && id.includes("/~deps/")) return new Response(null, { status: 404 });
        const body = cached ? await readText(cache, `${tRoot}/${id}`) : await transformAndCache(id);
        return new Response(body, { status: 200, headers: { "content-type": "text/javascript" } });
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}

function normalizeBase(base: string): string {
  let b = base.startsWith("/") ? base : `/${base}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

// The deps prefix is relative to `basePath` — no leading slash, trailing slash
// when non-empty; "" means "no prefix" (packages served alongside project files).
function normalizeDeps(prefix: string): string {
  if (!prefix) return "";
  const s = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return s ? `${s}/` : "";
}
