# webrun-files

This repository holds `FilesApi`, one small interface for file storage, and its implementations:
memory, Node.js, the browser File System Access API, S3, SQLite (node:sqlite, Cloudflare Durable
Objects, D1) and HTTP. A set of decorators mounts, guards, filters and layers them. Application
code is written once against `FilesApi`; the backend is picked where the code runs. All public
packages are published to npm under `@statewalker/`.

## The shape: one interface, one package per backend

```
packages/
  webrun-files            FilesApi interface, types, file/path utilities, list-order helpers
  webrun-files-mem        in-memory backend
  webrun-files-node       node:fs/promises backend, rooted at a directory
  webrun-files-browser    File System Access API backend (user directories, OPFS)
  webrun-files-s3         S3 / S3-compatible backend (peer: @aws-sdk/client-s3)
  webrun-files-sqlite     two SQLite backends + drivers for node:sqlite, Durable Objects, D1
  webrun-files-http       FilesApi served over HTTP and consumed again, fetch primitives only
  webrun-files-composite  decorators: mounts, guards, filters, read-only, overlay, copy-on-write
  webrun-files-tests      shared Vitest suites every backend runs (private, not published)

  every backend -----> @statewalker/webrun-files <----- webrun-files-tests (peer)
  webrun-files-http -> webrun-files-mem (default staging for chunked uploads)
```

| Package | What it gives | npm |
| --- | --- | --- |
| [`@statewalker/webrun-files`](./packages/webrun-files) | The `FilesApi` interface, its types, file and path utilities, listing-order helpers. No backend. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files) |
| [`@statewalker/webrun-files-mem`](./packages/webrun-files-mem) | In-memory backend. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-mem) |
| [`@statewalker/webrun-files-node`](./packages/webrun-files-node) | Node.js backend over `fs/promises`. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-node) |
| [`@statewalker/webrun-files-browser`](./packages/webrun-files-browser) | Browser backend over directory handles, including OPFS. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-browser) |
| [`@statewalker/webrun-files-s3`](./packages/webrun-files-s3) | Amazon S3 and S3-compatible stores. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-s3) |
| [`@statewalker/webrun-files-sqlite`](./packages/webrun-files-sqlite) | Block store and SQLite Archive backends. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-sqlite) |
| [`@statewalker/webrun-files-http`](./packages/webrun-files-http) | HTTP server stub and client stub. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-http) |
| [`@statewalker/webrun-files-composite`](./packages/webrun-files-composite) | Decorators over any `FilesApi`. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-composite) |
| [`@statewalker/webrun-files-tests`](./packages/webrun-files-tests) | Shared test suites. Private. | - |

Every public package ships ESM (`dist/esm`), CommonJS (`dist/cjs`) and type declarations, plus its
TypeScript sources in `src/`. Each has one entry point (`.`). The repository has no runtime
dependency on other `@statewalker` packages.

## How to run it

1. Use Node.js 24 and enable corepack, which provides the pinned pnpm (`packageManager:
   pnpm@10.16.1`):

   ```bash
   corepack enable
   ```

2. Install, build, then test. The order matters (see below):

   ```bash
   pnpm install
   pnpm build
   pnpm test
   ```

3. Before pushing, run the checks CI runs:

   ```bash
   pnpm lint:check
   pnpm format:check
   pnpm typecheck
   ```

4. The two suites that need extra infrastructure run on their own:

   ```bash
   pnpm --filter @statewalker/webrun-files-http test:e2e         # Chromium + Firefox via Playwright
   pnpm --filter @statewalker/webrun-files-s3 test:integration   # RustFS container, needs Docker
   ```

A minimal consumer:

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readText, writeText } from '@statewalker/webrun-files';

const files = new MemFilesApi();
await writeText(files, '/hello.txt', 'Hello, world!');
console.log(await readText(files, '/hello.txt')); // "Hello, world!"

for await (const entry of files.list('/')) {
  console.log(entry.name, entry.kind, entry.kind === 'file' ? entry.size : '');
}
```

## Why it is the way it is

**One interface, nine methods.** `FilesApi` has `read`, `write`, `mkdir`, `list`, `stats`,
`exists`, `remove`, `move`, `copy`. Content moves as `AsyncIterable<Uint8Array>` in both
directions, so a backend can stream without holding a file in memory, and a caller writes the same
loop for every backend.

**Metadata is a discriminated union.** `stats()` and `list()` return
`{ kind: "file", size, lastModified }` or `{ kind: "directory" }`, never one shape with optional
fields. A directory has no size, and a store where a directory is only a key prefix (S3) has no
modification time for it. Offering a value that exists on one backend and not on the next would
make callers depend on it.

**Listings are ordered and resumable.** Every backend lists in strictly increasing path order by
Unicode code point (UTF-8 byte order, the order SQLite and S3 already use), and `{ after }` resumes
after any path. A remote or very large listing can be read page by page without keeping an
iterator open. JavaScript's `<` is not this order above U+FFFF, so compare paths with
`comparePaths`.

**One shared test suite.** `webrun-files-tests` holds the contract as executable tests (77 for the
interface, 11 for a 256 MiB file). Every backend here runs them, which is what keeps the
implementations in agreement.

## What will surprise you

- **Tests see a stale build.** Packages use each other, including the shared suites, through their
  built `dist/`. A change in one package's `src/` is invisible to the others until `pnpm build`
  runs again. A test that "ignores" your fix is usually this.
- **`pnpm test` is heavy.** It includes the 256 MiB big-file suite for every in-process backend,
  and for the HTTP stubs both directly and over a real `@hono/node-server` connection. The
  `webrun-files-sqlite` run peaks at about 2.5 GB of memory, because `SqlarFilesApi` holds whole
  files by design. Under a tight memory limit it dies as an out-of-memory crash, not a test failure.
- **`pnpm test` barely tests `webrun-files-s3`.** It runs only the listing-order tests against a
  fake client. The real suites run against an S3 server and need Docker:
  `pnpm --filter @statewalker/webrun-files-s3 test:integration`.
- **`pnpm typecheck` checks nothing yet.** The root script runs `pnpm -r run typecheck`, and no
  package defines a `typecheck` script.
- **A zero-byte file has `size: 0`.** Test `entry.kind === 'file'`, not the truthiness of `size`.

## Reference

### Commands

| Command | What it runs |
| --- | --- |
| `pnpm build` | `pnpm -r run build`: rolldown bundles + `tsc --emitDeclarationOnly` per package |
| `pnpm test` | `pnpm -r run test` (Vitest) |
| `pnpm lint` / `pnpm lint:check` | `biome check --write .` / `biome check .` |
| `pnpm lint:fix`, `pnpm format:fix` | `biome check --write --unsafe .` |
| `pnpm format` / `pnpm format:check` | `biome format --write .` / `biome format .` |
| `pnpm typecheck` | `pnpm -r run typecheck` |
| `pnpm changeset` | add a changeset to your pull request |

### CI and releases

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests: a frozen install,
dependency-reference checks (`workspace:^` inside the repo, `catalog:` for everything else),
`lint:check`, `format:check`, build, typecheck, tests, and checks of export targets, dist imports
and packed manifests.

Packages are published to npm from CI with changesets. After CI passes on `main`, a job adds a
changeset for each package whose packed contents differ from npm and opens a
"chore: version packages" pull request; merging it publishes with provenance. To choose the bump or
the changelog text yourself, run `pnpm changeset` in your pull request. Renovate opens the
dependency updates. See [PUBLISHING.md](./PUBLISHING.md).

### License

MIT, see [LICENSE](./LICENSE).
