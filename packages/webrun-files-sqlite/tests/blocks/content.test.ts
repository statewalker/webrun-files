/** Paths share immutable contents; a content lives as long as a path points at it. */
import { collectGenerator, collectStream, positionContent } from "@statewalker/webrun-files-tests";
import { describe, expect, it, vi } from "vitest";
import { count, fileRow, newFiles, pathRow } from "./helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = async (files: { read(p: string): AsyncIterable<Uint8Array> }, p: string) =>
  dec.decode(await collectStream(files.read(p)));
const small = { compression: null, blockSize: 64 } as const;

describe("sharing", () => {
  it("copy points the target at the same content, without copying blocks", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a", positionContent(300));
    const blocks = count(db, "fs_blocks");
    await files.copy("/a", "/b");
    expect(pathRow(db, "/b")?.fid).toBe(pathRow(db, "/a")?.fid);
    expect(count(db, "fs_blocks")).toBe(blocks);
    expect(count(db, "fs_files")).toBe(1);
  });

  it("copies a directory tree, sharing every content", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/src/x.txt", [enc.encode("x")]);
    await files.write("/src/sub/y.txt", [enc.encode("y")]);
    await files.mkdir("/src/empty");
    await files.copy("/src", "/dst/copy");
    const paths = (await collectGenerator(files.list("/dst", { recursive: true }))).map(
      (e) => e.path,
    );
    expect(paths.sort()).toEqual(
      [
        "/dst/copy",
        "/dst/copy/empty",
        "/dst/copy/sub",
        "/dst/copy/sub/y.txt",
        "/dst/copy/x.txt",
      ].sort(),
    );
    expect(count(db, "fs_files")).toBe(2);
    expect(await text(files, "/dst/copy/sub/y.txt")).toBe("y");
  });

  it("writes of identical content share one content row", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a", positionContent(300, [7]));
    await files.write("/b", positionContent(300, [100]));
    expect(pathRow(db, "/b")?.fid).toBe(pathRow(db, "/a")?.fid);
    expect(count(db, "fs_files")).toBe(1);
    expect(count(db, "fs_blocks")).toBe(5); // 4 × 64 + 44
  });

  it("does not share contents stored with different compression", async () => {
    const { db } = await newFiles(small);
    const pako = await import("pako");
    const { pakoDeflateCodec } = await import("../../src/index.js");
    const plain = await newFiles({ ...small, db });
    const packed = await newFiles({ ...small, db, compression: pakoDeflateCodec(pako) });
    await plain.files.write("/a", positionContent(300));
    await packed.files.write("/b", positionContent(300));
    expect(pathRow(db, "/b")?.fid).not.toBe(pathRow(db, "/a")?.fid);
  });
});

describe("sharing across block sizes", () => {
  it("shares identical content only between contents of the same block size", async () => {
    const { db } = await newFiles(small);
    const a = await newFiles({ db, compression: null, blockSize: 64 });
    const b = await newFiles({ db, compression: null, blockSize: 100 });
    const c = await newFiles({ db, compression: null, blockSize: 100 });
    await a.files.write("/a", positionContent(300));
    await b.files.write("/b", positionContent(300));
    await c.files.write("/c", positionContent(300));
    expect(pathRow(db, "/b")?.fid).not.toBe(pathRow(db, "/a")?.fid);
    expect(pathRow(db, "/c")?.fid).toBe(pathRow(db, "/b")?.fid);
    expect(count(db, "fs_files")).toBe(2);
  });
});

