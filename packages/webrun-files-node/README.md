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
| `write` | `fs.mkdir(parent, { recursive: true })`, then collects every chunk and calls `fs.writeFile` once |
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
- **`write` holds the whole file in memory** before writing it, so a very large upload costs its
  full size in RAM. Reads stream.
- **`move` across devices returns `false`.** It is a single `fs.rename`; when that fails (`EXDEV`,
  permissions) the method returns `false` instead of falling back to copy and delete.
- **Unreadable reads look like missing files.** `read` swallows every error (missing file,
  permission denied, a directory) and yields nothing; `copy` and `move` return `false`.

### Dependencies

`@statewalker/webrun-files` for the types and path helpers; Node.js built-ins otherwise.

## License

MIT
