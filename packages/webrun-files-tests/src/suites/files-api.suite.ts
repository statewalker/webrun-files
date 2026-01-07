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
    // 2. READ OPTIONS
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

      it("should read to end position", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { end: 30 }));
        expect(result.length).toBe(30);
        expect(result[0]).toBe(0);
        expect(result[29]).toBe(29);
      });

      it("should read a range (start and end)", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 20, end: 40 }));
        expect(result.length).toBe(20);
        expect(result[0]).toBe(20);
        expect(result[19]).toBe(39);
      });

      it("should return empty when start equals end", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 50, end: 50 }));
        expect(result.length).toBe(0);
      });

      it("should return empty when start is beyond file size", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 200 }));
        expect(result.length).toBe(0);
      });

      it("should clamp end to file size", async () => {
        const result = await collectStream(ctx.api.read("/range.bin", { start: 90, end: 200 }));
        expect(result.length).toBe(10);
        expect(result[9]).toBe(99);
      });
    });

    // ========================================
    // 3. READFILE CONVENIENCE METHOD
    // ========================================

    describe("readFile()", () => {
      it("should read entire file into buffer", async () => {
        await ctx.api.write("/complete.txt", [toBytes("Complete content")]);

        const result = await ctx.api.readFile("/complete.txt");
        expect(fromBytes(result)).toBe("Complete content");
      });

      it("should return empty buffer for empty file", async () => {
        await ctx.api.write("/empty.txt", [new Uint8Array(0)]);

        const result = await ctx.api.readFile("/empty.txt");
        expect(result.length).toBe(0);
      });

      it("should return empty for non-existent file", async () => {
        const result = await ctx.api.readFile("/nonexistent.txt");
        expect(result.length).toBe(0);
      });
    });

    // ========================================
    // 4. STATS
    // ========================================

    describe("stats()", () => {
      it("should return file info for existing file", async () => {
        await ctx.api.write("/info.txt", [toBytes("content here")]);

        const stats = await ctx.api.stats("/info.txt");
        expect(stats).toBeDefined();
        expect(stats?.kind).toBe("file");
        expect(stats?.name).toBe("info.txt");
        expect(stats?.path).toBe("/info.txt");
        expect(stats?.size).toBe(12);
        expect(stats?.lastModified).toBeGreaterThan(0);
      });

      it("should return directory info", async () => {
        await ctx.api.write("/mydir/file.txt", [toBytes("x")]);

        const stats = await ctx.api.stats("/mydir");
        expect(stats).toBeDefined();
        expect(stats?.kind).toBe("directory");
        expect(stats?.name).toBe("mydir");
        expect(stats?.path).toBe("/mydir");
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
    // 5. EXISTS
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
    // 6. LIST
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
    // 7. REMOVE
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
    // 8. COPY
    // ========================================

    describe("copy()", () => {
      it("should copy a file", async () => {
        await ctx.api.write("/original.txt", [toBytes("original content")]);

        const result = await ctx.api.copy("/original.txt", "/copied.txt");
        expect(result).toBe(true);

        const content = await ctx.api.readFile("/copied.txt");
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

        const contentA = await ctx.api.readFile("/dest-dir/a.txt");
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

        const content = await ctx.api.readFile("/dest.txt");
        expect(fromBytes(content)).toBe("new content");
      });
    });

    // ========================================
    // 9. MOVE
    // ========================================

    describe("move()", () => {
      it("should move a file", async () => {
        await ctx.api.write("/to-move.txt", [toBytes("move me")]);

        const result = await ctx.api.move("/to-move.txt", "/moved.txt");
        expect(result).toBe(true);

        expect(await ctx.api.exists("/to-move.txt")).toBe(false);
        expect(await ctx.api.exists("/moved.txt")).toBe(true);

        const content = await ctx.api.readFile("/moved.txt");
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
    // 10. MKDIR
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
    // 11. OPEN / FILEHANDLE
    // ========================================

    describe("open() and FileHandle", () => {
      describe("basic operations", () => {
        it("should open a new file", async () => {
          const handle = await ctx.api.open("/new-handle.txt");
          expect(handle.size).toBe(0);
          await handle.close();
        });

        it("should open an existing file with correct size", async () => {
          await ctx.api.write("/existing.txt", [toBytes("existing content")]);

          const handle = await ctx.api.open("/existing.txt");
          expect(handle.size).toBe(16);
          await handle.close();
        });

        it("should report updated size after write", async () => {
          const handle = await ctx.api.open("/growing.txt");
          expect(handle.size).toBe(0);

          await handle.createWriteStream([toBytes("hello")]);
          expect(handle.size).toBe(5);

          await handle.appendFile([toBytes(" world")]);
          expect(handle.size).toBe(11);

          await handle.close();
        });
      });

      describe("createReadStream()", () => {
        beforeEach(async () => {
          const data = new Uint8Array(100);
          for (let i = 0; i < 100; i++) data[i] = i;
          await ctx.api.write("/handle-read.bin", [data]);
        });

        it("should read entire file", async () => {
          const handle = await ctx.api.open("/handle-read.bin");
          try {
            const result = await collectStream(handle.createReadStream());
            expect(result.length).toBe(100);
            expect(result[0]).toBe(0);
            expect(result[99]).toBe(99);
          } finally {
            await handle.close();
          }
        });

        it("should read from start position", async () => {
          const handle = await ctx.api.open("/handle-read.bin");
          try {
            const result = await collectStream(handle.createReadStream({ start: 50 }));
            expect(result.length).toBe(50);
            expect(result[0]).toBe(50);
          } finally {
            await handle.close();
          }
        });

        it("should read a specific range", async () => {
          const handle = await ctx.api.open("/handle-read.bin");
          try {
            const result = await collectStream(handle.createReadStream({ start: 25, end: 75 }));
            expect(result.length).toBe(50);
            expect(result[0]).toBe(25);
            expect(result[49]).toBe(74);
          } finally {
            await handle.close();
          }
        });

        it("should support multiple sequential reads", async () => {
          const handle = await ctx.api.open("/handle-read.bin");
          try {
            const read1 = await collectStream(handle.createReadStream({ start: 0, end: 10 }));
            const read2 = await collectStream(handle.createReadStream({ start: 90, end: 100 }));

            expect(read1[0]).toBe(0);
            expect(read2[0]).toBe(90);
          } finally {
            await handle.close();
          }
        });
      });

      describe("createWriteStream()", () => {
        it("should write to new file", async () => {
          const handle = await ctx.api.open("/handle-write.txt");
          try {
            const written = await handle.createWriteStream([toBytes("Hello")]);
            expect(written).toBe(5);
          } finally {
            await handle.close();
          }

          const content = await ctx.api.readFile("/handle-write.txt");
          expect(fromBytes(content)).toBe("Hello");
        });

        it("should overwrite existing content", async () => {
          await ctx.api.write("/handle-overwrite.txt", [toBytes("original")]);

          const handle = await ctx.api.open("/handle-overwrite.txt");
          try {
            await handle.createWriteStream([toBytes("new")]);
          } finally {
            await handle.close();
          }

          const content = await ctx.api.readFile("/handle-overwrite.txt");
          expect(fromBytes(content)).toBe("new");
        });

        it("should write at specific position", async () => {
          await ctx.api.write("/handle-position.txt", [toBytes("Hello World!")]);

          const handle = await ctx.api.open("/handle-position.txt");
          try {
            await handle.createWriteStream([toBytes("XXXXX")], { start: 6 });
          } finally {
            await handle.close();
          }

          const content = await ctx.api.readFile("/handle-position.txt");
          expect(fromBytes(content)).toBe("Hello XXXXX");
        });
      });

      describe("appendFile()", () => {
        it("should append to existing file", async () => {
          await ctx.api.write("/handle-append.txt", [toBytes("Hello")]);

          const handle = await ctx.api.open("/handle-append.txt");
          try {
            const written = await handle.appendFile([toBytes(" World!")]);
            expect(written).toBe(7);
          } finally {
            await handle.close();
          }

          const content = await ctx.api.readFile("/handle-append.txt");
          expect(fromBytes(content)).toBe("Hello World!");
        });

        it("should append to new file", async () => {
          const handle = await ctx.api.open("/handle-append-new.txt");
          try {
            await handle.appendFile([toBytes("First")]);
            await handle.appendFile([toBytes(" Second")]);
          } finally {
            await handle.close();
          }

          const content = await ctx.api.readFile("/handle-append-new.txt");
          expect(fromBytes(content)).toBe("First Second");
        });
      });

      describe("read() - Random Access", () => {
        it("should read bytes from the beginning of a file", async () => {
          const content = toBytes("Hello, World!");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(5);
            const bytesRead = await handle.read(buffer, 0, 5, 0);

            expect(bytesRead).toBe(5);
            expect(fromBytes(buffer)).toBe("Hello");
          } finally {
            await handle.close();
          }
        });

        it("should read bytes from the middle of a file", async () => {
          const content = toBytes("Hello, World!");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(5);
            const bytesRead = await handle.read(buffer, 0, 5, 7);

            expect(bytesRead).toBe(5);
            expect(fromBytes(buffer)).toBe("World");
          } finally {
            await handle.close();
          }
        });

        it("should read bytes into buffer at offset", async () => {
          const content = toBytes("ABCDEFGHIJ");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(10);
            buffer.fill(0);

            const bytesRead = await handle.read(buffer, 3, 4, 2);

            expect(bytesRead).toBe(4);
            expect(Array.from(buffer)).toEqual([0, 0, 0, 67, 68, 69, 70, 0, 0, 0]); // C, D, E, F
          } finally {
            await handle.close();
          }
        });

        it("should return fewer bytes at end of file", async () => {
          const content = toBytes("Short");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(100);
            const bytesRead = await handle.read(buffer, 0, 100, 0);

            expect(bytesRead).toBe(5);
            expect(fromBytes(buffer.subarray(0, bytesRead))).toBe("Short");
          } finally {
            await handle.close();
          }
        });

        it("should return 0 when reading past end of file", async () => {
          const content = toBytes("Hello");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(10);
            const bytesRead = await handle.read(buffer, 0, 10, 100);

            expect(bytesRead).toBe(0);
          } finally {
            await handle.close();
          }
        });

        it("should handle reading from empty file", async () => {
          await ctx.api.write("/empty.txt", [new Uint8Array(0)]);

          const handle = await ctx.api.open("/empty.txt");
          try {
            const buffer = new Uint8Array(10);
            const bytesRead = await handle.read(buffer, 0, 10, 0);

            expect(bytesRead).toBe(0);
          } finally {
            await handle.close();
          }
        });

        it("should handle multiple sequential reads", async () => {
          const content = toBytes("ABCDEFGHIJ");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(2);

            let bytesRead = await handle.read(buffer, 0, 2, 0);
            expect(bytesRead).toBe(2);
            expect(fromBytes(buffer)).toBe("AB");

            bytesRead = await handle.read(buffer, 0, 2, 4);
            expect(bytesRead).toBe(2);
            expect(fromBytes(buffer)).toBe("EF");

            bytesRead = await handle.read(buffer, 0, 2, 8);
            expect(bytesRead).toBe(2);
            expect(fromBytes(buffer)).toBe("IJ");
          } finally {
            await handle.close();
          }
        });

        it("should handle random access reads in non-sequential order", async () => {
          const content = toBytes("0123456789");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(1);

            await handle.read(buffer, 0, 1, 5);
            expect(fromBytes(buffer)).toBe("5");

            await handle.read(buffer, 0, 1, 2);
            expect(fromBytes(buffer)).toBe("2");

            await handle.read(buffer, 0, 1, 9);
            expect(fromBytes(buffer)).toBe("9");

            await handle.read(buffer, 0, 1, 0);
            expect(fromBytes(buffer)).toBe("0");
          } finally {
            await handle.close();
          }
        });

        it("should handle reading large files in chunks", async () => {
          const size = 1024 * 100; // 100KB
          const content = randomBytes(size);
          await ctx.api.write("/large.bin", [content]);

          const handle = await ctx.api.open("/large.bin");
          try {
            const chunkSize = 8192;
            let position = 0;
            const result = new Uint8Array(size);

            while (position < size) {
              const buffer = new Uint8Array(chunkSize);
              const bytesRead = await handle.read(buffer, 0, chunkSize, position);
              result.set(buffer.subarray(0, bytesRead), position);
              position += bytesRead;
            }

            expect(result).toEqual(content);
          } finally {
            await handle.close();
          }
        });

        it("should respect buffer offset limits", async () => {
          const content = toBytes("ABCDEFGHIJ");
          await ctx.api.write("/test.txt", [content]);

          const handle = await ctx.api.open("/test.txt");
          try {
            const buffer = new Uint8Array(5);
            // Request to write at offset 3, but buffer only has 2 bytes left
            const bytesRead = await handle.read(buffer, 3, 10, 0);

            expect(bytesRead).toBe(2); // Only 2 bytes fit in buffer
            expect(fromBytes(buffer.subarray(3, 5))).toBe("AB");
          } finally {
            await handle.close();
          }
        });
      });
    });

    // ========================================
    // 12. PATH EDGE CASES
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
    // 13. CONCURRENT OPERATIONS
    // ========================================

    describe("concurrent operations", () => {
      it("should handle concurrent writes to different files", async () => {
        const writes = [];
        for (let i = 0; i < 10; i++) {
          writes.push(ctx.api.write(`/concurrent/file-${i}.txt`, [toBytes(`content ${i}`)]));
        }
        await Promise.all(writes);

        for (let i = 0; i < 10; i++) {
          const content = await ctx.api.readFile(`/concurrent/file-${i}.txt`);
          expect(fromBytes(content)).toBe(`content ${i}`);
        }
      });

      it("should handle concurrent reads", async () => {
        await ctx.api.write("/concurrent-read.txt", [toBytes("shared content")]);

        const reads = [];
        for (let i = 0; i < 10; i++) {
          reads.push(ctx.api.readFile("/concurrent-read.txt"));
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
    // 14. ERROR HANDLING
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
