# @statewalker/webrun-files-sqlite

## What it is

Two implementations of `FilesApi` from `@statewalker/webrun-files` that store files in a SQLite
database, through `@statewalker/db-api`'s `Db`: any `@statewalker/db-sqlite-*` driver — `node:sqlite`,
the browser (sqlite-wasm), or a Durable Object's storage:

- `SqliteFilesApi` streams content as fixed-size blocks (1 MiB by default, optionally deflated per
  block), shares identical content between paths, and makes every metadata change one transaction.
  Files of any size.
- `SqlarFilesApi` stores each file as one row of a [SQLite Archive](https://sqlite.org/sqlar.html),
  readable by `sqlite3 -A`. Whole-file reads and writes.

## Why it exists

Durable Objects offer SQLite and nothing like a file system, and a single SQLite file is a
convenient, transactional store elsewhere too. Storing a file as one blob breaks there: Durable
Objects cap a row at 2 MB, and a blob is read and written whole. `SqliteFilesApi` cuts
content into blocks that stay under the cap and can be streamed and range-read. `SqlarFilesApi`
exists for the opposite need: an archive other SQLAR tools can open, in runtimes without a row
limit.

| | `SqliteFilesApi` | `SqlarFilesApi` |
| --- | --- | --- |
| Storage | paths -> contents -> blocks of at most 1.5 MiB | one row per file, SQLite Archive format |
| File size | unbounded; streamed block by block | one blob, read and written whole |
| Durable Objects | yes, every row stays under the 2 MB limit | only files whose stored row is under 2 MB |
| Readable by `sqlite3 -A` | no | yes |
| Identical content | stored once, shared by every path | stored per path |

Use `SqliteFilesApi` by default.

## How to use

```bash
pnpm add @statewalker/webrun-files-sqlite @statewalker/webrun-files @statewalker/db-sqlite-node
```

Pick the driver for your runtime: `@statewalker/db-sqlite-node` on Node, `@statewalker/db-sqlite-do`
in a Durable Object, `@statewalker/db-sqlite-browser` in the browser.

`pako` is not a dependency: pass the module to `pakoCodec` / `pakoDeflateCodec` if you use them.

One entry point, `@statewalker/webrun-files-sqlite`: ESM (`dist/esm/index.js`), CommonJS
(`dist/cjs/index.cjs`), types (`dist/index.d.ts`); sources in `src/`. The package imports no
database driver itself; you pass a `Db` in, so it bundles for any runtime.

```typescript
import { newNodeSqliteDb } from '@statewalker/db-sqlite-node';
import { SqliteFilesApi } from '@statewalker/webrun-files-sqlite';

const db = await newNodeSqliteDb({ path: 'files.db' }); // node:sqlite
// or, in a Durable Object (ctx.storage, not ctx.storage.sql):
// import { newDoSqliteDb } from '@statewalker/db-sqlite-do';
// const db = newDoSqliteDb(this.ctx.storage);

const files = new SqliteFilesApi(db, { blockSize: 1024 * 1024 });
await files.init(); // creates tables and indexes if missing; await it before any other call
```

### `SqliteFilesApi` options

| Option | Default | |
| --- | --- | --- |
| `compression` | `webDeflateCodec()` where `CompressionStream` exists, else none | `null` stores uncompressed; `pakoDeflateCodec(pako)` for runtimes without Compression Streams |
| `tablePrefix` | `"fs_"` | several file systems in one database |
| `blockSize` | 1 MiB | uncompressed bytes per block for new writes, 1 byte to 1.5 MiB |

### `SqlarFilesApi` codecs (`codec` option)

| Codec | Uses | When |
| --- | --- | --- |
| `defaultCodec()` | `webCodec()` or `rawCodec()` | the default: `webCodec()` where `CompressionStream` exists, `rawCodec()` elsewhere |
| `webCodec({ minSize? })` | `CompressionStream("deflate")` | browsers, Workers, Node, Deno, Bun |
| `pakoCodec(pako, { minSize?, level? })` | an injected `pako` module | runtimes without Compression Streams |
| `rawCodec()` | nothing | never compresses, and refuses to read compressed rows |

## Examples

### Stream a large file through `SqliteFilesApi`

```typescript
import { newNodeSqliteDb } from '@statewalker/db-sqlite-node';
import { SqliteFilesApi } from '@statewalker/webrun-files-sqlite';

const files = new SqliteFilesApi(await newNodeSqliteDb({ path: 'files.db' }));
await files.init();

await files.write('/video.mp4', chunks); // any Iterable or AsyncIterable of Uint8Array
for await (const chunk of files.read('/video.mp4', { start: 10_000_000, length: 65_536 })) {
  // only the block holding this range is fetched and inflated
}
```

### Inside a Durable Object

```typescript
import { newDoSqliteDb } from '@statewalker/db-sqlite-do';
import { SqliteFilesApi } from '@statewalker/webrun-files-sqlite';

const files = new SqliteFilesApi(newDoSqliteDb(this.ctx.storage));
await files.init();
```

### Clean up interrupted writes

```typescript
const removed = await files.sweep({ olderThan: 60 * 60_000 }); // contents untouched for an hour
```

### A portable archive with `SqlarFilesApi`

```typescript
import { newNodeSqliteDb } from '@statewalker/db-sqlite-node';
import * as pako from 'pako';
import { readText, writeText } from '@statewalker/webrun-files';
import { pakoCodec, SqlarFilesApi } from '@statewalker/webrun-files-sqlite';

const files = new SqlarFilesApi(await newNodeSqliteDb({ path: 'site.sqlar' }), {
  codec: pakoCodec(pako, { level: 9 }),
});
await files.init(); // creates the sqlar table if missing

await writeText(files, '/docs/index.md', '# Hello');
console.log(await readText(files, '/docs/index.md'));

await files.symlink('/latest.md', './docs/index.md');
await files.readlink('/latest.md'); // "./docs/index.md"
```

## Internals

### Why every step runs through `inTransaction`, and what breaks it

Each step that changes what a path shows runs as one SQLite transaction through `inTransaction`
from `@statewalker/db-sqlite`. It runs as `BEGIN IMMEDIATE … COMMIT` behind a mutex on Node and in
the browser, and through `ctx.storage.transaction()` in a Durable Object, where `sql.exec` rejects
`BEGIN`. The rows a statement changed come from `SELECT changes()` inside that transaction. Steps
never depend on reading another statement's result: conditions live in SQL (`WHERE EXISTS …`).

`inTransaction` finds the driver's transaction support through a hook on the `Db` it was given.
**A `Db` wrapped in your own proxy (logging, metrics) loses the hook.** The first `write`,
`remove`, `copy`, `move` or `sweep` then rejects with: `inTransaction: this Db has no SQLite
transaction hook. It is not a @statewalker/db-sqlite* Db, or it wraps one (a wrapper object loses
the hook - pass the driver's Db itself), or it is the handle of a running transaction (nesting is
not supported).` Pass the driver's `Db` itself, or forward `db[SQLITE_TRANSACTION]` (exported by
`@statewalker/db-sqlite`) in your wrapper.

