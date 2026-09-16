# webrun-files

A minimalistic cross-platform files API for JavaScript and TypeScript applications. This library provides a unified interface for file system operations that works seamlessly across Node.js, browser, cloud, and SQLite (including Cloudflare Durable Objects and D1) environments.

## Why This Library?

Working with files shouldn't require learning different APIs for different platforms. Whether you're building a desktop application with Node.js, a web app with browser storage, or a cloud service with S3, your file handling code should look the same. That's the core idea behind webrun-files.

The library defines a simple `FilesApi` interface that any storage backend can implement. Write your application code once against this interface, then swap implementations depending on where your code runs. Need to test file operations without touching the disk? Use the in-memory backend. Moving to production with real files? Switch to the Node.js adapter. Your application code doesn't change.

## Getting Started

Install the core package and the implementation you need:

```bash
# Core types and utilities
npm install @statewalker/webrun-files

# Pick an implementation
npm install @statewalker/webrun-files-mem    # In-memory (testing, browser)
npm install @statewalker/webrun-files-node   # Node.js filesystem
npm install @statewalker/webrun-files-browser # Browser File System Access API
npm install @statewalker/webrun-files-s3        # AWS S3 / S3-compatible
npm install @statewalker/webrun-files-sqlite    # SQLite: node:sqlite, Durable Objects, D1
npm install @statewalker/webrun-files-http      # Serve / consume a FilesApi over HTTP (fetch)
npm install @statewalker/webrun-files-composite # Mount multiple backends together
```

Here's what working with the API looks like:

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readFile, writeText } from '@statewalker/webrun-files';

// Create an in-memory filesystem
const files = new MemFilesApi();

// Write some content
await writeText(files, '/hello.txt', 'Hello, world!');

// Read it back using the utility function
const content = await readFile(files, '/hello.txt');
console.log(new TextDecoder().decode(content)); // "Hello, world!"

// Or read directly using the streaming API
for await (const chunk of files.read('/hello.txt')) {
  console.log(new TextDecoder().decode(chunk));
}

