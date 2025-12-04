# webrun-files

A minimalistic cross-platform files API for JavaScript and TypeScript applications. This library provides a unified interface for file system operations that works seamlessly across Node.js and browser environments.

## Why This Library?

Working with files shouldn't require learning different APIs for different platforms. Whether you're building a desktop application with Node.js, a web app with in-memory storage, or anything in between, your file handling code should look the same. That's the core idea behind webrun-files.

The library defines a simple contract that any storage backend can implement. Write your application code once against this interface, then swap implementations depending on where your code runs. Need to test file operations without touching the disk? Use the in-memory backend. Moving to production with real files? Switch to the Node.js adapter. Your application code doesn't change.

## Getting Started

Install the main package using your preferred package manager:

```bash
npm install @statewalker/webrun-files
# or
pnpm add @statewalker/webrun-files
```

Here's what working with the API looks like:

```typescript
import { FilesApi, MemFilesApi } from '@statewalker/webrun-files';

const files = new FilesApi(new MemFilesApi());

// Write some content
await files.write('/hello.txt', [new TextEncoder().encode('Hello, world!')]);

// Read it back
const content = await files.readFile('/hello.txt');
console.log(new TextDecoder().decode(content)); // "Hello, world!"

// Check what's in a directory
for await (const entry of files.list('/')) {
  console.log(entry.name, entry.kind, entry.size);
}
```

## Packages

This repository is organized as a monorepo containing two packages that work together.

### @statewalker/webrun-files

The core library lives here. It provides the `IFilesApi` interface that defines the contract for all file system operations, plus two ready-to-use implementations. The `MemFilesApi` keeps everything in memory, perfect for testing or browser applications. The `NodeFilesApi` wraps the standard Node.js filesystem, giving you real disk access when you need it. The package also includes `FilesApi`, a convenience wrapper that adds helpful methods on top of any backend implementation.

### @statewalker/webrun-files-tests

Building your own storage backend? This package gives you a comprehensive test suite to verify your implementation. Just call `createFilesApiTests()` with your backend, and it runs dozens of tests covering everything from basic read/write operations to edge cases like concurrent access and unusual file paths. If your implementation passes this suite, you can be confident it will work correctly with any code written against the `IFilesApi` interface.

## Development

The repository uses pnpm for package management and Turborepo for build orchestration. After cloning, install dependencies and build everything:

```bash
pnpm install
pnpm build
```

Run the test suite to verify everything works:

```bash
pnpm test
```

## License

MIT
