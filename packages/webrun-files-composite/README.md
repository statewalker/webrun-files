# @statewalker/webrun-files-composite

A `FilesApi` adapter that composes multiple `FilesApi` instances into a unified virtual filesystem with **mount points** and **access guards**.

## Features

- **Mount multiple backends** at different paths under a single `FilesApi` interface
- **Base path remapping** — use a subdirectory of any backend as its mount root
- **Access guards** to enforce per-operation, per-path access control
- **Cross-mount operations** — copy and move files transparently across different backends
- **Mount-point protection** — mounted directories cannot be removed
- **Longest-prefix routing** — deeper mounts take precedence (e.g. `/a/b` before `/a`)
- **Synthetic directory entries** — mount points appear as directories in listings

## Installation

```bash
pnpm add @statewalker/webrun-files-composite
```

## Usage

### Basic composition

```typescript
import { CompositeFilesApi } from "@statewalker/webrun-files-composite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const composite = new CompositeFilesApi(new MemFilesApi())
  .mount("/docs", new MemFilesApi())
  .mount("/cache", new MemFilesApi());

const encoder = new TextEncoder();
await composite.write("/readme.txt", [encoder.encode("Hello")]);
await composite.write("/docs/guide.md", [encoder.encode("# Guide")]);
```

### Base path remapping

Each mount can specify which subdirectory of the backing filesystem to use as its root. The constructor also accepts an optional `rootPath`:

```typescript
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { S3FilesApi } from "@statewalker/webrun-files-s3";
import { MemFilesApi } from "@statewalker/webrun-files-mem";

const fsMain = new NodeFilesApi({ ... });
const fsS3 = new S3FilesApi({ ... });
const fsMem = new MemFilesApi();

// Use "/projects" as the root of the composite file system:
const composite = new CompositeFilesApi(fsMain, "./projects")
  .mount("/docs", fsS3, "/documentation") // use the "/documentation" folder on S3
  .mount("/cache", fsMem);               // use the root of the in-memory FS

// Writes to /readme.txt go to fsMain at /projects/readme.txt
await composite.write("/readme.txt", [encoder.encode("Hello")]);

// Writes to /docs/guide.md go to fsS3 at /documentation/guide.md
await composite.write("/docs/guide.md", [encoder.encode("# Guide")]);

// Writes to /cache/tmp.dat go to fsMem at /tmp.dat
await composite.write("/cache/tmp.dat", [encoder.encode("temp")]);
```

### Access guards

```typescript
composite
  .guard(
    ["write", "remove", "move"],
    (path) => !path.startsWith("/.private/"),
    "Cannot modify private files"
  )
  .guard(
    ["write"],
    (path) => !path.includes(".."),
    "Path traversal not allowed"
  );
```

Guards are checked before each operation. The first failing guard throws an error with its message.

### Cross-mount operations

```typescript
// Copy from one mount to another
await composite.copy("/docs/file.txt", "/archive/file.txt");

// Move across mounts (implemented as copy + delete)
await composite.move("/cache/temp.txt", "/docs/temp.txt");
```

### Listing

Mount points appear as synthetic directory entries:

```typescript
const entries = [];
for await (const entry of composite.list("/")) {
  entries.push(entry);
}
// Includes: { name: "docs", path: "/docs", kind: "directory" }

// Recursive listing spans all mounts
for await (const entry of composite.list("/", { recursive: true })) {
  // entries from root, /docs, /cache, and all subdirectories
}
```

## API

### `CompositeFilesApi`

Implements the `FilesApi` interface from `@statewalker/webrun-files`.

#### Constructor

```typescript
new CompositeFilesApi(root: FilesApi, rootPath?: string)
```

Creates a composite filesystem with `root` as the default backend for `/`. If `rootPath` is provided, all root operations are remapped to that subdirectory in the backing filesystem.

#### `mount(path: string, api: FilesApi, fsPath?: string): this`

Mounts a `FilesApi` backend at the given path. If `fsPath` is provided, operations on this mount are remapped to that subdirectory in the backing filesystem. Paths are normalized (leading `/`, no trailing `/`). Returns `this` for chaining.

#### `guard(operations: FileOperation[], check: (path: string) => boolean, message?: string): this`

Adds an access guard. Before each matching operation, `check(path)` is called. If it returns `false`, the operation throws an error with the optional `message`. Returns `this` for chaining.

#### FilesApi methods

| Method | Description |
|--------|-------------|
| `read(path, options?)` | Read file content as `AsyncIterable<Uint8Array>` |
| `write(path, content)` | Write content to a file |
| `mkdir(path)` | Create a directory |
| `list(path, options?)` | List directory entries (supports `{ recursive: true }`) |
| `stats(path)` | Get file/directory stats; mount points return `{ kind: "directory" }` |
| `exists(path)` | Check if a path exists; returns `true` for mount points |
| `remove(path)` | Remove a file or directory (throws on mount points) |
| `move(source, target)` | Move a file or directory (cross-mount supported) |
| `copy(source, target)` | Copy a file or directory (cross-mount supported) |

### Types

```typescript
type FileOperation = "read" | "write" | "remove" | "move" | "copy" | "list" | "mkdir";

interface FileGuard {
  operations: FileOperation[];
  check: (path: string) => boolean;
  message?: string;
}
```

## Path resolution

1. All input paths are normalized (forward slashes, leading `/`, no trailing `/`)
2. The mount with the **longest matching prefix** handles the operation
3. The mount prefix is stripped and the `fsPath` (base path) is prepended — e.g. `/docs/guide.md` with mount at `/docs` and `fsPath="/documentation"` resolves to `/documentation/guide.md` on the mounted backend
4. Guards always operate on **composite paths** (before remapping), not backing filesystem paths

## Design constraints

- The root mount (`/`) is set at construction time and cannot be remounted
- Mount points are immutable — `remove()` on a mount point throws an error
- Cross-mount move is implemented as copy + delete (no atomic guarantee)
- Guards are evaluated in the order they were added; first denial wins

## Related packages

| Package | Role |
|---------|------|
| `@statewalker/webrun-files` | Core `FilesApi` interface and path utilities |
| `@statewalker/webrun-files-mem` | In-memory `FilesApi` backend |
| `@statewalker/webrun-files-node` | Node.js filesystem backend |
| `@statewalker/webrun-files-tests` | Shared parametrized test suites |

## License

MIT