### How `SqliteFilesApi` stores content

```
fs_paths(pid, path UNIQUE, fid, mtime)          a path -> a content, or a directory (fid NULL)
   |
   v
fs_files(fid, size, compression, block_size,    an immutable content: size, "none"/"deflate",
         hash, updated)                         block size, SHA-256, last change
   |
   v
fs_blocks(fid, shift, block)                    the content in blocks of block_size bytes;
                                                shift = offset in the uncompressed content
```

Each block of a `deflate` content is its own zlib stream, so a range read fetches and inflates
exactly the blocks it touches, found by key. `copy` adds path rows pointing at the same content; a
write whose bytes match an existing content (same SHA-256, size, compression and block size) shares
it too. A content and its blocks are deleted when the last path pointing at it goes.

### Why the block size is capped at 1.5 MiB

A deflated block can be slightly larger than its input. 1.5 MiB keeps even incompressible input
under the 2 MB row limit of Durable Objects. Larger blocks mean fewer rows; smaller blocks make
small range reads cheaper. Each content records its own block size, so changing `blockSize` never
affects existing files.

### Streaming and memory

`write` pulls the source only while it builds the current block and stores each block before
pulling the next; `read` fetches a block only when its consumer asks for bytes beyond the previous
one. Memory is bounded by one block plus one source chunk; the tests measure both bounds. An
`AbortSignal` passed to `read` is checked before every block. `list` reads `fs_paths` in pages of
256 by key, in index order, which is the `FilesApi` path order, and `{ after }` is where the first
page starts.

