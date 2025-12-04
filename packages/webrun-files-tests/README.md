# @statewalker/webrun-files-tests

A comprehensive test suite for validating `IFilesApi` implementations. If you're building a custom storage backend—whether it's for S3, IndexedDB, or any other storage system—this package helps ensure your implementation correctly follows the interface contract.

## Installation

```bash
npm install --save-dev @statewalker/webrun-files-tests
# or
pnpm add -D @statewalker/webrun-files-tests
```

The package requires Vitest as a peer dependency since the test suite is built on top of it.

## Using the Test Suite

The main export is `createFilesApiTests`, a function that generates a complete test suite for your implementation. You call it with a name and a factory function that creates fresh instances of your API:

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';
import { FilesApi } from '@statewalker/webrun-files';
import { MyCustomFilesApi } from './my-custom-files-api';

createFilesApiTests('MyCustomFilesApi', async () => {
  const backend = new MyCustomFilesApi();

  return {
    api: new FilesApi(backend),
    cleanup: async () => {
      // Optional: clean up resources after each test
      await backend.clear();
    }
  };
});
```

The factory function runs before each test, giving every test a fresh, isolated API instance. If your backend needs cleanup—like deleting temporary files or clearing a database—include a `cleanup` function that runs after each test completes.

## What Gets Tested

The test suite covers the full spectrum of filesystem operations. It starts with basic file I/O, verifying that your implementation can write content and read it back correctly. This includes small text files, empty files, binary data, Unicode content, and larger files over a megabyte.

Directory operations get thorough coverage as well. The suite checks that listing works correctly for both flat directories and recursive traversal, that stats returns accurate metadata, and that the exists check behaves properly for files, directories, and paths that don't exist.

File management operations like copy, move, and remove are tested in various scenarios. The suite verifies that copying works for single files and recursively for directories, that moving correctly relocates content, and that deletion properly removes files and directories without affecting siblings.

Edge cases receive special attention. The test suite explores unusual file paths with special characters, very long path names, double slashes, and other potential gotchas. It also runs concurrent operation tests to verify your implementation handles parallel reads and writes gracefully.

The suite tests low-level file handle operations too, including partial reads with start and end positions, writing at specific offsets, and appending data.

## Test Utilities

The package exports several helper functions that make writing additional tests easier:

```typescript
import {
  toBytes,          // Convert string to Uint8Array
  fromBytes,        // Convert Uint8Array to string
  collectStream,    // Gather async stream into single Uint8Array
  collectGenerator, // Collect async iterable into array
  randomBytes,      // Generate random binary data
  patternContent,   // Generate predictable byte patterns
  allBytesContent,  // Generate Uint8Array with all 256 byte values
} from '@statewalker/webrun-files-tests';
```

These utilities handle common testing patterns like encoding text, collecting streamed results, and generating test data.

## Example: Testing a Node.js Backend

Here's how the built-in `NodeFilesApi` is tested:

```typescript
import { createFilesApiTests } from '@statewalker/webrun-files-tests';
import { FilesApi, NodeFilesApi } from '@statewalker/webrun-files';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

createFilesApiTests('NodeFilesApi', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'files-test-'));

  return {
    api: new FilesApi(new NodeFilesApi(tempDir)),
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
});
```

Each test gets a fresh temporary directory, and cleanup removes it afterward. This pattern ensures tests don't interfere with each other or leave files behind.

## Running Tests

Since the test suite uses Vitest, run it with your normal test command:

```bash
pnpm test
# or
npx vitest run
```

If any tests fail, the output will tell you exactly which operation didn't behave as expected, making it straightforward to track down issues in your implementation.

## License

MIT
