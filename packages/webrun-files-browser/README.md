# @statewalker/webrun-files-browser

## What it is

`BrowserFilesApi`, an implementation of `FilesApi` from `@statewalker/webrun-files` over a
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
directory handle, plus helpers to obtain one: a user-picked directory (with optional persistence
of the handle) or the Origin Private File System (OPFS).

## Why it exists

Web apps that edit local projects, or need private persistent storage, get a
`FileSystemDirectoryHandle` from the browser, whose API is handle-based, unordered and full of
permission states. This package turns the handle into the same `FilesApi` the rest of the code
already uses, and wraps the picker, permission and stale-handle checks a real app needs around it.

## How to use

```bash
pnpm add @statewalker/webrun-files-browser @statewalker/webrun-files
```

One entry point, `@statewalker/webrun-files-browser`: ESM (`dist/esm/index.js`), CommonJS
(`dist/cjs/index.cjs`), types (`dist/index.d.ts`); sources in `src/`. Browsers with the File
System Access API; requires a secure context (HTTPS or localhost).

| Export | What it gives |
| --- | --- |
| `new BrowserFilesApi({ rootHandle })` | A `FilesApi` over any `FileSystemDirectoryHandle` |
| `openBrowserFilesApi(options?)` | Reuses a stored handle or shows `showDirectoryPicker()`, checks permission and accessibility |
| `getOPFSFilesApi()` | A `BrowserFilesApi` over `navigator.storage.getDirectory()` |
| `verifyPermission(handle, readWrite = false)` | Queries, then requests, `read` or `readwrite` permission |
| `isHandlerAccessible(handle)` | Whether the handle still points at something readable |

`OpenBrowserFilesApiOptions`:

| Option | Default | |
| --- | --- | --- |
| `handlerKey` | `"root-dir"` | Key under which the handle is stored |
| `readwrite` | `true` | Request read-write (`true`) or read-only access |
| `get(key)` | returns `undefined` | Load a stored handle |
| `set(key, handle)` | no-op | Store a newly picked handle |
| `del(key)` | no-op | Forget a handle that is no longer accessible |

## Examples

### A user-picked directory

```typescript
import { openBrowserFilesApi } from '@statewalker/webrun-files-browser';
import { readText, writeText } from '@statewalker/webrun-files';

// Call from a click handler: showDirectoryPicker() needs a user gesture
const files = await openBrowserFilesApi();

await writeText(files, '/notes/hello.txt', 'Hello, World!');
console.log(await readText(files, '/notes/hello.txt'));
```

### Remember the directory across sessions

```typescript
import { openBrowserFilesApi } from '@statewalker/webrun-files-browser';
import { del, get, set } from 'idb-keyval';

const files = await openBrowserFilesApi({ handlerKey: 'my-project-dir', readwrite: true, get, set, del });
```

### OPFS, no prompt

```typescript
import { getOPFSFilesApi } from '@statewalker/webrun-files-browser';
import { writeText } from '@statewalker/webrun-files';

const files = await getOPFSFilesApi();
await writeText(files, '/data/config.json', '{"theme": "dark"}');
```

### Any handle (drag and drop, IndexedDB)

```typescript
import { BrowserFilesApi, isHandlerAccessible, verifyPermission } from '@statewalker/webrun-files-browser';

if ((await verifyPermission(handle, true)) && (await isHandlerAccessible(handle))) {
  const files = new BrowserFilesApi({ rootHandle: handle });
}
```

### Testing in Node.js

```typescript
import { getOriginPrivateDirectory } from 'native-file-system-adapter';
// @ts-expect-error - no type declarations
import * as driver from 'native-file-system-adapter/src/adapters/memory.js';
import { BrowserFilesApi } from '@statewalker/webrun-files-browser';

const files = new BrowserFilesApi({ rootHandle: await getOriginPrivateDirectory(driver) });
```

This is how the package's own tests run.

## Internals

### How calls map to handles

- `read` slices the `File` from `getFile()` into 8 KiB `arrayBuffer()` reads over the requested range.
- `write` creates parents, then streams every chunk into `createWritable()` and closes it.
- `remove` is `removeEntry(name, { recursive: true })` on the parent.
- `move` uses the native `FileSystemHandle.move()` where it exists (Chromium 110+), which renames
  in place without copying. Without it, or when it throws, `move` copies then removes, which is
  not atomic.

### Why listings read every file

Directory handles enumerate in no defined order, and every `FilesApi` must list in `comparePaths`
order. `list()` reads each directory, calls `getFile()` per file for its size and time, and yields
entries sorted. A recursive listing reads a directory only when the listing reaches it, and skips
subtrees that sort at or before `after`. A large directory costs one `getFile()` per file.

### What breaks, and how it looks

- **`openBrowserFilesApi` throws** `Access was not granted` when the permission prompt is refused,
  and `Cannot access the folder. Please try again.` when a stored handle points at a moved or
  deleted directory (it calls `del(handlerKey)` first, so the next call shows the picker).
- **No user gesture, no picker.** Calling `openBrowserFilesApi()` without a stored handle outside a
  click or key handler rejects with the browser's `SecurityError`.
- **A failed write still commits.** If the content iterable throws midway, `write` closes the
  writable stream in a `finally`, which saves the bytes written so far instead of aborting.
- **Read errors look like missing files.** `read` yields nothing when the handle or file cannot be
  read.

### Browser support

The File System Access API with `showDirectoryPicker()` exists in Chromium-based browsers (Chrome,
Edge, Opera). OPFS (`getOPFSFilesApi`) is more widely available. For other environments, such as
tests, [native-file-system-adapter](https://github.com/jimmywarting/native-file-system-adapter)
provides compatible handles.

### Dependencies

`@statewalker/webrun-files` only. `native-file-system-adapter` is a development dependency for
tests.

## License

MIT
