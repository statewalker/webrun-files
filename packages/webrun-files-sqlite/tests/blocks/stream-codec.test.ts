/** Streaming zlib codecs: correct, interoperable, and pulled rather than pushed. */
import { deflateSync, inflateSync } from "node:zlib";
import { collectStream, positionContent } from "@statewalker/webrun-files-tests";
import * as pako from "pako";
import { describe, expect, it } from "vitest";
import { pakoDeflateCodec, type StreamCodec, webDeflateCodec } from "../../src/index.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const TEXT = new TextEncoder().encode("export const answer = 42;\n".repeat(20_000));

const codecs: [string, () => StreamCodec][] = [
  ["webDeflateCodec", () => webDeflateCodec()],
  ["pakoDeflateCodec", () => pakoDeflateCodec(pako)],
];

async function* chunked(bytes: Uint8Array, size: number) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

/** A source that counts what was pulled and notices being closed. */
function tracked(size: number, chunk = 16 * KiB) {
  const state = { pulled: 0, closed: false };
  async function* source() {
    try {
      for await (const piece of positionContent(size, [chunk])) {
        state.pulled += piece.length;
        yield piece;
      }
    } finally {
      state.closed = true;
    }
  }
  return { state, source: source() };
}

for (const [label, make] of codecs) {
  describe(label, () => {
    it("is named after the format, deflate", () => {
      expect(make().name).toBe("deflate");
    });

    it("writes a zlib stream that node:zlib inflates, from uneven input chunks", async () => {
      const compressed = await collectStream(make().compress(chunked(TEXT, 7777)));
      expect(compressed[0]).toBe(0x78);
      expect(compressed.length).toBeLessThan(TEXT.length / 10);
      expect(new Uint8Array(inflateSync(compressed))).toEqual(TEXT);
    });

    it("inflates a node:zlib stream fed in small pieces", async () => {
      const out = await collectStream(make().decompress(chunked(deflateSync(TEXT), 13)));
      expect(out).toEqual(TEXT);
    });

    it("compresses and inflates empty input", async () => {
      const compressed = await collectStream(make().compress(chunked(new Uint8Array(0), 1)));
      expect(new Uint8Array(inflateSync(compressed))).toEqual(new Uint8Array(0));
      expect((await collectStream(make().decompress(chunked(compressed, 3)))).length).toBe(0);
    });

    it("rejects a corrupt stream", async () => {
      const bad = deflateSync(TEXT).subarray(0, 200);
      await expect(collectStream(make().decompress(chunked(bad, 50)))).rejects.toThrow();
    });
  });
}

/**
 * Laziness is a property of pako's codec only. Node's CompressionStream reads
 * its whole writable side ahead of its output (measured on Node 24: 64 MiB
 * pulled before the first output byte, whatever the source's highWaterMark),
 * so no wrapper can make it lazy. SqliteFilesApi never depends on it: each
 * codec call receives at most one block, and the API-level backpressure
 * tests measure that bound.
 */
describe("pakoDeflateCodec laziness", () => {
  const make = () => pakoDeflateCodec(pako);

  it("pulls input only as output is consumed, and closes the source on early exit", async () => {
    const { state, source } = tracked(64 * MiB);
    for await (const _ of make().compress(source)) break;
    expect(state.pulled).toBeLessThan(4 * MiB);
    expect(state.closed).toBe(true);
  });

  it("decompresses lazily too", async () => {
    const compressed = await collectStream(make().compress(positionContent(8 * MiB, [MiB])));
    const state = { pulled: 0 };
    async function* source() {
      for await (const piece of chunked(compressed, 16 * KiB)) {
        state.pulled += piece.length;
        yield piece;
      }
    }
    for await (const _ of make().decompress(source())) break;
    expect(state.pulled).toBeLessThan(compressed.length / 2);
  });
});

describe("interoperability", () => {
  it("each codec inflates what the other wrote", async () => {
    const [web, pk] = [webDeflateCodec(), pakoDeflateCodec(pako)];
    expect(await collectStream(pk.decompress(web.compress(chunked(TEXT, 5000))))).toEqual(TEXT);
    expect(await collectStream(web.decompress(pk.compress(chunked(TEXT, 5000))))).toEqual(TEXT);
  });
});
