import { readText, writeText } from "@statewalker/webrun-files";
import { globalHostRegistry, HOST_REGISTRY_KEY } from "../deps/host-registry.js";
import { proxyId } from "../deps/proxy.js";
import {
  defaultGlobals,
  makeKeepExtPolicy,
  type PreprocessContext,
  type UrlPolicy,
  urlPath,
} from "../preprocess/context.js";
import {
  cssSpecifiers,
  ensureGlobalsProxy,
  ensurePackage,
  ensureRawByKey,
  loadRaw,
  makeDefaultEndpointResolver,
  rawBytes,
  resolveCssSpec,
  resolveSpec,
} from "../preprocess/resolve.js";
import { npmRegistrySource } from "../sources/npm-registry-source.js";
import { analyze } from "../transform/analyze.js";
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
import { relativeUrl } from "./specifiers.js";

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

  /** Transform + cache a `.css` file. Two Lightning CSS passes: pass 1 (via
   *  `cssSpecifiers`) captures every @import/url() specifier; the specifiers are
   *  then resolved asynchronously (the seam's `rewrite` itself must stay sync,
   *  so resolution can't happen inline); pass 2 substitutes the resolved urls. */
  async function cssTransformAndCache(id: string): Promise<CssTransformResult> {
    const { path, source } = await loadRaw(id, ctx);
    const cssModules = /\.module\.css$/.test(id);
    const rewrites = new Map<string, string>();
    for (const spec of await cssSpecifiers(path, source, ctx)) {
      rewrites.set(spec, (await resolveCssSpec(spec, id, ctx)).url);
    }
    const out = await cssTransformer.transform(
      { path, source, cssModules },
      (s) => rewrites.get(s) ?? s,
    );
    await writeText(cache, `${tRoot}/${id}`, out.code);
    await writeText(cache, `${tRoot}/${id}.exports.json`, JSON.stringify(out.exports));
    return out;
  }

  /** Transform a module (pre-resolving its specifiers) and cache the ESM output.
   *  Bare specifiers rewrite to `~deps` proxies; used allowlisted free globals get
   *  a prepended import from a co-located globals proxy (the server owns the
   *  prepend, not the Transform). */
  async function transformAndCache(id: string): Promise<string> {
    const { path, source, format } = await loadRaw(id, ctx);
    const { imports } = await analyze(source, format);
    const map = new Map<string, string>();
    for (const spec of Object.keys(imports)) {
      if (spec === "") continue;
      map.set(spec, (await resolveSpec(spec, id, imports[spec], ctx)).url);
    }
    // Globals: prepend an import from a co-located globals proxy for allowlisted
    // free vars (declared/imported names never appear in the `""` free-global set).
    const usedGlobals = (imports[""]?.names ?? []).filter((n) => Object.hasOwn(ctx.globals, n));
    let prelude = "";
    if (usedGlobals.length) {
      const gid = proxyId(id, "");
      await ensureGlobalsProxy(gid, usedGlobals, ctx);
      prelude = `import { ${usedGlobals.join(", ")} } from ${JSON.stringify(
        relativeUrl(urlPath(id, ctx), urlPath(gid, ctx)),
      )};\n`;
    }
    const { code } = await transformer.transform({ path, source, format }, (s) => map.get(s) ?? s);
    await writeText(cache, `${tRoot}/${id}`, prelude + code);
    return prelude + code;
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

  /** Serve a JSON file as an ESM module (`export default …`) — how a JS `import`
   *  of a `.json` is satisfied without relying on browser JSON-import attributes. */
  async function serveJsonModule(id: string): Promise<Response> {
    const bytes = await rawBytes(id, ctx);
    if (!bytes) return new Response(null, { status: 404 });
    const json = new TextDecoder().decode(bytes);
    return new Response(`export default ${json};`, {
      status: 200,
      headers: { "content-type": "text/javascript" },
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

  /** Walk + transform + cache the whole graph from an entry; persist the lockfile.
   *  Returns the entry id and every reachable module id. */
  async function walkGraph(entry: ModuleRef): Promise<{ rootId: string; ids: string[] }> {
    const rootId = await resolveEntryId(entry);
    const seen = new Set<string>();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      // `~deps` proxies are pre-generated into `/t/{target}` by their importer's
      // resolveSpec/transformAndCache — served from cache, never re-analyzed.
      if (id.includes("/~deps/") && (await cache.exists(`${tRoot}/${id}`))) continue;
      if (isCssFile(id)) {
        await cssTransformAndCache(id); // ensures the file + its exports are cached
        const { path, source } = await loadRaw(id, ctx);
        // Reuse cssSpecifiers — the SAME helper cssTransformAndCache uses — then
        // re-derive child ids via CSS's own direct resolver (never `resolveSpec`:
        // that one proxies bare externals through `~deps`, which CSS must not do).
        for (const spec of await cssSpecifiers(path, source, ctx)) {
          const { id: childId } = await resolveCssSpec(spec, id, ctx);
          if (childId && !seen.has(childId)) queue.push(childId);
        }
        continue;
      }
      if (!isModuleFile(id)) {
        // non-JS resource (json/css/…): ensure it's cached, don't scan/transform.
        const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\//);
        if (m) await ensureRawByKey(m[1], ctx);
        continue;
      }
      const { source, format } = await loadRaw(id, ctx);
      const { imports } = await analyze(source, format);
      for (const spec of Object.keys(imports)) {
        if (spec === "") {
          // Only allowlisted free globals get a proxy (matches transformAndCache);
          // real globals like `console`/`Math` are left as native references.
          if (imports[""].names.some((n) => Object.hasOwn(ctx.globals, n))) {
            queue.push(proxyId(id, ""));
          }
          continue;
        }
        const { id: childId, endpointId } = await resolveSpec(spec, id, imports[spec], ctx);
        if (childId && !seen.has(childId)) queue.push(childId); // the proxy
        if (endpointId && !seen.has(endpointId)) queue.push(endpointId); // the real endpoint
      }
      await transformAndCache(id);
    }
    await writeText(cache, "/lock.json", JSON.stringify(lock));
    return { rootId, ids: [...seen] };
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
      const { rootId } = await walkGraph(entry);
      return { url: urlFor(rootId), target };
    },

    async listResources(entry: ModuleRef): Promise<string[]> {
      await init();
      const { ids } = await walkGraph(entry);
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
          return await serveJsonModule(id);
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

/** JS module that injects the processed CSS as a <style> (guarded for non-DOM /
 *  Node) and default-exports the CSS Modules class map (when `cssModules`) or
 *  the CSS text otherwise. */
function cssModuleWrapper(
  css: string,
  exports: Record<string, string>,
  cssModules: boolean,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `if (typeof document !== "undefined") {`,
    `  const el = document.createElement("style");`,
    `  el.textContent = css;`,
    `  document.head.appendChild(el);`,
    `}`,
    `export default ${cssModules ? JSON.stringify(exports) : "css"};`,
  ].join("\n");
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
