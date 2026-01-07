# @statewalker/webrun-files

Core types and utilities for cross-platform file operations. This package defines the `FilesApi` interface that all storage backends implement, plus utility functions for common file operations.

## Installation

```bash
npm install @statewalker/webrun-files
```

For actual filesystem implementations, install one of these packages:
- `@statewalker/webrun-files-mem` - In-memory storage
- `@statewalker/webrun-files-node` - Node.js filesystem
- `@statewalker/webrun-files-browser` - Browser File System Access API
- `@statewalker/webrun-files-s3` - AWS S3 / S3-compatible storage

## The FilesApi Interface

All implementations provide this interface:

```typescript
interface FilesApi {
  // Read file content as async iterable of chunks
  read(path: string, options?: ReadOptions): AsyncIterable<Uint8Array>;

  // Write content to file (creates parent directories)
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;

  // Create directory (and parents)
  mkdir(path: string): Promise<void>;

  // List directory contents
  list(path: string, options?: ListOptions): AsyncIterable<FileInfo>;

  // Get file/directory metadata
  stats(path: string): Promise<FileStats | undefined>;

  // Check if path exists
  exists(path: string): Promise<boolean>;

  // Remove file or directory (recursively)
  remove(path: string): Promise<boolean>;

  // Move/rename file or directory
  move(source: string, target: string): Promise<boolean>;

  // Copy file or directory (recursively)
  copy(source: string, target: string): Promise<boolean>;
}
```

## Quick Start

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readFile, writeText } from '@statewalker/webrun-files';

const files = new MemFilesApi();

// Write a file
await writeText(files, '/documents/notes.txt', 'Remember to water the plants');

// Read it back
const content = await readFile(files, '/documents/notes.txt');
console.log(new TextDecoder().decode(content));
```

## Utility Functions

### Reading Files

```typescript
import { readFile, readText, tryReadFile, tryReadText, readRange, readAt } from '@statewalker/webrun-files';

// Read entire file as Uint8Array
const content = await readFile(files, '/data.bin');

// Read as UTF-8 string
const text = await readText(files, '/config.json');

// Read with undefined return for missing files
const maybeContent = await tryReadFile(files, '/optional.txt');
const maybeText = await tryReadText(files, '/optional.txt');

// Read a specific byte range
const chunk = await readRange(files, '/large.bin', 1000, 500); // 500 bytes starting at position 1000

// Read into a buffer at specific offset (like fs.read)
const buffer = new Uint8Array(100);
const bytesRead = await readAt(files, '/data.bin', buffer, 0, 100, 500);
```

### Writing Files

```typescript
import { writeText } from '@statewalker/webrun-files';

// Write string content as UTF-8
await writeText(files, '/greeting.txt', 'Hello, World!');

// Write binary content directly
await files.write('/data.bin', [new Uint8Array([1, 2, 3, 4])]);

// Write from multiple chunks
await files.write('/large.bin', generateChunks());
```

### Path Utilities

```typescript
import { normalizePath, joinPath, dirname, basename, extname } from '@statewalker/webrun-files';

normalizePath('//foo/../bar/./baz/');  // '/bar/baz'
joinPath('/foo', 'bar', 'baz.txt');    // '/foo/bar/baz.txt'
dirname('/foo/bar/baz.txt');            // '/foo/bar'
basename('/foo/bar/baz.txt');           // 'baz.txt'
extname('/foo/bar/baz.txt');            // '.txt'
```

## Working with Files

### Checking Existence

```typescript
if (await files.exists('/config.json')) {
  // Load configuration
}
```

### Getting Metadata

```typescript
const info = await files.stats('/photo.jpg');
if (info) {
  console.log(`Size: ${info.size} bytes`);
  console.log(`Modified: ${new Date(info.lastModified)}`);
  console.log(`Type: ${info.kind}`); // "file" or "directory"
}
```

### Listing Directories

```typescript
// List direct children
for await (const entry of files.list('/documents')) {
  console.log(`${entry.name} (${entry.kind})`);
}

// List recursively
for await (const entry of files.list('/project', { recursive: true })) {
  console.log(entry.path);
}
```

### File Management

```typescript
await files.mkdir('/archive/2024');
await files.copy('/report.pdf', '/archive/2024/report.pdf');
await files.move('/temp/draft.txt', '/documents/final.txt');
await files.remove('/old-stuff'); // Recursively deletes directories
```

## Type Reference

```typescript
import type {
  FilesApi,      // Core interface for backends
  FileInfo,      // Metadata from list() - includes name, path, kind, size, lastModified
  FileStats,     // Metadata from stats() - kind, size, lastModified
  FileKind,      // "file" | "directory"
  ReadOptions,   // { start?: number, length?: number, signal?: AbortSignal }
  ListOptions,   // { recursive?: boolean }
} from '@statewalker/webrun-files';
```

## License

MIT
