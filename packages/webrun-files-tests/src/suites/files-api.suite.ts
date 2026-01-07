/**
 * Parametrized test suite for FilesApi implementations
 *
 * This suite tests the core FilesApi interface contract.
 * All storage implementations must pass these tests.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGenerator, collectStream, fromBytes, randomBytes, toBytes } from "../test-utils.js";

/**
 * Options for configuring the test suite
 */
export interface TestSuiteOptions {
  /**
   * Human-readable name for the implementation being tested.
   */
  name: string;

  /**
   * Factory function to create a fresh FilesApi instance.
   * Called before each test.
   */
  createApi: () => Promise<FilesApi> | FilesApi;

  /**
   * Optional cleanup function called after each test.
   */
  cleanup?: (api: FilesApi) => Promise<void>;

  /**
   * Features supported by this implementation.
   */
  features?: {
    nativeMove?: boolean;
    nativeCopy?: boolean;
    permissions?: boolean;
    preciseTimestamps?: boolean;
    maxFileSize?: number;
  };
}

/**
 * Context provided by the files API factory
 */
export interface FilesApiTestContext {
  api: FilesApi;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a FilesApi instance for testing
 */
export type FilesApiFactory = () => Promise<FilesApiTestContext>;

/**
 * Create the FilesApi test suite with a specific factory
 *
 * @param name Name of the implementation (e.g., "MemFilesApi", "NodeFilesApi", "S3FilesApi")
 * @param factory Factory function to create API instances
 */
export function createFilesApiTests(name: string, factory: FilesApiFactory): void {
  describe(`FilesApi [${name}]`, () => {
    let ctx: FilesApiTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    // ========================================
    // 1. BASIC WRITE AND READ
    // ========================================

    describe("write() and read()", () => {
      it("should write and read a small text file", async () => {
        const content = "Hello, World!";
        await ctx.api.write("/test.txt", [toBytes(content)]);

        const result = await collectStream(ctx.api.read("/test.txt"));
        expect(fromBytes(result)).toBe(content);
      });

      it("should write and read an empty file", async () => {
        await ctx.api.write("/empty.txt", [new Uint8Array(0)]);

        const result = await collectStream(ctx.api.read("/empty.txt"));
        expect(result.length).toBe(0);
      });

      it("should write from multiple chunks", async () => {
        const chunks = [toBytes("Hello, "), toBytes("World"), toBytes("!")];
        await ctx.api.write("/chunks.txt", chunks);

        const result = await collectStream(ctx.api.read("/chunks.txt"));
        expect(fromBytes(result)).toBe("Hello, World!");
      });

      it("should write from async iterable", async () => {
        async function* generate() {
          yield toBytes("Line 1\n");
          yield toBytes("Line 2\n");
          yield toBytes("Line 3\n");
        }

        await ctx.api.write("/async.txt", generate());

        const result = await collectStream(ctx.api.read("/async.txt"));
        expect(fromBytes(result)).toBe("Line 1\nLine 2\nLine 3\n");
      });

      it("should overwrite existing file", async () => {
        await ctx.api.write("/overwrite.txt", [toBytes("first content")]);
        await ctx.api.write("/overwrite.txt", [toBytes("second")]);

        const result = await collectStream(ctx.api.read("/overwrite.txt"));
        expect(fromBytes(result)).toBe("second");
      });

      it("should create parent directories automatically", async () => {
        await ctx.api.write("/deep/nested/path/file.txt", [toBytes("deep")]);

        const result = await collectStream(ctx.api.read("/deep/nested/path/file.txt"));
        expect(fromBytes(result)).toBe("deep");
      });

      it("should handle binary data with null bytes", async () => {
        const binary = new Uint8Array([0, 1, 0, 2, 0, 3, 0, 0, 0]);
        await ctx.api.write("/binary.bin", [binary]);

        const result = await collectStream(ctx.api.read("/binary.bin"));
        expect(Array.from(result)).toEqual(Array.from(binary));
      });

      it("should handle large file (1MB)", async () => {
        const size = 1024 * 1024;
        const data = randomBytes(size);

        await ctx.api.write("/large.bin", [data]);

        const result = await collectStream(ctx.api.read("/large.bin"));
        expect(result.length).toBe(size);
        expect(result[0]).toBe(data[0]);
        expect(result[size - 1]).toBe(data[size - 1]);
      });

      it("should handle Unicode content", async () => {
        const content = "Hello 世界 🌍 Привет мир";
        await ctx.api.write("/unicode.txt", [toBytes(content)]);

        const result = await collectStream(ctx.api.read("/unicode.txt"));
        expect(fromBytes(result)).toBe(content);
      });
    });

    // ========================================
    // 2. READ OPTIONS (start/length)
    // ========================================

    describe("read() with options", () => {
      beforeEach(async () => {
        // Create test file: bytes 0-99
        const data = new Uint8Array(100);
        for (let i = 0; i < 100; i++) data[i] = i;
        await ctx.api.write("/range.bin", [data]);
      });

      it("should read from start position", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 50 }));
        expect(result.length).toBe(50);
        expect(result[0]).toBe(50);
        expect(result[49]).toBe(99);
      });

      it("should read specified length from beginning", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { length: 30 }));
        expect(result.length).toBe(30);
        expect(result[0]).toBe(0);
        expect(result[29]).toBe(29);
      });

      it("should read a range (start and length)", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 20, length: 20 }));
        expect(result.length).toBe(20);
        expect(result[0]).toBe(20);
        expect(result[19]).toBe(39);
      });

      it("should return empty when length is 0", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 50, length: 0 }));
        expect(result.length).toBe(0);
      });

      it("should return empty when start is beyond file size", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 200 }));
        expect(result.length).toBe(0);
      });

      it("should clamp length to remaining file size", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 90, length: 100 }));
        expect(result.length).toBe(10);
        expect(result[9]).toBe(99);
      });
    });

    // ========================================
    // 3. STATS
    // ========================================

    describe("stats()", () => {
      it("should return file stats for existing file", async () => {
        await ctx.api.write("/info.txt", [toBytes("content here")]);

        const stats = await ctx.api.stats("/info.txt");
        expect(stats).toBeDefined();
        expect(stats?.kind).toBe("file");
        expect(stats?.size).toBe(12);
        expect(stats?.lastModified).toBeGreaterThan(0);
      });

      it("should return directory stats", async () => {
        await ctx.api.write("/mydir/file.txt", [toBytes("x")]);

        const stats = await ctx.api.stats("/mydir");
        expect(stats).toBeDefined();
        expect(stats?.kind).toBe("directory");
      });

      it("should return undefined for non-existent path", async () => {
        const stats = await ctx.api.stats("/does-not-exist.txt");
        expect(stats).toBeUndefined();
      });

      it("should return correct size after overwrite", async () => {
        await ctx.api.write("/size.txt", [toBytes("longer content here")]);
        await ctx.api.write("/size.txt", [toBytes("short")]);

        const stats = await ctx.api.stats("/size.txt");
        expect(stats?.size).toBe(5);
      });

      it("should handle root directory", async () => {
        await ctx.api.write("/root-file.txt", [toBytes("x")]);

        const stats = await ctx.api.stats("/");
        expect(stats).toBeDefined();
        expect(stats?.kind).toBe("directory");
      });
    });

    // ========================================
    // 4. EXISTS
    // ========================================

    describe("exists()", () => {
      it("should return true for existing file", async () => {
        await ctx.api.write("/exists.txt", [toBytes("x")]);
        expect(await ctx.api.exists("/exists.txt")).toBe(true);
      });

      it("should return true for existing directory", async () => {
        await ctx.api.write("/existsdir/file.txt", [toBytes("x")]);
        expect(await ctx.api.exists("/existsdir")).toBe(true);
      });

      it("should return false for non-existent path", async () => {
        expect(await ctx.api.exists("/nope.txt")).toBe(false);
      });

      it("should return false after file is removed", async () => {
        await ctx.api.write("/temp.txt", [toBytes("x")]);
        await ctx.api.remove("/temp.txt");
        expect(await ctx.api.exists("/temp.txt")).toBe(false);
      });
    });

    // ========================================
    // 5. LIST
    // ========================================

    describe("list()", () => {
      beforeEach(async () => {
        await ctx.api.write("/listdir/a.txt", [toBytes("a")]);
        await ctx.api.write("/listdir/b.txt", [toBytes("b")]);
        await ctx.api.write("/listdir/sub/c.txt", [toBytes("c")]);
        await ctx.api.write("/listdir/sub/deep/d.txt", [toBytes("d")]);
      });

      it("should list direct children", async () => {
        const entries = await collectGenerator(ctx.api.list("/listdir"));
        const names = entries.map((e) => e.name).sort();

        expect(names).toContain("a.txt");
        expect(names).toContain("b.txt");
        expect(names).toContain("sub");
        expect(names).not.toContain("c.txt");
        expect(names).not.toContain("d.txt");
      });

      it("should include file kind and path", async () => {
        const entries = await collectGenerator(ctx.api.list("/listdir"));

        const file = entries.find((e) => e.name === "a.txt");
        expect(file).toBeDefined();
        expect(file?.kind).toBe("file");
        expect(file?.path).toBe("/listdir/a.txt");

        const dir = entries.find((e) => e.name === "sub");
        expect(dir).toBeDefined();
        expect(dir?.kind).toBe("directory");
      });

      it("should list recursively", async () => {
        const entries = await collectGenerator(ctx.api.list("/listdir", { recursive: true }));
        const paths = entries.map((e) => e.path).sort();

        expect(paths).toContain("/listdir/a.txt");
        expect(paths).toContain("/listdir/b.txt");
        expect(paths).toContain("/listdir/sub/c.txt");
        expect(paths).toContain("/listdir/sub/deep/d.txt");
      });

      it("should return empty for non-existent directory", async () => {
        const entries = await collectGenerator(ctx.api.list("/nonexistent"));
        expect(entries.length).toBe(0);
      });

      it("should return empty for file path", async () => {
        const entries = await collectGenerator(ctx.api.list("/listdir/a.txt"));
        expect(entries.length).toBe(0);
      });

      it("should list root directory", async () => {
        const entries = await collectGenerator(ctx.api.list("/"));
        const names = entries.map((e) => e.name);
        expect(names).toContain("listdir");
      });
    });

    // ========================================
    // 6. REMOVE
    // ========================================

    describe("remove()", () => {
      it("should remove a file", async () => {
        await ctx.api.write("/to-delete.txt", [toBytes("delete me")]);

        const result = await ctx.api.remove("/to-delete.txt");
        expect(result).toBe(true);
        expect(await ctx.api.exists("/to-delete.txt")).toBe(false);
      });

      it("should remove a directory recursively", async () => {
        await ctx.api.write("/to-delete-dir/a.txt", [toBytes("a")]);
        await ctx.api.write("/to-delete-dir/sub/b.txt", [toBytes("b")]);

        const result = await ctx.api.remove("/to-delete-dir");
        expect(result).toBe(true);
        expect(await ctx.api.exists("/to-delete-dir")).toBe(false);
        expect(await ctx.api.exists("/to-delete-dir/a.txt")).toBe(false);
        expect(await ctx.api.exists("/to-delete-dir/sub/b.txt")).toBe(false);
      });

      it("should return false for non-existent path", async () => {
        const result = await ctx.api.remove("/nonexistent.txt");
        expect(result).toBe(false);
      });

      it("should not affect sibling files", async () => {
        await ctx.api.write("/siblings/keep.txt", [toBytes("keep")]);
        await ctx.api.write("/siblings/delete.txt", [toBytes("delete")]);

        await ctx.api.remove("/siblings/delete.txt");

        expect(await ctx.api.exists("/siblings/keep.txt")).toBe(true);
        expect(await ctx.api.exists("/siblings/delete.txt")).toBe(false);
      });
    });

    // ========================================
    // 7. COPY
    // ========================================

    describe("copy()", () => {
      it("should copy a file", async () => {
        await ctx.api.write("/original.txt", [toBytes("original content")]);

        const result = await ctx.api.copy("/original.txt", "/copied.txt");
        expect(result).toBe(true);

        const content = await collectStream(ctx.api.read("/copied.txt"));
        expect(fromBytes(content)).toBe("original content");

        // Original should still exist
        expect(await ctx.api.exists("/original.txt")).toBe(true);
      });

      it("should copy a directory recursively", async () => {
        await ctx.api.write("/src-dir/a.txt", [toBytes("a")]);
        await ctx.api.write("/src-dir/sub/b.txt", [toBytes("b")]);

        const result = await ctx.api.copy("/src-dir", "/dest-dir");
        expect(result).toBe(true);

        expect(await ctx.api.exists("/dest-dir/a.txt")).toBe(true);
        expect(await ctx.api.exists("/dest-dir/sub/b.txt")).toBe(true);

        const contentA = await collectStream(ctx.api.read("/dest-dir/a.txt"));
        expect(fromBytes(contentA)).toBe("a");
      });

      it("should return false for non-existent source", async () => {
        const result = await ctx.api.copy("/nonexistent.txt", "/dest.txt");
        expect(result).toBe(false);
      });

      it("should overwrite existing destination", async () => {
        await ctx.api.write("/src.txt", [toBytes("new content")]);
        await ctx.api.write("/dest.txt", [toBytes("old content")]);

        await ctx.api.copy("/src.txt", "/dest.txt");

        const content = await collectStream(ctx.api.read("/dest.txt"));
        expect(fromBytes(content)).toBe("new content");
      });
    });

    // ========================================
    // 8. MOVE
    // ========================================

    describe("move()", () => {
      it("should move a file", async () => {
        await ctx.api.write("/to-move.txt", [toBytes("move me")]);

        const result = await ctx.api.move("/to-move.txt", "/moved.txt");
        expect(result).toBe(true);

        expect(await ctx.api.exists("/to-move.txt")).toBe(false);
        expect(await ctx.api.exists("/moved.txt")).toBe(true);

        const content = await collectStream(ctx.api.read("/moved.txt"));
        expect(fromBytes(content)).toBe("move me");
      });

      it("should move a directory", async () => {
        await ctx.api.write("/move-dir/file.txt", [toBytes("content")]);

        const result = await ctx.api.move("/move-dir", "/moved-dir");
        expect(result).toBe(true);

        expect(await ctx.api.exists("/move-dir")).toBe(false);
        expect(await ctx.api.exists("/moved-dir/file.txt")).toBe(true);
      });

      it("should return false for non-existent source", async () => {
        const result = await ctx.api.move("/nonexistent.txt", "/dest.txt");
        expect(result).toBe(false);
      });
    });

    // ========================================
    // 9. MKDIR
    // ========================================

    describe("mkdir()", () => {
      it("should create a directory", async () => {
        await ctx.api.mkdir("/new-dir");

        const stats = await ctx.api.stats("/new-dir");
        expect(stats).toBeDefined();
        expect(stats?.kind).toBe("directory");
      });

      it("should create nested directories", async () => {
        await ctx.api.mkdir("/deep/nested/dir");

        expect(await ctx.api.exists("/deep")).toBe(true);
        expect(await ctx.api.exists("/deep/nested")).toBe(true);
        expect(await ctx.api.exists("/deep/nested/dir")).toBe(true);
      });

      it("should not fail if directory exists", async () => {
        await ctx.api.mkdir("/existing-dir");
        await ctx.api.mkdir("/existing-dir"); // Should not throw

        expect(await ctx.api.exists("/existing-dir")).toBe(true);
      });
    });

    // ========================================
    // 10. PATH EDGE CASES
    // ========================================

    describe("path handling", () => {
      it("should normalize paths with double slashes", async () => {
        await ctx.api.write("//double//slashes//file.txt", [toBytes("x")]);
        expect(await ctx.api.exists("/double/slashes/file.txt")).toBe(true);
      });

      it("should handle paths without leading slash", async () => {
        await ctx.api.write("no-leading-slash.txt", [toBytes("x")]);
        expect(await ctx.api.exists("/no-leading-slash.txt")).toBe(true);
      });

      it("should remove trailing slashes", async () => {
        await ctx.api.mkdir("/trailing-slash/");
        expect(await ctx.api.exists("/trailing-slash")).toBe(true);
      });

      it("should handle dot segments", async () => {
        await ctx.api.write("/a/./b/file.txt", [toBytes("x")]);
        expect(await ctx.api.exists("/a/b/file.txt")).toBe(true);
      });

      it("should handle special characters in names", async () => {
        const specialNames = [
          "file with spaces.txt",
          "file-with-dashes.txt",
          "file_with_underscores.txt",
          "file.multiple.dots.txt",
        ];

        for (const name of specialNames) {
          await ctx.api.write(`/special/${name}`, [toBytes("content")]);
          expect(await ctx.api.exists(`/special/${name}`)).toBe(true);
        }
      });

      it("should handle very long paths", async () => {
        const longPath = `${"/a".repeat(50)}/file.txt`;
        await ctx.api.write(longPath, [toBytes("deep")]);
        expect(await ctx.api.exists(longPath)).toBe(true);
      });
    });

    // ========================================
    // 11. CONCURRENT OPERATIONS
    // ========================================

    describe("concurrent operations", () => {
      it("should handle concurrent writes to different files", async () => {
        const writes = [];
        for (let i = 0; i < 10; i++) {
          writes.push(ctx.api.write(`/concurrent/file-${i}.txt`, [toBytes(`content ${i}`)]));
        }
        await Promise.all(writes);

        for (let i = 0; i < 10; i++) {
          const content = await collectStream(ctx.api.read(`/concurrent/file-${i}.txt`));
          expect(fromBytes(content)).toBe(`content ${i}`);
        }
      });

      it("should handle concurrent reads", async () => {
        await ctx.api.write("/concurrent-read.txt", [toBytes("shared content")]);

        const reads = [];
        for (let i = 0; i < 10; i++) {
          reads.push(collectStream(ctx.api.read("/concurrent-read.txt")));
        }

        const results = await Promise.all(reads);
        for (const result of results) {
          expect(fromBytes(result)).toBe("shared content");
        }
      });

      it("should handle concurrent list operations", async () => {
        await ctx.api.write("/concurrent-list/a.txt", [toBytes("a")]);
        await ctx.api.write("/concurrent-list/b.txt", [toBytes("b")]);
        await ctx.api.write("/concurrent-list/c.txt", [toBytes("c")]);

        const lists = [];
        for (let i = 0; i < 5; i++) {
          lists.push(collectGenerator(ctx.api.list("/concurrent-list")));
        }

        const results = await Promise.all(lists);
        for (const entries of results) {
          expect(entries.length).toBe(3);
        }
      });
    });

    // ========================================
    // 12. ERROR HANDLING
    // ========================================

    describe("error handling", () => {
      it("should handle reading non-existent file gracefully", async () => {
        const result = await collectStream(ctx.api.read("/nonexistent.txt"));
        expect(result.length).toBe(0);
      });

      it("should not throw when removing non-existent file", async () => {
        const result = await ctx.api.remove("/nonexistent.txt");
        expect(result).toBe(false);
      });

      it("should not throw when getting stats for non-existent path", async () => {
        const stats = await ctx.api.stats("/nonexistent.txt");
        expect(stats).toBeUndefined();
      });
    });
  });
}
