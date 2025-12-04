# @statewalker/webrun-files

The core filesystem API for cross-platform file operations. This package provides a clean, minimal interface for reading, writing, and managing files that works consistently whether you're running in Node.js or need an in-memory implementation for browsers and testing.

## Installation

```bash
npm install @statewalker/webrun-files
# or
pnpm add @statewalker/webrun-files
```

## Quick Start

The fastest way to get going is to create a `FilesApi` instance with one of the built-in backends. Here's an example using the in-memory implementation:

```typescript
import { FilesApi, MemFilesApi } from '@statewalker/webrun-files';

const files = new FilesApi(new MemFilesApi());

// Write a file
await files.write('/documents/notes.txt', [
  new TextEncoder().encode('Remember to water the plants')
]);

// Read it back
const content = await files.readFile('/documents/notes.txt');
console.log(new TextDecoder().decode(content));
```

For Node.js applications that need to work with the actual filesystem, switch to `NodeFilesApi`:

```typescript
import { FilesApi, NodeFilesApi } from '@statewalker/webrun-files';

const files = new FilesApi(new NodeFilesApi('/path/to/root'));
```

The `NodeFilesApi` constructor accepts an optional root directory path. When provided, all file operations will be relative to this directory, effectively sandboxing the API.

## Working with Files

The `FilesApi` class provides everything you need for common file operations. Writing content is straightforward—just pass an array of `Uint8Array` chunks:

```typescript
const text = new TextEncoder().encode('Hello, World!');
await files.write('/greeting.txt', [text]);
```

Reading comes in two flavors. Use `readFile` when you want the entire contents as a single buffer:

```typescript
const content = await files.readFile('/greeting.txt');
```

For large files, `read` returns an async generator that yields chunks as they come in, keeping memory usage under control:

```typescript
for await (const chunk of files.read('/large-file.bin')) {
  process.stdout.write(chunk);
}
```

You can also read specific portions of a file by specifying start and end positions:

```typescript
for await (const chunk of files.read('/data.bin', { start: 100, end: 200 })) {
  // Only bytes 100-199
}
```

## Managing Files and Directories

Checking whether a file or directory exists is simple:

```typescript
if (await files.exists('/config.json')) {
  // Load configuration
}
```

To get detailed information about a file, use `stats`:

```typescript
const info = await files.stats('/photo.jpg');
if (info) {
  console.log(`Size: ${info.size} bytes`);
  console.log(`Modified: ${new Date(info.lastModified)}`);
  console.log(`Type: ${info.kind}`); // "file" or "directory"
}
```

Listing directory contents returns an async generator of file info objects:

```typescript
for await (const entry of files.list('/documents')) {
  console.log(`${entry.name} (${entry.kind})`);
}
```

Pass `{ recursive: true }` to traverse subdirectories:

```typescript
for await (const entry of files.list('/project', { recursive: true })) {
  console.log(entry.path);
}
```

Creating directories, copying, moving, and deleting all work as you'd expect:

```typescript
await files.mkdir('/archive/2024');
await files.copy('/report.pdf', '/archive/2024/report.pdf');
await files.move('/temp/draft.txt', '/documents/final.txt');
await files.remove('/old-stuff'); // Recursively deletes directories
```

## Low-Level File Handle Operations

When you need fine-grained control over file operations, work directly with file handles. Opening a file gives you a handle that supports reading, writing, and appending at specific positions:

```typescript
const handle = await files.open('/data.bin');

// Get the current file size
console.log(`File is ${handle.size} bytes`);

// Read a specific range
for await (const chunk of handle.createReadStream({ start: 0, end: 100 })) {
  // First 100 bytes
}

// Write at a specific position
await handle.createWriteStream([newData], { start: 50 });

// Append to the end
await handle.appendFile([moreData]);

// Always close when done
await handle.close();
```

## Building Your Own Backend

The `IFilesApi` interface defines the contract that all backends must implement. At minimum, you need four methods:

```typescript
interface IFilesApi {
  list(file: FileRef, options?: ListOptions): AsyncGenerator<FileInfo>;
  stats(file: FileRef): Promise<FileInfo | undefined>;
  remove(file: FileRef): Promise<boolean>;
  open(file: FileRef): Promise<FileHandle>;
}
```

The `FilesApi` wrapper class builds convenience methods like `read`, `write`, `copy`, and `move` on top of these primitives. Backends can optionally implement native versions of `move`, `copy`, and `mkdir` for better performance.

Take a look at `MemFilesApi` or `NodeFilesApi` in the source code for reference implementations.

## Type Reference

The package exports all the TypeScript types you'll need:

```typescript
import type {
  IFilesApi,        // Core interface for backends
  FilesApi,         // Wrapper class with convenience methods
  FileInfo,         // Metadata returned by stats() and list()
  FileHandle,       // Low-level file operations
  FileRef,          // string | { path: string }
  FileKind,         // "file" | "directory"
  BinaryStream,     // AsyncIterable<Uint8Array> | Iterable<Uint8Array>
  ListOptions,      // { recursive?: boolean }
  CopyOptions,      // { recursive?: boolean }
  ReadStreamOptions,  // { start?: number, end?: number, signal?: AbortSignal }
  WriteStreamOptions, // { start?: number, signal?: AbortSignal }
} from '@statewalker/webrun-files';
```

## Utility Functions

The package includes helpful utilities for working with paths and streams:

```typescript
import {
  normalizePath,    // Clean up path strings
  resolveFileRef,   // Convert FileRef to normalized path
  joinPath,         // Join path segments
  dirname,          // Get directory portion of path
  basename,         // Get filename portion
  extname,          // Get file extension
  collectGenerator, // Collect async iterable into array
} from '@statewalker/webrun-files';
```

## License

MIT
