import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";
import semver from "semver";
import { resolveNodeBuiltin } from "../resolution/node-builtins.js";
import { resolveEntry } from "../resolution/resolve-entry.js";
import { npmRegistrySource } from "../sources/npm-registry-source.js";
import { detectFormat, newDefaultTransform } from "../transform/index.js";
import { scanSpecifiers } from "../transform/scan.js";
import type {
  Lockfile,
  ModuleRef,
  ModuleServer,
  ModuleServerOptions,
  PackageManifest,
  ResolvedModule,
} from "../types.js";
import { ModuleResolveError } from "../types.js";
import { parseSpecifier, relativeUrl } from "./specifiers.js";

const RAW_EXT = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs"];

/** Create a module/dependency server over an injected `FilesApi` cache. */
export function newModuleServer(options: ModuleServerOptions): ModuleServer {
  const cache = options.cache;
  const project = options.project;
  const sources = options.sources ?? [npmRegistrySource()];
  const transformer = options.transform ?? newDefaultTransform();
  const target = options.target ?? "browser";
  const basePath = normalizeBase(options.basePath ?? "/");
  const lock: Lockfile = { ...(options.lock ?? {}) };
  const tRoot = `/t/${target}`;

  let ready: Promise<void> | undefined;
  const init = () => {
    ready ??= (async () => {
      if (await cache.exists("/lock.json")) {
        Object.assign(lock, JSON.parse(await readText(cache, "/lock.json")), options.lock ?? {});
      }
    })();
    return ready;
  };

  const urlFor = (id: string) => basePath + id;
  const idFromPath = (pathname: string): string => {
    const p = pathname.startsWith(basePath)
      ? pathname.slice(basePath.length)
      : pathname.replace(/^\//, "");
    return p;
  };

  function matchSource(ref: ModuleRef) {
    const s = sources.find((x) => x.matches(ref));
    if (!s) throw new ModuleResolveError(ref, "no source matches");
    return s;
  }

  function reusable(locked: string, spec: string | undefined): boolean {
    if (!spec) return true;
    if (semver.valid(spec)) return locked === spec;
    if (semver.validRange(spec)) return semver.satisfies(locked, spec);
    return true; // dist-tag → reuse the locked version
  }

  async function cachedManifest(pkgKey: string): Promise<PackageManifest> {
    return JSON.parse(await readText(cache, `/raw/${pkgKey}/package.json`));
  }

  /** Persist a loaded package's files under `/raw/{name}@{version}/…` (idempotent).
   *  The manifest is written as `package.json` (the authority — a Source's files
   *  are not required to include one). */
  async function cacheRaw(
    name: string,
    version: string,
    files: FilesApi,
    manifest: PackageManifest,
  ): Promise<void> {
    const key = `${name}@${version}`;
    if (await cache.exists(`/raw/${key}/package.json`)) return;
    for await (const info of files.list("/", { recursive: true })) {
      if (info.kind === "file") {
        await cache.write(`/raw/${key}${info.path}`, [await collect(files.read(info.path))]);
      }
    }
    if (!(await cache.exists(`/raw/${key}/package.json`))) {
      await writeText(cache, `/raw/${key}/package.json`, JSON.stringify(manifest));
    }
  }

  /** Lazily load a package's raw files by its `name@version` cache key (idempotent). */
  async function ensureRawByKey(pkgKey: string): Promise<void> {
    if (await cache.exists(`/raw/${pkgKey}/package.json`)) return;
    const at = pkgKey.lastIndexOf("@");
    const ref = { pkg: pkgKey.slice(0, at), version: pkgKey.slice(at + 1) };
    const loaded = await matchSource(ref).load(ref);
    await cacheRaw(loaded.name, loaded.version, loaded.files, loaded.manifest);
  }

  /** Ensure a package's raw files + manifest are cached; return its pinned id. */
  async function ensurePackage(ref: { pkg: string; version?: string; subpath?: string }) {
    const name = ref.pkg;
    const locked = lock[name];
    let version: string;
    let manifest: PackageManifest;
    if (
      locked &&
      reusable(locked, ref.version) &&
      (await cache.exists(`/raw/${name}@${locked}/package.json`))
    ) {
      version = locked;
      manifest = await cachedManifest(`${name}@${version}`);
    } else {
      const loaded = await matchSource(ref).load({ pkg: name, version: ref.version });
      version = loaded.version;
      await cacheRaw(name, version, loaded.files, loaded.manifest);
      manifest = loaded.manifest;
      if (!locked) lock[name] = version;
    }
    const entry = resolveEntry(manifest, ref.subpath, target);
    const file = await resolveRawFile(`${name}@${version}`, entry); // resolve real extension/index
    return { name, version, file, id: `${name}@${version}/${file}`, manifest };
  }

  /** Resolve an import specifier (from `fromId`) to what to emit + its cache id. */
  async function resolveSpec(spec: string, fromId: string): Promise<{ url: string; id?: string }> {
    if (/^(https?:|data:)/.test(spec)) return { url: spec }; // absolute — pass through
    const builtin = resolveNodeBuiltin(spec, target); // node: builtins → polyfill/external
    if (builtin) {
      if ("external" in builtin) return { url: builtin.external };
      const t = await ensurePackage(builtin.ref);
      return { url: relativeUrl(fromId, t.id), id: t.id };
    }
    if (spec.startsWith(".")) {
      const id = await resolveRelativeId(fromId, spec);
      return { url: spec, id };
    }
    const t = await ensurePackage(parseSpecifier(spec));
    return { url: relativeUrl(fromId, t.id), id: t.id };
  }

  /** Resolve a relative specifier against an importer id to a concrete cache id. */
  async function resolveRelativeId(fromId: string, spec: string): Promise<string> {
    const dir = fromId.split("/").slice(0, -1);
    for (const part of spec.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") dir.pop();
      else dir.push(part);
    }
    const base = dir.join("/");
    const pkgKey = base.match(/^(?:@[^/]+\/)?[^/]+@[^/]+/)?.[0];
    if (pkgKey) {
      const rel = base.slice(pkgKey.length + 1);
      const file = await resolveRawFile(pkgKey, rel);
      return `${pkgKey}/${file}`;
    }
    return base; // project-relative
  }

  /** Try extension/index variants for a package-relative file; return what exists. */
  async function resolveRawFile(pkgKey: string, file: string): Promise<string> {
    for (const ext of RAW_EXT) {
      if (await cache.exists(`/raw/${pkgKey}/${file}${ext}`)) return file + ext;
    }
    return file;
  }

  /** Load a canonical id's raw source + format context. */
  async function loadRaw(
    id: string,
  ): Promise<{ path: string; source: string; format: ReturnType<typeof detectFormat> }> {
    if (id.startsWith("~/")) {
      if (!project) throw new ModuleResolveError({ url: id }, "no project FilesApi");
      const path = `/${id.slice(2)}`;
      const source = await readText(project, path);
      return { path, source, format: detectFormat(path, source) };
    }
    const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\/(.+)$/);
    if (!m) throw new ModuleResolveError({ url: id }, "not a module id");
    const [, pkgKey, rawFile] = m;
    await ensureRawByKey(pkgKey);
    const file = await resolveRawFile(pkgKey, rawFile);
    const source = await readText(cache, `/raw/${pkgKey}/${file}`);
    const manifest = await cachedManifest(pkgKey).catch(() => undefined);
    return { path: `/${pkgKey}/${file}`, source, format: detectFormat(file, source, manifest) };
  }

  /** Transform a module (pre-resolving its specifiers) and cache the ESM output. */
  async function transformAndCache(id: string): Promise<string> {
    const { path, source, format } = await loadRaw(id);
    const specs = await scanSpecifiers(source, format);
    const map = new Map<string, string>();
    for (const spec of specs) map.set(spec, (await resolveSpec(spec, id)).url);
    const out = await transformer.transform({ path, source, format }, (s) => map.get(s) ?? s);
    await writeText(cache, `${tRoot}/${id}`, out);
    return out;
  }

  async function resolveEntryId(ref: ModuleRef): Promise<string> {
    if ("url" in ref) {
      if (/^https?:/.test(ref.url)) throw new ModuleResolveError(ref, "absolute URL is not local");
      const p = idFromPath(ref.url);
      return p.startsWith("~/") ? p : `~/${p.replace(/^\//, "")}`;
    }
    return (await ensurePackage(ref)).id;
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
      const seen = new Set<string>();
      const queue = [rootId];
      while (queue.length) {
        const id = queue.shift();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        const { source, format } = await loadRaw(id);
        for (const spec of await scanSpecifiers(source, format)) {
          const { id: childId } = await resolveSpec(spec, id);
          if (childId && !seen.has(childId)) queue.push(childId);
        }
        await transformAndCache(id);
      }
      await writeText(cache, "/lock.json", JSON.stringify(lock));
      return { url: urlFor(rootId), target };
    },

    async fetch(request: Request): Promise<Response> {
      await init();
      const url = new URL(request.url);
      const raw = url.searchParams.has("raw");
      const id = idFromPath(url.pathname);
      try {
        if (raw) {
          const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\/(.+)$/);
          if (!m) return new Response(null, { status: 404 });
          await ensureRawByKey(m[1]);
          const file = await resolveRawFile(m[1], m[2]);
          if (!(await cache.exists(`/raw/${m[1]}/${file}`)))
            return new Response(null, { status: 404 });
          const bytes = await collect(cache.read(`/raw/${m[1]}/${file}`));
          return new Response(bytes as BodyInit, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
        const body = (await cache.exists(`${tRoot}/${id}`))
          ? await readText(cache, `${tRoot}/${id}`)
          : await transformAndCache(id);
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

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of chunks) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