describe("collection", () => {
  it("keeps a content while another path points at it", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a", positionContent(300));
    await files.copy("/a", "/b");
    await files.remove("/a");
    expect(count(db, "fs_files")).toBe(1);
    expect((await collectStream(files.read("/b"))).length).toBe(300);
  });

  it("deletes the content and every block with the last path", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/dir/a", positionContent(300));
    await files.copy("/dir/a", "/dir/b");
    await files.remove("/dir");
    expect(count(db, "fs_paths")).toBe(0);
    expect(count(db, "fs_files")).toBe(0);
    expect(count(db, "fs_blocks")).toBe(0);
  });

  it("collects the previous content on overwrite", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a", positionContent(300));
    await files.write("/a", [enc.encode("short")]);
    expect(count(db, "fs_files")).toBe(1);
    expect(count(db, "fs_blocks")).toBe(1);
    expect(await text(files, "/a")).toBe("short");
  });

  it("keeps the content when a path is overwritten with the same bytes", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a", [enc.encode("same")]);
    await files.write("/a", [enc.encode("same")]);
    expect(count(db, "fs_files")).toBe(1);
    expect(await text(files, "/a")).toBe("same");
  });

  it("collects the replaced target of a move", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a", [enc.encode("aaa")]);
    await files.write("/b", [enc.encode("bbb")]);
    await files.move("/a", "/b");
    expect(count(db, "fs_files")).toBe(1);
    expect(await text(files, "/b")).toBe("aaa");
    expect(await files.exists("/a")).toBe(false);
  });
});

