# Refactoring Plan: webrun-files Monorepo Migration

This document outlines the plan to refactor the `webrun-files` project into a monorepo structure matching the `webrun-vcs` technological stack.

## Current State

- **Package:** `@statewalker/webrun-files` v0.3.1
- **Package Manager:** yarn
- **Bundler:** Rollup 4.x
- **Language:** JavaScript (ES modules)
- **Linting:** ESLint 8
- **Testing:** Mocha + expect.js
- **Structure:** Single package

## Target State

- **Package:** `@statewalker/webrun-files` v0.3.1 (preserved)
- **Package Manager:** pnpm 9.x with workspaces
- **Bundler:** Rolldown 1.0.0-beta
- **Language:** TypeScript 5.6+
- **Linting/Formatting:** Biome 2.x
- **Testing:** Vitest 4.x
- **Build Orchestration:** Turbo 2.x
- **Structure:** Monorepo with packages/ folder

---

## Phase 1: Root Monorepo Setup

### 1.1 Create Root Configuration Files

**pnpm-workspace.yaml**
```yaml
packages:
  - "packages/*"

catalog:
  "@biomejs/biome": "^2.3.7"
  "@types/node": "^24.10.1"
  "@vitest/coverage-v8": "^4.0.12"
  pnpm: "^10.23.0"
  rimraf: "^6.1.2"
  rolldown: "^1.0.0-beta.51"
  tsx: "^4.0.0"
  turbo: "^2.0.0"
  typescript: "^5.6.0"
  vitest: "^4.0.12"
```

**turbo.json**
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    },
    "lint": {
      "outputs": []
    }
  }
}
```

**biome.json**
```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.7/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true,
    "defaultBranch": "main"
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "trailingCommas": "all",
      "semicolons": "always"
    }
  }
}
```

**tsconfig.base.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "baseUrl": ".",
    "paths": {
      "@statewalker/webrun-files": ["packages/webrun-files/src"],
      "@statewalker/webrun-files-tests": ["packages/webrun-files-tests/src"]
    }
  }
}
```

