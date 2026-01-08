# webrun-files

A minimalistic cross-platform files API for JavaScript and TypeScript applications. This library provides a unified interface for file system operations that works seamlessly across Node.js, browser, and cloud environments.

## Why This Library?

Working with files shouldn't require learning different APIs for different platforms. Whether you're building a desktop application with Node.js, a web app with browser storage, or a cloud service with S3, your file handling code should look the same. That's the core idea behind webrun-files.

The library defines a simple `FilesApi` interface that any storage backend can implement. Write your application code once against this interface, then swap implementations depending on where your code runs. Need to test file operations without touching the disk? Use the in-memory backend. Moving to production with real files? Switch to the Node.js adapter. Your application code doesn't change.

## Getting Started

Install the core package and the implementation you need:

```bash
# Core types and utilities
npm install @statewalker/webrun-files

# Pick an implementation
npm install @statewalker/webrun-files-mem    # In-memory (testing, browser)
npm install @statewalker/webrun-files-node   # Node.js filesystem
npm install @statewalker/webrun-files-browser # Browser File System Access API
npm install @statewalker/webrun-files-s3     # AWS S3 / S3-compatible
```

Here's what working with the API looks like:

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readFile, writeText } from '@statewalker/webrun-files';

// Create an in-memory filesystem
const files = new MemFilesApi();

// Write some content
await writeText(files, '/hello.txt', 'Hello, world!');

// Read it back using the utility function
const content = await readFile(files, '/hello.txt');
console.log(new TextDecoder().decode(content)); // "Hello, world!"

// Or read directly using the streaming API
for await (const chunk of files.read('/hello.txt')) {
  console.log(new TextDecoder().decode(chunk));
}

// Check what's in a directory
for await (const entry of files.list('/')) {
  console.log(entry.name, entry.kind, entry.size);
}
```

## The FilesApi Interface

All implementations provide these methods:

```typescript
interface FilesApi {
  // Read file content as async iterable of chunks
  read(path: string, options?: { start?: number; length?: number }): AsyncIterable<Uint8Array>;

  // Write content to file (creates parent directories)
  write(path: string, content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<void>;

  // Create directory (and parents)
  mkdir(path: string): Promise<void>;

  // List directory contents
  list(path: string, options?: { recursive?: boolean }): AsyncIterable<FileInfo>;

  // Get file/directory metadata
  stats(path: string): Promise<FileStats | undefined>;

  // Check if path exists
  exists(path: string): Promise<boolean>;

  // Remove file or directory
  remove(path: string): Promise<boolean>;

  // Move/rename file or directory
  move(source: string, target: string): Promise<boolean>;

  // Copy file or directory
  copy(source: string, target: string): Promise<boolean>;
}
```

## Packages

This repository is organized as a monorepo containing six packages.

### @statewalker/webrun-files

The core library with the `FilesApi` interface definition, type exports, and utility functions. This package contains no implementations - it defines the contract that all backends follow.

Utilities include:
- `readFile()`, `readText()` - Read entire file into memory
- `writeText()` - Write string content
- `readRange()`, `readAt()` - Random access reading
- Path utilities: `basename()`, `dirname()`, `joinPath()`, `normalizePath()`

### @statewalker/webrun-files-mem

In-memory implementation. Perfect for testing, browser applications without persistent storage, or any case where you need fast, ephemeral file storage.

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';

const files = new MemFilesApi({
  initialFiles: {
    '/config.json': '{"debug": true}',
    '/data/items.txt': 'item1\nitem2\nitem3'
  }
});
```

### @statewalker/webrun-files-node

Node.js implementation using `fs/promises`. Maps virtual paths to a root directory on the local filesystem.

```typescript
import { NodeFilesApi } from '@statewalker/webrun-files-node';

const files = new NodeFilesApi({ rootDir: '/var/app/data' });
// files.write('/config.json', ...) writes to /var/app/data/config.json
```

### @statewalker/webrun-files-browser

Browser implementation using the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API). Enables web applications to read and write files to user-selected directories via `showDirectoryPicker()` or the Origin Private File System (OPFS).

```typescript
import { BrowserFilesApi, openBrowserFilesApi, getOPFSFilesApi } from '@statewalker/webrun-files-browser';

// Open a user-selected directory
const files = await openBrowserFilesApi({ mode: 'readwrite' });

// Or use OPFS for persistent private storage
const opfsFiles = await getOPFSFilesApi();
```

Works in Chrome, Edge, and other Chromium-based browsers.

### @statewalker/webrun-files-s3

S3-backed implementation for cloud storage. Works with Amazon S3 and S3-compatible services (MinIO, DigitalOcean Spaces, Backblaze B2, Cloudflare R2, etc.).

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3FilesApi } from '@statewalker/webrun-files-s3';

const s3Client = new S3Client({ region: 'us-east-1' });
const files = new S3FilesApi({
  client: s3Client,
  bucket: 'my-bucket',
  prefix: 'app-data'  // optional prefix acts as root directory
});
```

### @statewalker/webrun-files-tests

Comprehensive test suite for validating `FilesApi` implementations. If you're building your own storage backend, use this to verify correctness.

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';

createFilesApiTests('MyCustomFilesApi', async () => ({
  api: new MyCustomFilesApi(),
  cleanup: async () => { /* cleanup code */ }
}));
```

The suite covers 50+ test cases including basic operations, edge cases, concurrent access, and error handling.

## Development

The repository uses pnpm for package management. After cloning:

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
