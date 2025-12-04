# @statewalker/webrun-files-browser

Browser File System Access API implementation for the `@statewalker/webrun-files` package.

## Overview

This package provides an `IFilesApi` implementation that works in modern browsers using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). It allows web applications to read and write files to:

- **User-selected directories** via `showDirectoryPicker()`
- **Origin Private File System (OPFS)** - a sandboxed filesystem that persists between sessions

## Installation

```bash
npm install @statewalker/webrun-files-browser @statewalker/webrun-files
```

## Usage

### With User-Selected Directory

```typescript
import { openBrowserFilesApi } from "@statewalker/webrun-files-browser";
import { FilesApi } from "@statewalker/webrun-files";

// Opens a directory picker dialog (requires user gesture)
const browserFs = await openBrowserFilesApi();
const api = new FilesApi(browserFs);

// Write a file
await api.write("/notes/hello.txt", [
  new TextEncoder().encode("Hello, World!")
]);

// Read a file
const content = await api.readFile("/notes/hello.txt");
console.log(new TextDecoder().decode(content)); // "Hello, World!"

// List directory contents
for await (const entry of api.list("/notes")) {
  console.log(entry.name, entry.kind);
}
```

### With Origin Private File System (OPFS)

OPFS provides a sandboxed filesystem that doesn't require user interaction:

```typescript
import { getOPFSFilesApi } from "@statewalker/webrun-files-browser";
import { FilesApi } from "@statewalker/webrun-files";

// No user gesture required
const opfsFs = await getOPFSFilesApi();
const api = new FilesApi(opfsFs);

// Use the same API as above
await api.write("/data/config.json", [
  new TextEncoder().encode('{"theme": "dark"}')
]);
```

### With Custom Directory Handle

You can also create a `BrowserFilesApi` instance with any `FileSystemDirectoryHandle`:

```typescript
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";
import { FilesApi } from "@statewalker/webrun-files";

// Get a directory handle from drag & drop, IndexedDB, etc.
const directoryHandle = await getDirectoryHandleSomehow();

const browserFs = new BrowserFilesApi({ rootHandle: directoryHandle });
const api = new FilesApi(browserFs);
```

## API Reference

### BrowserFilesApi

Main class implementing `IFilesApi` for browser environments.

```typescript
interface BrowserFilesApiOptions {
  rootHandle: FileSystemDirectoryHandle;
}

class BrowserFilesApi implements IFilesApi {
  constructor(options: BrowserFilesApiOptions);

  // Core IFilesApi methods
  list(file: FileRef, options?: ListOptions): AsyncGenerator<FileInfo>;
  stats(file: FileRef): Promise<FileInfo | undefined>;
  remove(file: FileRef): Promise<boolean>;
  open(file: FileRef): Promise<FileHandle>;

  // Optional methods (implemented)
  mkdir(file: FileRef): Promise<void>;
  move(source: FileRef, target: FileRef): Promise<boolean>;
  copy(source: FileRef, target: FileRef, options?: CopyOptions): Promise<boolean>;
}
```

### BrowserFileHandle

File handle class for random access read/write operations.

```typescript
class BrowserFileHandle implements FileHandle {
  readonly size: number;

  close(): Promise<void>;
  appendFile(data: BinaryStream, options?: AppendOptions): Promise<number>;
  createReadStream(options?: ReadStreamOptions): AsyncGenerator<Uint8Array>;
  createWriteStream(data: BinaryStream, options?: WriteStreamOptions): Promise<number>;
}
```

### Helper Functions

```typescript
// Opens a directory picker and returns a BrowserFilesApi instance
function openBrowserFilesApi(): Promise<BrowserFilesApi>;

// Returns a BrowserFilesApi backed by the Origin Private File System
function getOPFSFilesApi(): Promise<BrowserFilesApi>;
```

## How It Works

### Directory Navigation

The implementation navigates the filesystem by traversing `FileSystemDirectoryHandle` entries. Paths like `/docs/notes/file.txt` are resolved by getting directory handles step by step:

```
root → "docs" → "notes" → "file.txt"
```

### Reading Files

Files are read using `File.slice()` for efficient partial reads. This enables random access without loading the entire file into memory:

```typescript
const handle = await api.open("/large-file.bin");
// Read only bytes 1000-2000
for await (const chunk of handle.createReadStream({ start: 1000, end: 2000 })) {
  console.log(chunk);
}
await handle.close();
```

### Writing Files

Writes use `FileSystemWritableFileStream`:

- **Full writes** create a new writable stream and write all data
- **Partial writes** (with `start` option) preserve content before the start position
- **Appends** seek to the end of the file before writing

### Directory Creation

Directories are created automatically when writing files. You can also create empty directories:

```typescript
await api.mkdir("/path/to/new/directory");
```

## Browser Support

The File System Access API is supported in:

- Chrome/Edge 86+
- Opera 72+
- Chrome for Android 86+

For other browsers, you may need a polyfill like [native-file-system-adapter](https://github.com/nicolo-ribaudo/native-file-system-adapter).

## Security Considerations

- **User gesture required**: `showDirectoryPicker()` must be called from a user gesture (click, key press)
- **Secure context**: The API only works in secure contexts (HTTPS or localhost)
- **Permission prompts**: Users must grant permission to access directories
- **OPFS isolation**: Origin Private File System is isolated per-origin and not accessible to the user

## Testing

For testing in Node.js environments, we use [native-file-system-adapter](https://github.com/jimmywarting/native-file-system-adapter) which provides a memory backend:

```typescript
import { getOriginPrivateDirectory } from "native-file-system-adapter";
import { BrowserFilesApi } from "@statewalker/webrun-files-browser";

const rootHandle = await getOriginPrivateDirectory(
  import("native-file-system-adapter/src/adapters/memory.js")
);

const api = new BrowserFilesApi({ rootHandle });
```

## License

MIT
