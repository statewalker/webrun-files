# @statewalker/webrun-files-tests

A comprehensive test suite for validating `FilesApi` implementations. Use this package to ensure your custom storage backend correctly follows the interface contract.

## Installation

```bash
npm install --save-dev @statewalker/webrun-files-tests vitest
```

The package requires Vitest as a peer dependency.

## Using the Test Suite

The main export is `createFilesApiTests`, a function that generates a complete test suite for your implementation:

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';
import { MyCustomFilesApi } from './my-custom-files-api';

createFilesApiTests('MyCustomFilesApi', async () => {
  const api = new MyCustomFilesApi();

  return {
    api,
    cleanup: async () => {
      // Optional: clean up resources after each test
      await api.clear();
    }
  };
});
```

The factory function runs before each test, giving every test a fresh, isolated API instance.

## What Gets Tested

The test suite covers 50+ test cases across these categories:

### Basic File I/O
- Writing and reading small text files
- Empty files
- Binary data with null bytes
- Large files (1MB+)
- Unicode content
- Multiple chunk writes

### Read Options
- Reading from specific positions (`start`)
- Reading specific lengths (`length`)
- Range reads (start + length)
- Edge cases: length=0, start beyond file size

### Directory Operations
- Listing direct children
- Recursive listing
- Empty directories
- File metadata (kind, size, lastModified)

### File Management
- Copy single files
- Copy directories recursively
- Move files and directories
- Remove files and directories

### Stats and Existence
- Getting file stats
- Getting directory stats
- Root directory handling
- Non-existent paths

### Edge Cases
- Special characters in file names
- Very long paths
- Double slashes in paths
- Paths without leading slash
- Trailing slashes
- Dot segments (`.`, `..`)

### Concurrent Operations
- Parallel writes to different files
- Parallel reads
- Parallel list operations

### Error Handling
- Reading non-existent files
- Removing non-existent files
- Stats for non-existent paths

## Test Utilities

The package exports helper functions for writing additional tests:

```typescript
import {
  toBytes,          // Convert string to Uint8Array
  fromBytes,        // Convert Uint8Array to string
  collectStream,    // Gather async stream into single Uint8Array
  randomBytes,      // Generate random binary data
  patternContent,   // Generate predictable byte patterns
  allBytesContent,  // Generate Uint8Array with all 256 byte values
} from '@statewalker/webrun-files-tests';

// Example usage
const text = 'Hello, World!';
const bytes = toBytes(text);
const result = await collectStream(files.read('/file.txt'));
const decoded = fromBytes(result);
```

## Example: Testing a Node.js Backend

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

## Example: Testing an In-Memory Backend

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';
import { MemFilesApi } from '@statewalker/webrun-files-mem';

createFilesApiTests('MemFilesApi', async () => ({
  api: new MemFilesApi(),
  // No cleanup needed - each test gets a fresh instance
}));
```

## Running Tests

Run with your normal test command:

```bash
pnpm test
# or
npx vitest run
```

If any tests fail, the output shows exactly which operation didn't behave as expected.

## License

MIT
