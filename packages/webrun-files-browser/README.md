# @statewalker/webrun-files-browser

Browser File System Access API implementation of the `FilesApi` interface from `@statewalker/webrun-files`.

## Overview

This package provides a `FilesApi` implementation that works in modern browsers using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). It allows web applications to read and write files to:

- **User-selected directories** via `showDirectoryPicker()`
- **Origin Private File System (OPFS)** - a sandboxed filesystem that persists between sessions

## Installation

```bash
npm install @statewalker/webrun-files-browser @statewalker/webrun-files
```

## Usage

### With User-Selected Directory

```typescript
import { openBrowserFilesApi } from '@statewalker/webrun-files-browser';
import { readText, writeText } from '@statewalker/webrun-files';

// Opens a directory picker dialog (requires user gesture)
const files = await openBrowserFilesApi();

// Write a file
await writeText(files, '/notes/hello.txt', 'Hello, World!');

// Read a file
const content = await readText(files, '/notes/hello.txt');
console.log(content); // "Hello, World!"

// List directory contents
for await (const entry of files.list('/notes')) {
  console.log(entry.name, entry.kind);
}
```

### With Persistent Directory Handle

Persist the directory handle using IndexedDB (via `idb-keyval` or similar) to avoid prompting the user every time:

```typescript
import { openBrowserFilesApi } from '@statewalker/webrun-files-browser';
import { get, set, del } from 'idb-keyval';

// Opens directory picker if no stored handle, otherwise reuses stored one
const files = await openBrowserFilesApi({
  handlerKey: 'my-project-dir',  // Key for storing the handle
  readwrite: true,               // Request read-write access
  get,                           // Retrieve stored handle
  set,                           // Store the handle
  del,                           // Delete stored handle if inaccessible
});
```

### With Origin Private File System (OPFS)

OPFS provides a sandboxed filesystem that doesn't require user interaction:

```typescript
import { getOPFSFilesApi } from '@statewalker/webrun-files-browser';
import { writeText } from '@statewalker/webrun-files';

// No user gesture required
const files = await getOPFSFilesApi();

// Use the same API
await writeText(files, '/data/config.json', '{"theme": "dark"}');
```

### With Custom Directory Handle

Create a `BrowserFilesApi` instance with any `FileSystemDirectoryHandle`:

```typescript
import { BrowserFilesApi } from '@statewalker/webrun-files-browser';

// Get a directory handle from drag & drop, IndexedDB, etc.
const directoryHandle = await getDirectoryHandleSomehow();

const files = new BrowserFilesApi({ rootHandle: directoryHandle });
```

## API Reference

### BrowserFilesApi

Main class implementing `FilesApi` for browser environments.

```typescript
interface BrowserFilesApiOptions {
  rootHandle: FileSystemDirectoryHandle;
}

class BrowserFilesApi implements FilesApi {
  constructor(options: BrowserFilesApiOptions);

  // All FilesApi methods
  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array>;
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo>;
  stats(path: string): Promise<FileStats | undefined>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  move(source: string, target: string): Promise<boolean>;
  copy(source: string, target: string): Promise<boolean>;
}
```

### Helper Functions

```typescript
// Opens a directory picker and returns a BrowserFilesApi instance
function openBrowserFilesApi(options?: OpenBrowserFilesApiOptions): Promise<BrowserFilesApi>;

interface OpenBrowserFilesApiOptions {
  handlerKey?: string;  // Key for storing the handle (default: "root-dir")
  readwrite?: boolean;  // Request read-write access (default: true)
  get?: (key: string) => Promise<FileSystemDirectoryHandle | undefined>;
  set?: (key: string, handler: FileSystemDirectoryHandle) => Promise<void>;
  del?: (key: string) => Promise<void>;
}

// Returns a BrowserFilesApi backed by the Origin Private File System
function getOPFSFilesApi(): Promise<BrowserFilesApi>;

// Checks if a file system handle is still accessible
function isHandlerAccessible(
  fileHandle: FileSystemFileHandle | FileSystemDirectoryHandle
): Promise<boolean>;

// Verifies and requests file system permissions for a handle
function verifyPermission(
  fileHandle: FileSystemFileHandle | FileSystemDirectoryHandle,
  readWrite?: boolean  // default: false
): Promise<boolean>;
```

## Browser Support

The File System Access API is supported in:

- Chrome/Edge 86+
- Opera 72+
- Chrome for Android 86+

For other browsers, you may need a polyfill like [native-file-system-adapter](https://github.com/jimmywarting/native-file-system-adapter).

## Security Considerations

- **User gesture required**: `showDirectoryPicker()` must be called from a user gesture (click, key press)
- **Secure context**: The API only works in secure contexts (HTTPS or localhost)
- **Permission prompts**: Users must grant permission to access directories
- **OPFS isolation**: Origin Private File System is isolated per-origin and not accessible to the user

## Permission and Accessibility Utilities

When working with persistent directory handles:

```typescript
import { verifyPermission, isHandlerAccessible } from '@statewalker/webrun-files-browser';

// Check if we have read-write permission
const hasPermission = await verifyPermission(directoryHandle, true);

// Check if the directory still exists and is accessible
const isAccessible = await isHandlerAccessible(directoryHandle);

if (!hasPermission) {
  console.log('Permission denied - user may need to re-grant access');
}

if (!isAccessible) {
  console.log('Directory no longer accessible - may have been deleted or moved');
}
```

## Testing

For testing in Node.js environments, use [native-file-system-adapter](https://github.com/jimmywarting/native-file-system-adapter) which provides a memory backend:

```typescript
import { getOriginPrivateDirectory } from 'native-file-system-adapter';
// @ts-expect-error - no type declarations
import * as driver from 'native-file-system-adapter/src/adapters/memory.js';
import { BrowserFilesApi } from '@statewalker/webrun-files-browser';

const rootHandle = await getOriginPrivateDirectory(driver);
const files = new BrowserFilesApi({ rootHandle });
```

## License

MIT
