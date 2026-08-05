import type { FilesApi } from "@statewalker/webrun-files";
import { readText, writeText } from "@statewalker/webrun-files";
import semver from "semver";
import { newDefaultEndpointResolver } from "../deps/endpoint-resolver.js";
import { HOST_REGISTRY_KEY } from "../deps/host-registry.js";
import { proxyBody, proxyId } from "../deps/proxy.js";
import { resolveNodeBuiltin } from "../resolution/node-builtins.js";
import { resolveEntry } from "../resolution/resolve-entry.js";
import { parseSpecifier, relativeUrl } from "../server/specifiers.js";
import { detectFormat } from "../transform/index.js";
import type { EndpointBinding, EndpointResolver, ModuleImport, PackageManifest } from "../types.js";
import { ModuleResolveError } from "../types.js";
import { isCssFile, type PreprocessContext, urlPath } from "./context.js";

const RAW_EXT = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs"];

/** Coalesce truly-concurrent identical async work; a settled entry is dropped so
 *  a sequential driver never reuses a stale result (a no-op for the server). */
function singleFlight<T>(ctx: PreprocessContext, key: string, fn: () => Promise<T>): Promise<T> {
  const existing = ctx.inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => ctx.inflight.delete(key));
  ctx.inflight.set(key, p);
  return p;
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

/** A name is host-provided when the registry holds the exact name OR its package
 *  root (so both `react` and `react/jsx-runtime` bind to the `react` instance). */
export function providedNames(name: string, ctx: PreprocessContext): boolean {
  return name !== "" && (ctx.registry.has(name) || ctx.registry.has(parseSpecifier(name).pkg));
}

/** The default linker: `host` for provided names, same-origin `local` (via package
 *  resolution) otherwise. Built inside the core because it closes over
 *  `importerVersion` + `ensurePackage`. */
export function makeDefaultEndpointResolver(ctx: PreprocessContext): EndpointResolver {
  return newDefaultEndpointResolver({
    providedNames: (n) => (n === "" ? false : providedNames(n, ctx)),
    localUrl: async (spec, ectx) => {
      const { pkg, subpath } = parseSpecifier(spec);
      const version = await importerVersion(pkg, ectx.importerId, ctx);
      const t = await ensurePackage({ pkg, version, subpath }, ctx);
      return t.id; // canonical id; the served endpoint url is `urlPath(t.id)`
    },
  });
}

function matchSource(ref: { pkg: string; version?: string }, ctx: PreprocessContext) {
  const s = ctx.sources.find((x) => x.matches(ref));
  if (!s) throw new ModuleResolveError(ref, "no source matches");
  return s;
}

function reusable(locked: string, spec: string | undefined): boolean {
  if (!spec) return true;
  if (semver.valid(spec)) return locked === spec;
  if (semver.validRange(spec)) return semver.satisfies(locked, spec);
  return true; // dist-tag → reuse the locked version
}

async function cachedManifest(pkgKey: string, ctx: PreprocessContext): Promise<PackageManifest> {
  return JSON.parse(await readText(ctx.cache, `/raw/${pkgKey}/package.json`));
}

/** Persist a loaded package's files under `/raw/{name}@{version}/…` (idempotent). */
async function cacheRaw(
  name: string,
  version: string,
  files: FilesApi,
  manifest: PackageManifest,
  ctx: PreprocessContext,
): Promise<void> {
  const key = `${name}@${version}`;
  return singleFlight(ctx, `cacheRaw:${key}`, async () => {
    if (await ctx.cache.exists(`/raw/${key}/package.json`)) return;
    for await (const info of files.list("/", { recursive: true })) {
      if (info.kind === "file") {
        await ctx.cache.write(`/raw/${key}${info.path}`, [await collect(files.read(info.path))]);
      }
    }
    if (!(await ctx.cache.exists(`/raw/${key}/package.json`))) {
      await writeText(ctx.cache, `/raw/${key}/package.json`, JSON.stringify(manifest));
    }
  });
}