### Atomic steps, and why `sweep` exists

Streaming happens outside transactions. Every step that changes what a path shows is one
transaction: storing each block, finishing a write, `remove`, `copy` and `move`. A failure inside
any of them leaves the database as it was; `move` onto an existing target never loses the target.
A write stays invisible until it finishes: if it fails, the path keeps its previous content and the
partial content is deleted.

If the process dies mid-stream, the partial content is left behind, unreferenced. `sweep` deletes
contents that no path references and that have not been updated for `olderThan` milliseconds, with
their blocks. A write refreshes its content with every block, so only a write stalled longer than
`olderThan` can be swept, and it then fails rather than creating a broken path. Choose a threshold
above the longest pause a source may take. `sweep` never runs on its own.

### What `SqliteFilesApi` throws

- The constructor throws `SqliteFilesApi: blockSize must be an integer from 1 to 1572864, got ...`
  and `SqliteFilesApi: tablePrefix must be a plain SQL identifier, got ...`.
- `copy` and `move` replace the target's subtree rather than merging into it, and throw when one
  path contains the other.
- A read whose content is removed underneath it throws `changed during read`.
- A block whose uncompressed length does not match its position throws `block at <shift> holds ...
  bytes`, before any wrong byte reaches the reader.

### How `SqlarFilesApi` stores entries

| Entry | `name` | `sz` | `data` |
| --- | --- | --- | --- |
| File | `docs/index.md` (no leading slash) | byte length | plaintext, or deflated when strictly shorter |
| Empty file | | `0` | zero-length blob |
| Directory | | `0` | `NULL` |
| Symlink | | `-1` | target as text |

`mtime` is stored in seconds; `lastModified` reports milliseconds. Inputs shorter than `minSize`
(64 bytes by default) are stored without trying to compress. All codecs read and write the same
zlib format. Archives written by other tools without directory rows still behave as trees: a path
that is only a prefix of other names is a directory.

`FileKind` has no symlink, so `stats`, `exists`, `read` and `list` follow links as POSIX `stat()`
does. A dangling link, or a chain longer than 8, behaves as a missing path. `remove`, `copy` and
`move` act on the link itself. Only the final path component is resolved through symlinks.

### `SqlarFilesApi` limits

- A file is one blob: `write` buffers it, `read` inflates it whole and yields one chunk.
- On Durable Objects the stored (possibly compressed) size of one file must stay under 2 MB, since
  SQLAR keeps each file in one row. A larger file fails the `write` with `string or blob too big`
  — a value limit, not corruption. Store big files with `SqliteFilesApi`, whose blocks stay under
  the limit.
- Multi-row mutations (`copy`, `move`, `remove` of a tree) are not wrapped in a transaction: a
  failure part-way leaves the rows already changed in place, and a `move` can leave the entry under
  both paths.
- `list` loads every row under the directory, then sorts the entries into path order before
  applying `after`.

### Dependencies

- `@statewalker/db-api` — the `Db` contract both implementations run on.
- `@statewalker/db-sqlite` — `inTransaction`, for `SqliteFilesApi`'s atomic steps.
- `@statewalker/webrun-files` — the `FilesApi` contract and path helpers.

The browser driver (`@statewalker/db-sqlite-browser`) is supported through the same `Db` contract, but
this package's tests run on `node:sqlite` and the Durable Object fake only.

The drivers (`@statewalker/db-sqlite-node`, `@statewalker/db-sqlite-do`, …) are the caller's
choice and are not dependencies; neither is `pako`, which is passed in.

## License

MIT
