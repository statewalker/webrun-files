# @statewalker/webrun-files-node

Node.js filesystem implementation of the `FilesApi` interface from `@statewalker/webrun-files`.

## Overview

This package provides a `FilesApi` implementation that works with the real filesystem using Node.js `fs/promises`. It maps virtual paths (starting with `/`) to a root directory on disk.

## Installation

```bash
npm install @statewalker/webrun-files-node @statewalker/webrun-files
```

## Usage

### Basic Usage

```typescript
import { NodeFilesApi } from '@statewalker/webrun-files-node';
import { readText, writeText } from '@statewalker/webrun-files';

// Create API rooted at a specific directory
const files = new NodeFilesApi({ rootDir: '/var/app/data' });

// Write a file - creates /var/app/data/config.json
await writeText(files, '/config.json', '{"debug": true}');

// Read it back
const content = await readText(files, '/config.json');
console.log(content); // {"debug": true}

// List files
for await (const entry of files.list('/')) {
  console.log(entry.name, entry.kind, entry.size);
}
```

### Default Root Directory

If no `rootDir` is specified, the current working directory is used:

```typescript
import { NodeFilesApi } from '@statewalker/webrun-files-node';

const files = new NodeFilesApi();
// Virtual path /data/file.txt maps to ./data/file.txt
```

### Path Mapping

Virtual paths are mapped directly to the filesystem:

```
rootDir: "/var/app/data"
virtual path: "/users/alice.json"
real path: "/var/app/data/users/alice.json"
```

## API Reference

### NodeFilesApi

```typescript
interface NodeFilesApiOptions {
  /**
   * Root directory for file operations.
   * All paths are resolved relative to this directory.
   * Defaults to current working directory if not specified.
   */
  rootDir?: string;
}

class NodeFilesApi implements FilesApi {
  constructor(options?: NodeFilesApiOptions);

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

## Features

### Efficient Streaming

Large files are read in chunks without loading entirely into memory:

```typescript
// Stream a large file
for await (const chunk of files.read('/large-video.mp4')) {
  // Process each chunk (default 8KB chunks)
}

// Read a specific range
for await (const chunk of files.read('/large-file.bin', { start: 1000, length: 500 })) {
  // Only bytes 1000-1499
}
```

### Automatic Directory Creation

Parent directories are created automatically when writing files:

```typescript
// Creates /var/app/data/deep/nested/path/ automatically
await writeText(files, '/deep/nested/path/file.txt', 'content');
```

### Recursive Operations

Copy and remove work recursively on directories:

```typescript
// Copy entire directory tree
await files.copy('/source', '/destination');

// Remove directory and all contents
await files.remove('/old-data');
```

## Testing with Temporary Directories

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFilesApi } from '@statewalker/webrun-files-node';

// Create a temp directory for testing
const tempDir = await mkdtemp(join(tmpdir(), 'test-'));
const files = new NodeFilesApi({ rootDir: tempDir });

try {
  // Run tests...
  await writeText(files, '/test.txt', 'test content');
} finally {
  // Cleanup
  await rm(tempDir, { recursive: true, force: true });
}
```

## License

MIT