/** Lazily load a package's raw files by its `name@version` cache key (idempotent). */
export async function ensureRawByKey(pkgKey: string, ctx: PreprocessContext): Promise<void> {
  return singleFlight(ctx, `raw:${pkgKey}`, async () => {
    if (await ctx.cache.exists(`/raw/${pkgKey}/package.json`)) return;
    const at = pkgKey.lastIndexOf("@");
    const ref = { pkg: pkgKey.slice(0, at), version: pkgKey.slice(at + 1) };
    const loaded = await matchSource(ref, ctx).load(ref);
    await cacheRaw(loaded.name, loaded.version, loaded.files, loaded.manifest, ctx);
  });
}

/** Ensure a package's raw files + manifest are cached; return its pinned id. */
export async function ensurePackage(
  ref: { pkg: string; version?: string; subpath?: string },
  ctx: PreprocessContext,
): Promise<{ name: string; version: string; file: string; id: string; manifest: PackageManifest }> {
  const name = ref.pkg;
  return singleFlight(ctx, `pkg:${name}@${ref.version ?? ""}#${ref.subpath ?? ""}`, async () => {
    const locked = ctx.lock[name];
    let version: string;
    let manifest: PackageManifest;
    if (locked && reusable(locked, ref.version)) {
      // Honor the lock even on a cold cache — load the *locked* version, not latest.
      version = locked;
      await ensureRawByKey(`${name}@${version}`, ctx);
      manifest = await cachedManifest(`${name}@${version}`, ctx);
    } else {
      const loaded = await matchSource(ref, ctx).load({ pkg: name, version: ref.version });
      version = loaded.version;
      await cacheRaw(name, version, loaded.files, loaded.manifest, ctx);
      manifest = loaded.manifest;
      if (!locked) ctx.lock[name] = version;
    }
    const entry = resolveEntry(manifest, ref.subpath, ctx.target);
    const file = await resolveRawFile(`${name}@${version}`, entry, ctx); // real ext/index
    return { name, version, file, id: `${name}@${version}/${file}`, manifest };
  });
}

/** Resolve an import specifier (from `fromId`) to what to emit + its cache id. A
 *  bare external specifier is rewritten to a co-located `~deps` proxy; the proxy's
 *  real endpoint (for a `local` binding) is returned as `endpointId` so the graph
 *  walker caches it. */
export async function resolveSpec(
  spec: string,
  fromId: string,
  imp: ModuleImport,
  ctx: PreprocessContext,
): Promise<{ url: string; id?: string; endpointId?: string }> {
  if (/^(https?:|data:)/.test(spec)) return { url: spec }; // absolute — pass through
  const builtin = resolveNodeBuiltin(spec, ctx.target); // node: builtins → polyfill/external
  if (builtin) {
    if ("external" in builtin) return { url: builtin.external };
    const t = await ensurePackage(builtin.ref, ctx);
    return { url: ctx.policy.servedUrl(t.id, fromId), id: t.id };
  }
  if (spec.startsWith(".")) {
    const id = await resolveRelativeId(fromId, spec, ctx);
    // The policy emits the extension-resolved relative URL (`./x` → `./x.js`) and
    // marks json/css with `?module`; the browser fetches this URL verbatim.
    return { url: ctx.policy.servedUrl(id, fromId), id };
  }
  // Host-provided/builtin wins before the CSS reroute below.
  const provided = providedNames(spec, ctx);
  // Bare CSS-looking specifier — CSS never goes through `~deps`; resolve it directly
  // like the relative branch, then classify by the RESOLVED file, not the raw spec.
  if (!provided && isCssFile(spec)) {
    const { id } = await resolveCssSpec(spec, fromId, ctx);
    if (id && isCssFile(id)) return { url: ctx.policy.servedUrl(id, fromId), id };
  }
  // Bare external specifier → generate a co-located proxy; import the proxy.
  const pid = proxyId(fromId, spec);
  let binding: EndpointBinding;
  let endpointId: string | undefined;
  if (provided) {
    // Bind to the registered key — the exact spec if registered, else its package
    // root (so `react/jsx-runtime` reads the `react` instance).
    const providedKey = ctx.registry.has(spec) ? spec : parseSpecifier(spec).pkg;
    binding = { kind: "host", name: providedKey };
  } else {
    binding = await ctx.resolveEndpoint.resolve(spec, { importerId: fromId, target: ctx.target });
    if (binding.kind === "local") endpointId = binding.url; // canonical id → walked
  }
  await ensureProxy(pid, binding, imp, ctx);
  return { url: ctx.policy.servedUrl(pid, fromId), id: pid, endpointId };
}

