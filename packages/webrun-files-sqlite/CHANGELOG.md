# @statewalker/webrun-files-sqlite

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
