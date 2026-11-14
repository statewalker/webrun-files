# @statewalker/webrun-files-node

## What it is

`NodeFilesApi`, an implementation of `FilesApi` from `@statewalker/webrun-files` over Node.js
`fs/promises`. Virtual paths (`/users/alice.json`) are mapped to real files under a root directory.

## Why it exists

Server code, CLIs and tests that work against `FilesApi` need a backend that stores real files on
disk. With this package the same code that runs on `MemFilesApi` in tests, or on S3 in production,
reads and writes a local directory.

## How to use

```bash
pnpm add @statewalker/webrun-files-node @statewalker/webrun-files
```

One entry point, `@statewalker/webrun-files-node`: ESM (`dist/esm/index.js`), CommonJS
(`dist/cjs/index.cjs`), types (`dist/index.d.ts`); sources in `src/`. Node.js only (it imports
`node:fs/promises`).

```typescript
import { NodeFilesApi, type NodeFilesApiOptions } from '@statewalker/webrun-files-node';

const files = new NodeFilesApi({ rootDir: '/var/app/data' }); // rootDir defaults to process.cwd()
```

```
rootDir:      /var/app/data
virtual path: /users/alice.json
real path:    /var/app/data/users/alice.json
```

## Examples

### Read, write, list

```typescript
import { NodeFilesApi } from '@statewalker/webrun-files-node';
import { readText, writeText } from '@statewalker/webrun-files';

const files = new NodeFilesApi({ rootDir: '/var/app/data' });

await writeText(files, '/deep/nested/config.json', '{"debug": true}'); // parents are created
console.log(await readText(files, '/deep/nested/config.json'));

for await (const entry of files.list('/', { recursive: true })) {
  console.log(entry.path, entry.kind, entry.kind === 'file' ? entry.size : '');
}
```

### Stream a range

```typescript
for await (const chunk of files.read('/large-file.bin', { start: 1000, length: 500 })) {
  // bytes 1000-1499, in chunks of at most 8 KiB
}
```

### A temporary directory per test

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFilesApi } from '@statewalker/webrun-files-node';

const rootDir = await mkdtemp(join(tmpdir(), 'test-'));
const files = new NodeFilesApi({ rootDir });
try {
  // ...
} finally {
  await rm(rootDir, { recursive: true, force: true });
}
```

## Internals

### How each call maps to `fs`

| Call | Implementation |
| --- | --- |
| `read` | `fs.open` + positioned `handle.read` in 8 KiB buffers, only the requested range |
| `write` | `fs.mkdir(parent, { recursive: true })`, then streams the chunks (batched to 64 KiB) into a temporary `.webrun-tmp-<random>` beside the file and renames it over the file |
| `list` | `fs.readdir` + `fs.stat` per entry, walked through `listInPathOrder` |
| `move` | `fs.rename` after creating the target's parent |
| `copy` | `fs.cp(..., { recursive: true })` |
| `remove` | `fs.rm(..., { recursive: true, force: true })` for a directory, `fs.unlink` for a file |

### Why listings stat every entry

`readdir` returns names in no guaranteed order, and every `FilesApi` must list in `comparePaths`
order with `after` support. `list()` therefore reads each directory, stats its entries and yields
them sorted. A recursive listing reads a directory only when the listing reaches it, and skips any
directory whose whole subtree sorts at or before `after`.

### What breaks, and how it looks

- **A path that leaves `rootDir` is refused.** `..` segments are resolved against `rootDir`; when
  the result is outside it, the call throws
  `NodeFilesApi: path is outside rootDir: /../etc/passwd` (reads throw when iterated). `..` that
  stays inside (`/a/../b.txt`) is fine. Symbolic links inside `rootDir` are followed as the
  operating system follows them, so a link pointing out of `rootDir` still leads out.
- **`write` streams, and replaces the file at the end.** Memory stays at about two batches of
  64 KiB plus one chunk. Until the rename the old file stays readable, and a source that fails leaves it
  unchanged. A read-only file is refused, as an in-place write was. Replacing keeps the old
  file's permission bits (not setuid/setgid, which a write would clear) and writes through a
  symbolic link to its target (a dangling link is replaced by a regular file, and a link out of
  `rootDir` is written there, with its temporary beside the target); a hard link is replaced,
  not written through, and the owner, ACLs and extended
  attributes are those of a new file. The temporary needs write permission on the directory.
  `list` hides the temporaries (files named exactly `.webrun-tmp-` plus 16 hex digits); a crash
  can leave one behind, still visible to `exists`, `stats` and `read`. A caller that reuses
  a chunk's buffer after yielding it may change what is written (up to 64 KiB is held before
  each write). Reads stream.
- **`move` across devices returns `false`.** It is a single `fs.rename`; when that fails (`EXDEV`,
  permissions) the method returns `false` instead of falling back to copy and delete.
- **Unreadable reads look like missing files.** `read` swallows every error (missing file,
  permission denied, a directory) and yields nothing; `copy` and `move` return `false`.

### Dependencies

`@statewalker/webrun-files` for the types and path helpers; Node.js built-ins otherwise.

## License

MIT
