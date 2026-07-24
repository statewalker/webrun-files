# @statewalker/webrun-modules

Run authored TypeScript/JavaScript apps **and the arbitrary npm modules they
import** in the browser (or Node) with **no runtime CDN dependency**.

Given a TS/JS entry, `webrun-modules` resolves, downloads, and transforms the
whole dependency graph — from npm (or a CDN) **at resolve time only** — and serves
the transformed, browser-runnable ESM from a local
[`FilesApi`](https://www.npmjs.com/package/@statewalker/webrun-files) cache. Every
internal import is rewritten to a same-origin local URL, so nothing is fetched
from a third party at run time. The result is always a URL any module-compatible
runtime can `import` directly — no bespoke client loader.

It is **isomorphic**: the same code runs in a browser ServiceWorker and in Node —
the difference is only which `FilesApi` backend you inject.

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

// Eagerly download + transform the whole graph up front:
await server.prime({ pkg: "zod" });

// Serve it — `server.fetch` is a standard Web handler, mountable anywhere:
Deno.serve(server.fetch);                                       // Deno
export default { fetch: server.fetch };                         // Bun / Cloudflare
self.addEventListener("fetch", (e) => e.respondWith(server.fetch(e.request))); // ServiceWorker
```

### Serving your own source too

Point the server at a project `FilesApi` and it resolves local scripts the same
way — bare imports rewritten to `/{name}@{version}/…`, relative imports kept
relative, TS/JSX transpiled:

```ts
const server = newModuleServer({ cache, project: myProjectFiles });
const app = await server.resolve({ url: "/src/app.ts" }); // → importable URL
```

## Options

| Option      | Default                  | Purpose |
|-------------|--------------------------|---------|
| `cache`     | — (required)             | Injected `FilesApi` for the module cache. |
| `project`   | —                        | `FilesApi` of local project files to serve. |
| `sources`   | `[npmRegistrySource()]`  | Acquisition sources (npm tarball by default). |
| `transform` | default per-file         | ESM + CJS-interop transform. |
| `target`    | `"browser"`              | Selects `exports` conditions + cache key; `"node"` supported. |
| `lock`      | —                        | A lockfile (pins versions); `prime` also writes one back. |
| `basePath`  | `"/"`                    | Mount prefix, e.g. `"/deps/v1/"`. |

## How it works

- **Acquire** — the default `Source` fetches the npm registry tarball, untars it
  in memory (pure-JS, isomorphic), and caches every file. JSR / direct-URL sources
  plug into the same `Source` interface.
- **Resolve** — versions resolve against the registry with whole-name dedupe (one
  version per package where semver allows; incompatible ranges are kept side by
  side). `package.json` `exports`/`imports` conditions are honored for the target;
  Node builtins map to self-hosted `@jspm/core` polyfills (browser) or stay
  external (node). The resolution map is persisted as a lockfile.
- **Transform** — each file becomes browser-runnable ESM one-to-one. ESM/TS/JSX is
  transpiled and its specifiers rewritten in place; CommonJS is wrapped so the ESM
  module graph itself provides `require` (synchronously, backed by the eagerly
  primed graph). Internal imports are rewritten as **relative** URLs, so cached
  bytes are portable across mount prefixes.

## Serving surface

`server.fetch(request)` is a plain `(Request) => Promise<Response>`:

- modules are served as `text/javascript`;
- append `?raw` to get the untransformed bytes of any file in a package;
- an unresolvable path returns a `404` `Response` (never throws).

Mount it under any `basePath` (returned URLs carry the prefix; the cached bytes
stay portable).

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
