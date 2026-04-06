# @statewalker/webrun-files-tests

Comprehensive test suites for validating `FilesApi` implementations. Use this package to ensure your custom storage backend correctly follows the interface contract.

## Installation

```bash
pnpm add -D @statewalker/webrun-files-tests vitest
```

Requires Vitest as a peer dependency.

## Test suites

### `createFilesApiTests` — core interface tests

Generates 56+ test cases covering every `FilesApi` method:

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';
import { MyCustomFilesApi } from './my-custom-files-api';

createFilesApiTests('MyCustomFilesApi', async () => {
  const api = new MyCustomFilesApi();
  return {
    api,
    cleanup: async () => {
      await api.clear();
    }
  };
});
```

The factory runs before each test, giving every test a fresh, isolated API instance.

**Test categories:**

| Category | Tests | What's covered |
|----------|-------|----------------|
| write() and read() | 8 | Small text, empty files, multiple chunks, async iterables, overwrite, nested dirs, binary/null bytes, large files, Unicode |
| read() with options | 6 | Start position, length, ranges, edge cases (length=0, start beyond file) |
| stats() | 5 | File stats, directory stats, non-existent paths, size after overwrite, root directory |
| exists() | 4 | Existing files/directories, non-existent paths, post-removal verification |
| list() | 7 | Direct children, recursive listing, metadata (kind, size, path), empty dirs, non-existent paths, root listing |
| remove() | 4 | Files, directories (recursive), non-existent paths, sibling preservation |
| copy() | 4 | Single files, directories (recursive), non-existent source, overwrite |
| move() | 3 | Files, directories, non-existent source |
| mkdir() | 3 | Single directory, nested directories, idempotency |
| Path handling | 6 | Double slashes, missing leading slash, trailing slashes, dot segments, special characters, long paths |
| Concurrent ops | 3 | Parallel writes, reads, list operations |
| Error handling | 3 | Reading/removing/stat on non-existent paths |

### `createBigFilesApiTests` — large file tests

Tests streaming, chunked writes, and random access for large files:

```typescript
import { createBigFilesApiTests } from '@statewalker/webrun-files-tests';

createBigFilesApiTests('MyCustomFilesApi', async () => ({
  api: new MyCustomFilesApi(),
}), {
  sizes: [1_000_000, 10_000_000],  // 1MB and 10MB (default: 1MB, 10MB, 50MB, 100MB)
  timeout: 120_000,                 // per-test timeout in ms (default: 120000)
});
```

**Test categories:**
- Write and read large files with pattern verification
- Chunked writes via async generators
- Random-access range reads (first/last/middle 1KB, 1MB ranges)
- Overwrite large files with smaller content
- Copy and move large files

## Types

```typescript
interface FilesApiTestContext {
  api: FilesApi;
  cleanup?: () => Promise<void>;
}

type FilesApiFactory = () => Promise<FilesApiTestContext>;

interface BigFilesTestContext {
  api: FilesApi;
  cleanup?: () => Promise<void>;
}

type BigFilesApiFactory = () => Promise<BigFilesTestContext>;

interface BigFilesTestOptions {
  sizes?: number[];    // File sizes in bytes (default: [1MB, 10MB, 50MB, 100MB])
  timeout?: number;    // Per-test timeout in ms (default: 120000)
}
```

## Test utilities

Helper functions for writing additional tests:

```typescript
import {
  encode,           // Convert string to Uint8Array
  decode,           // Convert Uint8Array to string
  toBytes,          // Alias for encode
  fromBytes,        // Alias for decode
  collectStream,    // Gather async Uint8Array stream into single Uint8Array
  collectGenerator, // Collect async iterable into array
  randomBytes,      // Generate random binary data
  patternContent,   // Generate predictable byte pattern: (i + seed) % 256
  allBytesContent,  // Generate Uint8Array with all 256 byte values (0–255)
} from '@statewalker/webrun-files-tests';
```

## Examples

### Node.js backend

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';
import { NodeFilesApi } from '@statewalker/webrun-files-node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

createFilesApiTests('NodeFilesApi', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'files-test-'));
  return {
    api: new NodeFilesApi({ rootDir: tempDir }),
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
});
```

### In-memory backend

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';
import { MemFilesApi } from '@statewalker/webrun-files-mem';

createFilesApiTests('MemFilesApi', async () => ({
  api: new MemFilesApi(),
}));
```

## License

MIT
