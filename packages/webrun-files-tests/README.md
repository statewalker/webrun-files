# @statewalker/webrun-files-tests

Shared test suites for `FilesApi` implementations. Every backend in this repository runs them; use
them to check that a custom backend follows the interface contract.

This package is private to the monorepo (`"private": true`) and is consumed through
`workspace:*`. Its suites are Vitest suites: `vitest` is a peer dependency.

## Test suites

### `createFilesApiTests` — the interface contract

```typescript
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { MyCustomFilesApi } from "./my-custom-files-api";

createFilesApiTests("MyCustomFilesApi", async () => {
  const api = new MyCustomFilesApi();
  return {
    api,
    cleanup: async () => {
      await api.clear();
    },
  };
});
```

The factory runs before each test, so every test gets a fresh, isolated instance. One call
registers 77 tests: 57 covering every `FilesApi` method, plus the 12 of
`createFileStatsConformanceTests` and the 8 of `createListOrderTests` (both below), which it always
includes.

| Category | Tests | What's covered |
|----------|-------|----------------|
| write() and read() | 9 | Small text, empty files, multiple chunks, async iterables, overwrite, nested dirs, binary/null bytes, a 1 MB file, Unicode |
| read() with options | 6 | Start position, length, ranges, length 0, start beyond the file, length clamped to the file |
| stats() | 5 | File stats, directory stats, non-existent paths, size after overwrite, root directory |
| exists() | 4 | Existing files/directories, non-existent paths, after removal |
| list() | 7 | Direct children, no duplicates, kind and path, recursive listing, non-existent directory, a file path, the root |
| remove() | 4 | Files, directories (recursive), non-existent paths, siblings untouched |
| copy() | 4 | Files, directories (recursive), non-existent source, overwrite |
| move() | 3 | Files, directories, non-existent source |
| mkdir() | 3 | Single directory, nested directories, idempotency |
| Path handling | 6 | Double slashes, missing leading slash, trailing slashes, dot segments, special characters, long paths |
| Concurrent operations | 3 | Parallel writes, reads and listings |
| Error handling | 3 | Reading, removing and `stats()` on non-existent paths |

### `createListOrderTests` — listing order and `after`

Every `list()` must yield paths in strictly increasing `comparePaths` order (Unicode code point, i.e.
UTF-8 bytes), and `{ after }` must yield exactly the entries that follow a path. The fixture, under
`/order`, holds names chosen to break naive orderings: `B` (before `a`), `a b.txt`, `a-x` and
`a.txt` (between the directory `a` and its children, since ` `, `-` and `.` sort before `/`),
`é.txt`, and `\uFFFD.txt` before `😀.txt` (a surrogate pair, which `<` puts first).

The 8 tests check:

- the non-recursive listing is exactly the expected sequence, directories included;
- the recursive listing is strictly increasing and holds every file in place (which directories a
  recursive listing includes is left to the backend: S3 has none);
- for each listing mode, resuming after every entry yields exactly the rest;
- for each mode, cursors that are not entries — between entries, before the directory, past it, and
  unnormalised ones like `/order/./z` — yield exactly the entries after them;
- paging in chunks of three with `after` reassembles the full listing;
- the root lists in order.

### `createFileStatsConformanceTests` — the `FileStats` union

`FileStats` is a discriminated union on `kind`. These 12 tests check at runtime that `stats()` and
`list()` return exactly one variant: a file with numeric `size` and `lastModified` and nothing else,
a directory with `kind` alone (no `size`, no `lastModified`), a zero-byte file as a file with
`size: 0`, and `list()` agreeing with `stats()` on every entry. `createFilesApiTests` already runs
them; call this directly only to run them on their own.

### `createBigFilesApiTests` — big files, streamed

```typescript
import { createBigFilesApiTests } from "@statewalker/webrun-files-tests";

createBigFilesApiTests("MyCustomFilesApi", async () => ({ api: new MyCustomFilesApi() }), {
  size: 256 * 1024 * 1024, // default: 256 MiB
  timeout: 10 * 60_000, // per test and for the initial write; default: 10 minutes
});
```

One API instance and one file of `size` bytes are created for the whole suite (`beforeAll`), and
`cleanup` runs once at the end. The suite never holds the file in memory: its content is
`positionByte(offset)`, generated as it is written and checked as it is read. That content does not
compress, so backends that compress are exercised with input that grows.

The file is written in uneven chunks (1 MiB + 7 B, 65 537 B, 3 MiB − 1 B, 4 093 B, cycled) so chunk
boundaries never line up with a backend's own. The 11 tests check:

- the exact size from `stats()`;
- a full read, byte for byte;
- range reads: the first 100 bytes, 64 bytes across each MiB boundary for the first 8 MiB, 1 MiB
  from the middle, the last 1 000 bytes, a length running past the end (clamped), and a start past
  the end (nothing);
- stopping a read after the first chunk, after which the file still reads;
- `copy` of the big file, a range read of the copy, and `remove` of the copy leaving the original;
- overwriting a copy of the big file with 3 bytes.

## Types

```typescript
interface FilesApiTestContext {
  api: FilesApi;
  cleanup?: () => Promise<void>;
}

type FilesApiFactory = () => Promise<FilesApiTestContext>;

interface BigFilesTestContext {
  api: FilesApi;
  cleanup?: () => Promise<void>;
}

type BigFilesApiFactory = () => Promise<BigFilesTestContext>;

interface BigFilesTestOptions {
  size?: number; // bytes; default 256 MiB
  timeout?: number; // ms; default 10 minutes
}
```

## Test utilities

```typescript
import {
  asFileStats, // Narrow a stats()/list() result to the file variant, or throw a readable error
  encode, // string → Uint8Array
  decode, // Uint8Array → string
  toBytes, // alias of encode
  fromBytes, // alias of decode
  collectStream, // async iterable of Uint8Array → one Uint8Array
  collectGenerator, // async iterable → array
  randomBytes, // random binary data
  patternContent, // bytes (i + seed) % 256
  allBytesContent, // the 256 byte values 0–255
  positionByte, // the big-file content byte at an offset (a hash of the offset)
  positionContent, // lazy async generator of positionByte content, in given chunk sizes
} from "@statewalker/webrun-files-tests";
```

`positionContent(size, chunkSizes = [64 KiB], start = 0)` yields `size` bytes starting at offset
`start`, creating each chunk only when it is pulled — useful for streaming and backpressure tests.

## Examples

### Node.js backend

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { createFilesApiTests } from "@statewalker/webrun-files-tests";

createFilesApiTests("NodeFilesApi", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "files-test-"));
  return {
    api: new NodeFilesApi({ rootDir }),
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
});
```

### In-memory backend

```typescript
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createBigFilesApiTests, createFilesApiTests } from "@statewalker/webrun-files-tests";

createFilesApiTests("MemFilesApi", async () => ({ api: new MemFilesApi() }));
createBigFilesApiTests("MemFilesApi", async () => ({ api: new MemFilesApi() }));
```

Keep `createBigFilesApiTests` in its own test file (this repository uses `tests/big-files.test.ts`):
Vitest runs test files in parallel, and a 256 MiB suite competes for CPU and memory.

## License

MIT
