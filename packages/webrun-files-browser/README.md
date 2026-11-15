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
| `new BrowserFilesApi({ rootHandle, lockScope? })` | A `FilesApi` over any `FileSystemDirectoryHandle`; `lockScope` names a directory outside OPFS in `createExclusive`'s locks |
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

### A lock file shared by every tab

```typescript
const files = await getOPFSFilesApi();

if (await files.createExclusive('/repo/.git/index.lock', [new TextEncoder().encode('locked')])) {
  try {
    // ... no other tab or worker of this origin gets here meanwhile
  } finally {
    await files.remove('/repo/.git/index.lock');
  }
}
```

The File System Access API cannot create a file only if it is absent, so `createExclusive` runs
the check and the create under a Web Lock (`navigator.locks`) named after the file. Every tab and
worker of the origin that calls `createExclusive` for that file asks for the same lock, with
`ifAvailable`: the one that gets it creates the file, and any call that finds it held returns
`false` at once, without waiting for the holder to finish writing.

The lock has to name the file the same way in every tab and every instance. Under an OPFS root it
is named by the file's full path in OPFS, `webrun-files:opfs:/repo/.git/index.lock`, so an
instance rooted at OPFS `/repo` locking `/.git/index.lock` and one rooted at OPFS `/` locking
`/repo/.git/index.lock` take the same lock. A directory from `showDirectoryPicker()` or a drop
has no such name, so the lock falls back to the handle object, which only instances built on that
very object share; two tabs that each obtained the handle exclude each other only by the
existence check, which can race. Give both the same `lockScope` (it is ignored under OPFS):

```typescript
const files = new BrowserFilesApi({ rootHandle: handle, lockScope: 'project:my-repo' });
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
- `createExclusive` asks for the Web Lock `webrun-files:opfs:<full OPFS path>` (under an OPFS
  root) or `webrun-files:<lockScope or handle id>:<path>` (elsewhere) in `exclusive` mode with
  `ifAvailable: true`, and returns `false` if it is held. Holding it, it looks for a file or
  directory of that name with `getFileHandle` / `getDirectoryHandle` (no `create`) and, if there
  is none, creates the parents and writes the file as `write` does.
- `remove` is `removeEntry(name, { recursive: true })` on the parent.
- `move` first checks an existing target as `rename(2)` would: a file replaces a file and a
  directory an empty directory; a file onto a directory, a directory onto a file or a non-empty
  directory, or a directory into its own subtree returns `false` and changes source and target
  not at all (the target's parent directories, created first, may be left even then). It then uses
  the native `FileSystemHandle.move()` where it exists (Chromium 110+), which renames in place
  without copying and is atomic in OPFS; current Chromium replaces an existing file. The target
  check and the native move are separate steps, so another writer can change the target in
  between; the native move then decides on its own. Without native move, or when it reports the
  move unsupported (`TypeError`, `NotSupportedError`) or refuses an existing target
  (`InvalidModificationError` on older versions), `move` copies then removes, which
  is not atomic: a file is copied through a writable stream, so the target's content is swapped
  in one step on close; a directory is copied file by file. If the source cannot be removed after
  the copy, the removal is retried once, then `move` throws a `MoveIncompleteError`
  (`move /a -> /b: the target was replaced, but the source could not be removed`): the target
  already holds the new content and the source still exists. It never returns `false` for a
  half-done move. Any other native error (`NoModificationAllowedError` for a locked entry,
  `NotAllowedError`, ...) is rethrown, except that a native move which throws after the source
  has already moved (the source is gone, the target exists) counts as done and returns `true`.

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
- **A failed write keeps the old file.** If the content iterable throws midway, `write` aborts
  the writable stream (its swap file is dropped), so the previous content stays, and a file the
  write created is removed again.
- **Without Web Locks, exclusion stops at the realm.** Where `navigator.locks` is missing (Node.js
  before 24 with a polyfilled handle, some test adapters), an in-memory lock per lock name
  stands in: calls in the same JavaScript realm still exclude each other (a call that finds the
  lock held returns `false` at once), other tabs or workers only through the existence check.
- **A held lock means `false`.** A call that finds another call holding the lock returns `false`
  without waiting. If that other call's content then fails, the path ends up free even though
  this call reported it taken.
- **`createExclusive` excludes only itself.** A plain `write` to the path, from this or another
  tab, does not take the lock. While the content is written the file exists and reads as empty;
  a source that fails removes it again.
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
