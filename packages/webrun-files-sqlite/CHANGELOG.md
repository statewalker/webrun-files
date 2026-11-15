# @statewalker/webrun-files-sqlite

## 0.13.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-files crosses a breaking line

### Patch Changes

- 48e9aac: The CommonJS build has its own type declarations (`dist/cjs/*.d.cts`), and `exports` names them under `require`. TypeScript used to type `require("@statewalker/webrun-files…")` with the ESM declarations ("masquerading as ESM", attw's FalseESM). The API is unchanged.
- 6e3b14d: Dependencies are no longer bundled into `dist`: `@statewalker/webrun-files`, `@statewalker/webrun-files-mem` and `@statewalker/db-sqlite` are imported, as declared, instead of copied into the build. Consumers no longer get a second copy of the core (whose classes failed `instanceof` checks against the real one), and a compatible update of a dependency no longer republishes these packages. One exception: the CommonJS build of `@statewalker/webrun-files-sqlite` still contains `@statewalker/db-sqlite` and `@statewalker/db-api`, which publish no `require` entry, so that `require("@statewalker/webrun-files-sqlite")` keeps working.
- 339a3f9: `pakoDeflateCodec` accepts the pako 3 module as it is (`import * as pako from "pako"`) without a type error. `PakoStreamModule` no longer asks `Deflate` for an `ended` property, which pako 3 declares private there; `Inflate.ended` is still read to detect a truncated stream.
- ffd746b: Security: `..` segments no longer slip past path filters, guards and composite mounts (#40).
  
  `normalizePath` now resolves `..` (`/a/../b` is `/b`) and throws `Path climbs above the root: <path>`
  when one would climb above the root (`/../x`). Its result never holds a `..`, so `FilteredFilesApi`,
  `GuardedFilesApi` and `CompositeFilesApi` decide on the same path the backend acts on: over a node
  backend, `/x/../.git/config` used to pass a `/.git` filter and `/m/../y` used to escape a mount.
  `joinPath`, `dirname` and `basename` follow. The RPC server refuses an escaping append instead of
  clamping it; the HTTP client sends `/a/../b` as `/b` instead of refusing it.
  
  Migration: keys already stored in mem, S3 or SQLite with a literal `..` segment become unreachable
  through the API; rename them with a direct tool before upgrading. Rollback: pin the previous minor.
- Updated dependencies [48e9aac]
- Updated dependencies [ffd746b]
  - @statewalker/webrun-files@0.12.0

## 0.12.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: dist/cjs/index.cjs, dist/esm/index.js

## 0.12.0

### Minor Changes

- 260b050: ### Breaking
  
  - **`SqlarFilesApi.move` now requires a `Db` carrying db-sqlite's transaction hook (`inTransaction`).** Every `@statewalker/db-sqlite*` driver's `Db` has it. A wrapper `Db` must forward it (the `Symbol.for("@statewalker/db-sqlite:transaction")` property), or `move` rejects with `inTransaction: this Db has no SQLite transaction hook…`. There is no non-transactional fallback.
  
  ### Changes
  
  `FilesApi.move` is atomic where the backend allows it, so code that writes `index.lock` and moves it over `index` (as git does) never shows readers a missing or partial target. The `move` contract now says that it replaces an existing file, how each backend treats an existing directory, where it is atomic, and what a partial failure looks like.
  
  - `@statewalker/webrun-files`: new `MoveIncompleteError` and `removeMovedSource(files, source, target)`. A copy-then-delete move whose source cannot be removed after the copy retries the removal once, then throws `MoveIncompleteError` (`move /a -> /b: the target was replaced, but the source could not be removed`) instead of returning `false`, which callers read as "nothing happened".
  - `MemFilesApi`: `move` is one synchronous re-keying of the entry, or of every entry under a directory, instead of a copy and a remove with `await`s between them. An existing target is treated as `rename(2)` treats it, like `NodeFilesApi`: a file replaces a file, a directory replaces an empty directory, and anything else (a file onto a directory, a directory onto a file or a non-empty directory, a directory into its own subtree, a target below a file) returns `false` and changes nothing. Before, these cases merged or corrupted the tree, and a move into its own subtree never returned.
  - `BrowserFilesApi`: checks an existing target the same way before moving; the native `FileSystemHandle.move()` stays the atomic path (current Chromium replaces an existing file), and the copy-then-delete fallback, used when it is missing or unsupported (see below), still replaces a file's content in one step through a writable stream. A fallback whose source cannot be deleted now throws `MoveIncompleteError` instead of returning `false`.
  - `SqlarFilesApi`: `move` is one transaction (through `inTransaction`, like `SqliteFilesApi`) that deletes the target's subtree, creates its parents and renames the source rows by prefix, keeping their data instead of copying it. It replaces the target's subtree, and throws when one path contains the other (before, a move into its own subtree deleted the data and returned `true`). A target below a file or a symlink returns `false` and changes nothing (before, the move created the target under the file).
  - `SqliteFilesApi`: `copy` and `move` rewrite name prefixes by characters, as SQLite's `substr()` counts them, so a source name with characters above U+FFFF no longer loses its children; a non-recursive `list` of such a directory no longer returns grandchildren.
  - `BrowserFilesApi`: the copy-then-delete fallback runs only when the native `move()` is unsupported (`TypeError`, `NotSupportedError`) or refuses an existing target (`InvalidModificationError`); other native errors (`NoModificationAllowedError`, `NotAllowedError`, ...) are rethrown instead of being retried as a copy. A native `move()` that throws after the source has moved counts as done.
  - `cow` (webrun-files-composite): `move` checks an existing target as `rename(2)` does, like `MemFilesApi` (a file replaces a file, a directory an empty directory, anything else returns `false` and changes nothing), and a source that cannot be removed after the copy throws `MoveIncompleteError` instead of being reported as moved. Still copy then delete, documented as not atomic.
  - `webrun-files-http` and `webrun-files-rpc` clients: a `MoveIncompleteError` thrown by the server's backend is rebuilt on the client as a `MoveIncompleteError` (recognised by its name over http, by its message through a structured-clone rpc transport), carrying the client's paths and the transported error as `cause`.
  - Parent directories created for the target may be left even when `move` returns `false` (node, browser); the contract now says so.
  - `CompositeFilesApi` (across mounts) and `S3FilesApi`: still copy then delete, documented as not atomic; a source that cannot be removed now throws `MoveIncompleteError` instead of being ignored (composite) or returned as `false` (s3).
  - `NodeFilesApi` (`fs.rename`, atomic): documentation only. `webrun-files-http` and `webrun-files-rpc` moves are as atomic as the server's backend.
- 12603ad: `FilesApi` gains an optional `createExclusive(path, content): Promise<boolean>`: create the file only if nothing exists at the path, atomically, so that of concurrent calls for one path at most one returns `true`. It returns `false`, writing no file, for an existing file, directory or link; creates parent directories (which may stay even when it returns `false`); and removes the file again when the content fails. Only the creation is atomic: on some backends (node) readers can see partial content until the call completes, so callers that need atomic content create a temporary file and move it. It is the primitive behind lock files (git's `index.lock`). Being optional, existing implementations keep compiling; callers feature-detect it.
  
  - `NodeFilesApi`: `open(path, "wx")` (`O_CREAT | O_EXCL`), streamed in 64 KiB batches; excludes every process on the filesystem. A symbolic link, even a dangling one, counts as existing. A failed source unlinks the path, as git does.
  - `MemFilesApi`: a synchronous check and reservation; excludes callers sharing the instance. The file stays invisible until complete, and a file at an ancestor of the path makes the call return `false`.
  - `BrowserFilesApi`: the check and create run under a Web Lock (`navigator.locks`) asked for `ifAvailable`, excluding every tab and worker of the origin; a call that finds the lock held returns `false` at once. Without Web Locks, an in-memory lock excludes only the current realm. Under an OPFS root the lock is named by the file's full OPFS path, so instances rooted at different OPFS directories share it; elsewhere, the new option `lockScope` names the directory for instances built on separately obtained handles.
  - `SqliteFilesApi` and `SqlarFilesApi`: `INSERT ... ON CONFLICT DO NOTHING`; excludes every connection to the database. Nothing is visible until complete.
  - `S3FilesApi`: `If-None-Match: *` on the final `PutObject` or `CompleteMultipartUpload` (412 returns `false`, 409 is retried); excludes every client of the bucket on services that honour conditional writes (AWS S3 since 2024, RustFS).
  - `CompositeFilesApi` has the method only while every backend has it, and delegates to the owning backend; `GuardedFilesApi` (checked as a `write`) and `FilteredFilesApi` have it while what they wrap has it. Presence, `in` included, is checked at each access, so a wrapper over a composite loses the method when a `mount()` adds a backend without it.
  
  `webrun-files-http` and `webrun-files-rpc` do not offer it: neither protocol has a conditional create.

### Patch Changes

- Updated dependencies [260b050]
- Updated dependencies [12603ad]
  - @statewalker/webrun-files@0.11.0

## 0.11.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: dist/cjs/index.cjs, dist/esm/index.js
- Updated dependencies
  - @statewalker/webrun-files@0.10.5

## 0.11.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-files ^0.10.3 -> ^0.10.4

## 0.11.0

### Minor Changes

- 4967f48: Breaking (0.x minor): `SqliteFilesApi` and `SqlarFilesApi` now take a `Db` from `@statewalker/db-api`
  (any `@statewalker/db-sqlite-*` driver) instead of a `SqlDriver`. `SqlDriver`, `SqlStatement`,
  `NodeSqlDriver`, `DoSqlDriver` and `D1SqlDriver` are removed; D1 is no longer supported. Multi-statement
  steps run through `inTransaction` from `@statewalker/db-sqlite`. The storage format is unchanged:
  databases written by 0.10 open as they are. Consumers that stay on the old driver API keep `^0.10.3`.
  Migrate `new SqliteFilesApi(new NodeSqlDriver(...))` to `new SqliteFilesApi(await newNodeSqliteDb({ path }))`,
  and the Durable Object driver to `newDoSqliteDb(this.ctx.storage)`.

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-files@0.10.3

## 0.10.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-files@0.10.2

## 0.10.0

### Minor Changes

- 2ea6787: Ordered listings and `ListOptions.after`. Every `list()` now yields entries in strictly increasing
  path order, compared by Unicode code point (UTF-8 byte order), recursively or not, and
  `{ after: path }` resumes after any path, existing or not. The core package adds `comparePaths`,
  `listInPathOrder` and `mergeInPathOrder`.

  Behaviour changes: listings that previously came out in backend order (Node `readdir`, browser
  handles, memory insertion order, S3 prefixes before keys, composite mounts last) are now sorted; a
  `CompositeFilesApi` mount point replaces a same-path entry of the parent backend in listings; an S3
  key `a` and keys under `a/` list `/a` once, as the file.

- c4cb1cd: New package `@statewalker/webrun-files-sqlite`:

  - `SqliteFilesApi` — a streaming FilesApi over SQLite: paths share immutable contents stored as
    blocks of at most 1 MiB, optionally deflated per block, with measured backpressure. Works within
    the 2 MB row limit of Durable Objects and D1. One fixed `blockSize` per instance, recorded per
    content; metadata steps are atomic transactions, and `sweep()` removes what a crash leaves.
  - `SqlarFilesApi` — a FilesApi stored as a SQLite Archive, readable by `sqlite3 -A`.
  - Drivers for `node:sqlite`, Durable Object storage (`ctx.storage`) and D1, each with atomic
    `transaction()`; buffer codecs for SQLAR and streaming
    codecs (`webDeflateCodec`, `pakoDeflateCodec`) for block storage.

### Patch Changes

- Updated dependencies [2ea6787]
  - @statewalker/webrun-files@0.10.0
