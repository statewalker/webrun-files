# @statewalker/webrun-files-sqlite

Two `FilesApi` implementations over SQLite, sharing one small SQL port with drivers for
`node:sqlite`, Cloudflare Durable Object storage and Cloudflare D1.

| | `SqliteFilesApi` | `SqlarFilesApi` |
| --- | --- | --- |
| Storage | paths → contents → blocks of ≤ 1 MiB | one row per file, [SQLite Archive](https://sqlite.org/sqlar.html) format |
| File size | unbounded; streamed block by block | one blob, read and written whole |
| Durable Objects / D1 | yes — every row stays under the 2 MB limit | only files whose stored row is under 2 MB |
| Readable by `sqlite3 -A` | no | yes |
| Identical content | stored once, shared by every path | stored per path |

Use `SqliteFilesApi` by default, and `SqlarFilesApi` where the archive must be portable to other
SQLAR tools, in a runtime without a row limit (Node, Deno, Bun, a browser SQLite).

## Installation

```bash
npm install @statewalker/webrun-files-sqlite @statewalker/webrun-files
```

`pako` is not a dependency: pass the module to `pakoCodec` / `pakoDeflateCodec` if you use them.

## Drivers

Both implementations take a `SqlDriver`. The package imports none of the handles below — they are
passed in — so it bundles for any runtime.

```typescript
import { D1SqlDriver, DoSqlDriver, NodeSqlDriver } from "@statewalker/webrun-files-sqlite";

new NodeSqlDriver(new DatabaseSync("files.db")); // node:sqlite
new DoSqlDriver(this.ctx.storage); // inside a Durable Object: ctx.storage, not ctx.storage.sql
new D1SqlDriver(env.DB); // a D1 binding
```

Any other SQLite binding works by implementing the port:

```typescript
interface SqlStatement {
  sql: string;
  params?: unknown[];
}

interface SqlDriver {
  /** Rows as objects keyed by column name. */
  all<T>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
  /** One statement, for its effect. */
  run(sql: string, ...params: unknown[]): void | Promise<void>;
  /**
   * The statements in order, as one transaction: all apply or none do. Returns the number of rows
   * each statement changed. No statement may depend on another's result.
   */
  transaction(statements: SqlStatement[]): number[] | Promise<number[]>;
}
```

The built-in drivers implement `transaction` with `BEGIN IMMEDIATE … COMMIT` (node:sqlite),
`ctx.storage.transactionSync` (Durable Objects, where `sql.exec` rejects `BEGIN`) and `batch()` (D1).
Blobs come back as `Uint8Array`, `ArrayBuffer` or `number[]` depending on the runtime; both
implementations accept all three.

## SqliteFilesApi

```typescript
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver, SqliteFilesApi } from "@statewalker/webrun-files-sqlite";

const files = new SqliteFilesApi(new NodeSqlDriver(new DatabaseSync("files.db")));
await files.init(); // creates fs_paths, fs_files and fs_blocks if missing

await files.write("/video.mp4", response.body); // any Iterable or AsyncIterable of Uint8Array
for await (const chunk of files.read("/video.mp4", { start: 10_000_000, length: 65_536 })) {
  // only the block holding this range is fetched and inflated
}
```

`init()` creates the tables and indexes if they are missing; await it before any other call.

### How content is stored

- `fs_paths(pid, path UNIQUE, fid, mtime)` — a path points at a content, or is a directory (`fid` NULL).
- `fs_files(fid, size, compression, block_size, hash, updated)` — an immutable content: its
  uncompressed size, `"none"` or `"deflate"`, the block size it was written with, the SHA-256 of its
  bytes, and when it last changed (`size` and `hash` are NULL while it is being written).
- `fs_blocks(fid, shift, block)`, keyed by `(fid, shift)` — the content cut into blocks of
  `block_size` uncompressed bytes (only the last one shorter); `shift` is the block's offset in the
  uncompressed content, always a multiple of `block_size`. Each block of a `deflate` content is its
  own zlib stream, so a range read fetches and inflates exactly the blocks the range touches, found
  by key.

`copy` adds path rows pointing at the same content; a write whose bytes match an existing content
(same SHA-256, size, compression and block size) shares it too. A content and its blocks are deleted when the
last path pointing at it is removed or overwritten.

### Streaming

`write` pulls the source only while it builds the current block and stores each block before
pulling for the next; `read` fetches a block only when its consumer asks for bytes beyond the
previous one. Memory is bounded by one block plus one source chunk, and the tests measure both
bounds. An `AbortSignal` passed to `read` is checked before every block.

`list` is streamed too: it reads `fs_paths` in pages of 256 by key, in the index's order — which is
the path order every `FilesApi` lists in — and `{ after }` is simply where the first page starts.

### Options

| Option | Default | |
| --- | --- | --- |
| `compression` | `webDeflateCodec()` where `CompressionStream` exists, else none | `null` stores uncompressed; `pakoDeflateCodec(pako)` for runtimes without Compression Streams |
| `tablePrefix` | `"fs_"` | several file systems in one database |
| `blockSize` | 1 MiB | uncompressed bytes per block for new writes, 1 to 1.5 MiB (the cap keeps a deflated block under the 2 MB row limit). Larger means fewer rows — better where statements are costly, as on D1; smaller means cheaper small range reads. Each content records its own size, so changing this never affects existing files. |

### Semantics worth knowing

- `copy` and `move` replace the target's subtree rather than merging into it, and throw when one
  path contains the other.
- A write is invisible until complete: if it fails for any reason, the path keeps its previous
  content and the partly written content is deleted.
- A read whose content is removed underneath it throws `changed during read`. A block whose
  uncompressed length is not what its position implies throws `block at <shift> holds … bytes`,
  before any wrong byte reaches the reader.

### Interruptions and `sweep`

Streaming happens outside transactions; every step that changes what a path shows is one
transaction (`BEGIN IMMEDIATE` on node:sqlite, `transactionSync` on Durable Objects, `batch()` on D1):
storing each block, finishing a write, `remove`, `copy` and `move`. A failure inside any of them
leaves the database exactly as it was — `move` onto an existing target never loses the target.

A write stays invisible until it finishes. If the process dies mid-stream, the partly written
content is left behind unreferenced; remove such leftovers with

```typescript
const removed = await files.sweep({ olderThan: 60 * 60_000 }); // contents untouched for an hour
```

`sweep` deletes contents that no path references and that have not been updated for `olderThan`
milliseconds, with their blocks. A write refreshes its content with every block, so only a write
stalled longer than `olderThan` can be swept — and it then fails rather than creating a broken path.
Choose a threshold above the longest pause a source may take. `sweep` never runs on its own.

## SqlarFilesApi

```typescript
import { DatabaseSync } from "node:sqlite";
import { readText, writeText } from "@statewalker/webrun-files";
import { NodeSqlDriver, SqlarFilesApi } from "@statewalker/webrun-files-sqlite";

const files = new SqlarFilesApi(new NodeSqlDriver(new DatabaseSync("site.sqlar")));
await files.init(); // creates the sqlar table if missing — await before anything else

await writeText(files, "/docs/index.md", "# Hello");
console.log(await readText(files, "/docs/index.md"));
```

It takes the same drivers (see *Drivers*), subject to the row limit below.

### Compression codecs

| Codec | Uses | When |
| --- | --- | --- |
| `webCodec()` | `CompressionStream("deflate")` | Default wherever `CompressionStream` exists |
| `pakoCodec(pako, { level })` | an injected `pako` module | Runtimes without Compression Streams |
| `rawCodec()` | nothing | Default elsewhere; never compresses, and refuses to read compressed rows |

```typescript
import * as pako from "pako";
const files = new SqlarFilesApi(driver, { codec: pakoCodec(pako) });
```

All codecs read and write the same zlib format, so an archive written with one is read by another.
Inputs shorter than `minSize` (64 bytes by default) are stored without attempting compression.

### How entries are stored

| Entry | `name` | `sz` | `data` |
| --- | --- | --- | --- |
| File | `docs/index.md` (no leading slash) | byte length | plaintext, or deflated when strictly shorter |
| Empty file | | `0` | zero-length blob |
| Directory | | `0` | `NULL` |
| Symlink | | `-1` | target as text |

`mtime` is stored in seconds; `lastModified` reports it in milliseconds. Archives written by other
tools without directory rows still behave as trees: a path that is only a prefix of other names is a
directory.

#### Symlinks

`FileKind` has no symlink, so `stats`, `exists`, `read` and `list` follow links the way POSIX
`stat()` does. A dangling link, or a chain of more than 8, behaves as a missing path. `remove`,
`copy` and `move` act on the link itself. Two extension methods give access to links:

```typescript
await files.symlink("/latest.js", "./v2/index.js");
await files.readlink("/latest.js"); // "./v2/index.js"
```

### Limitations

- A file is one blob: `write` buffers its content, `read` inflates it whole and yields one chunk.
- On Durable Objects and D1 a row may not exceed 2 MB, so the *stored* (possibly compressed) size
  of one file is capped there. Use `SqliteFilesApi` in those runtimes.
- Multi-row mutations (`copy`, `move`, `remove` of a tree) are not wrapped in a transaction.
- Only the final path component is resolved through symlinks.
- `list` loads every row under the directory, then sorts the entries into path order (implicit
  directories and resolved links do not sit where the rows do) before applying `after`.

## License

MIT
