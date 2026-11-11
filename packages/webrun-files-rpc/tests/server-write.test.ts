import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newFilesRpcServer } from "../src/index.js";
import { bytes, collect, concat, sleep, text } from "./helpers.js";

const KB = 1024;
const split = (data: Uint8Array, size: number) => {
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += size) out.push(data.slice(at, at + size));
  return out;
};

describe("server: writing by (streamId, chunkId)", () => {
  it("writes chunks sent in order; the file appears at closeWrite", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs });
    const data = bytes(10 * KB);
    const { streamId } = await server.openWrite("/dir/a.bin");
    const chunks = split(data, KB);
    for (const [i, c] of chunks.entries()) await server.writeChunk(streamId, i, c);
    await server.closeWrite(streamId, chunks.length);
    expect(await collect(fs.read("/dir/a.bin"))).toEqual(data);
  });

  it("keeps chunks that arrive out of order and writes them in order", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs, writeWindow: 16 });
    const data = bytes(12 * KB, 3);
    const chunks = split(data, KB);
    const { streamId } = await server.openWrite("/a.bin");
    const order = [5, 0, 11, 2, 1, 9, 3, 10, 4, 8, 6, 7];
    await Promise.all(order.map((i) => server.writeChunk(streamId, i, chunks[i] as Uint8Array)));
    await server.closeWrite(streamId, chunks.length);
    expect(await collect(fs.read("/a.bin"))).toEqual(data);
  });

  it("ignores a chunk delivered twice (a retry), before or after it was written", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/a.txt");
    await server.writeChunk(streamId, 1, text("b"));
    await server.writeChunk(streamId, 1, text("b"));
    await server.writeChunk(streamId, 0, text("a"));
    await sleep(5);
    await server.writeChunk(streamId, 0, text("a")); // already consumed
    await server.closeWrite(streamId, 2);
    expect(new TextDecoder().decode(await collect(fs.read("/a.txt")))).toBe("ab");
  });

  it("holds a chunk beyond the window until the chunks before it are written (backpressure)", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs, writeWindow: 2 });
    const { streamId } = await server.openWrite("/a.txt");
    let settled = false;
    const far = server.writeChunk(streamId, 3, text("d")).then(() => {
      settled = true;
    });
    await sleep(10);
    expect(settled).toBe(false);
    await server.writeChunk(streamId, 0, text("a"));
    await server.writeChunk(streamId, 1, text("b"));
    await server.writeChunk(streamId, 2, text("c"));
    await far;
    expect(settled).toBe(true);
    await server.closeWrite(streamId, 4);
    expect(new TextDecoder().decode(await collect(fs.read("/a.txt")))).toBe("abcd");
  });

  it("closeWrite waits for a missing chunk, and fails if the count is less than what was sent", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/a.txt");
    await server.writeChunk(streamId, 0, text("a"));
    await server.writeChunk(streamId, 2, text("c"));
    let closed = false;
    const close = server.closeWrite(streamId, 3).then(() => {
      closed = true;
    });
    await sleep(10);
    expect(closed).toBe(false);
    await server.writeChunk(streamId, 1, text("b"));
    await close;
    expect(new TextDecoder().decode(await collect(fs.read("/a.txt")))).toBe("abc");

    const s2 = await server.openWrite("/b.txt");
    await server.writeChunk(s2.streamId, 0, text("x"));
    await server.writeChunk(s2.streamId, 1, text("y"));
    await expect(server.closeWrite(s2.streamId, 1)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("an empty file is zero chunks", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/empty");
    await server.closeWrite(streamId, 0);
    expect(await fs.stats("/empty")).toMatchObject({ kind: "file", size: 0 });
  });

  it("abortWrite cancels: the file keeps what it had, later calls fail, pending calls fail", async () => {
    const fs = new MemFilesApi({ initialFiles: { "/a.txt": "old" } });
    const server = newFilesRpcServer({ fs, writeWindow: 3 });
    const { streamId } = await server.openWrite("/a.txt");
    await server.writeChunk(streamId, 0, text("new"));
    const waiting = server.writeChunk(streamId, 5, text("x")); // beyond the window: waits
    await server.abortWrite(streamId, "changed my mind");
    await expect(waiting).rejects.toMatchObject({ code: "ABORTED" });
    await expect(server.writeChunk(streamId, 1, text("y"))).rejects.toMatchObject({
      code: "UNKNOWN_STREAM",
    });
    await sleep(5);
    expect(new TextDecoder().decode(await collect(fs.read("/a.txt")))).toBe("old");
    expect(server.openStreams()).toBe(0);
  });

  it("a failing write fails the calls after it", async () => {
    const fs = new MemFilesApi();
    fs.write = async (_path, content) => {
      for await (const _ of content) throw new Error("disk full");
    };
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/a.txt");
    await server.writeChunk(streamId, 0, text("a")).catch(() => {});
    await expect(server.closeWrite(streamId, 1)).rejects.toThrow("disk full");
    expect(server.openStreams()).toBe(0);
  });

  it("chunks are bytes: a Uint8Array view, an ArrayBuffer; anything else is refused", async () => {
    const fs = new MemFilesApi();
    const server = newFilesRpcServer({ fs });
    const { streamId } = await server.openWrite("/a.bin");
    const big = bytes(100);
    await server.writeChunk(streamId, 0, big.subarray(10, 20));
    await server.writeChunk(streamId, 1, big.slice(20, 30).buffer);
    await expect(
      server.writeChunk(streamId, 2, "text" as unknown as Uint8Array),
    ).rejects.toMatchObject({ code: "INVALID" });
    await server.closeWrite(streamId, 2);
    expect(await collect(fs.read("/a.bin"))).toEqual(
      concat([big.subarray(10, 20), big.subarray(20, 30)]),
    );
  });
});