describe("failures", () => {
  it("leaves the previous content and no orphan rows when the source throws", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a", [enc.encode("previous")]);
    async function* broken() {
      yield* positionContent(200, [30]);
      throw new Error("source failed");
    }
    await expect(files.write("/a", broken())).rejects.toThrow("source failed");
    expect(await text(files, "/a")).toBe("previous");
    expect(count(db, "fs_files")).toBe(1);
    expect(count(db, "fs_blocks")).toBe(1);
  });

  it("closes the source when storing a block fails", async () => {
    let closed = false;
    const { files } = await newFiles({
      ...small,
      wrap: (driver) => ({
        all: (sql, ...params) => driver.all(sql, ...params),
        run: (sql, ...params) => {
          if (sql.includes("INSERT INTO fs_blocks") && params[1] === 64)
            throw new Error("disk full");
          return driver.run(sql, ...params);
        },
      }),
    });
    async function* source() {
      try {
        yield* positionContent(1000, [10]);
      } finally {
        closed = true;
      }
    }
    await expect(files.write("/a", source())).rejects.toThrow("disk full");
    expect(closed).toBe(true);
  });

  it("throws when the content is collected during a read", async () => {
    const { files } = await newFiles(small);
    await files.write("/a", positionContent(300));
    const reading = files.read("/a")[Symbol.asyncIterator]();
    await reading.next();
    await files.remove("/a");
    await expect(
      (async () => {
        for (;;) if ((await reading.next()).done) return;
      })(),
    ).rejects.toThrow(/\/a changed during read/);
  });

  it("names the path and compression when no codec can read a content", async () => {
    const { db } = await newFiles(small);
    const pako = await import("pako");
    const { pakoDeflateCodec } = await import("../../src/index.js");
    const writer = await newFiles({ ...small, db, compression: pakoDeflateCodec(pako) });
    await writer.files.write("/z", positionContent(300));
    vi.stubGlobal("CompressionStream", undefined);
    try {
      const reader = await newFiles({ ...small, db, compression: null });
      await expect(collectStream(reader.files.read("/z"))).rejects.toThrow(/\/z.*deflate/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("compression choice", () => {
  it("defaults to deflate over Compression Streams", async () => {
    const { db, files } = await newFiles({ blockSize: 1024 });
    await files.write("/t.txt", [enc.encode("abc".repeat(10_000))]);
    const fid = pathRow(db, "/t.txt")?.fid as number;
    expect(fileRow(db, fid)?.compression).toBe("deflate");
    expect(await text(files, "/t.txt")).toBe("abc".repeat(10_000));
  });

  it("stores content uncompressed with compression: null", async () => {
    const { db, files } = await newFiles({ compression: null });
    await files.write("/t.txt", [enc.encode("abc")]);
    expect(fileRow(db, pathRow(db, "/t.txt")?.fid as number)?.compression).toBe("none");
  });

  it("reads deflate content through Compression Streams whatever codec it writes with", async () => {
    const { db } = await newFiles(small);
    const pako = await import("pako");
    const { pakoDeflateCodec } = await import("../../src/index.js");
    const writer = await newFiles({ ...small, db, compression: pakoDeflateCodec(pako) });
    await writer.files.write("/z", positionContent(300));
    const reader = await newFiles({ ...small, db, compression: null });
    expect((await collectStream(reader.files.read("/z"))).length).toBe(300);
  });
});

describe("copy and move", () => {
  it("refuses to copy or move into the source's own subtree, or onto an ancestor", async () => {
    const { files } = await newFiles(small);
    await files.write("/a/b/c.txt", [enc.encode("c")]);
    await expect(files.copy("/a", "/a/b/inner")).rejects.toThrow(/contains/);
    await expect(files.move("/a", "/a/x")).rejects.toThrow(/contains/);
    await expect(files.move("/a/b", "/a")).rejects.toThrow(/contains/);
    expect(await text(files, "/a/b/c.txt")).toBe("c");
  });

  it("replaces the target subtree instead of merging into it", async () => {
    const { files } = await newFiles(small);
    await files.write("/src/new.txt", [enc.encode("new")]);
    await files.write("/dst/old.txt", [enc.encode("old")]);
    await files.copy("/src", "/dst");
    const names = (await collectGenerator(files.list("/dst"))).map((e) => e.name);
    expect(names).toEqual(["new.txt"]);
  });

  it("moves a tree by renaming, keeping contents and creating parents", async () => {
    const { db, files } = await newFiles(small);
    await files.write("/a/x.txt", [enc.encode("x")]);
    const fid = pathRow(db, "/a/x.txt")?.fid;
    await files.move("/a", "/deep/er/b");
    expect(pathRow(db, "/deep/er/b/x.txt")?.fid).toBe(fid);
    expect(pathRow(db, "/deep/er")?.fid).toBeNull();
    expect(await files.exists("/a")).toBe(false);
  });

  it("treats copy and move onto themselves as successful no-ops", async () => {
    const { files } = await newFiles(small);
    await files.write("/a", [enc.encode("a")]);
    expect(await files.copy("/a", "/a")).toBe(true);
    expect(await files.move("/a", "/a")).toBe(true);
    expect(await text(files, "/a")).toBe("a");
  });
});

describe("names", () => {
  it("keeps /a and /A apart, and /ab out of /a", async () => {
    const { files } = await newFiles(small);
    await files.write("/a/l.txt", [enc.encode("l")]);
    await files.write("/A/u.txt", [enc.encode("u")]);
    await files.write("/ab/s.txt", [enc.encode("s")]);
    await files.write("/a.txt", [enc.encode("t")]);
    const paths = (await collectGenerator(files.list("/a", { recursive: true }))).map(
      (e) => e.path,
    );
    expect(paths).toEqual(["/a/l.txt"]);
    await files.remove("/a");
    expect(await files.exists("/A/u.txt")).toBe(true);
    expect(await files.exists("/ab/s.txt")).toBe(true);
    expect(await files.exists("/a.txt")).toBe(true);
  });

  it("lists more entries than one page, each once, in order", async () => {
    const { files } = await newFiles(small);
    for (let i = 0; i < 600; i++) await files.mkdir(`/many/d${String(i).padStart(4, "0")}`);
    await files.write("/many/d0001/nested.txt", [enc.encode("n")]);
    const direct = await collectGenerator(files.list("/many"));
    expect(direct.map((e) => e.name)).toEqual(
      Array.from({ length: 600 }, (_, i) => `d${String(i).padStart(4, "0")}`),
    );
    expect((await collectGenerator(files.list("/many", { recursive: true }))).length).toBe(601);
  });
});
