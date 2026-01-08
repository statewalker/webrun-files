# @statewalker/webrun-files-mem

In-memory implementation of the `FilesApi` interface from `@statewalker/webrun-files`.

## Overview

This package provides a fast, ephemeral filesystem that stores everything in memory. Perfect for:

- **Testing** - Isolated tests without disk I/O or cleanup
- **Browser applications** - When you don't need persistence
- **Prototyping** - Quick experiments without file system setup
- **Caching layers** - Fast temporary storage

## Installation

```bash
npm install @statewalker/webrun-files-mem @statewalker/webrun-files
```

## Usage

### Basic Usage

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readText, writeText } from '@statewalker/webrun-files';

const files = new MemFilesApi();

// Write a file
await writeText(files, '/config.json', '{"debug": true}');

// Read it back
const content = await readText(files, '/config.json');
console.log(content); // {"debug": true}

// List files
for await (const entry of files.list('/')) {
  console.log(entry.name, entry.kind, entry.size);
}
```

### Initialize with Files

Pre-populate the filesystem when creating it:

```typescript
import { MemFilesApi } from '@statewalker/webrun-files-mem';

const files = new MemFilesApi({
  initialFiles: {
    '/config.json': '{"theme": "dark", "locale": "en"}',
    '/data/users.json': '[{"id": 1, "name": "Alice"}]',
    '/data/binary.bin': new Uint8Array([0x00, 0x01, 0x02, 0x03]),
  }
});

// Files are ready to use
const config = await readText(files, '/config.json');
```

Values can be strings (encoded as UTF-8) or `Uint8Array` for binary data. Parent directories are created automatically.

## API Reference

### MemFilesApi

```typescript
interface MemFilesApiOptions {
  /** Initial files to populate. Keys are paths, values are content. */
  initialFiles?: Record<string, string | Uint8Array>;
}

class MemFilesApi implements FilesApi {
  constructor(options?: MemFilesApiOptions);

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

## Testing Example

Use with vitest or any test framework:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MemFilesApi } from '@statewalker/webrun-files-mem';
import { readText, writeText } from '@statewalker/webrun-files';

describe('MyApp', () => {
  let files: MemFilesApi;

  beforeEach(() => {
    // Fresh filesystem for each test
    files = new MemFilesApi({
      initialFiles: {
        '/config.json': '{"version": 1}'
      }
    });
  });

  it('should update config', async () => {
    await writeText(files, '/config.json', '{"version": 2}');
    const content = await readText(files, '/config.json');
    expect(JSON.parse(content).version).toBe(2);
  });
});
```

## License

MIT
