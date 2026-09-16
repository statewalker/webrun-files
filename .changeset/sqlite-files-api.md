---
"@statewalker/webrun-files-sqlite": minor
---

New package `@statewalker/webrun-files-sqlite`:

- `SqliteFilesApi` — a streaming FilesApi over SQLite: paths share immutable contents stored as
  blocks of at most 1 MiB, optionally deflated per block, with measured backpressure. Works within
  the 2 MB row limit of Durable Objects and D1.
- `SqlarFilesApi` — a FilesApi stored as a SQLite Archive, readable by `sqlite3 -A`.
- Drivers for `node:sqlite`, Durable Object storage and D1; buffer codecs for SQLAR and streaming
  codecs (`webDeflateCodec`, `pakoDeflateCodec`) for block storage.