**vitest.config.ts**
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
```

### 1.2 Update Root package.json

```json
{
  "name": "@statewalker/webrun-files-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "biome check --write .",
    "lint:check": "biome check .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@types/node": "catalog:",
    "@vitest/coverage-v8": "catalog:",
    "pnpm": "catalog:",
    "rolldown": "catalog:",
    "tsx": "catalog:",
    "turbo": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

---

## Phase 2: Create Package Structure

### 2.1 Directory Structure

```
webrun-files/
├── packages/
│   ├── webrun-files/                    # Core API and types
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── files-api.ts
│   │   │   ├── types.ts
│   │   │   ├── impl/
│   │   │   │   ├── browser-files-api.ts
│   │   │   │   ├── mem-files-api.ts
│   │   │   │   └── node-files-api.ts
│   │   │   └── utils/
│   │   │       ├── get-mime-type.ts
│   │   │       ├── mime-types.ts
│   │   │       ├── normalize-path.ts
│   │   │       └── add-files-api-logger.ts
│   │   ├── tests/
│   │   │   ├── mem-files-api.test.ts    # Uses shared test suites
│   │   │   └── node-files-api.test.ts   # Uses shared test suites
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── rolldown.config.js
│   │
│   └── webrun-files-tests/              # Shared test suites package
│       ├── src/
│       │   ├── index.ts                 # Exports all suites
│       │   ├── test-utils.ts            # Common test utilities
│       │   └── suites/
│       │       ├── index.ts
│       │       ├── files-api.suite.ts   # Core IFilesApi tests
│       │       ├── read-write.suite.ts  # Read/write operations
│       │       ├── directory.suite.ts   # Directory operations
│       │       └── streaming.suite.ts   # Streaming operations
│       ├── package.json
│       ├── tsconfig.json
│       └── rolldown.config.js
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── biome.json
├── tsconfig.base.json
├── vitest.config.ts
├── .gitignore
├── README.md
└── CHANGELOG.md
```

### 2.2 webrun-files package.json

```json
{
  "name": "@statewalker/webrun-files",
  "version": "0.3.1",
  "private": false,
  "type": "module",
  "main": "./dist/cjs/index.cjs",
  "module": "./dist/esm/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.cjs"
    }
  },
  "files": [
    "dist",
    "src"
  ],
  "scripts": {
    "build": "rimraf dist && rolldown -c && tsc --emitDeclarationOnly --declaration",
    "test": "vitest run",
    "lint": "biome lint src tests"
  },
  "devDependencies": {
    "@statewalker/webrun-files-tests": "workspace:*",
    "@types/node": "catalog:",
    "rimraf": "catalog:",
    "rolldown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

### 2.3 webrun-files-tests package.json

```json
{
  "name": "@statewalker/webrun-files-tests",
  "version": "0.3.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "scripts": {
    "build": "rimraf dist && rolldown -c && tsc --emitDeclarationOnly --declaration",
    "test": "vitest run --passWithNoTests",
    "lint": "biome lint src"
  },
  "dependencies": {
    "@statewalker/webrun-files": "workspace:*"
  },
  "peerDependencies": {
    "vitest": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "rimraf": "catalog:",
    "rolldown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

### 2.4 Package tsconfig.json (both packages)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

### 2.5 Package rolldown.config.js (both packages)

```javascript
import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: [
    {
      dir: "dist/esm",
      format: "esm",
      entryFileNames: "[name].js",
      chunkFileNames: "[name]-[hash].js",
    },
    {
      dir: "dist/cjs",
      format: "cjs",
      entryFileNames: "[name].cjs",
      chunkFileNames: "[name]-[hash].cjs",
    },
  ],
  external: ["@statewalker/webrun-files", "vitest"],
  treeshake: true,
});
```

---

## Phase 3: Source Code Migration

### 3.1 TypeScript Conversion

Convert all JavaScript files to TypeScript:

| Current File | Target File |
|--------------|-------------|
| `src/FilesApi.js` | `packages/webrun-files/src/files-api.ts` |
| `src/BrowserFilesApi.js` | `packages/webrun-files/src/impl/browser-files-api.ts` |
| `src/MemFilesApi.js` | `packages/webrun-files/src/impl/mem-files-api.ts` |
| `src/NodeFilesApi.js` | `packages/webrun-files/src/impl/node-files-api.ts` |
| `src/getMimeType.js` | `packages/webrun-files/src/utils/get-mime-type.ts` |
| `src/mimeTypes.js` | `packages/webrun-files/src/utils/mime-types.ts` |
| `src/normalizePath.js` | `packages/webrun-files/src/utils/normalize-path.ts` |
| `src/addFilesApiLogger.js` | `packages/webrun-files/src/utils/add-files-api-logger.ts` |
| `src/openBrowserFilesApi.js` | `packages/webrun-files/src/impl/open-browser-files-api.ts` |
| `src/index.js` | `packages/webrun-files/src/index.ts` |

### 3.2 Add Type Definitions

Create `packages/webrun-files/src/types.ts`:

```typescript
export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  mtime?: Date;
}

export interface FilesApiOptions {
  rootPath?: string;
}

export interface FilesApi {
  read(path: string): Promise<Uint8Array>;
  write(path: string, content: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  list(path: string): Promise<FileInfo[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<FileInfo>;
}
```

### 3.3 Reference Implementation

Use the existing TypeScript implementation from `webrun-vcs/packages/webrun-files/src/` as reference for:
- Type definitions
- Class structure
- Implementation patterns

---

## Phase 4: Test Package (webrun-files-tests)

The `@statewalker/webrun-files-tests` package provides parametrized test suites for all `IFilesApi` implementations. This allows testing any backend (in-memory, Node.js filesystem, S3, browser, etc.) against the same comprehensive test suite.

### 4.1 Test Package Architecture

```
packages/webrun-files-tests/
├── src/
│   ├── index.ts                    # Public exports
│   ├── test-utils.ts               # Common test utilities
│   └── suites/
│       ├── index.ts                # Suite exports
│       ├── files-api.suite.ts      # Core IFilesApi contract tests
│       ├── read-write.suite.ts     # Read/write operations
│       ├── directory.suite.ts      # Directory operations (list, mkdir, etc.)
│       └── streaming.suite.ts      # Streaming/chunked operations
├── package.json
├── tsconfig.json
└── rolldown.config.js
```

### 4.2 Test Suite Pattern

**packages/webrun-files-tests/src/suites/files-api.suite.ts:**

```typescript
/**
 * Parametrized test suite for IFilesApi implementations
 *
 * This suite tests the core IFilesApi interface contract.
 * All storage implementations must pass these tests.
 */

import type { IFilesApi } from "@statewalker/webrun-files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode, decode } from "../test-utils.js";

/**
 * Context provided by the files API factory
 */
export interface FilesApiTestContext {
  api: IFilesApi;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create an IFilesApi instance for testing
 */
export type FilesApiFactory = () => Promise<FilesApiTestContext>;

/**
 * Create the IFilesApi test suite with a specific factory
 *
 * @param name Name of the implementation (e.g., "MemFilesApi", "NodeFilesApi", "S3FilesApi")
 * @param factory Factory function to create API instances
 */
export function createFilesApiTests(name: string, factory: FilesApiFactory): void {
  describe(`IFilesApi [${name}]`, () => {
    let ctx: FilesApiTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Basic Read/Write Operations", () => {
      it("writes and reads text content", async () => {
        const content = encode("Hello, World!");
        await ctx.api.write("/test.txt", content);

        const result = await ctx.api.read("/test.txt");
        expect(decode(result)).toBe("Hello, World!");
      });

      it("checks file existence correctly", async () => {
        expect(await ctx.api.exists("/nonexistent.txt")).toBe(false);

        await ctx.api.write("/exists.txt", encode("test"));
        expect(await ctx.api.exists("/exists.txt")).toBe(true);
      });

      it("deletes files", async () => {
        await ctx.api.write("/to-delete.txt", encode("test"));
        expect(await ctx.api.exists("/to-delete.txt")).toBe(true);

        await ctx.api.remove("/to-delete.txt");
        expect(await ctx.api.exists("/to-delete.txt")).toBe(false);
      });

      it("overwrites existing files", async () => {
        await ctx.api.write("/file.txt", encode("original"));
        await ctx.api.write("/file.txt", encode("updated"));

        const result = await ctx.api.read("/file.txt");
        expect(decode(result)).toBe("updated");
      });
    });

    describe("Binary Content", () => {
      it("handles empty content", async () => {
        const content = new Uint8Array(0);
        await ctx.api.write("/empty.bin", content);

        const result = await ctx.api.read("/empty.bin");
        expect(result.length).toBe(0);
      });

      it("handles binary content with null bytes", async () => {
        const content = new Uint8Array([0, 1, 2, 0, 255, 0, 254]);
        await ctx.api.write("/binary.bin", content);

        const result = await ctx.api.read("/binary.bin");
        expect(result).toEqual(content);
      });

      it("handles content with all byte values", async () => {
        const content = new Uint8Array(256);
        for (let i = 0; i < 256; i++) content[i] = i;

        await ctx.api.write("/all-bytes.bin", content);
        const result = await ctx.api.read("/all-bytes.bin");
        expect(result).toEqual(content);
      });

      it("handles large content (1MB)", { timeout: 30000 }, async () => {
        const content = new Uint8Array(1024 * 1024);
        for (let i = 0; i < content.length; i++) content[i] = i % 256;

        await ctx.api.write("/large.bin", content);
        const result = await ctx.api.read("/large.bin");
        expect(result).toEqual(content);
      });
    });

    describe("Directory Operations", () => {
      it("creates directories", async () => {
        await ctx.api.mkdir("/new-dir");
        expect(await ctx.api.exists("/new-dir")).toBe(true);
      });

      it("creates nested directories", async () => {
        await ctx.api.mkdir("/parent/child/grandchild");
        expect(await ctx.api.exists("/parent/child/grandchild")).toBe(true);
      });

      it("lists directory contents", async () => {
        await ctx.api.write("/dir/file1.txt", encode("1"));
        await ctx.api.write("/dir/file2.txt", encode("2"));
        await ctx.api.mkdir("/dir/subdir");

        const entries = await ctx.api.list("/dir");
        const names = entries.map(e => e.name).sort();
        expect(names).toEqual(["file1.txt", "file2.txt", "subdir"]);
      });

      it("returns file info with correct types", async () => {
        await ctx.api.write("/dir/file.txt", encode("content"));
        await ctx.api.mkdir("/dir/folder");

        const entries = await ctx.api.list("/dir");
        const file = entries.find(e => e.name === "file.txt");
        const folder = entries.find(e => e.name === "folder");

        expect(file?.isDirectory).toBe(false);
        expect(folder?.isDirectory).toBe(true);
      });
    });

    describe("Path Handling", () => {
      it("handles nested paths", async () => {
        await ctx.api.write("/a/b/c/file.txt", encode("nested"));
        const result = await ctx.api.read("/a/b/c/file.txt");
        expect(decode(result)).toBe("nested");
      });

      it("normalizes paths with trailing slashes", async () => {
        await ctx.api.mkdir("/folder/");
        expect(await ctx.api.exists("/folder")).toBe(true);
      });
    });

    describe("Error Handling", () => {
      it("throws on reading non-existent file", async () => {
        await expect(ctx.api.read("/nonexistent.txt")).rejects.toThrow();
      });

      it("handles concurrent operations", async () => {
        const promises = Array(10)
          .fill(null)
          .map((_, i) => ctx.api.write(`/concurrent-${i}.txt`, encode(`content-${i}`)));

        await Promise.all(promises);

        for (let i = 0; i < 10; i++) {
          const result = await ctx.api.read(`/concurrent-${i}.txt`);
          expect(decode(result)).toBe(`content-${i}`);
        }
      });
    });
  });
}
```

### 4.3 Test Utilities

**packages/webrun-files-tests/src/test-utils.ts:**

```typescript
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decode(data: Uint8Array): string {
  return decoder.decode(data);
}

export function allBytesContent(): Uint8Array {
  const content = new Uint8Array(256);
  for (let i = 0; i < 256; i++) content[i] = i;
  return content;
}

export function patternContent(size: number, seed: number = 0): Uint8Array {
  const content = new Uint8Array(size);
  for (let i = 0; i < size; i++) content[i] = (i + seed) % 256;
  return content;
}
```

### 4.4 Suite Exports

**packages/webrun-files-tests/src/suites/index.ts:**

```typescript
export * from "./files-api.suite.js";
export * from "./read-write.suite.js";
export * from "./directory.suite.js";
export * from "./streaming.suite.js";
```

**packages/webrun-files-tests/src/index.ts:**

```typescript
/**
 * @statewalker/webrun-files-tests
 *
 * Parametrized test suites for IFilesApi implementations.
 * Use these suites to test any files API backend against the standard interface contracts.
 */

// Test suites
export * from "./suites/index.js";
// Test utilities
export * from "./test-utils.js";
```

### 4.5 Usage in Implementation Packages

**packages/webrun-files/tests/mem-files-api.test.ts:**

```typescript
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { MemFilesApi } from "../src/impl/mem-files-api.js";

createFilesApiTests("MemFilesApi", async () => ({
  api: new MemFilesApi(),
  cleanup: async () => {
    // Memory implementation needs no cleanup
  },
}));
```

**packages/webrun-files/tests/node-files-api.test.ts:**

```typescript
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { NodeFilesApi } from "../src/impl/node-files-api.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

createFilesApiTests("NodeFilesApi", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "webrun-files-test-"));
  return {
    api: new NodeFilesApi(tempDir),
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
});
```

### 4.6 Future Implementation Examples

**Example: S3FilesApi (in a future webrun-files-s3 package):**

```typescript
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { S3FilesApi } from "../src/s3-files-api.js";

createFilesApiTests("S3FilesApi", async () => {
  const bucket = `test-bucket-${Date.now()}`;
  const api = new S3FilesApi({ bucket, region: "us-east-1" });
  await api.createBucket();

  return {
    api,
    cleanup: async () => {
      await api.deleteBucket();
    },
  };
});
```

**Example: IndexedDBFilesApi (in a browser package):**

```typescript
import { createFilesApiTests } from "@statewalker/webrun-files-tests";
import { IndexedDBFilesApi } from "../src/indexeddb-files-api.js";

createFilesApiTests("IndexedDBFilesApi", async () => {
  const dbName = `test-db-${Date.now()}`;
  const api = new IndexedDBFilesApi(dbName);
  await api.init();

  return {
    api,
    cleanup: async () => {
      await api.deleteDatabase();
    },
  };
});
```

---

## Phase 5: Cleanup and Migration Steps

### 5.1 Execution Order

1. Create backup of current project
2. Initialize pnpm workspace at root
3. Create `packages/` directory
4. Copy `webrun-vcs/packages/webrun-files/` to `packages/webrun-files/`
5. Update package name to `@statewalker/webrun-files`
6. Update version to `0.3.1`
7. Create root configuration files
8. Remove old files:
   - `rollup.config.js`
   - `.eslintrc.json`
   - `yarn.lock`
   - Old `src/` directory
   - Old `test/` directory
9. Run `pnpm install`
10. Run `pnpm build`
11. Run `pnpm test`
12. Run `pnpm lint`

### 5.2 Files to Remove

```
rollup.config.js
.eslintrc.json
yarn.lock
src/           (entire directory - replaced by packages/webrun-files/src)
test/          (entire directory - replaced by packages/webrun-files/tests)
dist/          (will be regenerated)
node_modules/  (will be regenerated by pnpm)
index.js       (entry point moved to package)
```

### 5.3 Files to Keep

```
README.md      (update with monorepo instructions)
CHANGELOG.md   (preserve history)
LICENSE
.gitignore     (update for new structure)
examples/      (may need updates for new import paths)
```

---

## Phase 6: Update .gitignore

```gitignore
# Dependencies
node_modules/
.pnpm-store/

# Build outputs
dist/
*.tsbuildinfo

# Turbo
.turbo/

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
pnpm-debug.log*

# Environment
.env
.env.local
.env.*.local

# Coverage
coverage/
.nyc_output/
```

---

## Summary

### Packages

| Package | Description | Published |
|---------|-------------|-----------|
| `@statewalker/webrun-files` | Core API, types, and implementations (Mem, Node, Browser) | Yes |
| `@statewalker/webrun-files-tests` | Shared test suites for all IFilesApi implementations | No (private) |

### Key Changes

| Aspect | Before | After |
|--------|--------|-------|
| Structure | Single package | Monorepo with packages/ |
| Package Manager | yarn | pnpm 9.x |
| Language | JavaScript | TypeScript |
| Bundler | Rollup 4.x | Rolldown 1.0.0-beta |
| Linting | ESLint 8 | Biome 2.x |
| Testing | Mocha + expect.js | Vitest 4.x (parametrized suites) |
| Build Orchestration | None | Turbo 2.x |
| Exports | UMD + ESM | ESM + CJS + Types |
| Test Architecture | Inline tests | Shared test package |

### Benefits

1. **Type Safety:** Full TypeScript with strict mode
2. **Modern Tooling:** Faster builds with Rolldown, unified linting with Biome
3. **Better DX:** Turbo caching, pnpm efficiency
4. **Scalability:** Ready for additional packages (S3, IndexedDB, etc.)
5. **Consistency:** Matches webrun-vcs architecture
6. **Reusable Tests:** Any IFilesApi implementation can use shared test suites
7. **Contract Testing:** Ensures all implementations satisfy the same interface contract

### Estimated Effort

- Phase 1 (Root Setup): Configuration files creation
- Phase 2 (Package Structure): Directory and config setup for both packages
- Phase 3 (Source Migration): TypeScript conversion
- Phase 4 (Test Package): Create webrun-files-tests with parametrized suites
- Phase 5 (Cleanup): File removal and verification
- Phase 6 (Documentation): README and gitignore updates

### Future Packages

The monorepo structure enables adding new IFilesApi implementations as separate packages:

```
packages/
├── webrun-files/           # Core (existing)
├── webrun-files-tests/     # Test suites (existing)
├── webrun-files-s3/        # S3 implementation (future)
├── webrun-files-indexeddb/ # IndexedDB implementation (future)
├── webrun-files-webdav/    # WebDAV implementation (future)
└── ...
```

Each new implementation simply imports the test suites from `@statewalker/webrun-files-tests` and runs them with its factory function.
