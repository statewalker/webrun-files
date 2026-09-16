/**
 * Big-file suite for FilesApi implementations.
 *
 * One file of `size` bytes (256 MiB by default) is written once for the whole
 * suite and then read back in full and in ranges. Nothing here holds the file
 * in memory: its content is a pure function of the byte offset
 * ({@link positionByte}), so every check regenerates what it expects. The
 * content does not compress, which also exercises storage whose compressed
 * form is larger than its input.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asFileStats, collectStream, positionByte, positionContent } from "../test-utils.js";

export interface BigFilesTestContext {
  api: FilesApi;
  cleanup?: () => Promise<void>;
}

export type BigFilesApiFactory = () => Promise<BigFilesTestContext>;

export interface BigFilesTestOptions {
  /** Size of the big file in bytes. Defaults to 256 MiB. */
  size?: number;
  /** Timeout for each test and for the initial write, in milliseconds. Defaults to 10 minutes. */
  timeout?: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

/** Source chunk sizes, cycled, chosen so no boundary lines up with a power of two. */
const WRITE_CHUNKS = [MiB + 7, 65_537, 3 * MiB - 1, 4093];

/**
 * Consume a stream and check every byte against {@link positionByte} as it
 * arrives, starting at `offset`. Returns the number of bytes seen.
 */
async function expectStreamAt(stream: AsyncIterable<Uint8Array>, offset: number): Promise<number> {
  let position = offset;
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== positionByte(position + i)) {
        throw new Error(
          `byte ${position + i}: expected ${positionByte(position + i)}, got ${chunk[i]}`,
        );
      }
    }
    position += chunk.length;
  }
  return position - offset;
}

export function createBigFilesApiTests(
  name: string,
  factory: BigFilesApiFactory,
  options: BigFilesTestOptions = {},
): void {
  const size = options.size ?? 256 * MiB;
  const timeout = options.timeout ?? 10 * 60_000;
  const label = size >= MiB ? `${size / MiB} MiB` : `${size} B`;
  const path = "/big/file.bin";

  describe(`Big files [${name}] — ${label}`, () => {
    let ctx: BigFilesTestContext;

    beforeAll(async () => {
      ctx = await factory();
      await ctx.api.write(path, positionContent(size, WRITE_CHUNKS));
    }, timeout);

    afterAll(async () => {
      await ctx?.cleanup?.();
    }, timeout);

    it(
      "reports the exact size",
      async () => {
        expect(asFileStats(await ctx.api.stats(path)).size).toBe(size);
      },
      timeout,
    );

    it(
      "reads the whole file back, byte for byte",
      async () => {
        expect(await expectStreamAt(ctx.api.read(path), 0)).toBe(size);
      },
      timeout,
    );

    it(
      "reads the first 100 bytes",
      async () => {
        expect(await expectStreamAt(ctx.api.read(path, { length: 100 }), 0)).toBe(100);
      },
      timeout,
    );

    it(
      "reads ranges straddling each MiB boundary",
      async () => {
        for (let boundary = MiB; boundary <= Math.min(8 * MiB, size - 32); boundary += MiB) {
          const start = boundary - 32;
          expect(await expectStreamAt(ctx.api.read(path, { start, length: 64 }), start)).toBe(64);
        }
      },
      timeout,
    );

    it(
      "reads 1 MiB from the middle",
      async () => {
        const start = Math.floor(size / 2) - 12_345;
        const length = Math.min(MiB, size - start);
        expect(await expectStreamAt(ctx.api.read(path, { start, length }), start)).toBe(length);
      },
      timeout,
    );

    it(
      "reads the last 1000 bytes",
      async () => {
        const start = size - 1000;
        expect(await expectStreamAt(ctx.api.read(path, { start }), start)).toBe(1000);
      },
      timeout,
    );

    it(
      "clamps a length that runs past the end",
      async () => {
        const start = size - 10;
        expect(await expectStreamAt(ctx.api.read(path, { start, length: MiB }), start)).toBe(10);
      },
      timeout,
    );

    it(
      "reads nothing from a start past the end",
      async () => {
        expect((await collectStream(ctx.api.read(path, { start: size + 1 }))).length).toBe(0);
      },
      timeout,
    );

    it(
      "stops early without error, and the file still reads",
      async () => {
        for await (const chunk of ctx.api.read(path)) {
          expect(chunk.length).toBeGreaterThan(0);
          break;
        }
        const start = size - 64;
        expect(await expectStreamAt(ctx.api.read(path, { start }), start)).toBe(64);
      },
      timeout,
    );

    it(
      "copies the file, and removing the copy keeps the original",
      async () => {
        const copy = "/big/copy.bin";
        expect(await ctx.api.copy(path, copy)).toBe(true);
        expect(asFileStats(await ctx.api.stats(copy)).size).toBe(size);
        const start = size - 5000;
        expect(await expectStreamAt(ctx.api.read(copy, { start }), start)).toBe(5000);
        expect(await ctx.api.remove(copy)).toBe(true);
        expect(await expectStreamAt(ctx.api.read(path, { start }), start)).toBe(5000);
      },
      timeout,
    );

    it(
      "overwrites the big file with a few bytes",
      async () => {
        const small = "/big/overwritten.bin";
        await ctx.api.copy(path, small);
        await ctx.api.write(small, [new Uint8Array([1, 2, 3])]);
        expect(asFileStats(await ctx.api.stats(small)).size).toBe(3);
        expect(Array.from(await collectStream(ctx.api.read(small)))).toEqual([1, 2, 3]);
      },
      timeout,
    );
  });
}
