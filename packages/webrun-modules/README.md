# @statewalker/webrun-modules

Run authored TypeScript/JavaScript apps **and the arbitrary npm modules they
import** in the browser (or Node) with **no runtime CDN dependency** — and with
**no install step**: packages are downloaded, resolved, and transformed **on
request**.

Given a TS/JS entry, `webrun-modules` resolves, downloads, and transforms the
dependency graph — from npm (or a CDN) **at resolve time only** — and serves the
transformed, browser-runnable ESM from a local
[`FilesApi`](https://www.npmjs.com/package/@statewalker/webrun-files) cache. Every
internal import is rewritten to a same-origin local URL, so nothing is fetched
from a third party at run time. The result is always a URL any module-compatible
runtime can `import` directly — no bespoke client loader.

It is **isomorphic**: the same code runs in a browser ServiceWorker and in Node —
the only difference is which `FilesApi` backend you inject.

## Install

```sh
npm add @statewalker/webrun-modules
```

## Quick start

```ts
import { newModuleServer, npmRegistrySource } from "@statewalker/webrun-modules";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

const server = newModuleServer({
  cache: new NodeFilesApi({ rootDir: "./.modules-cache" }),
});

// Resolve an npm package (with optional subpath) to an importable URL:
const zod = await server.resolve({ pkg: "zod" });
// → { url: "/zod@3.23.8/lib/index.mjs", target: "browser" }

// Serve it — `server.fetch` is a standard Web handler, mountable anywhere:
Deno.serve(server.fetch);                                       // Deno
export default { fetch: server.fetch };                         // Bun / Cloudflare
self.addEventListener("fetch", (e) => e.respondWith(server.fetch(e.request))); // ServiceWorker
```

There is **no separate "install" call**. The first time a module URL is requested
— via `resolve`, `prime`, or a direct `fetch` — its package is downloaded and
transformed on demand, then cached. Requesting a URL for a package that isn't in
the cache yet just works:

```ts
// Nothing primed, nothing resolved — this single fetch downloads + transforms + serves:
const res = await server.fetch(new Request("http://host/ms@2.1.3/index.js"));
// → 200, content-type: text/javascript
```

## Eager priming (optional)

To download and transform a whole dependency graph up front (e.g. before going
offline, or to warm a cache), use `prime`. It walks the entry's transitive graph,
transforms every module, and writes the lockfile:

```ts
await server.prime({ pkg: "react-dom", version: "^18" });
// entry + every transitive dep are now cached and importable with the network off.
```

## Listing what an entry needs, or what a package contains

Two questions, two methods:

```ts
// (1) Every module URL required to RUN an entry — the reachable graph (primes it).
const urls = await server.listResources({ pkg: "react" });
// → [ "/react@19.2.8/index.js",
//     "/react@19.2.8/cjs/react.production.js",
//     "/react@19.2.8/cjs/react.development.js" ]   ← the exact set of scripts to serve

// (2) Every FILE in a package — the full tarball contents (loads it if needed).
const files = await server.listPackageFiles({ pkg: "react" });
// → [ "LICENSE", "index.js", "jsx-runtime.js", "cjs/react.development.js", … ]  (27 files)
```

`listResources` is the minimal set (what the entry actually imports);
`listPackageFiles` is everything the package ships (including alternative entry
points like `react/jsx-runtime` the main entry never imports). To capture an app's
full needs, call `listResources` for each entry point you import and take the union.

To **download** everything for later offline/static serving, point the cache at a
real directory and prime — the transformed files land under `{rootDir}/t/{target}/`:

```ts
const server = newModuleServer({ cache: new NodeFilesApi({ rootDir: "./react-bundle" }) });
await server.prime({ pkg: "react" });
await server.prime({ pkg: "react", subpath: "jsx-runtime" }); // if you use JSX
// ./react-bundle/t/browser/react@19.2.8/… now holds the importable scripts.
```

## Serving your own source too

Point the server at a project `FilesApi` and it resolves local scripts the same
way — bare imports rewritten to `/{name}@{version}/…`, relative imports kept
relative, TS/JSX transpiled:

```ts
const server = newModuleServer({ cache, project: myProjectFiles });
const app = await server.resolve({ url: "/src/app.ts" }); // → importable URL
```

## Examples

Three runnable examples (each has a package script; all hit the live npm
registry, so they need network on first run):

```sh
pnpm --filter @statewalker/webrun-modules example              # full-cycle (alias)
pnpm --filter @statewalker/webrun-modules example:full-cycle   # examples/full-cycle.ts
pnpm --filter @statewalker/webrun-modules example:server       # examples/http-server.ts (unpkg-like)
pnpm --filter @statewalker/webrun-modules example:site         # examples/site-pipeline.ts
```

(From inside the package directory you can drop the `--filter …` prefix:
`pnpm example:server`.)

[`examples/full-cycle.ts`](./examples/full-cycle.ts) demonstrates the entire
cycle against the live npm registry — lazy download-on-request, `resolve`,
`prime`, executing a served module, `?raw`, and the lockfile.

### An unpkg-like HTTP service

Because `server.fetch` is a standard Web handler, exposing an unpkg-style endpoint
is a thin wrapper — mount it on any host and add the one convenience of
redirecting a bare/ranged spec to its pinned, versioned URL.
[`examples/http-server.ts`](./examples/http-server.ts) is a complete, dependency-
free Node server that does exactly this:

```sh
pnpm --filter @statewalker/webrun-modules example:server
# then:
curl -L localhost:8787/lodash-es@4/merge   # 302 → /lodash-es@4.18.1/merge.js → importable ESM
curl -L localhost:8787/debug               # 302 → /debug@4.4.3/src/browser.js
curl 'localhost:8787/react?meta'           # JSON: react's full file list
curl 'localhost:8787/react?graph'          # JSON: every module URL needed to run react
curl 'localhost:8787/react@19.2.8/package.json'   # non-JS files served raw (application/json)
```

For a given package it returns an importable JS module with every dependency
already resolved to a same-origin URL — e.g. requesting `lodash-es@4/merge` serves
`merge.js` whose `import "./_baseMerge.js"` / `import "./_createAssigner.js"` all
point back at the same server. Use it straight from a browser:

```html
<script type="module">
  import merge from "http://localhost:8787/lodash-es@4/merge";
  console.log(merge({ a: 1 }, { b: 2 }));
</script>
```

### In-browser site pipeline (replacing a jspm-based resolver)

Because the server transpiles first-party TS/TSX **and** resolves the npm deps,
one `newModuleServer` replaces an entire `@jspm/generator`-based pipeline
(resolver + CDN providers + `es-module-lexer` rewrite + recursive prefetch +
`/external` mount). Put your source in a `project` `FilesApi`, mount `server.fetch`
under a site, and run server modules through the existing server-runner:

```ts
const server = newModuleServer({ cache, project: myAppFiles, target: "browser" });

new SiteBuilder()
  .setEndpoint("/", server.fetch)                                  // html + transpiled TSX + deps
  .setEndpoint("/api", newServerRunner(serverEntryUrl, () => baseUrl)) // run server modules
  .build();
```

[`examples/site-pipeline.ts`](./examples/site-pipeline.ts) runs the whole thing
(JSX/TSX transpiled, `import "react"` rewritten to a same-origin URL, `react` +
`react/jsx-runtime` resolved, `listResources` = the exact scripts to serve).
**Note:** the server resolves a bare `import "react"` to *latest* unless a version
is pinned — seed `lock` (e.g. `{ react: "18.3.1" }`) to honor a project's
`package.json` versions reproducibly.

## Options

| Option      | Default                  | Purpose |
|-------------|--------------------------|---------|
| `cache`     | — (required)             | Injected `FilesApi` for the module cache. |
| `project`   | —                        | `FilesApi` of local project files to serve. |
| `sources`   | `[npmRegistrySource()]`  | Acquisition sources (npm tarball by default). |
| `transform` | `newDefaultTransform()`  | Per-file transform (ESM + CJS-interop). |
| `css`       | `newDefaultCssTransform()` | Per-file CSS transform (Lightning CSS). |
| `target`    | `"browser"`              | Selects `exports` conditions + cache key; `"node"` supported. |
| `lock`      | —                        | A `Lockfile` (pins versions); `prime` also writes one back. |
| `basePath`  | `"/"`                    | Mount prefix, e.g. `"/deps/v1/"`. |

### `ModuleServer`

```ts
interface ModuleServer {
  resolve(ref: ModuleRef, importer?: string): Promise<ResolvedModule>; // single ref → URL
  prime(entry: ModuleRef): Promise<ResolvedModule>;                    // warm the whole graph
  listResources(entry: ModuleRef): Promise<string[]>;                  // every URL the entry needs
  listPackageFiles(ref: ModuleRef): Promise<string[]>;                 // a package's full file list
  fetch(request: Request): Promise<Response>;                          // standard Web handler
  readonly lock: Lockfile;                                             // resolution map
}

type ModuleRef =
  | { pkg: string; version?: string; subpath?: string } // e.g. { pkg: "lodash-es", subpath: "merge" }
  | { url: string };                                     // a local project script
```

## Targets: browser vs node

`target` selects which `package.json` `exports` conditions win and how Node
builtins are handled, and is part of the cache key (a browser build and a node
build of the same package never collide):

```ts
// Browser (default): node:* builtins → self-hosted @jspm/core polyfill URLs.
newModuleServer({ cache, target: "browser" });

// Node: node:* builtins stay external (real Node builtins).
newModuleServer({ cache, target: "node" });
```

## Reproducible resolution (the lockfile)

The resolution map is a `Lockfile` (`{ [name]: version }`). `prime` writes it to
the cache and returns it via `server.lock`. Supply it back as `lock` to pin
versions reproducibly — a partial lockfile pins only the names it lists:

```ts
const first = newModuleServer({ cache });
await first.prime({ pkg: "app" });
const lock = first.lock; // e.g. { app: "1.0.0", react: "18.3.1", … }

// Elsewhere / later: identical resolution, no re-solve.
const pinned = newModuleServer({ cache, lock });
```

## Custom `Source` (npm / JSR / URL / your own registry)

A `Source` turns a reference into a package's files + manifest. The default is
`npmRegistrySource()`; provide your own (or several — the first whose `matches`
returns true wins):

```ts
import type { Source } from "@statewalker/webrun-modules";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const myRegistry: Source = {
  matches: (ref) => "pkg" in ref,
  async load(ref) {
    // fetch + unpack however you like; return the package tree + manifest
    const files = new MemFilesApi();
    // … write files …
    return { name: ref.pkg, version: "1.0.0", files, manifest: { name: ref.pkg, version: "1.0.0" } };
  },
};

newModuleServer({ cache, sources: [myRegistry, npmRegistrySource()] });
```

`npmRegistrySource(options?)` accepts `{ registryUrl, fetch, createFiles }` — pass
a custom `fetch` (e.g. to add auth or point at a private registry) or a private
registry URL.

## Custom `Transform`

The default transform (`newDefaultTransform()`) dispatches per file: ESM/TS/JSX go
through `newEsmTransform()`, CommonJS through `newCjsTransform()`. Swap in your own
`Transform` — it receives one file and a `rewrite(specifier) => url` callback and
returns browser-runnable ESM:

```ts
import { newDefaultTransform, detectFormat } from "@statewalker/webrun-modules";
import type { Transform } from "@statewalker/webrun-modules";

const myTransform: Transform = {
  async transform(file, rewrite) {
    // file = { path, source, format: "esm" | "cjs" | "ts" | "tsx" }
    // call rewrite(spec) for each import specifier to get its local URL
    return /* transformed ESM */ file.source;
  },
};

newModuleServer({ cache, transform: myTransform });
```

`detectFormat(path, source, manifest?)` returns the `SourceFormat` the default
transform would infer.

## CSS

`.css` files are processed, not just passed through — by default with
[Lightning CSS](https://lightningcss.dev/) (nesting flattened, vendor-prefixed
against a fixed, conservative modern-browser baseline). `newLightningCssTransform()`
takes no arguments — it is not configurable. To customize processing (different
targets, a different engine, Sass, PostCSS, …), implement your own `CssTransform`
and pass it as the `css` option; the pluggable seam is the override point:

```ts
import { newDefaultCssTransform } from "@statewalker/webrun-modules";
import type { CssTransform } from "@statewalker/webrun-modules";

const myCss: CssTransform = {
  async transform(file, rewrite) {
    // file = { path, source, cssModules }; call rewrite(spec) per @import/url()
    return /* processed CSS */ { code: file.source, exports: {} };
  },
};

newModuleServer({ cache, css: myCss }); // default is newDefaultCssTransform() (Lightning CSS)
```

Two ways to consume a stylesheet:

- **`import "./x.css"` or `import "some-pkg/x.css"` from JS/TS** — both
  relative and bare specifiers resolve to `x.css?module`, a JS module that
  injects a `<style>` element on import and default-exports the CSS text (or,
  for `*.module.css`, the **CSS Modules class map** — `{ localName:
  scopedName }`, empty object when the file has no class selectors to scope).
  A bare specifier resolves directly to its pinned package URL — like CSS's
  own `@import`/`url()` resolution, it never goes through the `~deps` proxy
  layer. The `<style>` injection is guarded by `typeof document !== "undefined"`,
  so the same module evaluates cleanly under `target: "node"` (no DOM, no
  throw) — it just skips the injection and still returns the default export.
- **a bare `.css` URL** (no `?module`) — serves the processed stylesheet as
  `text/css`, for a `<link rel="stylesheet">`.

`@import` and `url(...)` targets are rewritten to same-origin URLs exactly like
JS imports (direct to a pinned package URL for bare specifiers — CSS never
goes through the `~deps` proxy layer, since it has no imperative bindings to
proxy) and are joined by `listResources`/`prime`.

**Out of scope:** Tailwind JIT (precompile Tailwind to plain CSS before
serving), CSS-in-JS, Sass/PostCSS (bring your own via the `CssTransform` seam
above), and CSS source maps (tracked for a later `map` field on
`CssTransformResult`).

## Serving surface

`server.fetch(request)` is a plain `(Request) => Promise<Response>`:

- JS/TS module files are transformed and served as `text/javascript`;
- `.css` files are processed (see [CSS](#css) below) — a bare `.css` URL serves
  processed `text/css`; `?module` serves a JS wrapper;
- other non-module files (`package.json`, `README.md`, …) are served **raw**,
  untransformed, with a content-type guessed from the extension
  (`application/json`, `text/markdown`, …);
- append `?raw` to get the raw bytes of *any* file as `application/octet-stream`;
- an unresolvable path returns a `404` `Response` (never throws).

Mount it under any `basePath` (returned URLs carry the prefix; the cached bytes
stay portable, because internal imports are rewritten as **relative** URLs):

```ts
const server = newModuleServer({ cache, basePath: "/deps/v1/" });
const r = await server.resolve({ pkg: "zod" }); // → { url: "/deps/v1/zod@3.23.8/lib/index.mjs" }
```

## Errors

- `ModuleResolveError { ref, reason }` — a package / version / subpath can't be
  resolved (surfaced as a `404` from `fetch`).
- `ModuleTransformError { path, reason }` — a file can't be transformed to runnable
  ESM.

## Utilities

Also exported: `untarTgz(bytes)` (isomorphic npm-tarball unpacker),
`parseSpecifier(spec)` (bare specifier → `{ pkg, subpath? }`, scope-aware), and
`relativeUrl(fromId, toId)`.

## How it works

- **Acquire** — the default `Source` fetches the npm registry tarball, untars it
  in memory (pure-JS, isomorphic), and caches every file.
- **Resolve** — versions resolve against the registry with whole-name dedupe (one
  version per package where semver allows; incompatible ranges are kept side by
  side). `package.json` `exports`/`imports` conditions are honored for the target;
  Node builtins map to `@jspm/core` polyfills (browser) or stay external (node).
  The resolution map is persisted as a lockfile.
- **Transform** — each file becomes browser-runnable ESM one-to-one. ESM/TS/JSX is
  transpiled and its specifiers rewritten in place; CommonJS is wrapped so the ESM
  module graph itself provides `require` (synchronously, backed by the eagerly
  primed graph). Internal imports are rewritten as **relative** URLs, so cached
  bytes are portable across mount prefixes.

## Limitations

- **Computed `require(expr)`** across package boundaries can't be pre-resolved and
  throws at execution time — the boundary where an `esbuild-wasm` bundle fallback
  would take over.
- Dedupe is greedy (first-resolved version wins per name), not a full constraint
  hoist.
- **Free Node globals under `target: "browser"`** (`process.env.NODE_ENV` and
  friends) are solved via the `~deps` proxy layer below — no page-side `define`
  needed.
- Bundling/copying the resolved graph into a distributable tree, `.d.ts` type
  serving, package lifecycle scripts, and HMR are out of scope.
- **`import * as X` of a host-provided module** can't enumerate the instance's
  keys as named bindings (an ESM proxy can't introspect an arbitrary runtime
  object) — only `import X from "…"` (default = the instance itself, covering
  property access) and explicitly-named imports are supported for `host`
  bindings. Ordinary (non-provided) npm/local deps have no such limit —
  `export *` re-exports the real module.

## The `~deps` proxy layer

Every external/free-global reference a module makes is rewritten to import a
small **co-located proxy** (`./~deps/{module}/deps.{name}.js`) instead of the
bare specifier directly. The module's own bytes are therefore always portable —
same relative imports whether the target is `local`, `host`, or `cdn` — and the
per-import proxy is what actually resolves the binding:

- **`provided`** — names bound to **live host instances** (e.g. the page's own
  `react`, or an app-defined class used as a `Map` key elsewhere) instead of a
  downloaded copy. Pass a plain `Record<string, unknown>` (copied into the
  shared registry at construction) or a live `HostRegistry` (`newHostRegistry()`)
  — passing the instance itself means `.set(name, value)` calls made **after**
  construction (late registration) are still visible, because the server treats
  that instance as `globalThis.__webrunHostRegistry`. Every proxy for a provided
  name reads `globalThis.__webrunHostRegistry.get(name)`, so all importers of
  `react` (or any provided key, including a class used as an adapter-map key)
  observe the **same reference** — real object identity, not a copy.
  *Caveat:* a live `HostRegistry` installs **itself** as the single realm-global
  registry, so in a multi-`newModuleServer` **Node** process the last one wins;
  single-realm browser use is the intended case.
- **`globals`** — extends/overrides the injectable free-variable allowlist
  (`process`, `Buffer`, `global`, `globalThis`, `__dirname`, `__filename` by
  default). A free variable *not* on the allowlist (e.g. `console`) is left as a
  native reference, never proxied.
- **`resolveEndpoint`** — swaps the linker that decides how a non-provided bare
  specifier binds: `local` (same-origin, served from this server's own cache —
  the default, and the **only** kind the default resolver ever emits: no
  runtime CDN dependency), `host` (provided names), `cdn` (an external URL), or
  `inline` (bundled source verbatim). Supply your own `EndpointResolver` to opt
  into `cdn`/`inline` — swapping it changes only the generated proxy bodies, the
  module's own imports never change.

## License

MIT
