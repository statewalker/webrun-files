/**
 * Discriminant conformance suite for FilesApi implementations.
 *
 * `FileStats` is a discriminated union on `kind`: a file carries a `size` and
 * a `lastModified`, a directory carries nothing else. The type says so, but a
 * type says nothing to a JavaScript caller and nothing to an implementation
 * compiled separately, so this suite says it again at runtime.
 *
 * What it enforces, and why each half matters:
 *
 * - **A file is EXACTLY the file variant.** Both numbers must be present and
 *   must be numbers. This is the half with real teeth: an implementation that
 *   omits `size` is claiming less than it must, and the omission has to fail
 *   here rather than travel as an `undefined` into a caller's arithmetic.
 * - **A directory is EXACTLY the directory variant.** No `size`, no
 *   `lastModified`, no extras. Some stores know a directory's modification
 *   time and others cannot, so no caller may rely on it; an implementation
 *   that happens to know one drops it rather than offering a value that would
 *   be present on one backend and missing on the next.
 *
 * The trap this suite exists to catch is `size: 0`. A zero-byte file is the
 * file variant with a size of zero, and every truthiness check reads that as
 * "no size" and every store that spells directories as key prefixes is
 * tempted to spell an empty one as a zero-byte object. Both mistakes look
 * identical to a caller and both are checked below.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGenerator, toBytes } from "../test-utils.js";
// Type-only, so this does not close a runtime import cycle with that module.
import type { FilesApiFactory, FilesApiTestContext } from "./files-api.suite.js";

/**
 * Assert that a value is exactly one variant of the union and nothing more.
 *
 * Deliberately an exact-key comparison rather than a property-by-property
 * check: the point of the union is that these are the ONLY fields, and a
 * subset check would pass an implementation that leaks a directory
 * `lastModified` some callers would then quietly start depending on.
 */
function expectExactVariant(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toBeDefined();
  expect(Object.keys(value as object).sort()).toEqual(Object.keys(expected).sort());
  expect(value).toEqual(expected);
}

/**
 * Create the `FileStats` discriminant conformance suite for one implementation.
 *
 * @param name Name of the implementation (e.g. "MemFilesApi", "S3FilesApi")
 * @param factory Factory function to create API instances
 */
export function createFileStatsConformanceTests(name: string, factory: FilesApiFactory): void {
  describe(`FileStats discriminant [${name}]`, () => {
    let ctx: FilesApiTestContext;

    beforeEach(async () => {
      ctx = await factory();
      await ctx.api.write("/dir/a.txt", [toBytes("aaa")]);
      await ctx.api.write("/dir/empty.bin", [new Uint8Array(0)]);
      await ctx.api.write("/dir/sub/b.txt", [toBytes("b")]);
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("stats()", () => {
      it("returns exactly the file variant for a file", async () => {
        const stats = await ctx.api.stats("/dir/a.txt");
        expectExactVariant(stats, { kind: "file", size: 3, lastModified: expect.any(Number) });
      });

      it("returns a file's lastModified as a positive epoch milliseconds value", async () => {
        const stats = await ctx.api.stats("/dir/a.txt");
        if (stats?.kind !== "file") throw new Error("expected the file variant");
        expect(stats.lastModified).toBeGreaterThan(0);
      });

      it("returns a zero-byte file as the file variant with size 0, not as a directory", async () => {
        // The falsy trap. `size: 0` is a fact about the file, and any check
        // written as `if (stats.size)` reads it as an absent size.
        const stats = await ctx.api.stats("/dir/empty.bin");
        expectExactVariant(stats, { kind: "file", size: 0, lastModified: expect.any(Number) });
      });

      it("returns exactly the directory variant for a directory", async () => {
        const stats = await ctx.api.stats("/dir");
        expectExactVariant(stats, { kind: "directory" });
      });

      it("returns exactly the directory variant for a nested directory", async () => {
        const stats = await ctx.api.stats("/dir/sub");
        expectExactVariant(stats, { kind: "directory" });
      });

      it("returns exactly the directory variant for the root", async () => {
        const stats = await ctx.api.stats("/");
        expectExactVariant(stats, { kind: "directory" });
      });

      it("returns exactly the directory variant for a directory created by mkdir", async () => {
        // An empty directory is where an object store is most tempted to
        // report the zero-byte marker it wrote as a file.
        await ctx.api.mkdir("/made");
        const stats = await ctx.api.stats("/made");
        expectExactVariant(stats, { kind: "directory" });
      });
    });

    describe("list()", () => {
      it("yields exactly one variant per entry, plus name and path", async () => {
        const entries = await collectGenerator(ctx.api.list("/dir"));
        expect(entries.length).toBeGreaterThan(0);

        for (const entry of entries) {
          if (entry.kind === "file") {
            expectExactVariant(entry, {
              kind: "file",
              name: entry.name,
              path: entry.path,
              size: expect.any(Number),
              lastModified: expect.any(Number),
            });
          } else {
            expectExactVariant(entry, {
              kind: "directory",
              name: entry.name,
              path: entry.path,
            });
          }
        }
      });

      it("yields a zero-byte file as the file variant with size 0", async () => {
        const entries = await collectGenerator(ctx.api.list("/dir"));
        const empty = entries.find((e) => e.name === "empty.bin");
        expect(empty).toBeDefined();
        if (empty?.kind !== "file") throw new Error("expected the file variant");
        expect(empty.size).toBe(0);
      });

      it("yields a subdirectory with neither a size nor a lastModified", async () => {
        const entries = await collectGenerator(ctx.api.list("/dir"));
        const sub = entries.find((e) => e.name === "sub");
        expect(sub).toBeDefined();
        expectExactVariant(sub, { kind: "directory", name: "sub", path: sub?.path });
      });

      it("yields exactly one variant per entry when recursive", async () => {
        const entries = await collectGenerator(ctx.api.list("/dir", { recursive: true }));
        expect(entries.length).toBeGreaterThan(0);

        for (const entry of entries) {
          if (entry.kind === "file") {
            expect(typeof entry.size).toBe("number");
            expect(typeof entry.lastModified).toBe("number");
          } else {
            expect(entry).not.toHaveProperty("size");
            expect(entry).not.toHaveProperty("lastModified");
          }
        }
      });

      it("agrees with stats() on every entry it yields", async () => {
        // A listing and a stats() call are two routes to the same fact, and
        // implementations reach them through different backend calls. They
        // must not disagree about which variant an entry is.
        const entries = await collectGenerator(ctx.api.list("/dir", { recursive: true }));
        for (const entry of entries) {
          const stats = await ctx.api.stats(entry.path);
          expect(stats?.kind).toBe(entry.kind);
          if (entry.kind === "file" && stats?.kind === "file") {
            expect(stats.size).toBe(entry.size);
          }
        }
      });
    });
  });
}
