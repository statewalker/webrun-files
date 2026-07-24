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

## Serving your own source too

Point the server at a project `FilesApi` and it resolves local scripts the same
way — bare imports rewritten to `/{name}@{version}/…`, relative imports kept
relative, TS/JSX transpiled:

```ts
const server = newModuleServer({ cache, project: myProjectFiles });
const app = await server.resolve({ url: "/src/app.ts" }); // → importable URL
```

## Full runnable example

[`examples/full-cycle.ts`](./examples/full-cycle.ts) demonstrates the entire
cycle against the live npm registry — lazy download-on-request, `resolve`,
`prime`, executing a served module, `?raw`, and the lockfile:

```sh
pnpm --filter @statewalker/webrun-modules exec tsx examples/full-cycle.ts
```

## Options

| Option      | Default                  | Purpose |
|-------------|--------------------------|---------|
| `cache`     | — (required)             | Injected `FilesApi` for the module cache. |
| `project`   | —                        | `FilesApi` of local project files to serve. |
| `sources`   | `[npmRegistrySource()]`  | Acquisition sources (npm tarball by default). |
| `transform` | `newDefaultTransform()`  | Per-file transform (ESM + CJS-interop). |
| `target`    | `"browser"`              | Selects `exports` conditions + cache key; `"node"` supported. |
| `lock`      | —                        | A `Lockfile` (pins versions); `prime` also writes one back. |
| `basePath`  | `"/"`                    | Mount prefix, e.g. `"/deps/v1/"`. |

### `ModuleServer`

```ts
interface ModuleServer {
  resolve(ref: ModuleRef, importer?: string): Promise<ResolvedModule>; // single ref → URL
  prime(entry: ModuleRef): Promise<ResolvedModule>;                    // warm the whole graph
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

## Serving surface

`server.fetch(request)` is a plain `(Request) => Promise<Response>`:

- modules are served as `text/javascript`;
- append `?raw` to get the untransformed bytes of any file in a package;
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
- Bundling/copying the resolved graph into a distributable tree, `.d.ts` type
  serving, package lifecycle scripts, and HMR are out of scope.

## License

MIT