/** Generate + cache a proxy module (idempotent). A `local` endpoint's URL is
 *  shaped through the URL policy (`servedUrl(endpointId, pid)`) so it carries the
 *  driver's extension decision (keep-ext keeps the source ext; ext-map rewrites to
 *  `.js`) and is already relativized — `proxyBody` splices it in verbatim. */
export async function ensureProxy(
  pid: string,
  binding: EndpointBinding,
  imp: ModuleImport,
  ctx: PreprocessContext,
): Promise<void> {
  return singleFlight(ctx, `proxy:${pid}`, async () => {
    const key = ctx.policy.emittedPath(pid);
    if (await ctx.cache.exists(key)) return;
    const wire: EndpointBinding =
      binding.kind === "local"
        ? { kind: "local", url: ctx.policy.servedUrl(binding.url, pid) }
        : binding;
    const body = proxyBody({ binding: wire, imp, registryKey: HOST_REGISTRY_KEY });
    await writeText(ctx.cache, key, body);
  });
}

/** Generate + cache the co-located globals proxy exporting the used allowlisted
 *  free globals (idempotent). */
export async function ensureGlobalsProxy(
  gid: string,
  names: string[],
  ctx: PreprocessContext,
): Promise<void> {
  return singleFlight(ctx, `globals:${gid}`, async () => {
    const key = ctx.policy.emittedPath(gid);
    if (await ctx.cache.exists(key)) return;
    // Alias form (`const __gI = <expr>; export { __gI as name }`) avoids a TDZ
    // ReferenceError for a global whose expression is the bare `globalThis` token.
    const body = names
      .map((n, i) => `const __g${i} = ${ctx.globals[n]};\nexport { __g${i} as ${n} };`)
      .join("\n");
    await writeText(ctx.cache, key, body);
  });
}

/** The version constraint a bare specifier should resolve to, from the importer's
 *  package: self-reference → own version; a dependency → the importer's range. */
export async function importerVersion(
  pkg: string,
  fromId: string,
  ctx: PreprocessContext,
): Promise<string | undefined> {
  const m = fromId.match(/^((?:@[^/]+\/)?[^/]+)@([^/]+)\//);
  if (!m) return undefined; // project file — no package context
  const [, impName, impVersion] = m;
  if (pkg === impName) return impVersion; // self-reference → same version
  const manifest = await cachedManifest(`${impName}@${impVersion}`, ctx).catch(() => undefined);
  return (
    manifest?.dependencies?.[pkg] ??
    manifest?.peerDependencies?.[pkg] ??
    (manifest?.optionalDependencies as Record<string, string> | undefined)?.[pkg]
  );
}

/** Direct CSS specifier resolution. A bare package specifier is resolved straight
 *  to its same-origin URL — never proxied through `~deps`. The returned url is
 *  PLAIN (no `?module`): CSS `@import` urls are substituted into the CSS text. */
export async function resolveCssSpec(
  spec: string,
  fromId: string,
  ctx: PreprocessContext,
): Promise<{ url: string; id?: string }> {
  if (/^(https?:|data:)/.test(spec)) return { url: spec }; // absolute — pass through
  if (spec.startsWith(".")) {
    const id = await resolveRelativeId(fromId, spec, ctx);
    return { url: relativeUrlCss(fromId, id, ctx), id };
  }
  // Bare package specifier (e.g. "some-pkg/reset.css") — resolve directly.
  const { pkg, subpath } = parseSpecifier(spec);
  const version = await importerVersion(pkg, fromId, ctx);
  const t = await ensurePackage({ pkg, version, subpath }, ctx);
  return { url: relativeUrlCss(fromId, t.id, ctx), id: t.id };
}

/** Plain urlPath-space relative URL (no ext decision / no `?module`) for CSS
 *  `@import`/`url()` substitution — identical under keep-ext and ext-map. */
function relativeUrlCss(fromId: string, id: string, ctx: PreprocessContext): string {
  return relativeUrl(urlPath(fromId, ctx), urlPath(id, ctx));
}

/** Run one CSS-transform pass that only CAPTURES the @import/url() specifiers a
 *  file references (via the seam's `rewrite`), without resolving them. */
export async function cssSpecifiers(
  path: string,
  source: string,
  ctx: PreprocessContext,
): Promise<string[]> {
  const cssModules = /\.module\.css$/.test(path);
  const specs = new Set<string>();
  await ctx.css.transform({ path, source, cssModules }, (s) => {
    specs.add(s);
    return s;
  });
  return [...specs];
}

/** Resolve a relative specifier against an importer id to a concrete cache id. */
export async function resolveRelativeId(
  fromId: string,
  spec: string,
  ctx: PreprocessContext,
): Promise<string> {
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
    const file = await resolveRawFile(pkgKey, rel, ctx);
    return `${pkgKey}/${file}`;
  }
  return await resolveProjectId(base, ctx); // project-relative
}

