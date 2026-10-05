# @statewalker/webrun-files-mem

## What it is

`MemFilesApi`, an implementation of `FilesApi` from `@statewalker/webrun-files` that keeps every
file and directory in a `Map` in memory. Nothing persists after the instance is dropped.

## Why it exists

Tests, prototypes and short-lived caches need a file system that starts empty (or pre-filled),
needs no disk, no cleanup and no permissions, and behaves like every other backend. Because it
passes the same shared test suites as the Node, browser, S3 and SQLite backends, code tested
against it behaves the same when the backend is swapped.

## How to use

```bash
pnpm add @statewalker/webrun-files-mem @statewalker/webrun-files
```

One entry point, `@statewalker/webrun-files-mem`: ESM (`dist/esm/index.js`), CommonJS
(`dist/cjs/index.cjs`), types (`dist/index.d.ts`); sources in `src/`. Runs anywhere: browsers,
workers, Node.js.

```typescript
import { MemFilesApi, type MemFilesApiOptions } from '@statewalker/webrun-files-mem';

const files = new MemFilesApi(); // or new MemFilesApi({ initialFiles: { ... } })
```

`MemFilesApiOptions` has one field, `initialFiles?: Record<string, string | Uint8Array>`: paths
mapped to content. Strings are encoded as UTF-8; parent directories are created.

## Examples

### Write, read, list

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readText, writeText } from '@statewalker/webrun-files';

const files = new MemFilesApi();
await writeText(files, '/config.json', '{"debug": true}');
console.log(await readText(files, '/config.json')); // {"debug": true}

for await (const entry of files.list('/')) {
  if (entry.kind === 'file') console.log(entry.name, entry.size, entry.lastModified);
  else console.log(entry.name, 'directory'); // directories carry no size or time
}
```

### Start with files

```typescript
const files = new MemFilesApi({
  initialFiles: {
    '/config.json': '{"theme": "dark"}',
    '/data/users.json': '[{"id": 1, "name": "Alice"}]',
    '/data/binary.bin': new Uint8Array([0x00, 0x01, 0x02, 0x03]),
  },
});
```

### A fresh file system per test

```typescript
import { beforeEach, expect, it } from 'vitest';
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readText, writeText } from '@statewalker/webrun-files';

let files: MemFilesApi;
beforeEach(() => {
  files = new MemFilesApi({ initialFiles: { '/config.json': '{"version": 1}' } });
});

it('updates the config', async () => {
  await writeText(files, '/config.json', '{"version": 2}');
  expect(JSON.parse(await readText(files, '/config.json')).version).toBe(2);
});
```

## Internals

### One map of normalized paths

Each entry is keyed by its normalized path and is either a file (its bytes and a timestamp) or a
directory. `write` collects all chunks and stores one `Uint8Array`; `read` yields one chunk, a
`subarray` of the stored bytes clipped to `start`/`length`.

### What it costs, and what to watch

- **`list()` scans every entry.** Each call walks the whole map, keeps the entries under the
  directory, sorts them with `comparePaths` and then applies `after`. Cost grows with the total
  number of entries, not with the size of the listed directory.
- **Shared buffers.** A `Uint8Array` passed in `initialFiles` is stored as is, and the chunk
  `read()` yields is a view of the stored bytes. Mutating either changes the stored file. Copy
  first if you need to modify them.
- **`move` is copy then remove**, in memory, so it is cheap but not atomic against concurrent
  calls on the same instance.
- Everything lives in the JavaScript heap; a large file costs its size in memory.

### Dependencies

`@statewalker/webrun-files` only, for the types, `normalizePath`, `basename` and `comparePaths`.

## License

MIT
