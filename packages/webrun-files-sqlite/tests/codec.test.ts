/**
 * Compression. SQLAR mandates zlib-wrapped Deflate (RFC 1950); every codec
 * must write it and read what the others wrote, and `node:zlib` is the
 * independent reader that says the bytes are right.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { collectStream } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Codec, defaultCodec, pakoCodec, rawCodec, webCodec } from "../src/index.js";
import { newArchive, rawRow } from "./helpers.js";

const enc = new TextEncoder();
const COMPRESSIBLE = enc.encode("export const x = 1;\n".repeat(400));
const INCOMPRESSIBLE = crypto.getRandomValues(new Uint8Array(4096));

const read = async (files: { read: (p: string) => AsyncIterable<Uint8Array> }, path: string) =>
  collectStream(files.read(path));

const codecs: [string, () => Codec][] = [
  ["webCodec", () => webCodec()],
  ["pakoCodec", () => pakoCodec(pako)],
];

for (const [label, make] of codecs) {
  describe(label, () => {
    it("round-trips compressible content", async () => {
      const { files } = await newArchive({ codec: make() });
      await files.write("/a.js", [COMPRESSIBLE]);
      expect(await read(files, "/a.js")).toEqual(COMPRESSIBLE);
    });

    it("compresses, keeping the original size in sz", async () => {
      const { db, files } = await newArchive({ codec: make() });
      await files.write("/a.js", [COMPRESSIBLE]);
      const row = rawRow(db, "a.js");
      expect(row?.sz).toBe(COMPRESSIBLE.byteLength);
      expect(row?.len).toBeLessThan(COMPRESSIBLE.byteLength);
    });

    it("writes a zlib stream that node:zlib inflates to the original", async () => {
      const { db, files } = await newArchive({ codec: make() });
      await files.write("/a.js", [COMPRESSIBLE]);
      const data = rawRow(db, "a.js")?.data as Uint8Array;
      expect(data[0]).toBe(0x78);
      expect(new Uint8Array(inflateSync(data))).toEqual(COMPRESSIBLE);
    });

    it("stores incompressible content as plaintext", async () => {
      const { db, files } = await newArchive({ codec: make() });
      await files.write("/noise.bin", [INCOMPRESSIBLE]);
      const row = rawRow(db, "noise.bin");
      expect(row?.len).toBe(row?.sz);
      expect(await read(files, "/noise.bin")).toEqual(INCOMPRESSIBLE);
    });

    it("stores input shorter than minSize as plaintext without deflating", async () => {
      const codec = make();
      const deflate = vi.spyOn(codec, "deflate");
      const { db, files } = await newArchive({ codec });
      await files.write("/tiny.txt", [enc.encode("a".repeat(codec.minSize - 1))]);
      expect(deflate).not.toHaveBeenCalled();
      expect(rawRow(db, "tiny.txt")?.len).toBe(codec.minSize - 1);
    });

    it("never stores data longer than sz", async () => {
      const { db, files } = await newArchive({ codec: make() });
      for (const size of [1, 7, 63, 64, 65, 200, 5000]) {
        await files.write(`/f${size}`, [crypto.getRandomValues(new Uint8Array(size))]);
        const row = rawRow(db, `f${size}`);
        expect(row?.len, `f${size}`).toBeLessThanOrEqual(row?.sz ?? -1);
      }
    });

    it("serves ranges of the inflated content", async () => {
      const { files } = await newArchive({ codec: make() });
      await files.write("/a.js", [COMPRESSIBLE]);
      const got = await collectStream(files.read("/a.js", { start: 25, length: 10 }));
      expect(got).toEqual(COMPRESSIBLE.subarray(25, 35));
    });

    it("keeps a compressed row byte-identical through copy", async () => {
      const { db, files } = await newArchive({ codec: make() });
      await files.write("/a.js", [COMPRESSIBLE]);
      await files.copy("/a.js", "/b.js");
      expect(rawRow(db, "b.js")?.data).toEqual(rawRow(db, "a.js")?.data);
      expect(await read(files, "/b.js")).toEqual(COMPRESSIBLE);
    });
  });
}

describe("codec options", () => {
  it("webCodec honours minSize", async () => {
    const { db, files } = await newArchive({ codec: webCodec({ minSize: 1_000_000 }) });
    await files.write("/a.js", [COMPRESSIBLE]);
    expect(rawRow(db, "a.js")?.len).toBe(COMPRESSIBLE.byteLength);
  });

  it("pakoCodec passes the level through", async () => {
    // Level 0 emits stored blocks, which are longer than the input.
    const { db, files } = await newArchive({ codec: pakoCodec(pako, { level: 0 }) });
    await files.write("/a.js", [COMPRESSIBLE]);
    expect(rawRow(db, "a.js")?.len).toBe(COMPRESSIBLE.byteLength);
  });
});

describe("interoperability", () => {
  it("reads with webCodec what pakoCodec wrote, and the reverse", async () => {
    const pakoSide = await newArchive({ codec: pakoCodec(pako) });
    await pakoSide.files.write("/p.js", [COMPRESSIBLE]);
    const webSide = await newArchive({ codec: webCodec(), db: pakoSide.db });
    await webSide.files.write("/w.js", [COMPRESSIBLE]);

    expect(await read(webSide.files, "/p.js")).toEqual(COMPRESSIBLE);
    expect(await read(pakoSide.files, "/w.js")).toEqual(COMPRESSIBLE);
  });

  it("reads a row deflated by node:zlib, as sqlite3 -A writes it", async () => {
    const { db, files } = await newArchive({ codec: webCodec() });
    db.prepare("INSERT INTO sqlar VALUES ('z.js', 33188, 1, ?, ?)").run(
      COMPRESSIBLE.byteLength,
      deflateSync(COMPRESSIBLE),
    );
    expect(await read(files, "/z.js")).toEqual(COMPRESSIBLE);
  });
});

describe("rawCodec", () => {
  it("never compresses, and still round-trips", async () => {
    const { db, files } = await newArchive({ codec: rawCodec() });
    await files.write("/a.js", [COMPRESSIBLE]);
    expect(rawRow(db, "a.js")?.len).toBe(COMPRESSIBLE.byteLength);
    expect(await read(files, "/a.js")).toEqual(COMPRESSIBLE);
  });

  it("fails loudly on a compressed row instead of returning deflate bytes", async () => {
    const writer = await newArchive({ codec: pakoCodec(pako) });
    await writer.files.write("/a.js", [COMPRESSIBLE]);
    const reader = await newArchive({ codec: rawCodec(), db: writer.db });
    await expect(read(reader.files, "/a.js")).rejects.toThrow(/rawCodec cannot inflate/);
  });
});

describe("defaultCodec", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is webCodec where CompressionStream exists", () => {
    expect(defaultCodec().name).toBe("web");
  });

  it("is rawCodec where CompressionStream is missing", () => {
    vi.stubGlobal("CompressionStream", undefined);
    expect(defaultCodec().name).toBe("raw");
  });

  it("webCodec refuses to construct where CompressionStream is missing", () => {
    vi.stubGlobal("CompressionStream", undefined);
    expect(() => webCodec()).toThrow(/CompressionStream/);
  });

  it("is used when no codec is given", async () => {
    const { db, files } = await newArchive();
    await files.write("/a.js", [COMPRESSIBLE]);
    expect(rawRow(db, "a.js")?.len).toBeLessThan(COMPRESSIBLE.byteLength);
  });
});

describe("corrupt rows", () => {
  it("throws when the inflated size disagrees with sz", async () => {
    const { db, files } = await newArchive({ codec: pakoCodec(pako) });
    await files.write("/a.js", [COMPRESSIBLE]);
    db.prepare("UPDATE sqlar SET sz = 999999 WHERE name = 'a.js'").run();
    await expect(read(files, "/a.js")).rejects.toThrow(/a\.js.*inflated 8000.*sz 999999/);
  });

  for (const [label, make] of codecs) {
    it(`throws a named error when ${label} cannot inflate the stored bytes`, async () => {
      const { db, files } = await newArchive({ codec: make() });
      db.prepare("INSERT INTO sqlar VALUES ('bad.js', 33188, 1, 100, x'0102030405')").run();
      await expect(read(files, "/bad.js")).rejects.toThrow(/sqlar: bad\.js/);
    });
  }

  it("throws when length(data) exceeds sz", async () => {
    const { db, files } = await newArchive({ codec: pakoCodec(pako) });
    await files.write("/a.txt", [enc.encode("hello")]);
    db.prepare("UPDATE sqlar SET sz = 2 WHERE name = 'a.txt'").run();
    await expect(read(files, "/a.txt")).rejects.toThrow(/a\.txt.*length\(data\)=5.*sz=2/);
  });
});
