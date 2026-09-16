/** How content is cut into fixed-size blocks, recorded, and read back — checked with raw SQL. */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { collectStream, positionContent } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { describe, expect, it } from "vitest";
import { pakoDeflateCodec, type SqlDriver, SqliteFilesApi } from "../../src/index.js";
import { blocksOf, count, fileRow, newFiles, passthrough, pathRow } from "./helpers.js";

const KiB = 1024;
const MiB = 1024 * KiB;

const bytesOf = (size: number) => collectStream(positionContent(size, [size || 1]));
const fidOf = (db: Parameters<typeof pathRow>[0], path: string) => pathRow(db, path)?.fid as number;
const layout = (db: Parameters<typeof pathRow>[0], path: string) =>
  blocksOf(db, fidOf(db, path)).map((b) => [b.shift, b.len]);

describe("fixed block size", () => {
  it("cuts 1 MiB blocks by default and records the size on the content", async () => {
    const { db, files } = await newFiles({ compression: null });
    await files.write("/f.bin", positionContent(2 * MiB + MiB / 2 + 123, [100_003]));
    expect(layout(db, "/f.bin")).toEqual([
      [0, MiB],
      [MiB, MiB],
      [2 * MiB, MiB / 2 + 123],
    ]);
    expect(fileRow(db, fidOf(db, "/f.bin"))?.block_size).toBe(MiB);
  });

  it("cuts every block to blockSize, with only the last one shorter", async () => {
    const { db, files } = await newFiles({ compression: null, blockSize: 40 });
    await files.write("/f", positionContent(150, [7]));
    expect(layout(db, "/f")).toEqual([
      [0, 40],
      [40, 40],
      [80, 40],
      [120, 30],
    ]);
    expect(fileRow(db, fidOf(db, "/f"))?.block_size).toBe(40);
  });

  it("writes no empty trailing block when the size is an exact multiple", async () => {
    const { db, files } = await newFiles({ compression: null, blockSize: 40 });
    await files.write("/f", positionContent(120, [50]));
    expect(layout(db, "/f")).toEqual([
      [0, 40],
      [40, 40],
      [80, 40],
    ]);
  });

  it("stores a file smaller than one block as a single short block", async () => {
    const { db, files } = await newFiles({ compression: null, blockSize: 40 });
    await files.write("/f", positionContent(5, [1]));
    expect(layout(db, "/f")).toEqual([[0, 5]]);
  });

  it("does not depend on how the source is chunked", async () => {
    const one = await newFiles({ compression: null, blockSize: 64 });
    const other = await newFiles({ compression: null, blockSize: 64 });
    await one.files.write("/f", positionContent(500, [500]));
    await other.files.write("/f", positionContent(500, [1, 3, 200, 9]));
    const blocks = (db: typeof one.db) =>
      blocksOf(db, fidOf(db, "/f")).map((b) => [b.shift, Array.from(b.block)]);
    expect(blocks(other.db)).toEqual(blocks(one.db));
  });

  it("stores an empty file as size 0 with no blocks", async () => {
    const { db, files } = await newFiles({ compression: null, blockSize: 40 });
    await files.write("/empty", []);
    expect(fileRow(db, fidOf(db, "/empty"))).toMatchObject({
      size: 0,
      compression: "none",
      block_size: 40,
    });
    expect(blocksOf(db, fidOf(db, "/empty"))).toEqual([]);
    expect(await files.stats("/empty")).toMatchObject({ kind: "file", size: 0 });
  });

  it("records size, compression, block size and the SHA-256 of the uncompressed content", async () => {
    const { db, files } = await newFiles({ compression: null, blockSize: 100 });
    const bytes = await bytesOf(5000);
    const before = Date.now();
    await files.write("/f", [bytes]);
    const fid = fidOf(db, "/f");
    expect(fileRow(db, fid)).toEqual({
      fid,
      size: 5000,
      compression: "none",
      block_size: 100,
      hash: createHash("sha256").update(bytes).digest("hex"),
      updated: expect.any(Number),
    });
    expect(fileRow(db, fid)?.updated).toBeGreaterThanOrEqual(before);
    expect(fileRow(db, fid)?.updated).toBeLessThanOrEqual(Date.now());
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

describe("blockSize validation", () => {
  const construct = (blockSize: number) =>
    new SqliteFilesApi({ all: () => [], run: () => {}, transaction: () => [] }, { blockSize });

  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1.5 * MiB + 1]) {
    it(`rejects ${bad}`, () => {
      expect(() => construct(bad)).toThrow(/blockSize/);
    });
  }

  for (const good of [1, 1000, 1.5 * MiB]) {
    it(`accepts ${good}`, () => {
      expect(() => construct(good)).not.toThrow();
    });
  }
});

describe("contents keep their own block size", () => {
  it("reads contents written with another blockSize, whole and in ranges", async () => {
    const writer = await newFiles({ compression: null, blockSize: 40 });
    const bytes = await bytesOf(333);
    await writer.files.write("/f", [bytes]);
    const reader = await newFiles({ db: writer.db, compression: null, blockSize: 64 });
    expect(await collectStream(reader.files.read("/f"))).toEqual(bytes);
    for (const [start, length] of [
      [39, 2],
      [40, 40],
      [63, 3],
      [320, 100],
    ]) {
      expect(await collectStream(reader.files.read("/f", { start, length }))).toEqual(
        bytes.subarray(start, start + length),
      );
    }
  });

  it("writes with its own size next to contents of another size", async () => {
    const first = await newFiles({ compression: null, blockSize: 40 });
    await first.files.write("/a", positionContent(100));
    const second = await newFiles({ db: first.db, compression: null, blockSize: 64 });
    await second.files.write("/b", positionContent(100, [3]));
    expect(layout(first.db, "/a").map(([, len]) => len)).toEqual([40, 40, 20]);
    expect(layout(first.db, "/b").map(([, len]) => len)).toEqual([64, 36]);
    expect((await collectStream(second.files.read("/a"))).length).toBe(100);
  });
});

describe("range reads", () => {
  it("fetch exactly the blocks the range touches", async () => {
    const shifts: number[] = [];
    const { files } = await newFiles({
      compression: null,
      blockSize: 100,
      wrap: (d): SqlDriver =>
        passthrough(d, {
          all: (sql, ...params) => {
            if (sql.includes("FROM fs_blocks")) shifts.push(params[1] as number);
            return d.all(sql, ...params);
          },
        }),
    });
    await files.write("/f", positionContent(1000, [333]));
    const fetched = async (start: number, length?: number) => {
      shifts.length = 0;
      await collectStream(files.read("/f", { start, length }));
      return [...shifts];
    };
    expect(await fetched(250, 100)).toEqual([200, 300]);
    expect(await fetched(300, 100)).toEqual([300]);
    expect(await fetched(299, 2)).toEqual([200, 300]);
    expect(await fetched(999)).toEqual([900]);
    expect(await fetched(0, 0)).toEqual([]);
    expect(await fetched(1000)).toEqual([]);
    expect(await fetched(0)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  for (const [label, compression] of [
    ["uncompressed", null],
    ["deflate", pakoDeflateCodec(pako)],
  ] as const) {
    it(`return exactly the requested bytes near every block edge — ${label}`, async () => {
      const { files } = await newFiles({ compression, blockSize: 8 });
      const bytes = await bytesOf(200);
      await files.write("/f", [bytes]);
      for (const start of [0, 1, 7, 8, 9, 23, 24, 25, 55, 56, 57, 191, 192, 199, 200, 250]) {
        for (const length of [0, 1, 8, 9, 40, 300]) {
          const got = await collectStream(files.read("/f", { start, length }));
          expect(Array.from(got), `start ${start} length ${length}`).toEqual(
            Array.from(bytes.subarray(start, start + length)),
          );
        }
      }
    });
  }
});

describe("compressed blocks", () => {
  it("stores each block as an independent zlib stream of its uncompressed slice", async () => {
    const { db, files } = await newFiles({ blockSize: 4000 });
    const bytes = new TextEncoder().encode("block storage streams bytes. ".repeat(1000));
    await files.write("/t.txt", [bytes]);
    expect(fileRow(db, fidOf(db, "/t.txt"))?.compression).toBe("deflate");
    const blocks = blocksOf(db, fidOf(db, "/t.txt"));
    expect(blocks.map((b) => b.shift)).toEqual([
      0, 4000, 8000, 12_000, 16_000, 20_000, 24_000, 28_000,
    ]);
    for (const b of blocks) {
      const slice = bytes.subarray(b.shift, b.shift + 4000);
      expect(b.len).toBeLessThan(slice.length);
      expect(new Uint8Array(inflateSync(b.block))).toEqual(slice);
    }
  });
});

describe("corrupt block lengths", () => {
  /** A 1000-byte file in 100-byte blocks, with one block rewritten by raw SQL. */
  async function corrupted(compression: "none" | "deflate", shift: number, block: Uint8Array) {
    const { db, files } = await newFiles({
      compression: compression === "none" ? null : pakoDeflateCodec(pako),
      blockSize: 100,
    });
    await files.write("/f", positionContent(1000, [1000]));
    db.prepare("UPDATE fs_blocks SET block = ? WHERE fid = ? AND shift = ?").run(
      block,
      fidOf(db, "/f"),
      shift,
    );
    return files;
  }
  const bytesAt = async (shift: number, length: number) =>
    collectStream(positionContent(length, [length], shift));

  const cases: [string, "none" | "deflate", number, () => Promise<Uint8Array>][] = [
    ["a raw block too short", "none", 300, () => bytesAt(300, 99)],
    ["a raw block too long", "none", 300, () => bytesAt(300, 101)],
    ["a raw last block too short", "none", 900, () => bytesAt(900, 50)],
    ["a raw last block too long", "none", 900, () => bytesAt(900, 150)],
    [
      "a deflated block inflating short",
      "deflate",
      300,
      async () => deflateSync(await bytesAt(300, 99)),
    ],
    [
      "a deflated block inflating long",
      "deflate",
      300,
      async () => deflateSync(await bytesAt(300, 101)),
    ],
    [
      "a deflated last block inflating long",
      "deflate",
      900,
      async () => deflateSync(await bytesAt(900, 150)),
    ],
  ];

  for (const [label, compression, shift, block] of cases) {
    it(`throws on ${label}, naming the path and the block`, async () => {
      const files = await corrupted(compression, shift, await block());
      await expect(collectStream(files.read("/f"))).rejects.toThrow(
        new RegExp(`/f block at ${shift} holds (at least )?\\d+ bytes, expected 100`),
      );
    });
  }

  for (const [label, compression, shift, block] of cases) {
    it(`hands out only correct bytes before failing on ${label}`, async () => {
      const files = await corrupted(compression, shift, await block());
      const received: Uint8Array[] = [];
      await expect(
        (async () => {
          for await (const chunk of files.read("/f")) received.push(chunk.slice());
        })(),
      ).rejects.toThrow(/holds/);
      const got = await collectStream(received);
      expect(got.length).toBeLessThanOrEqual(shift + 100);
      expect(got).toEqual(await bytesAt(0, got.length));
    });
  }

  it("throws when a middle block is missing, even for a range starting inside it", async () => {
    const { db, files } = await newFiles({ compression: null, blockSize: 100 });
    await files.write("/f", positionContent(1000, [1000]));
    db.prepare("DELETE FROM fs_blocks WHERE fid = ? AND shift = 500").run(fidOf(db, "/f"));
    await expect(collectStream(files.read("/f"))).rejects.toThrow(/\/f changed during read/);
    await expect(collectStream(files.read("/f", { start: 550, length: 10 }))).rejects.toThrow(
      /\/f changed during read/,
    );
    expect((await collectStream(files.read("/f", { start: 400, length: 100 }))).length).toBe(100);
  });
});
