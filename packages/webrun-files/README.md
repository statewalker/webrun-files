# @statewalker/webrun-files

## What it is

The `FilesApi` interface for file storage, its metadata types, and helpers that work on any
implementation: whole-file and range reads, text writes, path manipulation, and the listing order
every implementation follows. It contains no storage backend.

## Why it exists

Code that reads and writes files should not care whether the files live in memory, on disk, in a
browser directory, in S3, in SQLite or behind an HTTP endpoint. This package is the contract those
backends implement, so application code, tests and decorators are written once against it. Keeping
it backend-free means depending on it pulls in nothing runtime-specific.

Backends: `@statewalker/webrun-files-mem`, `-node`, `-browser`, `-s3`, `-sqlite`, `-http`; mounts,
guards and layers: `@statewalker/webrun-files-composite`.

## How to use

```bash
pnpm add @statewalker/webrun-files
```

One entry point, `@statewalker/webrun-files`: ESM (`dist/esm/index.js`), CommonJS
(`dist/cjs/index.cjs`), types (`dist/index.d.ts`); the TypeScript sources ship in `src/`. It has no
runtime-specific imports and runs in browsers, workers and Node.js.

```typescript
interface FilesApi {
  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array>; // missing path: yields nothing
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>; // creates parents
  mkdir(path: string): Promise<void>;                                     // creates parents
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo>;     // in path order
  stats(path: string): Promise<FileStats | undefined>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;                                 // recursive
  move(source: string, target: string): Promise<boolean>;
  copy(source: string, target: string): Promise<boolean>;                 // recursive
}

interface ReadOptions { start?: number; length?: number; signal?: AbortSignal }
interface ListOptions { recursive?: boolean; after?: string }
```

## Examples

### Read and write whole files

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readFile, readText, tryReadText, writeText } from '@statewalker/webrun-files';

const files = new MemFilesApi();
await writeText(files, '/documents/notes.txt', 'Remember to water the plants');

const bytes = await readFile(files, '/documents/notes.txt'); // Uint8Array
const text = await readText(files, '/documents/notes.txt');  // UTF-8 string
const maybe = await tryReadText(files, '/optional.txt');     // undefined when missing

// Binary content goes straight to write(), as chunks
await files.write('/data.bin', [new Uint8Array([1, 2, 3, 4])]);
```

`readFile` and `readText` return an empty result for a missing path; `tryReadFile` and
`tryReadText` return `undefined` instead.

### Random access

```typescript
import { readAt, readRange } from '@statewalker/webrun-files';

const chunk = await readRange(files, '/large.bin', 1000, 500); // 500 bytes from position 1000

// Like fs.read: (files, path, buffer, bufferOffset, length, position) -> bytes read
const buffer = new Uint8Array(100);
const bytesRead = await readAt(files, '/data.bin', buffer, 0, 100, 500);
```

### Metadata: narrow on `kind`

```typescript
const info = await files.stats('/photo.jpg');
if (info?.kind === 'file') {
  console.log(info.size, new Date(info.lastModified)); // both always present
} else if (info?.kind === 'directory') {
  console.log('a directory');                           // nothing else to report
}
```

### List a directory in pages

```typescript
import type { FileInfo } from '@statewalker/webrun-files';

let after: string | undefined;
for (;;) {
  const page: FileInfo[] = [];
  for await (const entry of files.list('/data', { recursive: true, after })) {
    page.push(entry);
    if (page.length === 256) break;
  }
  if (page.length === 0) break;
  await handle(page);
  after = page[page.length - 1].path;
}
```

### Paths

```typescript
import { basename, dirname, extname, joinPath, normalizePath } from '@statewalker/webrun-files';

normalizePath('//foo/./bar//baz/');  // '/foo/bar/baz'
joinPath('/foo', 'bar', 'baz.txt');  // '/foo/bar/baz.txt'
dirname('/foo/bar/baz.txt');         // '/foo/bar'
basename('/foo/bar/baz.txt');        // 'baz.txt'
basename('/foo/bar/baz.txt', '.txt'); // 'baz'
extname('/foo/bar/baz.txt');         // '.txt'
```

### Listing helpers for backend authors

```typescript
import { comparePaths, listInPathOrder, mergeInPathOrder } from '@statewalker/webrun-files';

comparePaths(a, b); // the listing order: negative, zero or positive

// children(dir) returns one directory's direct entries, in any order. The generator reads a
// directory only when the listing reaches it, and skips any subtree that sorts at or before `after`.
listInPathOrder('/', children, { recursive: true, after });

// Merge listings that are each already ordered; the first stream wins a shared path.
mergeInPathOrder([streamA, streamB]);
```

### Types

```typescript
import type {
  FilesApi,
  FileStats,           // FileEntryStats | DirectoryEntryStats
  FileEntryStats,      // { kind: "file"; size: number; lastModified: number }
  DirectoryEntryStats, // { kind: "directory" }
  FileInfo,            // FileEntryInfo | DirectoryEntryInfo
  FileEntryInfo,       // FileEntryStats & FileEntryLocation
  DirectoryEntryInfo,  // DirectoryEntryStats & FileEntryLocation
  FileEntryLocation,   // { name: string; path: string }
  FileKind,            // "file" | "directory"
  ReadOptions,
  ListOptions,
} from '@statewalker/webrun-files';
```

## Internals

### Why metadata is a union and not optional fields

A file always reports `size` and `lastModified`. A directory reports neither: it has no size, and
on stores where a directory is only a key prefix there is no modification time to give. An
implementation that knows a directory's time drops it, so callers cannot come to rely on a field
that one backend has and the next lacks. A zero-byte file is the file variant with `size: 0`:

```typescript
if (info.size) { /* WRONG: treats an empty file as having no size */ }
if (info.kind === 'file') { /* RIGHT: info.size may be 0 */ }
```

### Why listings have one global order

Every implementation yields `list()` entries in strictly increasing path order, compared by Unicode
code point. That is UTF-8 byte order, which SQLite and S3 already list in, so those backends can
page through their native listings. `ListOptions.after` resumes after any path, present or not, so
a client can read a large or remote listing in chunks without an open iterator.

Two consequences:

- A directory comes before its descendants, but they are not contiguous with it: `/a-x` and
  `/a.txt` sort between `/a` and `/a/b`, because `-` and `.` sort before `/`.
- JavaScript's `<` compares UTF-16 code units and misorders characters above U+FFFF. Use
  `comparePaths`.

### What a backend must do

- Return exactly one metadata variant: a file with both numbers, a directory with only `kind`.
- List in the order above and honour `after` exactly: the entries after a path are the same, in
  the same order, as the matching suffix of the full listing.

The shared suites in `@statewalker/webrun-files-tests` (a private workspace package) check both at
runtime. `listInPathOrder` gives both properties to a backend that can read one directory at a
time.

### Path rules

`normalizePath` splits on `/`, drops empty and `.` segments and returns a path with one leading
slash and no trailing slash (`/` for the root). It does not resolve `..`; backends that map paths
to real locations (such as `webrun-files-node`) document what that means for them.

### Dependencies

None at runtime.

## License

MIT