/** Source extensions probed for a project-relative id, in priority order. TS/TSX
 *  first so an ESM-convention `.js` import resolves to its `.ts`/`.tsx` source. */
const PROJECT_EXT = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json"];

/**
 * Map a project-relative id (`~/…`) to the id of the source file that actually
 * exists. A `.js`/`.jsx` specifier (the standard ESM convention) commonly names a
 * `.ts`/`.tsx` source; the raw id would then have no backing file. If the literal
 * id already exists it is returned unchanged (no behaviour change for real `.js`
 * sources or `.json`/`.css` ids); otherwise the JS-family extension is swapped for
 * each source extension, then `index.*` is tried. The literal is the last resort so
 * an unresolvable id stays identical to the pre-probe behaviour.
 */
export async function resolveProjectId(base: string, ctx: PreprocessContext): Promise<string> {
  const files = ctx.files;
  if (!files || !base.startsWith("~/")) return base;
  const has = (id: string) => files.exists(`/${id.slice(2)}`);
  if (await has(base)) return base;
  const stem = base.replace(/\.(?:m|c)?jsx?$/, ""); // ./app.js → ./app, then probe source exts
  for (const ext of PROJECT_EXT) if (await has(stem + ext)) return stem + ext;
  for (const ext of PROJECT_EXT) if (await has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return base;
}

/** Try extension/index variants for a package-relative file; return what exists. */
export async function resolveRawFile(
  pkgKey: string,
  file: string,
  ctx: PreprocessContext,
): Promise<string> {
  for (const ext of RAW_EXT) {
    if (await ctx.cache.exists(`/raw/${pkgKey}/${file}${ext}`)) return file + ext;
  }
  return file;
}

/** Load a canonical id's raw source + format context. */
export async function loadRaw(
  id: string,
  ctx: PreprocessContext,
): Promise<{ path: string; source: string; format: ReturnType<typeof detectFormat> }> {
  if (id.startsWith("~/")) {
    if (!ctx.files) throw new ModuleResolveError({ url: id }, "no project FilesApi");
    const path = `/${id.slice(2)}`;
    const source = await readText(ctx.files, path);
    return { path, source, format: detectFormat(path, source) };
  }
  const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\/(.+)$/);
  if (!m) throw new ModuleResolveError({ url: id }, "not a module id");
  const [, pkgKey, rawFile] = m;
  await ensureRawByKey(pkgKey, ctx);
  const file = await resolveRawFile(pkgKey, rawFile, ctx);
  const source = await readText(ctx.cache, `/raw/${pkgKey}/${file}`);
  const manifest = await cachedManifest(pkgKey, ctx).catch(() => undefined);
  return { path: `/${pkgKey}/${file}`, source, format: detectFormat(file, source, manifest) };
}

/** Resolve a file id (project `~/…` or `{pkg}@{ver}/{file}`) to its raw bytes. */
export async function rawBytes(
  id: string,
  ctx: PreprocessContext,
): Promise<Uint8Array | undefined> {
  if (id.startsWith("~/")) {
    const path = `/${id.slice(2)}`;
    if (!ctx.files || !(await ctx.files.exists(path))) return undefined;
    return collect(ctx.files.read(path));
  }
  const m = id.match(/^((?:@[^/]+\/)?[^/]+@[^/]+)\/(.+)$/);
  if (!m) return undefined;
  await ensureRawByKey(m[1], ctx);
  const file = await resolveRawFile(m[1], m[2], ctx);
  if (!(await ctx.cache.exists(`/raw/${m[1]}/${file}`))) return undefined;
  return collect(ctx.cache.read(`/raw/${m[1]}/${file}`));
}
