# webrun-files

One small `FilesApi` interface for file storage, with backends for memory, Node.js, the browser
File System Access API, S3, SQLite (node:sqlite, Cloudflare Durable Objects, D1) and HTTP, plus
decorators that mount, guard, filter and layer them. Application code is written once against
`FilesApi`; the backend is chosen where the code runs.

## Packages

| Package | Description | npm |
| --- | --- | --- |
| [`@statewalker/webrun-files`](./packages/webrun-files) | The `FilesApi` interface, its types, file and path utilities, listing-order helpers. No backend. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files) |
| [`@statewalker/webrun-files-mem`](./packages/webrun-files-mem) | In-memory backend. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-mem) |
| [`@statewalker/webrun-files-node`](./packages/webrun-files-node) | Node.js backend over `fs/promises`, rooted at a directory. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-node) |
| [`@statewalker/webrun-files-browser`](./packages/webrun-files-browser) | Browser backend over File System Access API handles, including OPFS. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-browser) |
| [`@statewalker/webrun-files-s3`](./packages/webrun-files-s3) | Backend for Amazon S3 and S3-compatible stores. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-s3) |
| [`@statewalker/webrun-files-sqlite`](./packages/webrun-files-sqlite) | Two SQLite backends (block store and SQLite Archive) with drivers for node:sqlite, Durable Objects and D1. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-sqlite) |
| [`@statewalker/webrun-files-http`](./packages/webrun-files-http) | Serve a `FilesApi` over HTTP and use it remotely as a `FilesApi`, with `fetch` primitives only. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-http) |
| [`@statewalker/webrun-files-composite`](./packages/webrun-files-composite) | Decorators: mount points, access guards, path filters, read-only, overlay and copy-on-write views. | [npm](https://www.npmjs.com/package/@statewalker/webrun-files-composite) |
| [`@statewalker/webrun-files-tests`](./packages/webrun-files-tests) | Shared Vitest suites every backend runs. Private, not published. | - |

All public packages ship ESM and CommonJS builds with type declarations in `dist/`, plus the
TypeScript sources in `src/`. Each has a single entry point (`.`).

## Quick start

```bash
pnpm add @statewalker/webrun-files @statewalker/webrun-files-mem
```

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readFile, writeText } from '@statewalker/webrun-files';

const files = new MemFilesApi();

await writeText(files, '/hello.txt', 'Hello, world!');

// Read the whole file with a utility...
const content = await readFile(files, '/hello.txt');
console.log(new TextDecoder().decode(content)); // "Hello, world!"

// ...or stream it chunk by chunk
for await (const chunk of files.read('/hello.txt')) {
  console.log(new TextDecoder().decode(chunk));
}

for await (const entry of files.list('/')) {
  // `size` exists on files only: narrow on `kind` first
  console.log(entry.name, entry.kind, entry.kind === 'file' ? entry.size : '');
}
```

## The FilesApi interface

Every backend implements:

```typescript
interface FilesApi {
  // File content as chunks; a missing path yields nothing
  read(
    path: string,
    options?: { start?: number; length?: number; signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;

  // Write content (creates parent directories)
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;

  // Create a directory and its parents
  mkdir(path: string): Promise<void>;

  // Directory contents in path order; `after` resumes after any path
  list(path: string, options?: { recursive?: boolean; after?: string }): AsyncIterable<FileInfo>;

  // Metadata (a discriminated union, see below)
  stats(path: string): Promise<FileStats | undefined>;

  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  move(source: string, target: string): Promise<boolean>;
  copy(source: string, target: string): Promise<boolean>;
}
```

### Metadata is a discriminated union

`stats()` and `list()` return a union discriminated on `kind`, not one shape with optional fields:

```typescript
type FileStats =
  | { kind: "file"; size: number; lastModified: number }
  | { kind: "directory" };

type FileInfo = FileStats & { name: string; path: string };
```

A file always reports both numbers. A directory reports neither: it has no size, and some stores
have no modification time for it. Narrow on `kind` and the fields for that kind are present. A
zero-byte file is the file variant with `size: 0`, so check `kind`, not the truthiness of `size`.

### Listings are ordered and resumable

Every backend yields `list()` entries in strictly increasing path order, compared by Unicode code
point (UTF-8 byte order, as SQLite and S3 list), and `{ after }` resumes after any path. A large or
remote listing can be read in chunks: take N entries, remember the last path, ask again. Compare
paths with `comparePaths` from `@statewalker/webrun-files`, not `<`.

## Relation to other statewalker repositories

This repository depends on no other statewalker repository; all `@statewalker/*` dependencies are
internal (`workspace:^`). Other repositories build on it, for example `webrun-sync`, `webrun-vcs`,
`webrun-sites`, `statewalker-kernel` and `statewalker-knowledge`. The runtime layers that once lived
here (dataflow, builder, module server) moved to
[statewalker/webrun-sites](https://github.com/statewalker/webrun-sites).

## Development

Requirements: Node.js 24 and pnpm 10, enabled through corepack (the version is pinned in
`packageManager`).

```bash
corepack enable
pnpm install
pnpm build          # build every package (pnpm -r run build)
pnpm test           # run every package's tests
pnpm lint           # biome check --write
pnpm lint:check     # biome check, no writes (CI)
pnpm format         # biome format --write
pnpm format:check   # biome format, no writes (CI)
pnpm typecheck      # pnpm -r run typecheck
```

Build before testing: packages use each other, including the shared suites in
`webrun-files-tests`, through their built `dist/`. A change in one package's `src/` is invisible to
the others until it is rebuilt.

`pnpm test` includes the 256 MiB big-file suite for every in-process backend, and for the HTTP stubs
both directly and over a real `@hono/node-server` connection. It takes well under a minute per
package. The `webrun-files-sqlite` run peaks at about 2.5 GB of memory, because `SqlarFilesApi`
holds whole files by design.

Two suites run separately:

```bash
# HTTP stubs in Chromium and Firefox, through Playwright
pnpm --filter @statewalker/webrun-files-http test:e2e

# S3 backend against a RustFS container (needs Docker)
pnpm --filter @statewalker/webrun-files-s3 test:integration
```

CI runs the shared workflow from [statewalker/.github](https://github.com/statewalker/.github):
frozen install, dependency-reference checks, `lint:check`, `format:check`, build, typecheck, tests,
and export, dist-import and pack checks.

## Releases

Releases are automatic and use [changesets](https://github.com/changesets/changesets). After CI
passes on `main`, a job adds changesets for packages whose packed contents differ from npm and
opens a "chore: version packages" pull request. Merging it publishes to npm with provenance. To
choose the bump or the changelog text yourself, add a changeset with `pnpm changeset` in your pull
request. Dependency updates come from Renovate. See
[statewalker/.github](https://github.com/statewalker/.github#readme) for the details, and
[PUBLISHING.md](./PUBLISHING.md) for a short summary.

## License

MIT, see [LICENSE](./LICENSE).
