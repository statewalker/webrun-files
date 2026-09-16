---
"@statewalker/webrun-files-sqlite": minor
---

New package `@statewalker/webrun-files-sqlite`:

- `SqliteFilesApi` — a streaming FilesApi over SQLite: paths share immutable contents stored as
  blocks of at most 1 MiB, optionally deflated per block, with measured backpressure. Works within
  the 2 MB row limit of Durable Objects and D1. One fixed `blockSize` per instance, recorded per
  content; metadata steps are atomic transactions, and `sweep()` removes what a crash leaves.
- `SqlarFilesApi` — a FilesApi stored as a SQLite Archive, readable by `sqlite3 -A`.
- Drivers for `node:sqlite`, Durable Object storage (`ctx.storage`) and D1, each with atomic
  `transaction()`; buffer codecs for SQLAR and streaming
  codecs (`webDeflateCodec`, `pakoDeflateCodec`) for block storage.
