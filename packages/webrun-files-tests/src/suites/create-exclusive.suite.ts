/**
 * `FilesApi.createExclusive`, for every FilesApi that defines it.
 *
 * The method is optional: an implementation without it skips every case
 * here, and callers are expected to feature-detect it the same way. One that
 * defines it must create a file only where nothing exists, never write over
 * what is there, clean up after a failing source, and let exactly one of
 * several concurrent calls for one path win.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStream, fromBytes, toBytes } from "../test-utils.js";
import type { FilesApiFactory, FilesApiTestContext } from "./files-api.suite.js";

type CreateExclusive = NonNullable<FilesApi["createExclusive"]>;

/** Chunks that each arrive after a macrotask, so concurrent calls interleave. */
async function* slowly(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    yield toBytes(part);
  }
}

export function createCreateExclusiveTests(name: string, factory: FilesApiFactory): void {
  describe(`FilesApi.createExclusive [${name}]`, () => {
    let ctx: FilesApiTestContext;
    let createExclusive: CreateExclusive | undefined;

    beforeEach(async () => {
      ctx = await factory();
      createExclusive = ctx.api.createExclusive?.bind(ctx.api);
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    /** The bound method, or a skipped test when the API under test has none. */
    function method(skip: () => void): CreateExclusive {
      if (!createExclusive) skip();
      return createExclusive as CreateExclusive;
    }

    const read = async (path: string) => fromBytes(await collectStream(ctx.api.read(path)));

    it("creates the file and returns true", async ({ skip }) => {
      const create = method(skip);
      expect(await create("/lock.txt", [toBytes("first")])).toBe(true);
      expect(await read("/lock.txt")).toBe("first");
      expect((await ctx.api.stats("/lock.txt"))?.kind).toBe("file");
    });

    it("returns false for an existing file and leaves its content", async ({ skip }) => {
      const create = method(skip);
      expect(await create("/lock.txt", [toBytes("first")])).toBe(true);
      expect(await create("/lock.txt", [toBytes("second, longer")])).toBe(false);
      expect(await read("/lock.txt")).toBe("first");
    });

    it("returns false for a file written by write()", async ({ skip }) => {
      const create = method(skip);
      await ctx.api.write("/written.txt", [toBytes("written")]);
      expect(await create("/written.txt", [toBytes("other")])).toBe(false);
      expect(await read("/written.txt")).toBe("written");
    });

    it("returns false for an existing directory", async ({ skip }) => {
      const create = method(skip);
      await ctx.api.mkdir("/dir");
      expect(await create("/dir", [toBytes("x")])).toBe(false);
      expect((await ctx.api.stats("/dir"))?.kind).toBe("directory");
    });

    it("returns false for a directory that holds files", async ({ skip }) => {
      const create = method(skip);
      await ctx.api.write("/parent/child.txt", [toBytes("child")]);
      expect(await create("/parent", [toBytes("x")])).toBe(false);
      expect((await ctx.api.stats("/parent"))?.kind).toBe("directory");
      expect(await read("/parent/child.txt")).toBe("child");
    });

    it("creates missing parent directories", async ({ skip }) => {
      const create = method(skip);
      expect(await create("/a/b/c/lock.txt", [toBytes("deep")])).toBe(true);
      expect((await ctx.api.stats("/a/b"))?.kind).toBe("directory");
      expect(await read("/a/b/c/lock.txt")).toBe("deep");
    });

    it("creates an empty file", async ({ skip }) => {
      const create = method(skip);
      expect(await create("/empty.lock", [])).toBe(true);
      expect(await ctx.api.exists("/empty.lock")).toBe(true);
      expect(await create("/empty.lock", [toBytes("x")])).toBe(false);
    });

    it("accepts an async source of several chunks", async ({ skip }) => {
      const create = method(skip);
      expect(await create("/async.lock", slowly("one ", "two ", "three"))).toBe(true);
      expect(await read("/async.lock")).toBe("one two three");
    });

    it("leaves no file and rethrows when the source fails part way", async ({ skip }) => {
      const create = method(skip);
      const failure = new Error("source failed");
      async function* failing() {
        yield toBytes("partial ");
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw failure;
      }
      await expect(create("/dir/failed.lock", failing())).rejects.toBe(failure);
      expect(await ctx.api.exists("/dir/failed.lock")).toBe(false);
      // The path is free again.
      expect(await create("/dir/failed.lock", [toBytes("retry")])).toBe(true);
      expect(await read("/dir/failed.lock")).toBe("retry");
    });

    it("lets exactly one of 10 concurrent calls win, with its content", async ({ skip }) => {
      const create = method(skip);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          create("/race/index.lock", slowly(`writer ${i}`, ` part 2 of ${i}`)),
        ),
      );
      const winners = results.flatMap((won, i) => (won ? [i] : []));
      expect(winners).toHaveLength(1);
      const [winner] = winners;
      expect(await read("/race/index.lock")).toBe(`writer ${winner} part 2 of ${winner}`);
    });
  });
}