// Check what's in a directory
for await (const entry of files.list('/')) {
  // `size` exists on files only - narrow on `kind` first
  console.log(entry.name, entry.kind, entry.kind === 'file' ? entry.size : '');
}
```

## The FilesApi Interface

All implementations provide these methods:

```typescript
interface FilesApi {
  // Read file content as async iterable of chunks (a missing path yields nothing)
  read(
    path: string,
    options?: { start?: number; length?: number; signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;

  // Write content to file (creates parent directories)
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;

  // Create directory (and parents)
  mkdir(path: string): Promise<void>;

  // List directory contents, in path order; `after` resumes after any path
  list(path: string, options?: { recursive?: boolean; after?: string }): AsyncIterable<FileInfo>;

  // Get file/directory metadata (a discriminated union - see below)
  stats(path: string): Promise<FileStats | undefined>;

  // Check if path exists
  exists(path: string): Promise<boolean>;

  // Remove file or directory
  remove(path: string): Promise<boolean>;

  // Move/rename file or directory
  move(source: string, target: string): Promise<boolean>;

  // Copy file or directory
  copy(source: string, target: string): Promise<boolean>;
}
```

### Metadata is a discriminated union

`stats()` and `list()` return a union discriminated on `kind`, not one shape
with optional fields:

```typescript
type FileStats =
  | { kind: "file"; size: number; lastModified: number }
  | { kind: "directory" };

type FileInfo = FileStats & { name: string; path: string };
```

A file always reports both numbers. A directory reports neither: it has no
size, and a modification time for one exists on some stores and not on others,
so no caller may rely on it. Narrow on `kind` and the fields for that kind are
known to be present. Note that a zero-byte file is the file variant with
`size: 0` - check the `kind`, never the truthiness of `size`.

### Listings are ordered and resumable

Every backend yields `list()` entries in strictly increasing path order, compared by Unicode code
point (UTF-8 byte order, as SQLite and S3 list), and `{ after }` resumes after any path. A large or
remote listing can therefore be read in chunks — take N entries, remember the last path, ask again
— without holding an iterator open. Compare paths with `comparePaths` from
`@statewalker/webrun-files`, not `<`.

## Packages

This repository holds the `FilesApi` interface, its backends, a composition layer, and the shared
test suites every backend runs. (The runtime layers once hosted here — dataflow, builder, module
server — moved to `statewalker/webrun-transform`.)

### [@statewalker/webrun-files](./packages/webrun-files)

The core library with the `FilesApi` interface definition, type exports, and utility functions. This package contains no implementations - it defines the contract that all backends follow.

Utilities include:
- `readFile()`, `readText()` - Read entire file into memory
- `writeText()` - Write string content
- `readRange()`, `readAt()` - Random access reading
- Path utilities: `basename()`, `dirname()`, `joinPath()`, `normalizePath()`

### [@statewalker/webrun-files-mem](./packages/webrun-files-mem)

In-memory implementation. Perfect for testing, browser applications without persistent storage, or any case where you need fast, ephemeral file storage.

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';

const files = new MemFilesApi({
  initialFiles: {
    '/config.json': '{"debug": true}',
    '/data/items.txt': 'item1\nitem2\nitem3'
  }
});
```

### [@statewalker/webrun-files-node](./packages/webrun-files-node)

Node.js implementation using `fs/promises`. Maps virtual paths to a root directory on the local filesystem.

```typescript
import { NodeFilesApi } from '@statewalker/webrun-files-node';

const files = new NodeFilesApi({ rootDir: '/var/app/data' });
// files.write('/config.json', ...) writes to /var/app/data/config.json
```

### [@statewalker/webrun-files-browser](./packages/webrun-files-browser)

Browser implementation using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). Enables web applications to read and write files to user-selected directories via `showDirectoryPicker()` or the Origin Private File System (OPFS).

```typescript
import { BrowserFilesApi, openBrowserFilesApi, getOPFSFilesApi } from '@statewalker/webrun-files-browser';

// Open a user-selected directory
const files = await openBrowserFilesApi({ readwrite: true });

// Or use OPFS for persistent private storage
const opfsFiles = await getOPFSFilesApi();
```

Works in Chrome, Edge, and other Chromium-based browsers.

### [@statewalker/webrun-files-s3](./packages/webrun-files-s3)

S3-backed implementation for cloud storage. Works with Amazon S3 and S3-compatible services (MinIO, DigitalOcean Spaces, Backblaze B2, Cloudflare R2, etc.).

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3FilesApi } from '@statewalker/webrun-files-s3';

const s3Client = new S3Client({ region: 'us-east-1' });
const files = new S3FilesApi({
  client: s3Client,
  bucket: 'my-bucket',
  prefix: 'app-data'  // optional prefix acts as root directory
});
```

### [@statewalker/webrun-files-sqlite](./packages/webrun-files-sqlite)

Two SQLite-backed implementations over one small SQL driver interface, with drivers for `node:sqlite`,
Cloudflare Durable Object storage and D1.

- `SqliteFilesApi` streams content as fixed-size blocks (1 MiB by default, optionally deflated per
  block), shares identical content between paths, makes every metadata change one transaction,
  and stays within the 2 MB row limit of Durable Objects and D1. Files of any size.
- `SqlarFilesApi` stores each file as one row of a [SQLite Archive](https://sqlite.org/sqlar.html),
  readable by `sqlite3 -A`. Whole-file reads and writes; for runtimes without a row limit.

```typescript
import { DatabaseSync } from 'node:sqlite';
import { DoSqlDriver, NodeSqlDriver, SqliteFilesApi } from '@statewalker/webrun-files-sqlite';

const files = new SqliteFilesApi(new NodeSqlDriver(new DatabaseSync('files.db')));
await files.init();

// Inside a Durable Object
const doFiles = new SqliteFilesApi(new DoSqlDriver(this.ctx.storage));
```

### [@statewalker/webrun-files-http](./packages/webrun-files-http)

Serves any `FilesApi` over HTTP and consumes it as a `FilesApi` again, with only `fetch` primitives
on both sides. The server stub is a `(Request) => Promise<Response>` handler; the client stub takes
any `fetch`, including the server stub itself.

- Each call is its own request: `GET` with `Range`, `HEAD`, `PUT`, `MKCOL`/`COPY`/`MOVE`/`DELETE`
  with a `POST ?op=` fallback, and paged listings resumed with `after`.
- Reads and streamed uploads use real streams, with backpressure. Chunked, S3-style uploads cover
  browsers that cannot stream request bodies; their parts are staged in a separate `FilesApi`.
- `onRequest` / `onResponse` hooks and a per-request `fs` for authentication, CORS and tenancy.

```typescript
import { newClientStub, newServerStub } from '@statewalker/webrun-files-http';

