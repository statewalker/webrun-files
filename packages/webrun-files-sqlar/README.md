# @statewalker/webrun-files-sqlar

A `FilesApi` whose whole state is one table in the [SQLite Archive](https://sqlite.org/sqlar.html)
(SQLAR) format.

## Overview

- **One portable file.** The archive is an ordinary SQLite database, readable by `sqlite3 -A`,
  `sqlar` and `sqlarfs`.
- **Any SQLite.** A two-method SQL port with drivers for `node:sqlite`, Durable Object storage
  (`ctx.storage.sql`) and Cloudflare D1. Handles are injected; the package imports none of them.
- **Compressed.** Content is stored as zlib-wrapped Deflate when that makes it smaller, plaintext
  otherwise, exactly as the format specifies.

## Installation

```bash
npm install @statewalker/webrun-files-sqlar @statewalker/webrun-files
```

## Usage

```typescript
import { DatabaseSync } from "node:sqlite";
import { readText, writeText } from "@statewalker/webrun-files";
import { NodeSqlDriver, SqlarFilesApi } from "@statewalker/webrun-files-sqlar";

const files = new SqlarFilesApi(new NodeSqlDriver(new DatabaseSync("site.sqlar")));
await files.init(); // creates the sqlar table if missing — await before anything else

await writeText(files, "/docs/index.md", "# Hello");
console.log(await readText(files, "/docs/index.md"));
```

### Durable Objects and D1

```typescript
import { D1SqlDriver, DoSqlDriver, SqlarFilesApi } from "@statewalker/webrun-files-sqlar";

// Inside a Durable Object
const files = new SqlarFilesApi(new DoSqlDriver(this.ctx.storage.sql));

// With a D1 binding
const shared = new SqlarFilesApi(new D1SqlDriver(env.DB));
```

Any other SQLite binding works through the `SqlDriver` port:

```typescript
interface SqlDriver {
  all<T>(sql: string, ...params: unknown[]): T[] | Promise<T[]>;
  run(sql: string, ...params: unknown[]): void | Promise<void>;
}
```

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

## How entries are stored

| Entry | `name` | `sz` | `data` |
| --- | --- | --- | --- |
| File | `docs/index.md` (no leading slash) | byte length | plaintext, or deflated when strictly shorter |
| Empty file | | `0` | zero-length blob |
| Directory | | `0` | `NULL` |
| Symlink | | `-1` | target as text |

`mtime` is stored in seconds; `lastModified` reports it in milliseconds. Archives written by other
tools without directory rows still behave as trees: a path that is only a prefix of other names is a
directory.

### Symlinks

`FileKind` has no symlink, so `stats`, `exists`, `read` and `list` follow links the way POSIX
`stat()` does. A dangling link, or a chain of more than 8, behaves as a missing path. `remove`,
`copy` and `move` act on the link itself. Two extension methods give access to links:

```typescript
await files.symlink("/latest.js", "./v2/index.js");
await files.readlink("/latest.js"); // "./v2/index.js"
```

## Limitations

- A file is one blob: `write` buffers its content, `read` inflates it whole and yields one chunk.
- Multi-row mutations (`copy`, `move`, `remove` of a tree) are not wrapped in a transaction.
- Only the final path component is resolved through symlinks.

## License

MIT
