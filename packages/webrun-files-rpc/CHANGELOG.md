# @statewalker/webrun-files-rpc

## 0.3.0

### Minor Changes

- ffd746b: Security: `..` segments no longer slip past path filters, guards and composite mounts (#40).
  
  `normalizePath` now resolves `..` (`/a/../b` is `/b`) and throws `Path climbs above the root: <path>`
  when one would climb above the root (`/../x`). Its result never holds a `..`, so `FilteredFilesApi`,
  `GuardedFilesApi` and `CompositeFilesApi` decide on the same path the backend acts on: over a node
  backend, `/x/../.git/config` used to pass a `/.git` filter and `/m/../y` used to escape a mount.
  `joinPath`, `dirname` and `basename` follow. The RPC server refuses an escaping append instead of
  clamping it; the HTTP client sends `/a/../b` as `/b` instead of refusing it.
  
  Migration: keys already stored in mem, S3 or SQLite with a literal `..` segment become unreachable
  through the API; rename them with a direct tool before upgrading. Rollback: pin the previous minor.

### Patch Changes

- 48e9aac: The CommonJS build has its own type declarations (`dist/cjs/*.d.cts`), and `exports` names them under `require`. TypeScript used to type `require("@statewalker/webrun-files…")` with the ESM declarations ("masquerading as ESM", attw's FalseESM). The API is unchanged.
- 6e3b14d: Dependencies are no longer bundled into `dist`: `@statewalker/webrun-files`, `@statewalker/webrun-files-mem` and `@statewalker/db-sqlite` are imported, as declared, instead of copied into the build. Consumers no longer get a second copy of the core (whose classes failed `instanceof` checks against the real one), and a compatible update of a dependency no longer republishes these packages. One exception: the CommonJS build of `@statewalker/webrun-files-sqlite` still contains `@statewalker/db-sqlite` and `@statewalker/db-api`, which publish no `require` entry, so that `require("@statewalker/webrun-files-sqlite")` keeps working.
- Updated dependencies [48e9aac]
- Updated dependencies [ffd746b]
  - @statewalker/webrun-files@0.12.0

## 0.2.0

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

### Patch Changes

- Updated dependencies [260b050]
- Updated dependencies [12603ad]
  - @statewalker/webrun-files@0.11.0

## 0.1.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: dist/cjs/index.cjs, dist/esm/index.js
- Updated dependencies
  - @statewalker/webrun-files@0.10.5

## 0.1.1

### Patch Changes

0.1.0 was published before these changes were merged; they were first released in 0.1.1.

- 844226f: Appends: `openWrite(path, { append: true })` and `FilesRpcClient.append(path, content)` add a stream's chunks to the end of a file. A served FilesApi with an `append(path, content)` method (`AppendableFilesApi`) appends through it; any other is appended to with read, write and remove only, through a temporary sibling.
  
  Metadata calls (`mkdir`, `remove`, `move`, `copy`) take an optional `requestId`: the server keeps each answer for `idleTimeout` (at most `maxRequests`), so a call delivered twice runs once and gets the first answer. The client sends one with every such call.
- 7e5d5f5: Fixes: a metadata call still running keeps its `requestId`, past `idleTimeout` and past `maxRequests` (the oldest settled answer is forgotten first), so a retry delivered meanwhile no longer runs it a second time; a read takes its listener off its `signal` when it ends, fails or is aborted (a long-lived signal no longer gathers one per read); `errorCode(e)` returns only protocol codes, not another error's own `code` (such as `ENOENT`).
- Updated dependencies
  - @statewalker/webrun-files@0.10.4

## 0.1.0

### Minor Changes

- 8ec21d1: New package: a FilesApi over any RPC. `newFilesRpcServer({ fs })` serves any FilesApi as plain method calls and `newFilesRpcClient({ rpc })` is a FilesApi over them; reads and writes stream as chunks kept and awaited by (streamId, chunkId), so calls may be pipelined, reordered or delivered twice. Built for carrying a FilesApi over Durable Object RPC, which streams only on workerd.
