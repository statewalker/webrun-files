/**
 * Big file test suite for FilesApi implementations
 *
 * Tests reading, writing, and random access for large files (1MB, 10MB, 50MB, 100MB).
 * All storage implementations should pass these tests.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStream, patternContent } from "../test-utils.js";

/**
 * Context provided by the files API factory
 */
export interface BigFilesTestContext {
  api: FilesApi;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a FilesApi instance for testing
 */
export type BigFilesApiFactory = () => Promise<BigFilesTestContext>;

/**
 * Options for configuring big file tests
 */
export interface BigFilesTestOptions {
  /**
   * File sizes to test in bytes. Defaults to [1MB, 10MB, 50MB, 100MB]
   */
  sizes?: number[];

  /**
   * Timeout for individual tests in milliseconds. Defaults to 120000 (2 minutes)
   */
  timeout?: number;
}

const MB = 1024 * 1024;
const DEFAULT_SIZES = [1 * MB, 10 * MB, 50 * MB, 100 * MB];

/**
 * Verify data matches expected pattern at specific positions
 */
function verifyPattern(data: Uint8Array, seed: number, offset: number = 0): boolean {
  for (let i = 0; i < data.length; i++) {
    const expected = (offset + i + seed) % 256;
    if (data[i] !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * Format bytes as human-readable string
 */
function formatSize(bytes: number): string {
  if (bytes >= MB) {
    return `${bytes / MB}MB`;
  }
  return `${bytes / 1024}KB`;
}

/**
 * Create the big files test suite with a specific factory
 *
 * @param name Name of the implementation (e.g., "MemFilesApi", "NodeFilesApi", "S3FilesApi")
 * @param factory Factory function to create API instances
 * @param options Optional configuration for the tests
 */
export function createBigFilesApiTests(
  name: string,
  factory: BigFilesApiFactory,
  options: BigFilesTestOptions = {},
): void {
  const sizes = options.sizes ?? DEFAULT_SIZES;
  const timeout = options.timeout ?? 120000;

  describe(`Big Files [${name}]`, () => {
    let ctx: BigFilesTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    // ========================================
    // SEQUENTIAL WRITE AND READ
    // ========================================

    describe("write() and read() - large files", () => {
      for (const size of sizes) {
        const sizeStr = formatSize(size);
        const seed = size % 256; // Different seed per size for variety

        it(
          `should write and read ${sizeStr} file`,
          async () => {
            const data = patternContent(size, seed);
            const path = `/big-${sizeStr}.bin`;

            // Write the file
            await ctx.api.write(path, [data]);

            // Verify file exists with correct size
            const stats = await ctx.api.stats(path);
            expect(stats).toBeDefined();
            expect(stats?.size).toBe(size);

            // Read the entire file back
            const result = await collectStream(ctx.api.read(path));
            expect(result.length).toBe(size);

            // Verify content at beginning, middle, and end
            expect(result[0]).toBe(data[0]);
            expect(result[Math.floor(size / 2)]).toBe(data[Math.floor(size / 2)]);
            expect(result[size - 1]).toBe(data[size - 1]);

            // Full verification using pattern
            expect(verifyPattern(result, seed)).toBe(true);
          },
          timeout,
        );
      }
    });

    // ========================================
    // CHUNKED WRITE
    // ========================================

    describe("write() - chunked large files", () => {
      const chunkSize = 1 * MB; // 1MB chunks

      for (const size of sizes) {
        const sizeStr = formatSize(size);
        const seed = (size + 1) % 256;

        it(
          `should write ${sizeStr} file in ${formatSize(chunkSize)} chunks`,
          async () => {
            const path = `/chunked-${sizeStr}.bin`;

            // Generate and write in chunks
            async function* generateChunks(): AsyncGenerator<Uint8Array> {
              let offset = 0;
              while (offset < size) {
                const remaining = size - offset;
                const currentChunkSize = Math.min(chunkSize, remaining);
                const chunk = patternContent(currentChunkSize, seed);
                // Adjust values based on offset
                for (let i = 0; i < chunk.length; i++) {
                  chunk[i] = (offset + i + seed) % 256;
                }
                yield chunk;
                offset += currentChunkSize;
              }
            }

            await ctx.api.write(path, generateChunks());

            // Verify size
            const stats = await ctx.api.stats(path);
            expect(stats?.size).toBe(size);

            // Read back and verify
            const result = await collectStream(ctx.api.read(path));
            expect(result.length).toBe(size);
            expect(verifyPattern(result, seed)).toBe(true);
          },
          timeout,
        );
      }
    });

    // ========================================
    // RANDOM ACCESS READ
    // ========================================

    describe("read() - random access", () => {
      for (const size of sizes) {
        const sizeStr = formatSize(size);
        const seed = (size + 2) % 256;
        const path = `/random-access-${sizeStr}.bin`;

        describe(`${sizeStr} file`, () => {
          beforeEach(async () => {
            // Create the test file
            const data = patternContent(size, seed);
            await ctx.api.write(path, [data]);
          }, timeout);

          it(
            "should read first 1KB",
            async () => {
              const result = await collectStream(ctx.api.read(path, { end: 1024 }));
              expect(result.length).toBe(1024);
              expect(verifyPattern(result, seed, 0)).toBe(true);
            },
            timeout,
          );

          it(
            "should read last 1KB",
            async () => {
              const start = size - 1024;
              const result = await collectStream(ctx.api.read(path, { start }));
              expect(result.length).toBe(1024);
              expect(verifyPattern(result, seed, start)).toBe(true);
            },
            timeout,
          );

          it(
            "should read middle 1KB",
            async () => {
              const start = Math.floor(size / 2) - 512;
              const end = start + 1024;
              const result = await collectStream(ctx.api.read(path, { start, end }));
              expect(result.length).toBe(1024);
              expect(verifyPattern(result, seed, start)).toBe(true);
            },
            timeout,
          );

          it(
            "should read multiple random ranges",
            async () => {
              // Test several random positions
              const positions = [
                0,
                Math.floor(size * 0.25),
                Math.floor(size * 0.5),
                Math.floor(size * 0.75),
                size - 4096,
              ];

              for (const start of positions) {
                const end = Math.min(start + 4096, size);
                const expectedLength = end - start;

                const result = await collectStream(ctx.api.read(path, { start, end }));
                expect(result.length).toBe(expectedLength);
                expect(verifyPattern(result, seed, start)).toBe(true);
              }
            },
            timeout,
          );

          it(
            "should read 1MB range from middle",
            async () => {
              const start = Math.floor(size / 2) - 512 * 1024;
              const end = Math.min(start + MB, size);
              const expectedLength = end - start;

              const result = await collectStream(ctx.api.read(path, { start, end }));
              expect(result.length).toBe(expectedLength);
              expect(verifyPattern(result, seed, start)).toBe(true);
            },
            timeout,
          );
        });
      }
    });

    // ========================================
    // FILEHANDLE RANDOM ACCESS
    // ========================================

    describe("FileHandle - random access", () => {
      for (const size of sizes) {
        const sizeStr = formatSize(size);
        const seed = (size + 3) % 256;
        const path = `/handle-${sizeStr}.bin`;

        describe(`${sizeStr} file via FileHandle`, () => {
          beforeEach(async () => {
            const data = patternContent(size, seed);
            await ctx.api.write(path, [data]);
          }, timeout);

          it(
            "should open file with correct size",
            async () => {
              const handle = await ctx.api.open(path);
              try {
                expect(handle.size).toBe(size);
              } finally {
                await handle.close();
              }
            },
            timeout,
          );

          it(
            "should read ranges via createReadStream",
            async () => {
              const handle = await ctx.api.open(path);
              try {
                // Read from beginning
                const beginning = await collectStream(handle.createReadStream({ end: 1024 }));
                expect(beginning.length).toBe(1024);
                expect(verifyPattern(beginning, seed, 0)).toBe(true);

                // Read from middle
                const middleStart = Math.floor(size / 2);
                const middle = await collectStream(
                  handle.createReadStream({ start: middleStart, end: middleStart + 1024 }),
                );
                expect(middle.length).toBe(1024);
                expect(verifyPattern(middle, seed, middleStart)).toBe(true);

                // Read from end
                const endStart = size - 1024;
                const ending = await collectStream(handle.createReadStream({ start: endStart }));
                expect(ending.length).toBe(1024);
                expect(verifyPattern(ending, seed, endStart)).toBe(true);
              } finally {
                await handle.close();
              }
            },
            timeout,
          );

          it(
            "should perform sequential range reads",
            async () => {
              const handle = await ctx.api.open(path);
              try {
                // Simulate reading file in 1MB chunks
                const chunkSize = MB;
                let offset = 0;

                while (offset < size) {
                  const end = Math.min(offset + chunkSize, size);
                  const chunk = await collectStream(
                    handle.createReadStream({ start: offset, end }),
                  );
                  expect(chunk.length).toBe(end - offset);
                  expect(verifyPattern(chunk, seed, offset)).toBe(true);
                  offset = end;
                }
              } finally {
                await handle.close();
              }
            },
            timeout,
          );
        });
      }
    });

    // ========================================
    // APPEND TO LARGE FILES (using writeStream with start: size)
    // ========================================

    describe("FileHandle - append to large files", () => {
      // Use smaller size for append tests to reduce memory/time
      const appendTestSizes = sizes.filter((s) => s <= 10 * MB);

      for (const size of appendTestSizes) {
        const sizeStr = formatSize(size);
        const seed = (size + 4) % 256;
        const path = `/append-handle-${sizeStr}.bin`;

        it(
          `should append to ${sizeStr} file`,
          async () => {
            // Create initial file
            const data = patternContent(size, seed);
            await ctx.api.write(path, [data]);

            // Append additional data using writeStream with start: handle.size
            const handle = await ctx.api.open(path);
            try {
              const appendData = new Uint8Array(1024).fill(0xff); // Append 0xFF bytes
              await handle.writeStream([appendData], { start: handle.size });
            } finally {
              await handle.close();
            }

            // Verify new size
            const stats = await ctx.api.stats(path);
            expect(stats?.size).toBe(size + 1024);

            // Read and verify the content
            const result = await collectStream(ctx.api.read(path));
            expect(result.length).toBe(size + 1024);

            // Check original content is unchanged
            expect(verifyPattern(result.slice(0, size), seed, 0)).toBe(true);

            // Check appended content
            for (let i = 0; i < 1024; i++) {
              expect(result[size + i]).toBe(0xff);
            }
          },
          timeout,
        );
      }
    });

    // ========================================
    // OVERWRITE LARGE FILES
    // ========================================

    describe("overwrite large files", () => {
      for (const size of sizes) {
        const sizeStr = formatSize(size);

        it(
          `should overwrite ${sizeStr} file with smaller content`,
          async () => {
            const path = `/overwrite-${sizeStr}.bin`;
            const seed1 = size % 256;
            const seed2 = (size + 100) % 256;

            // Write large file
            const largeData = patternContent(size, seed1);
            await ctx.api.write(path, [largeData]);

            // Overwrite with smaller content
            const smallData = patternContent(1024, seed2);
            await ctx.api.write(path, [smallData]);

            // Verify new size
            const stats = await ctx.api.stats(path);
            expect(stats?.size).toBe(1024);

            // Verify new content
            const result = await collectStream(ctx.api.read(path));
            expect(result.length).toBe(1024);
            expect(verifyPattern(result, seed2, 0)).toBe(true);
          },
          timeout,
        );
      }
    });

    // ========================================
    // COPY AND MOVE LARGE FILES
    // ========================================

    describe("copy() and move() - large files", () => {
      // Use smaller sizes for copy/move tests
      const copyMoveTestSizes = sizes.filter((s) => s <= 10 * MB);

      for (const size of copyMoveTestSizes) {
        const sizeStr = formatSize(size);
        const seed = (size + 5) % 256;

        it(
          `should copy ${sizeStr} file`,
          async () => {
            const srcPath = `/copy-src-${sizeStr}.bin`;
            const destPath = `/copy-dest-${sizeStr}.bin`;

            // Create source file
            const data = patternContent(size, seed);
            await ctx.api.write(srcPath, [data]);

            // Copy
            const result = await ctx.api.copy(srcPath, destPath);
            expect(result).toBe(true);

            // Verify both exist with correct size
            const srcStats = await ctx.api.stats(srcPath);
            const destStats = await ctx.api.stats(destPath);
            expect(srcStats?.size).toBe(size);
            expect(destStats?.size).toBe(size);

            // Verify dest content
            const destContent = await collectStream(ctx.api.read(destPath));
            expect(verifyPattern(destContent, seed, 0)).toBe(true);
          },
          timeout,
        );

        it(
          `should move ${sizeStr} file`,
          async () => {
            const srcPath = `/move-src-${sizeStr}.bin`;
            const destPath = `/move-dest-${sizeStr}.bin`;

            // Create source file
            const data = patternContent(size, seed);
            await ctx.api.write(srcPath, [data]);

            // Move
            const result = await ctx.api.move(srcPath, destPath);
            expect(result).toBe(true);

            // Verify source gone, dest exists
            expect(await ctx.api.exists(srcPath)).toBe(false);
            const destStats = await ctx.api.stats(destPath);
            expect(destStats?.size).toBe(size);

            // Verify dest content
            const destContent = await collectStream(ctx.api.read(destPath));
            expect(verifyPattern(destContent, seed, 0)).toBe(true);
          },
          timeout,
        );
      }
    });
  });
}