// Server: mount in Hono, Bun, Deno, a Worker…
const handler = newServerStub({ fs: new NodeFilesApi({ rootDir: '/data' }), basePath: '/api/files' });

// Client
const files = await newClientStub({ baseUrl: 'https://example.com/api/files' });
```

### [@statewalker/webrun-files-composite](./packages/webrun-files-composite)

Composes multiple `FilesApi` instances into a unified virtual filesystem with mount points, base-path remapping, and access guards.

```typescript
import { CompositeFilesApi } from '@statewalker/webrun-files-composite';
import { NodeFilesApi } from '@statewalker/webrun-files-node';
import { S3FilesApi } from '@statewalker/webrun-files-s3';
import { MemFilesApi } from '@statewalker/webrun-files-mem';

const composite = new CompositeFilesApi(new NodeFilesApi({ rootDir: '/data' }), '/projects')
  .mount('/docs', s3Files, '/documentation')  // S3 subfolder as /docs
  .mount('/cache', new MemFilesApi())          // in-memory cache
  .guard(['write', 'remove'], path => !path.startsWith('/readonly/'), 'Read-only area');

// Transparent read/write across all backends
await writeText(composite, '/readme.txt', 'Hello');       // → NodeFilesApi at /data/projects/readme.txt
await writeText(composite, '/docs/guide.md', '# Guide');  // → S3FilesApi at /documentation/guide.md
await writeText(composite, '/cache/tmp.dat', 'temp');      // → MemFilesApi at /tmp.dat
```

Features: longest-prefix mount routing, cross-mount copy/move, mount-point protection, per-operation access guards, and recursive listing across mount boundaries.

### [@statewalker/webrun-files-tests](./packages/webrun-files-tests)

The shared test suites every backend here runs (private to the monorepo). Use them to verify a
custom backend:

```typescript
import { createBigFilesApiTests, createFilesApiTests } from '@statewalker/webrun-files-tests';

createFilesApiTests('MyCustomFilesApi', async () => ({
  api: new MyCustomFilesApi(),
  cleanup: async () => { /* cleanup code */ }
}));

// In a separate test file: one 256 MiB file, streamed in and verified on the fly
createBigFilesApiTests('MyCustomFilesApi', async () => ({ api: new MyCustomFilesApi() }));
```

`createFilesApiTests` registers 77 tests: every `FilesApi` method, path edge cases, concurrency,
error handling, runtime checks of the `FileStats` union, and listing order with `after`. `createBigFilesApiTests` adds 11 tests
of full and range reads, early stops, copy, remove and overwrite on a big file.

## Cross-repo dependencies

**This repository depends on no other repository.** It is a foundation of the
StateWalker dependency graph — everything below it may be built without it.

Cross-repo dependencies are declared `workspace:*` rather than `catalog:`. This is
deliberate: turbo derives its task graph from `workspace:` specifiers and does **not**
resolve `catalog:`, so a `catalog:` cross-repo dependency is invisible to the scheduler
and its consumer can be built before it.

## Development

The repository uses pnpm for package management. After cloning:

```bash
pnpm install
pnpm build
pnpm test
```

Build before testing: packages consume each other — including the shared suites in
`webrun-files-tests` — through their built `dist/`, so a change in one package's `src/` is invisible
to the others until it is rebuilt.

`pnpm test` includes the 256 MiB big-file suite for every in-process backend, and for the HTTP stubs
both directly and over a real `@hono/node-server` connection. It takes well under a
minute per package, and the `webrun-files-sqlite` run peaks at about 2.5 GB of memory (its
`SqlarFilesApi` holds whole files by design).

The S3 backend's tests need Docker and run separately, against a RustFS container:

```bash
pnpm --filter @statewalker/webrun-files-s3 test:integration
```

## License

MIT
