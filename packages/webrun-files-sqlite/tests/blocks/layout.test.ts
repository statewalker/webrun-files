/** How content is cut into blocks and recorded, checked with raw SQL. */
import { createHash } from "node:crypto";
import { collectStream, positionContent } from "@statewalker/webrun-files-tests";
import { describe, expect, it } from "vitest";
import { blocksOf, count, fileRow, newFiles, pathRow } from "./helpers.js";

const KiB = 1024;
const MiB = 1024 * KiB;

async function bytesOf(size: number) {
  return collectStream(positionContent(size, [size || 1]));
}

describe("block layout", () => {
  it("cuts blocks of 64, 128, 256, 512 KiB, then 1 MiB, by uncompressed size", async () => {
    const { db, files } = await newFiles({ compression: null });
    const size = 64 * KiB + 128 * KiB + 256 * KiB + 512 * KiB + MiB + MiB + 123;
    await files.write("/f.bin", positionContent(size, [100_003]));
    const fid = pathRow(db, "/f.bin")?.fid as number;
    expect(blocksOf(db, fid).map((b) => [b.shift, b.len])).toEqual([
      [0, 64 * KiB],
      [64 * KiB, 128 * KiB],
      [192 * KiB, 256 * KiB],
      [448 * KiB, 512 * KiB],
      [960 * KiB, MiB],
      [960 * KiB + MiB, MiB],
      [960 * KiB + 2 * MiB, 123],
    ]);
  });

  it("follows minBlockSize and maxBlockSize", async () => {
    const { db, files } = await newFiles({ compression: null, minBlockSize: 10, maxBlockSize: 40 });
    await files.write("/f.bin", positionContent(150, [7]));
    const fid = pathRow(db, "/f.bin")?.fid as number;
    expect(blocksOf(db, fid).map((b) => b.len)).toEqual([10, 20, 40, 40, 40]);
  });

  it("does not depend on how the source is chunked", async () => {
    const one = await newFiles({ compression: null, minBlockSize: 16, maxBlockSize: 64 });
    const other = await newFiles({ compression: null, minBlockSize: 16, maxBlockSize: 64 });
    await one.files.write("/f", positionContent(500, [500]));
    await other.files.write("/f", positionContent(500, [1, 3, 200, 9]));
    const layout = (db: typeof one.db) =>
      blocksOf(db, pathRow(db, "/f")?.fid as number).map((b) => [b.shift, Array.from(b.block)]);
    expect(layout(other.db)).toEqual(layout(one.db));
  });

  it("stores an empty file as size 0 with no blocks", async () => {
    const { db, files } = await newFiles({ compression: null });
    await files.write("/empty", []);
    const fid = pathRow(db, "/empty")?.fid as number;
    expect(fileRow(db, fid)).toMatchObject({ size: 0, compression: "none" });
    expect(blocksOf(db, fid)).toEqual([]);
    expect(await files.stats("/empty")).toMatchObject({ kind: "file", size: 0 });
  });

  it("records the size and the SHA-256 of the uncompressed content", async () => {
    const { db, files } = await newFiles({ compression: null, minBlockSize: 100 });
    const bytes = await bytesOf(5000);
    await files.write("/f", [bytes]);
    const fid = pathRow(db, "/f")?.fid as number;
    expect(fileRow(db, fid)).toEqual({
      fid,
      size: 5000,
      compression: "none",
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("stores directories as paths without content, and mtime in milliseconds", async () => {
    const { db, files } = await newFiles();
    const before = Date.now();
    await files.write("/a/b/c.txt", [new Uint8Array([1])]);
    expect(pathRow(db, "/a")?.fid).toBeNull();
    expect(pathRow(db, "/a/b")?.fid).toBeNull();
    expect(pathRow(db, "/a/b/c.txt")?.mtime).toBeGreaterThanOrEqual(before);
    expect(pathRow(db, "/")).toBeUndefined();
    expect(count(db, "fs_paths")).toBe(3);
  });
});

describe("range reads across blocks", () => {
  it("returns exactly the requested bytes for every start and length near block edges", async () => {
    const { files } = await newFiles({ compression: null, minBlockSize: 8, maxBlockSize: 32 });
    const bytes = await bytesOf(200);
    await files.write("/f", [bytes]);
    for (const start of [0, 1, 7, 8, 9, 23, 24, 25, 55, 56, 57, 199]) {
      for (const length of [0, 1, 8, 9, 40, 300]) {
        const got = await collectStream(files.read("/f", { start, length }));
        expect(Array.from(got), `start ${start} length ${length}`).toEqual(
          Array.from(bytes.subarray(start, start + length)),
        );
      }
    }
  });
});

describe("compressed blocks", () => {
  it("stores each block as an independent zlib stream of its uncompressed slice", async () => {
    const { inflateSync } = await import("node:zlib");
    const { db, files } = await newFiles({ minBlockSize: 1000, maxBlockSize: 4000 });
    const bytes = new TextEncoder().encode("block storage streams bytes. ".repeat(1000));
    await files.write("/t.txt", [bytes]);
    const fid = pathRow(db, "/t.txt")?.fid as number;
    expect(fileRow(db, fid)?.compression).toBe("deflate");
    const blocks = blocksOf(db, fid);
    expect(blocks.map((b) => b.shift)).toEqual([
      0, 1000, 3000, 7000, 11_000, 15_000, 19_000, 23_000, 27_000,
    ]);
    for (const [i, b] of blocks.entries()) {
      const end = blocks[i + 1]?.shift ?? bytes.length;
      expect(b.len).toBeLessThan(end - b.shift);
      expect(new Uint8Array(inflateSync(b.block))).toEqual(bytes.subarray(b.shift, end));
    }
  });
});
